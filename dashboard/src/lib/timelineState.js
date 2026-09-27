/**
 * timelineState.js — the ONE timeline state model for the LOOM editor.
 *
 * WHY THIS MODULE EXISTS
 * The editor's trim controls used to be a bare pair of numeric inputs. Phase 2A
 * adds a visual timeline with draggable START/END handles and ±1s controls, and
 * the acceptance requirement is that the numeric inputs and the visual timeline
 * are views of ONE state, never two trim states that can disagree.
 *
 * So every range mutation funnels through the functions below. The React state
 * (`trimStart`/`trimEnd`) stays the single source of truth; the timeline renders
 * from it and writes back through the same normalizer the numeric inputs use.
 *
 * SOURCE RANGE vs SELECTED RANGE
 * The LOOM-selected moment is a RECOMMENDATION, not an editing boundary. Bryan
 * must be able to move START earlier (or END later) into any part of the durable
 * original source that actually exists. Therefore this module keeps two distinct
 * concepts:
 *   - sourceDuration: how much durable source media is actually available
 *   - range:          the currently SELECTED window inside it
 *
 * AUTHORITATIVE SOURCE BOUND
 * `media_url` for a source-lineage launch is the durable original file, so the
 * browser-measured duration of that file is the only fully trustworthy bound.
 * The declared bootstrap `duration_seconds` is derived from the candidate's
 * boundary plan (the WINDOW length) and is floored at the window end, so it is
 * treated as a fallback only — never allowed to shrink a measured source.
 * See resolveSourceDuration().
 *
 * EXTENSIBILITY (Phase 2A requirement)
 * The document shape produced by buildTimelineDocument() is the additive seam
 * for future typed edit events (split / remove / reorder / sfx / transition /
 * overlay / commentary / captions / hook). Those types are DECLARED here so the
 * seam is explicit and testable, and are refused by appendEvent() so no
 * speculative event can be persisted as if it were implemented. Nothing in this
 * module needs to be replaced to add them.
 */

/** Smallest selected window we allow, in seconds. Keeps end strictly > start. */
export const MIN_RANGE_SEC = 0.1;

// ---------------------------------------------------------------------------
// REUSED OPENSHORTS RULES
// These three were previously private constants inside components/ClipEditor.jsx
// (the existing OpenShorts multi-segment editor). They live here so the single-
// range track on the /edit page and the segment editor cannot drift apart on the
// rules that decide what a legal cut is.
// ---------------------------------------------------------------------------

/** ClipEditor's minimum segment length. Stricter than the /edit trim minimum. */
export const MIN_SEGMENT_SECONDS = 0.5;

/** How close an edge must be to a transcript word before it snaps to it. */
export const SNAP_WINDOW_SECONDS = 0.35;

/** Tolerance before coverage arithmetic calls a millisecond sliver unrendered. */
export const COVERAGE_EPSILON = 0.02;

/** Tolerance for float noise when clamping to a measured media duration. */
export const SOURCE_BOUNDS_EPSILON_SEC = 0.05;

/** Version stamped on the persisted timeline document. */
export const TIMELINE_DOCUMENT_VERSION = 1;

/**
 * The typed edit-event registry — the extension seam.
 *
 * `implemented: false` means the type is a DECLARED, authorized-later slot: the
 * shape is written down so the representation does not have to change when it
 * ships, but appendEvent() refuses it today so a speculative event can never be
 * silently persisted. Phase 2A implements exactly `trim` (and it is implicit in
 * `range`, never stored as an event).
 */
export const TIMELINE_EVENT_TYPES = Object.freeze({
  trim: { implemented: true, fields: ['start', 'end'] },
  split: { implemented: false, fields: ['at'] },
  remove: { implemented: false, fields: ['start', 'end'] },
  reorder: { implemented: false, fields: ['segments'] },
  sfx: { implemented: false, fields: ['at', 'asset_id'] },
  transition: { implemented: false, fields: ['at', 'preset', 'duration'] },
  overlay: { implemented: false, fields: ['start', 'end', 'asset_id'] },
  commentary: { implemented: false, fields: ['start', 'asset_id'] },
  captions: { implemented: false, fields: ['range', 'style'] },
  hook: { implemented: false, fields: ['range', 'text'] },
});

