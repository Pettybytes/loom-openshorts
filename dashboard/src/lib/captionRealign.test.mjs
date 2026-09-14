import { test } from 'node:test';
import assert from 'node:assert';
import { realignCaptions, normalizeWord } from './captionRealign.js';

const orig = [
  { text: 'Hey', startMs: 1000, endMs: 2000 },
  { text: 'the', startMs: 2500, endMs: 3500 },
  { text: 'fuck', startMs: 4000, endMs: 5000 },
  { text: 'is', startMs: 5500, endMs: 6500 },
  { text: 'DDG', startMs: 7000, endMs: 8500 },
];
const trim = { trimStartMs: 0, trimEndMs: 10000 };

function texts(blocks) { return blocks.map(b => b.text); }
function span(blocks, t) { const b = blocks.find(x => x.text === t); return b ? [b.startMs, b.endMs] : null; }

test('single replacement inherits the replaced word timing', () => {
  const r = realignCaptions(orig, 'Yo the fuck is DDG', trim);
  assert.equal(r.alignment, 'redistributed');
  assert.equal(r.changedCount, 1);
  assert.deepEqual(span(r.blocks, 'Yo'), [1000, 2000]); // inherits "Hey"
  assert.deepEqual(texts(r.blocks), ['Yo', 'the', 'fuck', 'is', 'DDG']);
});

test('capitalization/punctuation edit is preserved', () => {
  const r = realignCaptions(orig, 'hey, THE fuck is ddg!!', trim);
  assert.equal(r.alignment, 'preserved');
  assert.equal(r.changedCount, 0);
  assert.deepEqual(r.blocks.map(b => [b.startMs, b.endMs]), orig.map(w => [w.startMs, w.endMs]));
});

test('one inserted word interpolates between anchors', () => {
  const r = realignCaptions(orig, 'Hey the yeah fuck is DDG', trim);
  assert.equal(r.alignment, 'redistributed');
  assert.equal(r.changedCount, 1);
  assert.deepEqual(span(r.blocks, 'yeah'), [3500, 4000]);
});

test('multiple inserted words divide the interval proportionally', () => {
  const r = realignCaptions(orig, 'Hey the yeah yo fuck is DDG', trim);
  assert.equal(r.changedCount, 2);
  assert.deepEqual(span(r.blocks, 'yeah'), [3500, 3750]);
  assert.deepEqual(span(r.blocks, 'yo'), [3750, 4000]);
});

test('deleted word and its timing are removed', () => {
  const r = realignCaptions(orig, 'Hey the fuck DDG', trim);
  assert.equal(r.changedCount, 1);
  assert.deepEqual(texts(r.blocks), ['Hey', 'the', 'fuck', 'DDG']);
  assert.ok(!r.blocks.some(b => b.text === 'is'));
});

test('leading insertion uses clip start to first anchor', () => {
  const r = realignCaptions(orig, 'yo Hey the fuck is DDG', trim);
  assert.deepEqual(span(r.blocks, 'yo'), [0, 1000]);
});

test('trailing insertion uses last anchor to clip end', () => {
  const r = realignCaptions(orig, 'Hey the fuck is DDG bye', trim);
  assert.deepEqual(span(r.blocks, 'bye'), [8500, 10000]);
});

test('mixed insertion/deletion', () => {
  // delete "the", insert "yo" between "fuck" and "is"
  const r = realignCaptions(orig, 'Hey fuck yo is DDG', trim);
  assert.equal(r.changedCount, 2);
  assert.deepEqual(texts(r.blocks), ['Hey', 'fuck', 'yo', 'is', 'DDG']);
  assert.deepEqual(span(r.blocks, 'yo'), [5000, 5500]);
});

test('major rewrite is rejected as realignment_required', () => {
  const r = realignCaptions(orig, 'completely different words here now', trim);
  assert.equal(r.alignment, 'realignment_required');
  assert.deepEqual(r.blocks, []);
});

test('timings remain monotonic and inside the trim range', () => {
  const r = realignCaptions(orig, 'Hey the yeah yo fuck is DDG bye yo', trim);
  assert.equal(r.alignment, 'redistributed');
  for (let k = 1; k < r.blocks.length; k++) {
    assert.ok(r.blocks[k].startMs >= r.blocks[k - 1].endMs, 'non-overlapping');
    assert.ok(r.blocks[k].startMs >= r.blocks[k - 1].startMs, 'monotonic');
  }
  for (const b of r.blocks) {
    assert.ok(b.startMs >= trim.trimStartMs && b.endMs <= trim.trimEndMs, 'within range');
  }
});

test('normalizeWord lowercases and strips punctuation', () => {
  assert.equal(normalizeWord('Hey,'), 'hey');
  assert.equal(normalizeWord('DDG!'), 'ddg');
  assert.equal(normalizeWord("don't"), 'dont');
});
