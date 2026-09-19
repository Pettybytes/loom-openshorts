/**
 * Selection → span contract: the interaction Bryan performs must be provable
 * without a DOM, and it must survive the thing that actually broke it — the
 * textarea losing focus when a control is clicked.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  normalizeSelection,
  hasRange,
  keepSelection,
  applySelectionPatch,
  clearSelectionStyle,
  styleAtSelection,
} from './rangeSelection.js';
import { normalizeRich, buildRuns } from './richText.js';

const HEADER_TEXT = 'roger gang gang';
//                     r0 o1 g2 e3 r4 _5 g6 a7 n8 g9 _10 g11 a12 n13 g14
const ONE_CHAR = { start: 8, end: 9 };          // the 'n' in the first "gang"
const PARTIAL_WORD = { start: 6, end: 9 };      // "gan"
const ONE_WORD = { start: 11, end: 15 };        // "gang" (the second one)
const MULTI_WORD = { start: 6, end: 15 };       // "gang gang"

const value = (text = HEADER_TEXT) => ({ text, base: { color: null, font: null }, spans: [] });

function styleOfRange(rich, index) {
  const runs = buildRuns(rich.text, normalizeRich(rich).spans);
  const run = runs.find((r) => index >= r.start && index < r.end);
  return run ? run.style : null;
}

// --- selection plumbing ----------------------------------------------------

test('a selection is clamped to the text and ordered', () => {
  assert.deepEqual(normalizeSelection({ start: 0, end: 4 }, 15), { start: 0, end: 4 });
  assert.deepEqual(normalizeSelection({ start: 9, end: 4 }, 15), { start: 4, end: 9 });
  assert.deepEqual(normalizeSelection({ start: 10, end: 999 }, 15), { start: 10, end: 15 });
  assert.deepEqual(normalizeSelection({ start: -5, end: 3 }, 15), { start: 0, end: 3 });
  assert.deepEqual(normalizeSelection(null, 15), { start: 0, end: 0 });
});

test('a caret with no range is not a range', () => {
  assert.equal(hasRange({ start: 8, end: 8 }, 15), false);
  assert.equal(hasRange({ start: 8, end: 9 }, 15), true);
});

test('selectionStart/selectionEnd reach the control unchanged', () => {
  // What the textarea reports on a real drag-select.
  const fromDom = { start: 6, end: 9 };
  assert.deepEqual(keepSelection({ start: 0, end: 0 }, fromDom, HEADER_TEXT.length), fromDom);
});

test('a focus-loss reading of 0/0 does NOT wipe a live range', () => {
  // The regression that produced "no selection — controls set the base style"
  // while the whole header changed colour: the swatch click blurred the
  // textarea and WebKit reported an empty selection.
  const live = { start: 6, end: 9 };
  const afterBlur = keepSelection(live, { start: 0, end: 0 }, HEADER_TEXT.length);
  assert.deepEqual(afterBlur, live, 'the live range must survive the blur');

  const collapsedCaret = keepSelection(live, { start: 9, end: 9 }, HEADER_TEXT.length);
  assert.deepEqual(collapsedCaret, live, 'a collapsed caret must not replace the range either');
});

test('a genuinely new selection replaces the old one', () => {
  assert.deepEqual(keepSelection({ start: 6, end: 9 }, { start: 0, end: 5 }, 15), { start: 0, end: 5 });
});

test('an empty reading is accepted when nothing was selected before', () => {
  assert.deepEqual(keepSelection({ start: 0, end: 0 }, { start: 0, end: 0 }, 15), { start: 0, end: 0 });
});

// --- one character / word / partial / multi-word ---------------------------

test('a one-character selection styles exactly that character', () => {
  const { value: next, scope } = applySelectionPatch(value(), ONE_CHAR, { color: '#FF0000' });
  assert.equal(scope, 'range');
  assert.deepEqual(next.spans, [{ start: 8, end: 9, color: '#FF0000' }]);
  assert.deepEqual(styleOfRange(next, 8), { color: '#FF0000' });
  assert.deepEqual(styleOfRange(next, 7), {}, 'the neighbouring character is untouched');
  assert.deepEqual(styleOfRange(next, 9), {});
});

test('a partial-word selection styles exactly that fragment', () => {
  const { value: next } = applySelectionPatch(value(), PARTIAL_WORD, { color: '#00E5FF' });
  assert.deepEqual(next.spans, [{ start: 6, end: 9, color: '#00E5FF' }]);
});

test('a one-word selection styles that word and nothing else', () => {
  const { value: next } = applySelectionPatch(value(), ONE_WORD, { font: 'Impact' });
  assert.deepEqual(next.spans, [{ start: 11, end: 15, font: 'Impact' }]);
  assert.deepEqual(styleOfRange(next, 12), { font: 'Impact' });
  assert.deepEqual(styleOfRange(next, 8), {}, 'the first "gang" is untouched');
});

test('a multi-word selection styles the whole span', () => {
  const { value: next } = applySelectionPatch(value(), MULTI_WORD, { size: 1.3 });
  assert.deepEqual(next.spans, [{ start: 6, end: 15, size: 1.3 }]);
});

// --- each property ---------------------------------------------------------

test('colour creates the correct span and leaves the rest alone', () => {
  const { value: next } = applySelectionPatch(value(), ONE_WORD, { color: '#FFD600' });
  assert.deepEqual(next.spans, [{ start: 11, end: 15, color: '#FFD600' }]);
  assert.equal(next.base.color, null, 'a range patch must not touch the base style');
});

test('font creates the correct span', () => {
  const { value: next } = applySelectionPatch(value(), ONE_CHAR, { font: 'Georgia' });
  assert.deepEqual(next.spans, [{ start: 8, end: 9, font: 'Georgia' }]);
});

test('size creates the correct span as a multiplier', () => {
  const { value: next } = applySelectionPatch(value(), ONE_WORD, { size: 55 / 40 });
  assert.deepEqual(next.spans, [{ start: 11, end: 15, size: 1.375 }]);
});

test('successive range patches accumulate on their own ranges', () => {
  let current = value();
  current = applySelectionPatch(current, PARTIAL_WORD, { color: '#FFD600' }).value;
  current = applySelectionPatch(current, ONE_WORD, { color: '#FF0000' }).value;
  current = applySelectionPatch(current, ONE_CHAR, { size: 1.3 }).value;
  assert.equal(current.spans.length, 3);
  assert.deepEqual(styleOfRange(current, 7), { color: '#FFD600' });
  assert.deepEqual(styleOfRange(current, 12), { color: '#FF0000' });
  assert.deepEqual(styleOfRange(current, 8), { color: '#FFD600', size: 1.3 });
});

test('unselected ranges remain unchanged by a later patch', () => {
  let current = applySelectionPatch(value(), ONE_WORD, { color: '#FF0000' }).value;
  const snapshot = JSON.stringify(current.spans);
  current = applySelectionPatch(current, PARTIAL_WORD, { font: 'Impact' }).value;
  const untouched = current.spans.find((s) => s.start === 11 && s.end === 15);
  assert.deepEqual(untouched, { start: 11, end: 15, color: '#FF0000' });
  assert.notEqual(JSON.stringify(current.spans), snapshot);
});

// --- no selection ----------------------------------------------------------

test('with no selection a colour patch sets the base style, and says so', () => {
  const { value: next, scope } = applySelectionPatch(value(), { start: 0, end: 0 }, { color: '#00FF00' });
  assert.equal(scope, 'base');
  assert.equal(next.base.color, '#00FF00');
  assert.deepEqual(next.spans, [], 'no span is invented out of an empty selection');
});

test('with no selection a size patch cannot silently restyle everything', () => {
  const { value: next } = applySelectionPatch(value(), { start: 0, end: 0 }, { size: 1.3 });
  assert.deepEqual(next.spans, []);
  assert.deepEqual(next.base, { color: null, font: null });
});

test('clearing with a selection clears only that range', () => {
  let current = applySelectionPatch(value(), ONE_WORD, { color: '#FF0000', size: 1.3 }).value;
  current = applySelectionPatch(current, PARTIAL_WORD, { font: 'Impact' }).value;
  const cleared = clearSelectionStyle(current, ONE_WORD).value;
  assert.equal(cleared.spans.find((s) => s.start === 11), undefined);
  assert.deepEqual(cleared.spans.find((s) => s.start === 6), { start: 6, end: 9, font: 'Impact' });
});

test('the panel readout resolves the range it is showing', () => {
  const current = applySelectionPatch(value(), ONE_WORD, { color: '#FF0000', size: 1.375 }).value;
  assert.deepEqual(styleAtSelection(current, ONE_WORD), { start: 11, end: 15, color: '#FF0000', size: 1.375 });
  assert.equal(styleAtSelection(current, { start: 0, end: 5 }), null);
});

// --- persistence -----------------------------------------------------------

test('ranges survive close/reopen (serialize → hydrate → style still applies)', () => {
  let current = applySelectionPatch(value(), PARTIAL_WORD, { color: '#FFD600' }).value;
  current = applySelectionPatch(current, ONE_CHAR, { size: 1.375 }).value;

  const wire = JSON.parse(JSON.stringify(current));       // draft save / reload
  const reopened = normalizeRich(wire);

  assert.equal(reopened.text, HEADER_TEXT);
  assert.deepEqual(styleOfRange(reopened, 7), { color: '#FFD600' });
  assert.deepEqual(styleOfRange(reopened, 8), { color: '#FFD600', size: 1.375 });

  // ...and a further edit on top still targets the right characters.
  const again = applySelectionPatch(reopened, ONE_WORD, { font: 'Impact' }).value;
  assert.deepEqual(styleOfRange(again, 12), { font: 'Impact' });
  assert.deepEqual(styleOfRange(again, 8), { color: '#FFD600', size: 1.375 });
});
