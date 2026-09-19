/**
 * Range-based Hook rich text — the structured model.
 *
 * Covers: arbitrary/single-character/single-word range creation, overlap and
 * adjacent-range normalization, colour/font/size range persistence, backward
 * compatibility with plain hook strings, and the final-render configuration
 * carrying the same range semantics.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  normalizeSpans,
  buildRuns,
  applyRangeStyle,
  normalizeRichHook,
  normalizeBase,
  resolveRunStyle,
  serializeHook,
  hasRangeStyling,
  isRichHook,
  richHooksEqual,
  SIZE_SCALE,
} from './hookRichText.js';

const ACCEPTANCE_HOOK = 'LOOK MA.. NO HANDS!';
//                      L0 O1 O2 K3 _4 M5 A6 .7 .8 _9 N10 O11 _12 H13 A14 N15 D16 S17 !18
const LOOK = [0, 4];
const MA = [5, 9];
const NO = [10, 12];
const HANDS = [13, 19];

function rich(text, spans, base) {
  return { text, base: base || { color: null, font: null, size: null }, spans: spans || [] };
}

function styleAt(richHook, index) {
  const runs = buildRuns(richHook.text, normalizeRichHook(richHook).spans);
  const run = runs.find((r) => index >= r.start && index < r.end);
  return run ? run.style : null;
}

// --- range creation --------------------------------------------------------

test('an arbitrary range can be styled independently of the rest', () => {
  const out = applyRangeStyle(rich(ACCEPTANCE_HOOK), MA[0], MA[1], { color: '#FF0000' });
  assert.deepEqual(out.spans, [{ start: 5, end: 9, color: '#FF0000' }]);
  assert.deepEqual(styleAt(out, 0), {}, 'characters outside the range stay unstyled');
  assert.deepEqual(styleAt(out, 6), { color: '#FF0000' });
});

test('a single-character range is a first-class range', () => {
  const out = applyRangeStyle(rich('LOOK'), 1, 2, { color: '#FFD600' });
  assert.deepEqual(out.spans, [{ start: 1, end: 2, color: '#FFD600' }]);
  assert.deepEqual(styleAt(out, 1), { color: '#FFD600' });
  assert.deepEqual(styleAt(out, 0), {});
  assert.deepEqual(styleAt(out, 2), {});
});

test('a single-word range matches the word exactly', () => {
  const out = applyRangeStyle(rich(ACCEPTANCE_HOOK), HANDS[0], HANDS[1], { size: 'L' });
  assert.deepEqual(out.spans, [{ start: 13, end: 19, size: 'L' }]);
});

test('the acceptance hook can carry four independently styled ranges at once', () => {
  let hook = rich(ACCEPTANCE_HOOK);
  hook = applyRangeStyle(hook, LOOK[0], LOOK[1], { color: '#FFD600' });
  hook = applyRangeStyle(hook, MA[0], MA[1], { color: '#FF0000', size: 'L' });
  hook = applyRangeStyle(hook, NO[0], NO[1], { color: '#FFFFFF' });
  hook = applyRangeStyle(hook, HANDS[0], HANDS[1], { color: '#00E5FF', font: 'Impact', size: 'S' });

  assert.equal(hook.spans.length, 4);
  assert.deepEqual(styleAt(hook, 0), { color: '#FFD600' });
  assert.deepEqual(styleAt(hook, 6), { color: '#FF0000', size: 'L' });
  assert.deepEqual(styleAt(hook, 10), { color: '#FFFFFF' });
  assert.deepEqual(styleAt(hook, 15), { color: '#00E5FF', font: 'Impact', size: 'S' });
  // Untouched characters (the separators) stay unstyled.
  assert.deepEqual(styleAt(hook, 4), {});
  assert.deepEqual(styleAt(hook, 9), {});
});

// --- normalization ---------------------------------------------------------

test('adjacent ranges with the same style coalesce into one span', () => {
  const spans = normalizeSpans(ACCEPTANCE_HOOK, [
    { start: 0, end: 2, color: '#FF0000' },
    { start: 2, end: 4, color: '#FF0000' },
  ]);
  assert.deepEqual(spans, [{ start: 0, end: 4, color: '#FF0000' }]);
});

test('adjacent ranges with different styles stay separate and ordered', () => {
  const spans = normalizeSpans(ACCEPTANCE_HOOK, [
    { start: 0, end: 4, color: '#FF0000' },
    { start: 4, end: 9, color: '#00FF00' },
  ]);
  assert.deepEqual(spans, [
    { start: 0, end: 4, color: '#FF0000' },
    { start: 4, end: 9, color: '#00FF00' },
  ]);
});

test('overlapping ranges resolve by paint order (later span wins) and split cleanly', () => {
  const spans = normalizeSpans(ACCEPTANCE_HOOK, [
    { start: 0, end: 9, color: '#FF0000' },
    { start: 5, end: 12, color: '#00FF00' },
  ]);
  assert.deepEqual(spans, [
    { start: 0, end: 5, color: '#FF0000' },
    { start: 5, end: 12, color: '#00FF00' },
  ]);
});

test('overlapping ranges merge per-property instead of discarding one another', () => {
  const spans = normalizeSpans(ACCEPTANCE_HOOK, [
    { start: 0, end: 9, color: '#FF0000' },
    { start: 5, end: 12, size: 'L' },
  ]);
  assert.deepEqual(spans, [
    { start: 0, end: 5, color: '#FF0000' },
    { start: 5, end: 9, color: '#FF0000', size: 'L' },
    { start: 9, end: 12, size: 'L' },
  ]);
});

test('normalization is idempotent', () => {
  const once = normalizeSpans(ACCEPTANCE_HOOK, [
    { start: 0, end: 9, color: '#FF0000' },
    { start: 5, end: 12, size: 'L' },
    { start: 100, end: 200, color: '#000000' },
  ]);
  assert.deepEqual(normalizeSpans(ACCEPTANCE_HOOK, once), once);
});

test('out-of-bounds, empty and style-less spans are dropped, never clamped into garbage', () => {
  const spans = normalizeSpans('LOOK', [
    { start: -5, end: 2, color: '#FF0000' },   // clamped to 0..2
    { start: 3, end: 1, color: '#FF0000' },    // inverted -> dropped
    { start: 0, end: 4 },                      // no style -> dropped
    { start: 2, end: 99, color: '#00FF00' },   // clamped to 2..4
    null,
    'nonsense',
  ]);
  assert.deepEqual(spans, [
    { start: 0, end: 2, color: '#FF0000' },
    { start: 2, end: 4, color: '#00FF00' },
  ]);
});

// --- per-property range persistence ---------------------------------------

test('colour ranges persist in the serialized record', () => {
  const hook = applyRangeStyle(rich('LOOK MA'), 0, 4, { color: '#FFD600' });
  const saved = serializeHook(hook);
  assert.deepEqual(normalizeRichHook(saved).spans, [{ start: 0, end: 4, color: '#FFD600' }]);
});

test('font ranges persist in the serialized record', () => {
  const hook = applyRangeStyle(rich('LOOK MA'), 5, 7, { font: 'Impact' });
  const saved = serializeHook(hook);
  assert.deepEqual(normalizeRichHook(saved).spans, [{ start: 5, end: 7, font: 'Impact' }]);
});

test('size ranges persist in the serialized record', () => {
  const hook = applyRangeStyle(rich('LOOK MA'), 5, 7, { size: 'L' });
  const saved = serializeHook(hook);
  assert.deepEqual(normalizeRichHook(saved).spans, [{ start: 5, end: 7, size: 'L' }]);
});

test('applying a patch to one range leaves another range untouched', () => {
  let hook = applyRangeStyle(rich(ACCEPTANCE_HOOK), LOOK[0], LOOK[1], { color: '#FFD600', font: 'Georgia' });
  hook = applyRangeStyle(hook, MA[0], MA[1], { color: '#FF0000' });
  assert.deepEqual(styleAt(hook, 1), { color: '#FFD600', font: 'Georgia' });
  assert.deepEqual(styleAt(hook, 6), { color: '#FF0000' });
});

test('a null patch value clears only that property for the range', () => {
  let hook = applyRangeStyle(rich('LOOK'), 0, 4, { color: '#FF0000', size: 'L' });
  hook = applyRangeStyle(hook, 0, 4, { color: null });
  assert.deepEqual(hook.spans, [{ start: 0, end: 4, size: 'L' }]);
});

test('applyRangeStyle returns a new object and never mutates its input', () => {
  const before = rich('LOOK', [{ start: 0, end: 1, color: '#FF0000' }]);
  const snapshot = JSON.stringify(before);
  applyRangeStyle(before, 2, 4, { size: 'L' });
  assert.equal(JSON.stringify(before), snapshot);
});

// --- base style ------------------------------------------------------------

test('base style applies to unstyled characters and is overridden per range', () => {
  const hook = rich('LOOK MA', [{ start: 5, end: 7, color: '#FF0000' }], { color: '#FFFFFF', size: 'L' });
  assert.deepEqual(resolveRunStyle(styleAt(hook, 0), hook.base), { color: '#FFFFFF', size: 'L' });
  assert.deepEqual(resolveRunStyle(styleAt(hook, 6), hook.base), { color: '#FF0000', size: 'L' });
});

test('normalizeBase keeps only the three style properties', () => {
  assert.deepEqual(normalizeBase({ color: '#fff', font: '', size: 'L', junk: 1 }), {
    color: '#fff', font: null, size: 'L',
  });
});

// --- backward compatibility ------------------------------------------------

test('a plain hook string is valid and renders normally', () => {
  const hook = normalizeRichHook('LOOK MA.. NO HANDS!');
  assert.equal(hook.text, 'LOOK MA.. NO HANDS!');
  assert.deepEqual(hook.spans, []);
  assert.equal(hasRangeStyling(hook), false);
  assert.equal(isRichHook('LOOK MA.. NO HANDS!'), false);
});

test('a plain hook serializes back to a plain string (no gratuitous schema churn)', () => {
  assert.equal(serializeHook('LOOK MA.. NO HANDS!'), 'LOOK MA.. NO HANDS!');
  assert.equal(serializeHook(rich('LOOK MA.. NO HANDS!')), 'LOOK MA.. NO HANDS!');
});

test('a plain hook with only a base style still serializes as a rich record', () => {
  const saved = serializeHook(rich('LOOK', [], { color: '#FFD600' }));
  assert.equal(typeof saved, 'object');
  assert.equal(saved.spans.length, 0);
  assert.equal(saved.base.color, '#FFD600');
});

test('null/undefined/garbage hooks degrade to an empty plain hook', () => {
  for (const value of [null, undefined, 42, [], { text: null }]) {
    const hook = normalizeRichHook(value);
    assert.equal(hook.text, '');
    assert.deepEqual(hook.spans, []);
  }
});

test('runs re-derive from a saved record exactly as they were before saving', () => {
  let hook = rich(ACCEPTANCE_HOOK);
  hook = applyRangeStyle(hook, LOOK[0], LOOK[1], { color: '#FFD600' });
  hook = applyRangeStyle(hook, MA[0], MA[1], { color: '#FF0000', size: 'L' });
  hook = applyRangeStyle(hook, HANDS[0], HANDS[1], { font: 'Impact' });

  const before = buildRuns(hook.text, hook.spans);
  const reloaded = normalizeRichHook(JSON.parse(JSON.stringify(serializeHook(hook))));
  const after = buildRuns(reloaded.text, reloaded.spans);

  assert.deepEqual(after, before);
  assert.equal(richHooksEqual(hook, reloaded), true);
});

test('runs cover the whole text contiguously with no gaps or overlaps', () => {
  const hook = applyRangeStyle(rich(ACCEPTANCE_HOOK), MA[0], MA[1], { color: '#FF0000' });
  const runs = buildRuns(hook.text, hook.spans);
  assert.equal(runs[0].start, 0);
  assert.equal(runs[runs.length - 1].end, ACCEPTANCE_HOOK.length);
  for (let i = 1; i < runs.length; i += 1) assert.equal(runs[i].start, runs[i - 1].end);
  assert.equal(runs.map((r) => r.text).join(''), ACCEPTANCE_HOOK);
});

// --- S/M/L vocabulary ------------------------------------------------------

test('the S/M/L size vocabulary is stable (shared with the server burn)', () => {
  assert.deepEqual(SIZE_SCALE, { S: 0.8, M: 1.0, L: 1.3 });
});
