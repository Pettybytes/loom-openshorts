/**
 * Preview-state contract: the draft → preview conversion that the PRIMARY
 * editor preview and the Hook modal both render from.
 *
 * Covers: hook presence in the primary preview state, text/style/position/size/
 * timing propagation, save→reload preservation, the final-render configuration,
 * Header behaviour remaining unchanged, and Social Caption staying non-visual.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  buildPreviewState,
  hookVisibleAt,
  hookRenderPayload,
  hookDraftFields,
  hasVisualOverlays,
} from './editorPreviewState.js';
import { applyRangeStyle as applyRangeStyleToHook } from './hookRichText.js';

/** Test-local convenience: style a range of a plain string OR an existing hook. */
function applyRangeStyle(target, start, end, patch) {
  const hook = typeof target === 'string'
    ? { text: target, base: { color: null, font: null, size: null }, spans: [] }
    : target;
  return applyRangeStyleToHook(hook, start, end, patch);
}

const ACCEPTANCE_HOOK = 'LOOK MA.. NO HANDS!';

const BASE_DRAFT = {
  trim_start: 0,
  trim_end: 8.868005,
  framing: 'track',
  title: 'EDITOR PREVIEW ACCEPTANCE',
  hook: 'OLD HOOK',
  social_caption: 'editor hydration acceptance #shorts',
  caption_text: 'spoken words here',
  hook_position: 'top',
  hook_size: 'M',
  hook_style: 'classic',
  hook_duration: 5,
  title_overlay: {
    enabled: true,
    text: 'HEADER PREVIEW',
    position: 'top',
    alignment: 'center',
    font_family: 'Verdana',
    font_size: 40,
    text_color: '#FFD600',
    background: 'box',
    background_color: '#000000',
  },
};

function draft(overrides) {
  return { ...BASE_DRAFT, ...(overrides || {}) };
}

// --- 1. presence in the primary preview state ------------------------------

test('a hook with text is present in the primary preview state', () => {
  const state = buildPreviewState(draft());
  assert.equal(state.hook.present, true);
  assert.equal(state.hook.text, 'OLD HOOK');
  assert.equal(hasVisualOverlays(state), true);
});

test('an empty hook is not present and draws nothing', () => {
  const state = buildPreviewState(draft({ hook: '' }));
  assert.equal(state.hook.present, false);
  assert.deepEqual(state.hook.runs, []);
});

test('a whitespace-only hook is not present', () => {
  assert.equal(buildPreviewState(draft({ hook: '   ' })).hook.present, false);
});

test('the preview state carries renderable runs for the hook text', () => {
  const state = buildPreviewState(draft({ hook: ACCEPTANCE_HOOK }));
  assert.equal(state.hook.runs.map((r) => r.text).join(''), ACCEPTANCE_HOOK);
});

// --- 2-6. live propagation -------------------------------------------------

test('changing the hook text propagates to the preview state', () => {
  const before = buildPreviewState(draft());
  const after = buildPreviewState(draft({ hook: 'booootayyyy' }));
  assert.equal(before.hook.text, 'OLD HOOK');
  assert.equal(after.hook.text, 'booootayyyy');
  assert.notDeepEqual(after.hook.runs, before.hook.runs);
});

test('changing the hook style propagates to the preview state', () => {
  const state = buildPreviewState(draft({ hook_style: 'red' }));
  assert.equal(state.hook.style, 'red');
});

test('changing the hook position propagates to the preview state', () => {
  assert.equal(buildPreviewState(draft({ hook_position: 'bottom' })).hook.position, 'bottom');
});

test('changing the hook size propagates to the preview state', () => {
  assert.equal(buildPreviewState(draft({ hook_size: 'L' })).hook.size, 'L');
});

test('changing the hook duration propagates to the preview state', () => {
  assert.equal(buildPreviewState(draft({ hook_duration: 7 })).hook.durationSec, 7);
});

// --- hook timing -----------------------------------------------------------