/** The only event types Phase 2A is authorized to persist. */
export const IMPLEMENTED_EVENT_TYPES = Object.freeze(
  Object.keys(TIMELINE_EVENT_TYPES).filter((t) => TIMELINE_EVENT_TYPES[t].implemented),
);

function finiteOrNull(v) {
  // Absent is not zero. `Number(null) === 0` and `Number('') === 0`, so a
  // plain Number() coercion would turn a MISSING value into a measured zero —
  // exactly the "unknown rendered as 0" defect this project already fixed once
  // on the review card. Reject absent values explicitly.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, lo, hi) {
  if (hi < lo) return lo;
  return Math.min(Math.max(v, lo), hi);
}

/**
 * How much durable source media is actually available?
 *
 * Rules, in priority order:
 *  1. A positive media-element measurement wins — it is the real file.
 *  2. Otherwise the declared bootstrap duration is the best available fallback.
 *  3. The result is never allowed to fall below the selected END: a range must
 *     always be inside its own source, so the on-screen readout can never
 *     contradict the handles.
 *
 * @param {{measured?: number, declared?: number, range?: {start?: number, end?: number}}} input
 * @returns {number} seconds, >= 0
 */
export function resolveSourceDuration({ measured, declared, range } = {}) {
  const m = finiteOrNull(measured);
  const d = finiteOrNull(declared);
  const end = finiteOrNull(range && range.end);
  let base = null;
  if (m !== null && m > 0) base = m;
  else if (d !== null && d > 0) base = d;
  if (base === null) base = 0;
  if (end !== null && end > 0) base = Math.max(base, end);
  return Math.max(base, 0);
}

/**
 * Clamp an arbitrary {start, end} into a valid window inside the source.
 * Always returns a valid range; never throws, never returns NaN.
 * Guards: start >= 0 · end <= sourceDuration · end >= start + MIN_RANGE_SEC.
 */
export function normalizeRange({ start, end, sourceDuration, minDuration = MIN_RANGE_SEC } = {}) {
  const src = Math.max(finiteOrNull(sourceDuration) ?? 0, 0);
  const min = Math.max(finiteOrNull(minDuration) ?? MIN_RANGE_SEC, 0);

  // Source shorter than the minimum window: the honest answer is the whole
  // (tiny) source, not an invalid inverted range.
  if (src <= min) {
    return { start: 0, end: src > 0 ? src : 0 };
  }

  let s = finiteOrNull(start);
  let e = finiteOrNull(end);
  if (s === null) s = 0;
  if (e === null) e = s + min;

  s = clamp(s, 0, src - min);
  e = clamp(e, s + min, src);
  // Re-clamp start against the final end (defensive; keeps ordering exact).
  s = clamp(s, 0, Math.max(e - min, 0));
  return { start: s, end: e };
}

/**
 * Honest description of a range: is it valid, and if not, why.
 * @returns {{valid: boolean, reason: null|'non_finite'|'end_not_after_start'|'beyond_source', duration: number}}
 */
export function describeRange({ range, sourceDuration } = {}) {
  const s = finiteOrNull(range && range.start);
  const e = finiteOrNull(range && range.end);
  const src = finiteOrNull(sourceDuration);
  if (s === null || e === null) {
    return { valid: false, reason: 'non_finite', duration: 0 };
  }
  if (e <= s) {
    return { valid: false, reason: 'end_not_after_start', duration: Math.max(e - s, 0) };
  }
  if (src !== null && e > src + SOURCE_BOUNDS_EPSILON_SEC) {
    return { valid: false, reason: 'beyond_source', duration: e - s };
  }
  return { valid: true, reason: null, duration: e - s };
}

/**
 * Move ONE boundary by `delta` seconds. The opposite boundary is never touched.
 *
 * @param {{range: {start: number, end: number}, boundary: 'start'|'end',
 *          delta: number, sourceDuration: number}} input
 * @returns {{start: number, end: number}} the new range (clamped, always valid)
 */
