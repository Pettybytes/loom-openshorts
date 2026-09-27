/**
 * Timeline state contract — the ONE range model shared by the /edit page's
 * visual timeline and OpenShorts' existing multi-segment editor.
 *
 * Covers: source-bound resolution (measured vs declared), clamping in every
 * direction, INDEPENDENT boundary movement, ±1s nudging, extension into the
 * original source beyond the LOOM-selected window, formatting, the typed
 * edit-event seam, and BEHAVIOURAL PARITY with the inline rules ClipEditor used
 * before they moved here (so the dedup cannot change what a legal cut is).
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  MIN_RANGE_SEC,
  MIN_SEGMENT_SECONDS,
  SNAP_WINDOW_SECONDS,
  TIMELINE_DOCUMENT_VERSION,
  TIMELINE_EVENT_TYPES,
  IMPLEMENTED_EVENT_TYPES,
  resolveSourceDuration,
  normalizeRange,
  describeRange,
  nudgeBoundary,
  rangeGeometry,
  secondsFromPointer,
  formatTimestamp,
  formatSeconds,
  roundToMillis,
  sourceBounds,
  clampSegmentToBounds,
  snapToWords,
  validateEvent,
  sortEvents,
  buildTimelineDocument,
  appendEvent,
  parseTimelineDocument,
} from './timelineState.js';

// ---------------------------------------------------------------------------
// Source bound: measured (the real file) beats declared (the window length).
// ---------------------------------------------------------------------------

test('resolveSourceDuration prefers the measured media duration', () => {
  // This is the live case: a source-lineage bootstrap reports the CANDIDATE
  // WINDOW length as duration_seconds, while the durable file is longer.
  assert.equal(
    resolveSourceDuration({ measured: 72.5, declared: 20.897959, range: { start: 0, end: 20.897959 } }),
    72.5,
  );
});

test('resolveSourceDuration falls back to declared before metadata arrives', () => {
  assert.equal(resolveSourceDuration({ measured: 0, declared: 20.9, range: { start: 0, end: 20.9 } }), 20.9);
  assert.equal(resolveSourceDuration({ declared: 11.167, range: { start: 0, end: 11.166667 } }), 11.167);
});

test('resolveSourceDuration never reports a source shorter than the selected end', () => {
  // A range must always live inside its own source, or the readout would
  // contradict the handles it is drawn from.
  assert.equal(resolveSourceDuration({ measured: 0, declared: 0, range: { start: 0, end: 33 } }), 33);
  assert.equal(resolveSourceDuration({}), 0);
  assert.equal(resolveSourceDuration({ measured: NaN, declared: undefined, range: { end: NaN } }), 0);
});

// ---------------------------------------------------------------------------
// Clamping — never off the start, never off the end, never inverted.
// ---------------------------------------------------------------------------

test('normalizeRange clamps both directions into the source', () => {
  const src = 60;
  assert.deepEqual(normalizeRange({ start: -10, end: 20, sourceDuration: src }), { start: 0, end: 20 });
  assert.deepEqual(normalizeRange({ start: 10, end: 999, sourceDuration: src }), { start: 10, end: 60 });
  assert.deepEqual(normalizeRange({ start: -5, end: 999, sourceDuration: src }), { start: 0, end: 60 });
});

test('normalizeRange never yields an inverted or zero-length window', () => {
  const r = normalizeRange({ start: 30, end: 30, sourceDuration: 60 });
  assert.ok(r.end > r.start);
  assert.ok(r.end - r.start >= MIN_RANGE_SEC - 1e-9);
});

test('normalizeRange is safe when the source is shorter than the minimum window', () => {
  assert.deepEqual(normalizeRange({ start: 0, end: 5, sourceDuration: 0.04 }), { start: 0, end: 0.04 });
});

test('normalizeRange tolerates junk input instead of producing NaN', () => {
  const r = normalizeRange({ start: 'abc', end: null, sourceDuration: 30 });
  assert.ok(Number.isFinite(r.start) && Number.isFinite(r.end));
  assert.ok(r.end > r.start);
});

test('describeRange names the failure instead of guessing', () => {
  assert.equal(describeRange({ range: { start: 0, end: 10 }, sourceDuration: 30 }).valid, true);
  assert.equal(describeRange({ range: { start: 10, end: 10 }, sourceDuration: 30 }).reason, 'end_not_after_start');
  assert.equal(describeRange({ range: { start: 0, end: 99 }, sourceDuration: 30 }).reason, 'beyond_source');
  assert.equal(describeRange({ range: { start: NaN, end: 5 }, sourceDuration: 30 }).reason, 'non_finite');
});

// ---------------------------------------------------------------------------
// INDEPENDENT boundaries: moving one must never move the other.
// ---------------------------------------------------------------------------

test('moving START leaves END untouched', () => {
  const r = nudgeBoundary({ range: { start: 10, end: 30 }, boundary: 'start', delta: 5, sourceDuration: 60 });
  assert.deepEqual(r, { start: 15, end: 30 });
});

test('moving END leaves START untouched', () => {
  const r = nudgeBoundary({ range: { start: 10, end: 30 }, boundary: 'end', delta: -5, sourceDuration: 60 });
  assert.deepEqual(r, { start: 10, end: 25 });
});

test('±1s is exactly one second on each boundary', () => {
  const base = { start: 14.2, end: 36.8 };
  assert.deepEqual(
    nudgeBoundary({ range: base, boundary: 'start', delta: -1, sourceDuration: 120 }),
    { start: 13.2, end: 36.8 },
  );
  assert.deepEqual(
    nudgeBoundary({ range: base, boundary: 'end', delta: 1, sourceDuration: 120 }),
    { start: 14.2, end: 37.8 },
  );
});

test('START stops at zero and at the minimum window before END', () => {
  const atZero = nudgeBoundary({ range: { start: 0.5, end: 30 }, boundary: 'start', delta: -10, sourceDuration: 60 });
  assert.equal(atZero.start, 0);
  assert.equal(atZero.end, 30);

  const atGap = nudgeBoundary({ range: { start: 10, end: 10.4 }, boundary: 'start', delta: 5, sourceDuration: 60 });
  assert.ok(atGap.start < atGap.end);
  assert.ok(atGap.end - atGap.start >= MIN_RANGE_SEC - 1e-9);
});

test('END stops at the end of the source and at the minimum window after START', () => {
  const atEnd = nudgeBoundary({ range: { start: 10, end: 59 }, boundary: 'end', delta: 10, sourceDuration: 60 });
  assert.equal(atEnd.end, 60);
  assert.equal(atEnd.start, 10);

  const atGap = nudgeBoundary({ range: { start: 10, end: 10.4 }, boundary: 'end', delta: -5, sourceDuration: 60 });
  assert.ok(atGap.end - atGap.start >= MIN_RANGE_SEC - 1e-9);
});

// ---------------------------------------------------------------------------
// §7 original-source extension: the LOOM window is a RECOMMENDATION, not a bound.
// ---------------------------------------------------------------------------

test('a boundary can be extended across the rest of the original source', () => {
  // The accepted live case: card window 0.0 -> 20.897959 inside a long source.
  const src = resolveSourceDuration({
    measured: 240,
    declared: 20.897959,
    range: { start: 0, end: 20.897959 },
  });
  assert.equal(src, 240, 'the measured file, not the recommended window, is the bound');

  // END extends well past the LOOM recommendation into real source.
  const longer = nudgeBoundary({ range: { start: 0, end: 20.897959 }, boundary: 'end', delta: 60, sourceDuration: src });
  assert.equal(longer.end, 80.897959);
  assert.ok(longer.end > 20.897959);

  // START can move freely toward END, but can never cross it — the two
  // boundaries are independent, not unconstrained.
  const later = nudgeBoundary({ range: { start: 0, end: 20.897959 }, boundary: 'start', delta: 5, sourceDuration: src });
  assert.equal(later.start, 5);
  assert.equal(later.end, 20.897959);

  const past = nudgeBoundary({ range: { start: 0, end: 20.897959 }, boundary: 'start', delta: 30, sourceDuration: src });
  assert.ok(past.start < past.end, 'START stops before END rather than inverting the range');
  assert.equal(past.end, 20.897959);
});

test('extension is impossible when the source really does end there', () => {
  // Honest negative: the durable TikTok file IS 11.166667s, so nothing exists
  // beyond it and the handle must stop.
  const src = resolveSourceDuration({ measured: 11.166667, declared: 11.167, range: { start: 0, end: 11.166667 } });
  const r = nudgeBoundary({ range: { start: 0, end: 11.166667 }, boundary: 'end', delta: 30, sourceDuration: src });
  assert.equal(r.end, 11.166667);
});

test('without source media the editable span collapses to the rendered range', () => {
  const b = sourceBounds({ sourceAvailable: false, sourceDuration: 0, canonical: { start: 5, end: 25 } });
  assert.deepEqual(b, { lo: 5, hi: 25 });
  const withSource = sourceBounds({ sourceAvailable: true, sourceDuration: 240, canonical: { start: 5, end: 25 } });
  assert.deepEqual(withSource, { lo: 0, hi: 240 });
});

// ---------------------------------------------------------------------------
// Geometry + pointer math (pure — no DOM, so drag math is testable).
// ---------------------------------------------------------------------------

test('rangeGeometry maps the window onto the track', () => {
  const g = rangeGeometry({ range: { start: 15, end: 45 }, sourceDuration: 60 });
  assert.equal(g.startPct, 25);
  assert.equal(g.endPct, 75);
  assert.equal(g.widthPct, 50);
});

test('rangeGeometry clamps out-of-source values and survives a zero source', () => {
  const g = rangeGeometry({ range: { start: -10, end: 999 }, sourceDuration: 60 });
  assert.deepEqual(g, { startPct: 0, endPct: 100, widthPct: 100 });
  assert.deepEqual(rangeGeometry({ range: { start: 0, end: 5 }, sourceDuration: 0 }), {
    startPct: 0, endPct: 0, widthPct: 0,
  });
});

test('secondsFromPointer clamps to the track and tolerates a degenerate rect', () => {
  assert.equal(secondsFromPointer({ clientX: 50, left: 0, width: 100, sourceDuration: 60 }), 30);
  assert.equal(secondsFromPointer({ clientX: -20, left: 0, width: 100, sourceDuration: 60 }), 0);
  assert.equal(secondsFromPointer({ clientX: 500, left: 0, width: 100, sourceDuration: 60 }), 60);
  assert.equal(secondsFromPointer({ clientX: 10, left: 0, width: 0, sourceDuration: 60 }), 0);
});

// ---------------------------------------------------------------------------
// Formatting, exactly as the readouts print it.
// ---------------------------------------------------------------------------

test('formatTimestamp prints whole seconds bare and hundredths with a point', () => {
  assert.equal(formatTimestamp(0), '00:00');
  assert.equal(formatTimestamp(14.2), '00:14.20');
  assert.equal(formatTimestamp(72), '01:12');
  assert.equal(formatTimestamp(125.5), '02:05.50');
  assert.equal(formatTimestamp(11.166667), '00:11.17');
  assert.equal(formatTimestamp(NaN), '—');
});

test('formatTimestamp carries rounding instead of printing 60 hundredths', () => {
  assert.equal(formatTimestamp(59.9996), '01:00');
});

test('formatSeconds prints the DURATION readout', () => {
  assert.equal(formatSeconds(22.6), '22.60 sec');
  assert.equal(formatSeconds(null), '—');
  assert.equal(formatSeconds(undefined), '—');
  // A real measured zero is still printed as zero, not hidden as unknown.
  assert.equal(formatSeconds(0), '0.00 sec');
});

// ---------------------------------------------------------------------------
// PARITY with ClipEditor's previous inline rules (the dedup guard).
// ---------------------------------------------------------------------------

// Verbatim copies of ClipEditor.jsx's pre-dedup implementations.
function legacyClampSeg(seg, bounds, minSeg) {
  return {
    start: Math.max(bounds.lo, Math.min(seg.start, seg.end - minSeg)),
    end: Math.min(bounds.hi, Math.max(seg.end, seg.start + minSeg)),
  };
}
function legacySnapEdge(t, kind, words, snapOn) {
  if (!snapOn || !words.length) return t;
  let best = null;
  for (const w of words) {
    const c = kind === 'start' ? w.s : w.e;
    if (Math.abs(c - t) <= SNAP_WINDOW_SECONDS && (best === null || Math.abs(c - t) < Math.abs(best - t))) best = c;
  }
  return best ?? t;
}

test('clampSegmentToBounds matches ClipEditor\'s inline clampSeg exactly', () => {
  const bounds = { lo: 0, hi: 60 };
  const segs = [
    { start: -5, end: 10 }, { start: 10, end: 999 }, { start: 30, end: 30 },
    { start: 10.25, end: 10.5 }, { start: 59.9, end: 60 },
  ];
  for (const seg of segs) {
    for (const minSeg of [MIN_SEGMENT_SECONDS, MIN_RANGE_SEC]) {
      assert.deepEqual(
        clampSegmentToBounds(seg, bounds, minSeg),
        legacyClampSeg(seg, bounds, minSeg),
        `segment ${JSON.stringify(seg)} minSeg ${minSeg}`,
      );
    }
  }
});

test('snapToWords matches ClipEditor\'s inline snapEdge exactly', () => {
  const words = [{ s: 10, e: 10.4 }, { s: 20, e: 21 }, { s: 33.3, e: 34 }];
  for (const t of [0, 9.9, 10.1, 10.36, 12, 20.2, 20.9, 33.5, 34.2]) {
    for (const kind of ['start', 'end']) {
      assert.equal(snapToWords(t, kind, words, { enabled: true }), legacySnapEdge(t, kind, words, true), `${kind}@${t}`);
      assert.equal(snapToWords(t, kind, words, { enabled: false }), legacySnapEdge(t, kind, words, false), `off ${kind}@${t}`);
    }
  }
});

test('snapToWords never fabricates an edge for an unmatched boundary', () => {
  assert.equal(snapToWords(50, 'start', [{ s: 10, e: 11 }], { enabled: true }), 50);
  assert.equal(snapToWords(5, 'start', [], { enabled: true }), 5);
});

test('roundToMillis kills drag arithmetic noise', () => {
  assert.equal(roundToMillis(190.22000000000003), 190.22);
  assert.equal(roundToMillis(1.0004999), 1.0);
});

// ---------------------------------------------------------------------------
// Typed edit-event seam: declared, additive, and NOT silently persisted.
// ---------------------------------------------------------------------------

test('the future event types are declared so the shape does not have to change', () => {
  for (const t of ['split', 'remove', 'reorder', 'sfx', 'transition', 'overlay', 'commentary', 'captions', 'hook']) {
    assert.ok(TIMELINE_EVENT_TYPES[t], `${t} must be declared`);
    assert.equal(TIMELINE_EVENT_TYPES[t].implemented, false);
    assert.ok(Array.isArray(TIMELINE_EVENT_TYPES[t].fields) && TIMELINE_EVENT_TYPES[t].fields.length > 0);
  }
  assert.deepEqual(IMPLEMENTED_EVENT_TYPES, ['trim']);
});

test('an unimplemented event type is refused, not persisted as if it worked', () => {
  assert.deepEqual(validateEvent({ type: 'sfx', at: 3 }), { ok: false, reason: 'event_type_not_implemented' });
  assert.deepEqual(validateEvent({ type: 'nonsense' }), { ok: false, reason: 'unknown_event_type' });
  assert.deepEqual(validateEvent({ at: 3 }), { ok: false, reason: 'missing_type' });
  assert.deepEqual(validateEvent(null), { ok: false, reason: 'not_an_object' });
  const doc = buildTimelineDocument({ range: { start: 0, end: 10 }, sourceDuration: 60 });
  assert.deepEqual(appendEvent(doc, { type: 'overlay', start: 1, end: 2 }), { ok: false, reason: 'event_type_not_implemented' });
});

test('appending an event is additive and never rewrites the range', () => {
  const doc = buildTimelineDocument({ range: { start: 5, end: 25 }, sourceDuration: 60 });
  const res = appendEvent(doc, { type: 'trim', start: 5, end: 25 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.document.range, { start: 5, end: 25 });
  assert.equal(res.document.events.length, 1);
  // The original document is not mutated.
  assert.equal(doc.events.length, 0);
});

test('events are ordered by source time', () => {
  const out = sortEvents([{ type: 'a', at: 9 }, { type: 'b', start: 2 }, { type: 'c', at: 5 }]);
  assert.deepEqual(out.map((e) => e.type), ['b', 'c', 'a']);
});

test('buildTimelineDocument is the durable shape and clamps its own range', () => {
  const doc = buildTimelineDocument({ range: { start: -5, end: 999 }, sourceDuration: 60 });
  assert.equal(doc.version, TIMELINE_DOCUMENT_VERSION);
  assert.deepEqual(doc.range, { start: 0, end: 60 });
  assert.equal(doc.source_duration, 60);
  assert.deepEqual(doc.events, []);
});

test('parseTimelineDocument falls back to the current range for a legacy draft', () => {
  const doc = parseTimelineDocument(undefined, { range: { start: 4, end: 12 }, sourceDuration: 30 });
  assert.deepEqual(doc.range, { start: 4, end: 12 });
  assert.equal(doc.source_duration, 30);
});

test('parseTimelineDocument filters events it cannot honour', () => {
  const doc = parseTimelineDocument(
    {
      version: 1,
      range: { start: 2, end: 8 },
      source_duration: 40,
      events: [{ type: 'sfx', at: 3 }, { type: 'trim', start: 2, end: 8 }, 'junk'],
    },
    { range: { start: 0, end: 0 }, sourceDuration: 0 },
  );
  assert.deepEqual(doc.range, { start: 2, end: 8 });
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].type, 'trim');
  // A declared source duration is honoured; the caller's is not allowed to win.
  assert.equal(doc.source_duration, 40);
});

test('MIN_RANGE_SEC and MIN_SEGMENT_SECONDS stay distinct on purpose', () => {
  // The /edit trim window may be tighter than a multi-segment cut; collapsing
  // them would silently change one of the two surfaces.
  assert.ok(MIN_RANGE_SEC < MIN_SEGMENT_SECONDS);
});