test('the hook is visible during its duration and hidden afterwards', () => {
  assert.equal(hookVisibleAt(0, 7), true);
  assert.equal(hookVisibleAt(6.9, 7), true);
  assert.equal(hookVisibleAt(7, 7), false);
  assert.equal(hookVisibleAt(30, 7), false);
});

test('the hook reappears when playback seeks back inside its window', () => {
  assert.equal(hookVisibleAt(12, 7), false);
  assert.equal(hookVisibleAt(1, 7), true);
});

test('a hook with no duration is visible for the whole clip', () => {
  assert.equal(hookVisibleAt(999, null), true);
  assert.equal(hookVisibleAt(999, 0), true);
});

test('a missing/unknown current time does not blank the hook', () => {
  assert.equal(hookVisibleAt(NaN, 5), true);
  assert.equal(hookVisibleAt(undefined, 5), true);
});

// --- selective rich text in the preview state ------------------------------

test('range styling is exposed as differently styled runs in the preview state', () => {
  let rich = applyRangeStyle(ACCEPTANCE_HOOK, 0, 4, { color: '#FFD600' });
  rich = applyRangeStyle(rich, 5, 9, { color: '#FF0000', size: 'L' });
  rich = applyRangeStyle(rich, 13, 19, { color: '#00E5FF', font: 'Impact' });

  const state = buildPreviewState(draft({ hook: ACCEPTANCE_HOOK, hook_rich: rich }));
  const runs = state.hook.runs;

  const yellow = runs.find((r) => r.text === 'LOOK');
  const red = runs.find((r) => r.text === 'MA..');
  // The unstyled 'NO' sits in a run with the bare separators around it.
  const white = runs.find((r) => r.text.includes('NO'));

  assert.equal(yellow.style.color, '#FFD600');
  assert.equal(red.style.color, '#FF0000');
  assert.equal(red.style.size, 'L');
  assert.ok(!white.style.color, 'the unstyled range has no colour override');
  assert.equal(runs.find((r) => r.text === 'HANDS!').style.font, 'Impact');
});

test('the same rich hook produces identical runs in the modal and the primary preview', () => {
  const rich = applyRangeStyle(ACCEPTANCE_HOOK, 5, 9, { color: '#FF0000', size: 'L' });
  // One builder, two consumers — the modal passes its live draft, the editor
  // passes its own. Same input must mean same output.
  const primary = buildPreviewState(draft({ hook: ACCEPTANCE_HOOK, hook_rich: rich }));
  const modal = buildPreviewState({ ...draft({ hook: ACCEPTANCE_HOOK, hook_rich: rich }) });
  assert.deepEqual(modal.hook.runs, primary.hook.runs);
  assert.deepEqual(modal.hook, primary.hook);
});

// --- 15. save / reload -----------------------------------------------------

test('hook rich text survives a save→reload round trip through the draft fields', () => {
  let rich = applyRangeStyle(ACCEPTANCE_HOOK, 0, 4, { color: '#FFD600' });
  rich = applyRangeStyle(rich, 5, 9, { color: '#FF0000', size: 'L' });

  const saved = hookDraftFields(rich, { position: 'bottom', size: 'L', style: 'yellow', duration: 7 });
  const wire = JSON.parse(JSON.stringify(saved));      // the server round trip
  const reloaded = buildPreviewState(wire);             // what the editor re-hydrates

  assert.equal(reloaded.hook.text, ACCEPTANCE_HOOK);
  assert.equal(reloaded.hook.position, 'bottom');
  assert.equal(reloaded.hook.size, 'L');
  assert.equal(reloaded.hook.style, 'yellow');
  assert.equal(reloaded.hook.durationSec, 7);
  assert.deepEqual(reloaded.hook.spans, [
    { start: 0, end: 4, color: '#FFD600' },
    { start: 5, end: 9, color: '#FF0000', size: 'L' },
  ]);
  assert.deepEqual(reloaded.hook.runs, buildPreviewState({ hook: ACCEPTANCE_HOOK, hook_rich: rich }).hook.runs);
});

