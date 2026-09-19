/**
 * Preview-state contract: the draft → preview conversion that the PRIMARY
 * editor preview, the Hook modal and the Header modal all render from.
 *
 * Covers: presence/propagation for both visual elements, header AND hook range
 * styling, save→reload survival for both, no leakage between the two elements,
 * the render payloads, Header behaviour remaining backward compatible, and the
 * two metadata concepts staying non-visual.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  buildPreviewState,
  hookVisibleAt,
  hookRenderPayload,
  headerRenderPayload,
  richDraftFields,
  resolveHeaderRich,
  resolveHookRich,
  hasVisualOverlays,
} from './editorPreviewState.js';
import { applyRangeStyle as applyRangeStyleToRich } from './richText.js';

/** Test-local convenience: style a range of a plain string OR an existing value. */
function applyRangeStyle(target, start, end, patch) {
  const value = typeof target === 'string'
    ? { text: target, base: { color: null, font: null }, spans: [] }
    : target;
  return applyRangeStyleToRich(value, start, end, patch);
}

const HOOK_TEXT = 'LOOK MA.. NO HANDS!';
const HEADER_TEXT = 'HEADER PREVIEW';

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
    text: HEADER_TEXT,
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

/** A header with four independently styled ranges, incl. two sizes. */
function styledHeaderDraft() {
  //              H0 E1 A2 D3 E4 R5 _6 P7 R8 E9 V10 I11 E12 W13
  let rich = applyRangeStyle(HEADER_TEXT, 0, 6, { color: '#FFD600' });   // HEADER
  rich = applyRangeStyle(rich, 7, 8, { color: '#FF0000', size: 55 / 40 });  // P (larger)
  rich = applyRangeStyle(rich, 8, 11, { color: '#00E5FF', size: 36 / 40 }); // REV (smaller)
  rich = applyRangeStyle(rich, 11, 14, { font: 'Impact' });              // IEW
  return draft({ header_rich: rich });
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

test('the header is present in the primary preview state alongside the hook', () => {
  const state = buildPreviewState(styledHeaderDraft());
  assert.equal(state.header.enabled, true);
  assert.equal(state.header.text, HEADER_TEXT);
  assert.equal(state.hook.present, true);
  assert.equal(hasVisualOverlays(state), true);
});

// --- 2-6. live propagation -------------------------------------------------

test('changing the hook text propagates to the preview state', () => {
  const before = buildPreviewState(draft());
  const after = buildPreviewState(draft({ hook: 'booootayyyy' }));
  assert.equal(before.hook.text, 'OLD HOOK');
  assert.equal(after.hook.text, 'booootayyyy');
  assert.notDeepEqual(after.hook.runs, before.hook.runs);
});

test('changing the hook style/position/size/duration propagates', () => {
  assert.equal(buildPreviewState(draft({ hook_style: 'red' })).hook.style, 'red');
  assert.equal(buildPreviewState(draft({ hook_position: 'bottom' })).hook.position, 'bottom');
  assert.equal(buildPreviewState(draft({ hook_size: 'L' })).hook.size, 'L');
  assert.equal(buildPreviewState(draft({ hook_duration: 7 })).hook.durationSec, 7);
});

test('changing the header text propagates to the preview state', () => {
  const after = buildPreviewState(draft({
    title_overlay: { ...BASE_DRAFT.title_overlay, text: 'roger gang' },
  }));
  assert.equal(after.header.text, 'roger gang');
  assert.equal(after.header.runs.map((r) => r.text).join(''), 'roger gang');
});

test('changing the header colour/font/props propagates', () => {
  const state = buildPreviewState(draft({
    title_overlay: { ...BASE_DRAFT.title_overlay, text_color: '#00FF00', font_family: 'Impact', font_size: 64, position: 'upper' },
  }));
  assert.equal(state.header.color, '#00FF00');
  assert.equal(state.header.fontFamily, 'Impact');
  assert.equal(state.header.fontSize, 64);
  assert.equal(state.header.position, 'upper');
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

test('hook range styling is exposed as differently styled runs', () => {
  let rich = applyRangeStyle(HOOK_TEXT, 0, 4, { color: '#FFD600' });
  rich = applyRangeStyle(rich, 5, 9, { color: '#FF0000', size: 1.3 });
  rich = applyRangeStyle(rich, 13, 19, { color: '#00E5FF', font: 'Impact' });

  const state = buildPreviewState(draft({ hook: HOOK_TEXT, hook_rich: rich }));
  const runs = state.hook.runs;

  assert.equal(runs.find((r) => r.text === 'LOOK').style.color, '#FFD600');
  const red = runs.find((r) => r.text === 'MA..');
  assert.equal(red.style.color, '#FF0000');
  assert.equal(red.style.size, 1.3);
  assert.ok(!runs.find((r) => r.text.includes('NO')).style.color);
  assert.equal(runs.find((r) => r.text === 'HANDS!').style.font, 'Impact');
});

test('header range styling is exposed as per-run colour, font and size', () => {
  const state = buildPreviewState(styledHeaderDraft());
  const runs = state.header.runs;

  assert.equal(runs.find((r) => r.text === 'HEADER').style.color, '#FFD600');
  const large = runs.find((r) => r.text === 'P');
  assert.equal(large.style.size, 1.375);
  const small = runs.find((r) => r.text === 'REV');
  assert.equal(small.style.size, 0.9);
  assert.equal(runs.find((r) => r.text === 'IEW').style.font, 'Impact');
});

test('a one-letter header range is representable', () => {
  const rich = applyRangeStyle(HEADER_TEXT, 4, 5, { color: '#FF0000' });   // the E in HEADER
  const state = buildPreviewState(draft({ header_rich: rich }));
  const styled = state.header.runs.filter((r) => r.style.color === '#FF0000');
  assert.equal(styled.length, 1);
  assert.equal(styled[0].text, 'E');
  assert.equal(styled[0].start, 4);
  assert.equal(styled[0].end, 5);
});

test('the same rich value produces identical runs in a modal and the primary preview', () => {
  const rich = applyRangeStyle(HOOK_TEXT, 5, 9, { color: '#FF0000', size: 1.3 });
  const primary = buildPreviewState(draft({ hook: HOOK_TEXT, hook_rich: rich }));
  const modal = buildPreviewState(draft({ hook: HOOK_TEXT, hook_rich: rich }));
  assert.deepEqual(modal.hook.runs, primary.hook.runs);
  assert.deepEqual(modal.header.runs, primary.header.runs);
});

// --- no leakage between the two elements -----------------------------------

test('hook ranges do not leak into the header', () => {
  const rich = applyRangeStyle(HOOK_TEXT, 0, 4, { color: '#FF0000' });
  const state = buildPreviewState(draft({ hook: HOOK_TEXT, hook_rich: rich }));
  assert.deepEqual(state.header.spans, []);
  assert.equal(state.header.runs.length, 1);
});

test('header ranges do not leak into the hook', () => {
  const state = buildPreviewState(styledHeaderDraft());
  assert.deepEqual(state.hook.spans, []);
  assert.equal(state.hook.runs.length, 1);
});

// --- save / reload for BOTH elements ---------------------------------------

test('hook rich text survives a save→reload round trip', () => {
  let rich = applyRangeStyle(HOOK_TEXT, 0, 4, { color: '#FFD600' });
  rich = applyRangeStyle(rich, 5, 9, { color: '#FF0000', size: 1.3 });

  const saved = {
    ...richDraftFields('hook', rich),
    hook: HOOK_TEXT,
    hook_position: 'bottom',
    hook_size: 'L',
    hook_style: 'yellow',
    hook_duration: 7,
  };
  const reloaded = buildPreviewState(JSON.parse(JSON.stringify(saved)));

  assert.equal(reloaded.hook.text, HOOK_TEXT);
  assert.equal(reloaded.hook.position, 'bottom');
  assert.equal(reloaded.hook.size, 'L');
  assert.equal(reloaded.hook.style, 'yellow');
  assert.equal(reloaded.hook.durationSec, 7);
  assert.deepEqual(reloaded.hook.spans, [
    { start: 0, end: 4, color: '#FFD600' },
    { start: 5, end: 9, color: '#FF0000', size: 1.3 },
  ]);
});

test('header range styling survives a save→reload round trip', () => {
  const saved = {
    ...richDraftFields('header', resolveHeaderRich(styledHeaderDraft())),
    title_overlay: BASE_DRAFT.title_overlay,
  };
  const reloaded = buildPreviewState(JSON.parse(JSON.stringify(saved)));

  assert.equal(reloaded.header.spans.length, 4);
  assert.equal(reloaded.header.runs.find((r) => r.text === 'P').style.size, 1.375);
  assert.equal(reloaded.header.runs.find((r) => r.text === 'IEW').style.font, 'Impact');
});

test('a header saved before rich text existed still hydrates, unchanged', () => {
  const state = buildPreviewState(draft());   // no header_rich at all
  assert.equal(state.header.enabled, true);
  assert.equal(state.header.text, HEADER_TEXT);
  assert.deepEqual(state.header.spans, []);
  assert.equal(state.header.runs.length, 1);
  assert.deepEqual(state.header.runs[0].style, {});
  // Legacy flat fields still drive the base rendering.
  assert.equal(state.header.color, '#FFD600');
  assert.equal(state.header.fontFamily, 'Verdana');
  assert.equal(state.header.fontSize, 40);
});

test('a legacy draft holding a plain hook string still hydrates', () => {
  const state = buildPreviewState({ hook: HOOK_TEXT, hook_style: 'red' });
  assert.equal(state.hook.present, true);
  assert.equal(state.hook.text, HOOK_TEXT);
  assert.deepEqual(state.hook.spans, []);
  assert.equal(state.hook.runs.length, 1);
});

test('a legacy draft missing every optional field does not throw', () => {
  const state = buildPreviewState({});
  assert.equal(state.hook.present, false);
  assert.equal(state.header.enabled, false);
  assert.equal(state.socialCaption.text, '');
});

test('the flat header text stays authoritative over a stale rich record', () => {
  const rich = applyRangeStyle(HOOK_TEXT, 0, 4, { color: '#FF0000' });
  const state = buildPreviewState(draft({
    title_overlay: { ...BASE_DRAFT.title_overlay, text: 'SHORT' },
    header_rich: { text: HOOK_TEXT, base: { color: null, font: null }, spans: rich.spans },
  }));
  assert.equal(state.header.text, 'SHORT');
  // The run splitter clamps the stale ranges to the real text length.
  assert.equal(state.header.runs.map((r) => r.text).join(''), 'SHORT');
  assert.ok(state.header.runs.every((r) => r.end <= 5));
});

test('an empty draft header_rich does not blank the legacy text', () => {
  const state = buildPreviewState(draft({ header_rich: null }));
  assert.equal(state.header.text, HEADER_TEXT);
  assert.equal(state.header.enabled, true);
});

// --- render payloads (final-render configuration) --------------------------

test('the hook render payload carries the same range styling as the preview', () => {
  const rich = applyRangeStyle(HOOK_TEXT, 5, 9, { color: '#FF0000', size: 1.3 });
  const state = buildPreviewState(draft({
    hook: HOOK_TEXT, hook_rich: rich, hook_position: 'bottom', hook_size: 'L', hook_style: 'yellow', hook_duration: 7,
  }));
  const payload = hookRenderPayload(state);

  assert.equal(payload.text, HOOK_TEXT);
  assert.equal(payload.position, 'bottom');
  assert.equal(payload.size, 'L');
  assert.equal(payload.style, 'yellow');
  assert.equal(payload.duration_seconds, 7);
  assert.deepEqual(payload.spans, [{ start: 5, end: 9, color: '#FF0000', size: 1.3 }]);
});

test('an unstyled hook sends no spans, so the server path is unchanged', () => {
  const payload = hookRenderPayload(buildPreviewState(draft({ hook: HOOK_TEXT })));
  assert.equal(payload.spans, undefined);
});

test('an absent hook asks the renderer to remove it, not to burn empty text', () => {
  assert.deepEqual(hookRenderPayload(buildPreviewState(draft({ hook: '' }))), { remove: true });
});

test('the header render payload carries ranges, but a plain header sends none', () => {
  const styled = headerRenderPayload(buildPreviewState(styledHeaderDraft()));
  assert.equal(styled.text, HEADER_TEXT);
  assert.equal(styled.spans.length, 4);
  assert.equal(styled.position, 'top');

  const plain = headerRenderPayload(buildPreviewState(draft()));
  assert.equal(plain.text, HEADER_TEXT);
  assert.equal(plain.spans, undefined, 'a plain header must not start carrying a schema it never had');
});

test('a disabled header produces no render payload', () => {
  const state = buildPreviewState(draft({ title_overlay: { ...BASE_DRAFT.title_overlay, enabled: false } }));
  assert.equal(headerRenderPayload(state), null);
});

// --- metadata stays non-visual ---------------------------------------------

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
  const state = buildPreviewState(draft({ social_caption: HOOK_TEXT }));
  assert.equal(state.hook.text, 'OLD HOOK');
  assert.equal(state.socialCaption.visual, false);
});

test('the clip title never becomes the header', () => {
  const state = buildPreviewState(draft({ header_rich: null }));
  assert.equal(state.clipTitle.text, 'EDITOR PREVIEW ACCEPTANCE');
  assert.equal(state.header.text, HEADER_TEXT);
});