export function nudgeBoundary({ range, boundary, delta, sourceDuration, minDuration = MIN_RANGE_SEC } = {}) {
  const src = Math.max(finiteOrNull(sourceDuration) ?? 0, 0);
  const min = Math.max(finiteOrNull(minDuration) ?? MIN_RANGE_SEC, 0);
  const s = finiteOrNull(range && range.start) ?? 0;
  const e = finiteOrNull(range && range.end) ?? 0;
  const d = finiteOrNull(delta) ?? 0;

  if (boundary === 'start') {
    // START is independently adjustable: it stops at 0 and at (END - minimum).
    const next = clamp(s + d, 0, Math.max(e - min, 0));
    return { start: next, end: e };
  }
  if (boundary === 'end') {
    // END is independently adjustable: it stops at (START + minimum) and at
    // the end of the available source.
    const next = clamp(e + d, s + min, Math.max(src, s + min));
    return { start: s, end: next };
  }
  return { start: s, end: e };
}

/** Percentage geometry for drawing the timeline bar (0..100, clamped). */
export function rangeGeometry({ range, sourceDuration } = {}) {
  const src = finiteOrNull(sourceDuration);
  if (src === null || src <= 0) return { startPct: 0, endPct: 0, widthPct: 0 };
  const s = clamp(finiteOrNull(range && range.start) ?? 0, 0, src);
  const e = clamp(finiteOrNull(range && range.end) ?? 0, 0, src);
  const startPct = (s / src) * 100;
  const endPct = (e / src) * 100;
  return { startPct, endPct, widthPct: Math.max(endPct - startPct, 0) };
}

/**
 * Seconds represented by a pointer position inside the timeline track.
 * Pure (no DOM) so drag math is unit-testable without a browser.
 */
export function secondsFromPointer({ clientX, left, width, sourceDuration } = {}) {
  const src = Math.max(finiteOrNull(sourceDuration) ?? 0, 0);
  const x = finiteOrNull(clientX);
  const l = finiteOrNull(left);
  const w = finiteOrNull(width);
  if (x === null || l === null || w === null || w <= 0) return 0;
  const pct = clamp((x - l) / w, 0, 1);
  return pct * src;
}