test('a legacy draft holding a plain hook string still hydrates', () => {
  const state = buildPreviewState({ hook: ACCEPTANCE_HOOK, hook_style: 'red' });
  assert.equal(state.hook.present, true);
  assert.equal(state.hook.text, ACCEPTANCE_HOOK);
  assert.deepEqual(state.hook.spans, []);
  assert.equal(state.hook.runs.length, 1);
  assert.deepEqual(state.hook.runs[0].style, {});
});

test('a legacy draft missing every optional field does not throw', () => {
  const state = buildPreviewState({});
  assert.equal(state.hook.present, false);
  assert.equal(state.header.enabled, false);
  assert.equal(state.socialCaption.text, '');
});

// --- 16. final render configuration ---------------------------------------

test('the render payload carries the same range styling as the preview', () => {
  const rich = applyRangeStyle(ACCEPTANCE_HOOK, 5, 9, { color: '#FF0000', size: 'L' });
  const state = buildPreviewState(draft({
    hook: ACCEPTANCE_HOOK, hook_rich: rich, hook_position: 'bottom', hook_size: 'L', hook_style: 'yellow', hook_duration: 7,
  }));
  const payload = hookRenderPayload(state);

  assert.equal(payload.text, ACCEPTANCE_HOOK);
  assert.equal(payload.position, 'bottom');
  assert.equal(payload.size, 'L');
  assert.equal(payload.style, 'yellow');
  assert.equal(payload.duration_seconds, 7);
  assert.deepEqual(payload.spans, [{ start: 5, end: 9, color: '#FF0000', size: 'L' }]);
});

test('an unstyled hook sends no spans, so the server path is unchanged', () => {
  const payload = hookRenderPayload(buildPreviewState(draft({ hook: ACCEPTANCE_HOOK })));
  assert.equal(payload.spans, undefined);
});

test('an absent hook asks the renderer to remove it, not to burn empty text', () => {
  assert.deepEqual(hookRenderPayload(buildPreviewState(draft({ hook: '' }))), { remove: true });
});

// --- 17. header unchanged --------------------------------------------------

test('header preview state is unaffected by hook changes', () => {
  const before = buildPreviewState(draft()).header;
  const after = buildPreviewState(draft({
    hook: ACCEPTANCE_HOOK,
    hook_style: 'outline_yellow',
    hook_position: 'bottom',
    hook_size: 'L',
    hook_rich: applyRangeStyle(ACCEPTANCE_HOOK, 0, 4, { color: '#FF0000' }),
  })).header;
  assert.deepEqual(after, before);
});

test('header text and colour still propagate independently of the hook', () => {
  const state = buildPreviewState(draft({
    title_overlay: { ...BASE_DRAFT.title_overlay, text: 'roger gang', text_color: '#00FF00' },
  }));
  assert.equal(state.header.text, 'roger gang');
  assert.equal(state.header.color, '#00FF00');
  assert.equal(state.header.enabled, true);
});

test('a disabled header is not enabled even when it has text', () => {
  const state = buildPreviewState(draft({ title_overlay: { ...BASE_DRAFT.title_overlay, enabled: false } }));
  assert.equal(state.header.enabled, false);
});

// --- 18. social caption stays non-visual -----------------------------------

test('the social caption is marked non-visual and never part of the overlays', () => {
  const state = buildPreviewState(draft({ social_caption: 'editor hydration acceptance' }));
  assert.equal(state.socialCaption.text, 'editor hydration acceptance');
  assert.equal(state.socialCaption.visual, false);
});

test('clip title is metadata and not visual either', () => {
  const state = buildPreviewState(draft());
  assert.equal(state.clipTitle.visual, false);
  assert.equal(state.clipTitle.text, 'EDITOR PREVIEW ACCEPTANCE');
});

test('a social caption containing overlay-looking text still does not render', () => {
  const state = buildPreviewState(draft({ social_caption: 'LOOK MA.. NO HANDS!' }));
  assert.equal(state.hook.text, 'OLD HOOK');
  assert.equal(state.socialCaption.visual, false);
});
