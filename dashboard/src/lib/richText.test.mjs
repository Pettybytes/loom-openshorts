/**
 * Range-based rich text — the structured model shared by the on-video Header
 * and the Hook.
 *
 * Covers: arbitrary/single-character/single-word range creation, overlap and
 * adjacent-range normalization, colour/font/size range persistence, backward
 * compatibility with plain strings, and the unified size semantics (a range
 * size is a MULTIPLIER of the element's base size, with the legacy S/M/L tokens
 * still accepted).
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  normalizeSpans,
  buildRuns,
  applyRangeStyle,
  normalizeRich,
  normalizeBase,
  normalizeSize,
  resolveRunStyle,
  serializeRich,
  hasRangeStyling,
  isRich,
  richEquals,
  SIZE_SCALE,
  RICH_FONTS,
} from './richText.js';

const ACCEPTANCE_HOOK = 'LOOK MA.. NO HANDS!';
//                      L0 O1 O2 K3 _4 M5 A6 .7 .8 _9 N10 O11 _12 H13 A14 N15 D16 S17 !18
const LOOK = [0, 4];
const MA = [5, 9];
const NO = [10, 12];
const HANDS = [13, 19];

const HEADER_TEXT = 'PREVIEW';
//                    P0 R1 E2 V3 I4 E5 W6

function rich(text, spans, base) {
  return { text, base: base || { color: null, font: null }, spans: spans || [] };
}

function styleAt(value, index) {
  const runs = buildRuns(value.text, normalizeRich(value).spans);
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
  const out = applyRangeStyle(rich(HEADER_TEXT), 4, 5, { color: '#FFD600' });
  assert.deepEqual(out.spans, [{ start: 4, end: 5, color: '#FFD600' }]);
  assert.deepEqual(styleAt(out, 4), { color: '#FFD600' });
  assert.deepEqual(styleAt(out, 3), {});
  assert.deepEqual(styleAt(out, 5), {});
});

test('a single-word range matches the word exactly', () => {
  const out = applyRangeStyle(rich(ACCEPTANCE_HOOK), HANDS[0], HANDS[1], { size: 1.3 });
  assert.deepEqual(out.spans, [{ start: 13, end: 19, size: 1.3 }]);
});

test('the acceptance hook can carry four independently styled ranges at once', () => {
  let value = rich(ACCEPTANCE_HOOK);
  value = applyRangeStyle(value, LOOK[0], LOOK[1], { color: '#FFD600' });
  value = applyRangeStyle(value, MA[0], MA[1], { color: '#FF0000', size: 1.3 });
  value = applyRangeStyle(value, NO[0], NO[1], { color: '#FFFFFF' });
  value = applyRangeStyle(value, HANDS[0], HANDS[1], { color: '#00E5FF', font: 'Impact', size: 0.8 });

  assert.equal(value.spans.length, 4);
  assert.deepEqual(styleAt(value, 0), { color: '#FFD600' });
  assert.deepEqual(styleAt(value, 6), { color: '#FF0000', size: 1.3 });
  assert.deepEqual(styleAt(value, 10), { color: '#FFFFFF' });
  assert.deepEqual(styleAt(value, 15), { color: '#00E5FF', font: 'Impact', size: 0.8 });
  // Untouched characters (the separators) stay unstyled.
  assert.deepEqual(styleAt(value, 4), {});
  assert.deepEqual(styleAt(value, 9), {});
});

test('a header can carry independent per-letter colours, fonts and sizes', () => {
  // The shape the Header acceptance calls for: one letter large, another small.
  let value = rich(HEADER_TEXT);
  value = applyRangeStyle(value, 0, 3, { color: '#FFD600' });                  // PRE
  value = applyRangeStyle(value, 4, 5, { color: '#FF0000', size: 55 / 40 });  // V
  value = applyRangeStyle(value, 5, 7, { color: '#00E5FF', size: 36 / 40 });  // EW

  assert.deepEqual(styleAt(value, 1), { color: '#FFD600' });
  assert.equal(styleAt(value, 4).size, 1.375);
  assert.equal(styleAt(value, 6).size, 0.9);
  assert.deepEqual(styleAt(value, 3), {}, 'the untouched letter keeps the base style');
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
    { start: 5, end: 12, size: 1.3 },
  ]);
  assert.deepEqual(spans, [
    { start: 0, end: 5, color: '#FF0000' },
    { start: 5, end: 9, color: '#FF0000', size: 1.3 },
    { start: 9, end: 12, size: 1.3 },
  ]);
});

test('normalization is idempotent', () => {
  const once = normalizeSpans(ACCEPTANCE_HOOK, [
    { start: 0, end: 9, color: '#FF0000' },
    { start: 5, end: 12, size: 1.3 },
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

// --- size semantics --------------------------------------------------------

test('the legacy S/M/L tokens still normalize to their multipliers', () => {
  assert.equal(normalizeSize('S'), 0.8);
  assert.equal(normalizeSize('M'), 1.0);
  assert.equal(normalizeSize('L'), 1.3);
  assert.equal(normalizeSize('l'), 1.3);
});

test('numeric sizes pass through and absurd ones are rejected or clamped', () => {
  assert.equal(normalizeSize(1.375), 1.375);
  assert.equal(normalizeSize(2), 2);
  assert.equal(normalizeSize(0), null);
  assert.equal(normalizeSize(-3), null);
  assert.equal(normalizeSize('wide'), null);
  assert.equal(normalizeSize(null), null);
  assert.equal(normalizeSize(1000), 10);
});

test('a range style saved as a token still renders after the multiplier change', () => {
  // Backward compatibility with spans persisted by the earlier hook release.
  const out = normalizeSpans('LOOK', [{ start: 0, end: 4, size: 'L' }]);
  assert.deepEqual(out, [{ start: 0, end: 4, size: 1.3 }]);
});

// --- per-property range persistence ---------------------------------------

test('colour ranges persist in the serialized record', () => {
  const value = applyRangeStyle(rich('LOOK MA'), 0, 4, { color: '#FFD600' });
  const saved = serializeRich(value);
  assert.deepEqual(normalizeRich(saved).spans, [{ start: 0, end: 4, color: '#FFD600' }]);
});

test('font ranges persist in the serialized record', () => {
  const value = applyRangeStyle(rich('LOOK MA'), 5, 7, { font: 'Impact' });
  const saved = serializeRich(value);
  assert.deepEqual(normalizeRich(saved).spans, [{ start: 5, end: 7, font: 'Impact' }]);
});

test('size ranges persist in the serialized record', () => {
  const value = applyRangeStyle(rich('LOOK MA'), 5, 7, { size: 1.3 });
  const saved = serializeRich(value);
  assert.deepEqual(normalizeRich(saved).spans, [{ start: 5, end: 7, size: 1.3 }]);
});

test('applying a patch to one range leaves another range untouched', () => {
  let value = applyRangeStyle(rich(ACCEPTANCE_HOOK), LOOK[0], LOOK[1], { color: '#FFD600', font: 'Georgia' });
  value = applyRangeStyle(value, MA[0], MA[1], { color: '#FF0000' });
  assert.deepEqual(styleAt(value, 1), { color: '#FFD600', font: 'Georgia' });
  assert.deepEqual(styleAt(value, 6), { color: '#FF0000' });
});

test('a null patch value clears only that property for the range', () => {
  let value = applyRangeStyle(rich('LOOK'), 0, 4, { color: '#FF0000', size: 1.3 });
  value = applyRangeStyle(value, 0, 4, { color: null });
  assert.deepEqual(value.spans, [{ start: 0, end: 4, size: 1.3 }]);
});

test('applyRangeStyle returns a new object and never mutates its input', () => {
  const before = rich('LOOK', [{ start: 0, end: 1, color: '#FF0000' }]);
  const snapshot = JSON.stringify(before);
  applyRangeStyle(before, 2, 4, { size: 1.3 });
  assert.equal(JSON.stringify(before), snapshot);
});

// --- base style ------------------------------------------------------------

test('base style applies to unstyled characters and is overridden per range', () => {
  const value = rich('LOOK MA', [{ start: 5, end: 7, color: '#FF0000' }], { color: '#FFFFFF', font: 'Verdana' });
  assert.deepEqual(resolveRunStyle(styleAt(value, 0), value.base), { color: '#FFFFFF', font: 'Verdana' });
  assert.deepEqual(resolveRunStyle(styleAt(value, 6), value.base), { color: '#FF0000', font: 'Verdana' });
});

test('base carries only colour and font — size stays the element\'s own field', () => {
  assert.deepEqual(normalizeBase({ color: '#fff', font: 'Arial', size: 1.3, junk: 1 }), {
    color: '#fff', font: 'Arial',
  });
});

test('a run multiplier is resolved on top of the base, never merged into it', () => {
  const resolved = resolveRunStyle({ size: 1.3 }, { color: '#FFF' });
  assert.deepEqual(resolved, { color: '#FFF', size: 1.3 });
});

// --- backward compatibility ------------------------------------------------

test('a plain string is valid and renders normally', () => {
  const value = normalizeRich('LOOK MA.. NO HANDS!');
  assert.equal(value.text, 'LOOK MA.. NO HANDS!');
  assert.deepEqual(value.spans, []);
  assert.equal(hasRangeStyling(value), false);
  assert.equal(isRich('LOOK MA.. NO HANDS!'), false);
});

test('a plain string serializes back to a plain string (no gratuitous schema churn)', () => {
  assert.equal(serializeRich('LOOK MA.. NO HANDS!'), 'LOOK MA.. NO HANDS!');
  assert.equal(serializeRich(rich('LOOK MA.. NO HANDS!')), 'LOOK MA.. NO HANDS!');
});

test('a value with only a base style still serializes as a rich record', () => {
  const saved = serializeRich(rich('LOOK', [], { color: '#FFD600' }));
  assert.equal(typeof saved, 'object');
  assert.equal(saved.spans.length, 0);
  assert.equal(saved.base.color, '#FFD600');
});

test('null/undefined/garbage values degrade to an empty plain value', () => {
  for (const value of [null, undefined, 42, [], { text: null }]) {
    const richValue = normalizeRich(value);
    assert.equal(richValue.text, '');
    assert.deepEqual(richValue.spans, []);
  }
});

test('runs re-derive from a saved record exactly as they were before saving', () => {
  let value = rich(ACCEPTANCE_HOOK);
  value = applyRangeStyle(value, LOOK[0], LOOK[1], { color: '#FFD600' });
  value = applyRangeStyle(value, MA[0], MA[1], { color: '#FF0000', size: 1.3 });
  value = applyRangeStyle(value, HANDS[0], HANDS[1], { font: 'Impact' });

  const before = buildRuns(value.text, value.spans);
  const reloaded = normalizeRich(JSON.parse(JSON.stringify(serializeRich(value))));
  const after = buildRuns(reloaded.text, reloaded.spans);

  assert.deepEqual(after, before);
  assert.equal(richEquals(value, reloaded), true);
});

test('runs cover the whole text contiguously with no gaps or overlaps', () => {
  const value = applyRangeStyle(rich(ACCEPTANCE_HOOK), MA[0], MA[1], { color: '#FF0000' });
  const runs = buildRuns(value.text, value.spans);
  assert.equal(runs[0].start, 0);
  assert.equal(runs[runs.length - 1].end, ACCEPTANCE_HOOK.length);
  for (let i = 1; i < runs.length; i += 1) assert.equal(runs[i].start, runs[i - 1].end);
  assert.equal(runs.map((r) => r.text).join(''), ACCEPTANCE_HOOK);
});

test('the same model serves both elements — nothing hook-specific leaks', () => {
  // One implementation, two elements: a header range and a hook range go
  // through byte-identical normalization.
  const header = applyRangeStyle(rich('PREVIEW'), 0, 3, { color: '#FFD600' });
  const hook = applyRangeStyle(rich('PREVIEW'), 0, 3, { color: '#FFD600' });
  assert.equal(richEquals(header, hook), true);
});

// --- vocabularies ----------------------------------------------------------

test('the S/M/L vocabulary and the font list are stable (shared with hooks.py)', () => {
  assert.deepEqual(SIZE_SCALE, { S: 0.8, M: 1.0, L: 1.3 });
  assert.ok(RICH_FONTS.includes('Noto Serif'));
  assert.ok(RICH_FONTS.includes('Impact'));
});
