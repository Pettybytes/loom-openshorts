import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { requestExistingAutoEdit, autoStartDecision } from './autoStart.js';

const plan = { edits: [{ type: 'punch_in', start: 2, end: 4, strength: 0.1 }], filter_string: 'generated-filter' };
const generatedUrl = '/videos/loom-session/edited_recut.mp4';
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('the bridge invokes existing Gemini Auto Edit with the prepared file and retains its applied plan', async () => {
  const calls = [];
  const result = await requestExistingAutoEdit({
    apiFetch: async (...args) => { calls.push(args); return response({ success: true, new_video_url: generatedUrl, edit_plan: plan }); },
    jobId: 'source', clipIndex: 0, inputFilename: 'recut.mp4', geminiKey: 'test-key',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/edit');
  assert.deepEqual(JSON.parse(calls[0][1].body), { job_id: 'source', clip_index: 0, input_filename: 'recut.mp4', generate_copy: true });
  assert.equal(calls[0][1].headers['X-Gemini-Key'], 'test-key');
  assert.deepEqual(result.edit_plan, plan);
  assert.equal(result.output_url, generatedUrl);
  assert.ok(!JSON.stringify(result).includes('test-key'), 'credential is not resolved edit state');
});

test('a successful no-effects decision is real analysis, but a missing plan is not', async () => {
  const args = { jobId: 'source', clipIndex: 0, inputFilename: 'recut.mp4' };
  const result = await requestExistingAutoEdit({ ...args,
    apiFetch: async () => response({ success: true, new_video_url: generatedUrl, edit_plan: { edits: [], filter_string: null } }),
  });
  assert.deepEqual(result.edit_plan.edits, []);
  await assert.rejects(requestExistingAutoEdit({ ...args,
    apiFetch: async () => response({ success: true, new_video_url: generatedUrl }),
  }), /resolved edit plan/);
});

test('a new session reopening a generated version never auto-starts another Gemini edit', () => {
  for (const edits of [plan.edits, []]) {
    assert.deepEqual(autoStartDecision({ editSessionId: 'new-session', sessionStatus: 'active',
      sourceAutoEdit: { status: 'completed', edit_plan: { edits } },
    }), { run: false, reason: 'source_already_auto_edited' });
  }
  assert.equal(autoStartDecision({ editSessionId: 'new-session',
    sourceAutoEdit: { status: 'completed' },
  }).run, true, 'a legacy render success without an AI plan does not count');
});

// Execute the REAL component callback, not a test-local copy of the pipeline.
// Only UI setters and network collaborators are supplied by the harness.
const source = readFileSync(new URL('../components/ManualTrimEditor.jsx', import.meta.url), 'utf8');
const start = source.indexOf('const handleRerender = useCallback(') + 'const handleRerender = useCallback('.length;
const end = source.indexOf('\n  }, [session, edl', start);
assert.ok(start > 0 && end > start, 'locate the existing render callback');
const callback = source.slice(start, end) + '\n  }';

async function runFlow({ analysisStatus = 200, draftStatus = 200, captions = [], generatedCopy = {} } = {}) {
  const calls = [], previews = [], drafts = [], registrations = [];
  const context = {
    session: { edit_session_id: 'session', job_id: 'source', clip_index: 0, draft: {} }, edl: {},
    needsRealignment: false, trimInvalid: false, trimStart: 0, trimEnd: 26, framing: 'auto',
    captionText: '', originalCaptionText: '', captionPosition: 'bottom', captionStyle: 'classic',
    captionUppercase: false, captionFontName: 'Verdana', captionFontSize: 24,
    captionFontColor: '#FFFFFF', captionHighlightColor: '#FFDD00', captionBorderColor: '#000000',
    captionBorderWidth: 2, captionBgColor: '#000000', captionBgOpacity: 0,
    captionEffect: 'none', captionBaseOpacity: 1, realigned: null,
    hook: '', hookRich: { spans: [], base: {} }, hookPosition: 'top', hookSize: 'M',
    hookStyle: 'classic', hookDuration: 5, hookEntrance: 'spring',
    titleOverlayEnabled: false, titleOverlayText: '', headerRich: { spans: [], base: {} },
    title: '', socialCaption: '', instruction: '', sourceDurationSec: 26,
    autoStart: { status: 'running' }, timelineEventsRef: { current: [] },
    _resolvedSession: { draft: { trim_start: 0, trim_end: 26 } },
    localStorage: { getItem: () => '' }, readAutoStartGuard: () => ({ session: { status: 'running' } }),
    outputBasename: (url) => url.split('/').pop(), getApiUrl: (url) => url,
    serializeRich: (x) => x, normalizeRich: (x) => x, isEmptyBase: () => true, buildSummary: () => 'summary',
    buildTimelineDocument: (x) => x, getEditorSessionToken: () => 'test-session',
    EDITOR_COMPLETE_URL: '/discord/editor/complete', clearStoredEditorSession: () => {},
    requestExistingAutoEdit,
    setClipUrl: (url) => previews.push(url),
    apiFetch: async (path, options) => {
      calls.push(path);
      const body = JSON.parse(options.body);
      if (path === '/discord/editor/draft') { drafts.push(body.draft); return response({ ok: true }, draftStatus); }
      if (path === '/api/clip/rerender') {
        assert.equal(body.ensure_transcript, true);
        return response({ new_video_url: '/videos/loom-session/recut.mp4', captions, transcription_complete: true });
      }
      if (path === '/api/edit') return response({ success: true, new_video_url: generatedUrl, edit_plan: plan, generated_copy: generatedCopy }, analysisStatus);
      if (path === '/api/hook') return response({ new_video_url: '/videos/loom-session/hooked_1_edited_recut.mp4' });
      throw new Error(`unexpected request ${path}`);
    },
    fetch: async (path, options) => {
      calls.push(path); registrations.push(JSON.parse(options.body)); return response({ ok: true, asset_version: 'render-1.2' });
    },
  };
  for (const name of ['setError', 'setRerendering', 'setResult', 'setReauthNeeded', 'setProgress', 'setAutoEdit', 'setDownloadUrl', 'setWords', 'setCaptionText', 'setOriginalCaptionText', 'setClipDurationSec', 'setTitle', 'setHook']) context[name] = () => {};
  const ok = await vm.runInNewContext(`(${callback})`, context)();
  return { ok, calls, previews, drafts, registrations };
}

test('real editor flow analyzes, persists the plan, previews that output, then registers THAT file', async () => {
  const r = await runFlow();
  assert.equal(r.ok, true);
  assert.deepEqual(r.calls, ['/discord/editor/draft', '/api/clip/rerender', '/api/edit', '/discord/editor/draft', '/discord/editor/complete']);
  assert.deepEqual(r.previews, [generatedUrl], 'use the backend workspace, never the logical source job id');
  assert.deepEqual(r.drafts[1].auto_edit.edit_plan, plan);
  for (const [key, value] of Object.entries(r.drafts[0])) {
    assert.deepEqual(r.drafts[1][key], value, `generated-state save preserves current ${key}`);
  }
  assert.equal(r.registrations[0].ready_file, 'edited_recut.mp4');
  assert.equal(r.registrations[0].llm_assist_used, true);
  assert.deepEqual(r.registrations[0].edl_metadata.auto_edit.edit_plan, plan);
});

test('failed Gemini analysis cannot preview or register the original as an Auto Edit success', async () => {
  const r = await runFlow({ analysisStatus: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.registrations.length, 0);
  assert.equal(r.previews.length, 0);
});

test('generated transcript is carried into the editor draft and registered resolved state', async () => {
  const captions = [{ text: 'hello', startMs: 1000, endMs: 2000 }];
  const r = await runFlow({ captions });
  assert.equal(r.ok, true);
  assert.equal(r.drafts[1].caption_text, 'hello');
  assert.deepEqual(r.registrations[0].edl_metadata.auto_edit.captions, captions);
  assert.deepEqual(r.registrations[0].caption_changes.blocks, captions);
});

test('generated hook is burned and generated title and hook reach the registered version', async () => {
  const r = await runFlow({ generatedCopy: { title: 'Cold plunge performance', hook: 'The show must go on' } });
  assert.equal(r.ok, true);
  assert.equal(r.drafts[1].title, 'Cold plunge performance');
  assert.equal(r.drafts[1].hook, 'The show must go on');
  assert.equal(r.registrations[0].proposed_title, 'Cold plunge performance');
  assert.equal(r.registrations[0].ready_file, 'hooked_1_edited_recut.mp4');
  assert.equal(r.registrations[0].edl_metadata.hook_applied, true);
  assert.deepEqual(r.previews, ['/videos/loom-session/hooked_1_edited_recut.mp4']);
});

test('failed durable guard save stops before rendering or paid analysis', async () => {
  const r = await runFlow({ draftStatus: 500 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.calls, ['/discord/editor/draft']);
});