/** `MM:SS` when the value is a whole second, else `MM:SS.CC` (hundredths). */
export function formatTimestamp(seconds) {
  const n = finiteOrNull(seconds);
  if (n === null) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const m = Math.floor(abs / 60);
  const s = Math.floor(abs % 60);
  const rest = abs - m * 60 - s;
  const hundredths = Math.round(rest * 100);
  // Rounding 99.996 -> 100 hundredths must carry into the seconds.
  let mm = m;
  let ss = s;
  let cc = hundredths;
  if (cc === 100) { cc = 0; ss += 1; }
  if (ss === 60) { ss = 0; mm += 1; }
  const base = `${sign}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return cc === 0 ? base : `${base}.${String(cc).padStart(2, '0')}`;
}

/** `22.60 sec` — the DURATION readout. */
export function formatSeconds(seconds) {
  const n = finiteOrNull(seconds);
  if (n === null) return '—';
  return `${n.toFixed(2)} sec`;
}

/** Segment edges round-trip through 3 decimals (raw drag math yields
 * 190.22000000000003).
 */
export function roundToMillis(v) {
  return Math.round((finiteOrNull(v) ?? 0) * 1000) / 1000;
}

/**
 * The editable span of the source.
 *
 * With the source media present every part of it is editable (`0..duration`).
 * With the source gone, cuts must stay inside the range the canonical file was
 * rendered from. Mirrors ClipEditor's `bounds` exactly.
 */
export function sourceBounds({ sourceAvailable, sourceDuration, canonical } = {}) {
  if (sourceAvailable) {
    return { lo: 0, hi: finiteOrNull(sourceDuration) || Infinity };
  }
  return {
    lo: finiteOrNull(canonical && canonical.start) ?? 0,
    hi: finiteOrNull(canonical && canonical.end) ?? 0,
  };
}

/**
 * Clamp one segment into `bounds`, keeping at least `minSeg` of length.
 * Behaviourally identical to ClipEditor's inline `clampSeg` (both bounds are
 * evaluated against the ORIGINAL start/end, not sequentially).
 */
export function clampSegmentToBounds(seg, bounds, minSeg = MIN_SEGMENT_SECONDS) {
  const s = finiteOrNull(seg && seg.start) ?? 0;
  const e = finiteOrNull(seg && seg.end) ?? 0;
  const lo = finiteOrNull(bounds && bounds.lo) ?? 0;
  const hi = finiteOrNull(bounds && bounds.hi) ?? Infinity;
  return {
    start: Math.max(lo, Math.min(s, e - minSeg)),
    end: Math.min(hi, Math.max(e, s + minSeg)),
  };
}

/**
 * Snap a boundary to the nearest transcript word edge within the window.
 * Reuses ClipEditor's rule verbatim: `w.s`/`w.e` are source-time seconds and a
 * no-match returns the input unchanged (never a fabricated edge).
 */
export function snapToWords(t, kind, words, { enabled = true, window = SNAP_WINDOW_SECONDS } = {}) {
  const value = finiteOrNull(t);
  if (value === null) return t;
  if (!enabled || !Array.isArray(words) || words.length === 0) return value;
  let best = null;
  for (const w of words) {
    const c = finiteOrNull(kind === 'start' ? w && w.s : w && w.e);
    if (c === null) continue;
    if (Math.abs(c - value) <= window && (best === null || Math.abs(c - value) < Math.abs(best - value))) {
      best = c;
    }
  }
  return best === null ? value : best;
}

/**
 * Validate ONE typed edit event against the registry.
 * @returns {{ok: true, event: object}|{ok: false, reason: string}}
 */
export function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, reason: 'not_an_object' };
  }
  const type = event.type;
  if (typeof type !== 'string' || !type) {
    return { ok: false, reason: 'missing_type' };
  }
  const spec = TIMELINE_EVENT_TYPES[type];
  if (!spec) return { ok: false, reason: 'unknown_event_type' };
  if (!spec.implemented) return { ok: false, reason: 'event_type_not_implemented' };
  return { ok: true, event: { ...event } };
}

/** Stable ordering: events are applied in source-time order. */
export function sortEvents(events) {
  const list = Array.isArray(events) ? events.slice() : [];
  return list
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => {
      const ta = finiteOrNull(a.ev && (a.ev.at ?? a.ev.start)) ?? 0;
      const tb = finiteOrNull(b.ev && (b.ev.at ?? b.ev.start)) ?? 0;
      return ta === tb ? a.i - b.i : ta - tb;
    })
    .map((x) => x.ev);
}

/** The document persisted at `loom_edit_corrections.edl_metadata.timeline`. */
export function buildTimelineDocument({ range, sourceDuration, events = [] } = {}) {
  const src = Math.max(finiteOrNull(sourceDuration) ?? 0, 0);
  const r = normalizeRange({ start: range && range.start, end: range && range.end, sourceDuration: src });
  return {
    version: TIMELINE_DOCUMENT_VERSION,
    range: { start: r.start, end: r.end },
    source_duration: src,
    events: sortEvents(events),
  };
}

/**
 * ADDITIVE event append. The range is never rewritten, so a future
 * split/SFX/overlay cannot invalidate an existing trim.
 * @returns {{ok: true, document: object}|{ok: false, reason: string}}
 */
export function appendEvent(document, event) {
  const validated = validateEvent(event);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  const doc = document && typeof document === 'object'
    ? document
    : buildTimelineDocument({ range: { start: 0, end: 0 }, sourceDuration: 0 });
  return {
    ok: true,
    document: { ...doc, events: sortEvents([...(doc.events || []), validated.event]) },
  };
}

/**
 * Tolerant read-back of a persisted timeline document.
 * A draft saved before the timeline existed (or a legacy `edl_metadata`) has no
 * document — the caller's current range is then the honest answer, never 0/0.
 */
export function parseTimelineDocument(raw, { range, sourceDuration } = {}) {
  const fallbackRange = {
    start: finiteOrNull(range && range.start) ?? 0,
    end: finiteOrNull(range && range.end) ?? 0,
  };
  const src = Math.max(finiteOrNull(sourceDuration) ?? 0, 0);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return buildTimelineDocument({ range: fallbackRange, sourceDuration: src });
  }
  const r = raw.range && typeof raw.range === 'object' ? raw.range : fallbackRange;
  const events = (Array.isArray(raw.events) ? raw.events : []).filter((e) => validateEvent(e).ok);
  const declaredSrc = finiteOrNull(raw.source_duration);
  return buildTimelineDocument({
    range: { start: r.start, end: r.end },
    sourceDuration: Math.max(declaredSrc ?? 0, src),
    events,
  });
}
