/**
 * hookRichText.js — the ONE structured model for Hook rich text.
 *
 * A hook is stored as:
 *
 *   {
 *     text:  "LOOK MA.. NO HANDS!",          // plain text, always present
 *     base:  { color, font, size },          // base/default style (null = inherit)
 *     spans: [ { start, end, color, font, size } ]   // range overrides
 *   }
 *
 * Rules this module owns (all deterministic, all pure):
 *   - `spans` are half-open [start, end) character ranges over `text`.
 *   - Later spans win over earlier ones where they overlap, so paint order is
 *     the array order. This is the ONLY overlap rule; there is no separate
 *     "word mode" or "letter mode" — a range of length 1 is a character.
 *   - Spans that end up with an identical accumulated style AND are adjacent
 *     are coalesced into one span (`normalizeSpans`).
 *   - Normalization is idempotent: normalize(normalize(x)) === normalize(x).
 *   - A plain string is a valid hook and renders "normally" (no spans).
 *
 * Nothing here touches the DOM, React, or the network — the editor UI and the
 * preview/render layers all consume these functions, which is what keeps the
 * Hook modal and the primary preview showing the same thing.
 */

// Size vocabulary shared by the modal, the previews and hooks.py.
export const SIZE_SCALE = { S: 0.8, M: 1.0, L: 1.3 };

// Fonts offered for a range. "Noto Serif" is what hooks.py actually ships;
// the rest are honoured by the browser preview and, on the server burn, only
// when the local font file can be resolved (otherwise they degrade to Noto).
export const BASE_FONT = 'Noto Serif';
export const HOOK_FONTS = [
  'Noto Serif',
  'Verdana',
  'Arial',
  'Impact',
  'Helvetica',
  'Georgia',
  'Courier New',
];

/** The three per-range style properties. Nothing else is a style. */
export const STYLE_KEYS = ['color', 'font', 'size'];

/** An all-null base style. */
export function emptyBase() {
  return { color: null, font: null, size: null };
}

/** Coerce anything into a clean {color, font, size} base style. */
export function normalizeBase(base) {
  const out = emptyBase();
  if (!base || typeof base !== 'object') return out;
  for (const key of STYLE_KEYS) {
    const v = base[key];
    if (v != null && v !== '') out[key] = v;
  }
  return out;
}

/** True when the base style overrides nothing. */
export function isEmptyBase(base) {
  const b = normalizeBase(base);
  return STYLE_KEYS.every((k) => b[k] == null);
}

function styleOf(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const key of STYLE_KEYS) {
    const v = obj[key];
    if (v != null && v !== '') out[key] = v;
  }
  return out;
}

function sameStyle(a, b) {
  return STYLE_KEYS.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
}

function textLengthOf(text) {
  const n = typeof text === 'string' ? text.length : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Coerce one incoming span into {start, end, ...style}, clamped to the text.
 * Returns null for anything unusable (non-numeric bounds, empty range, no
 * style properties at all).
 */
function coerceSpan(span, len) {
  if (!span || typeof span !== 'object') return null;
  const rawStart = Number(span.start);
  const rawEnd = Number(span.end);
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;
  const start = Math.max(0, Math.min(len, Math.trunc(rawStart)));
  const end = Math.max(0, Math.min(len, Math.trunc(rawEnd)));
  if (end <= start) return null;
  const style = styleOf(span);
  if (!Object.keys(style).length) return null;
  return { start, end, ...style };
}

/**
 * Accumulated per-character style map. Later spans overwrite earlier ones on
 * the overlapping characters only — every other character keeps its own style.
 */
function cellsFor(text, spans) {
  const len = textLengthOf(text);
  const cells = new Array(len).fill(null);
  if (!len) return cells;
  const list = (Array.isArray(spans) ? spans : [])
    .map((s) => coerceSpan(s, len))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const span of list) {
    const style = styleOf(span);
    for (let i = span.start; i < span.end; i += 1) {
      cells[i] = { ...(cells[i] || {}), ...style };
    }
  }
  return cells;
}

/** Canonical, non-overlapping, coalesced spans derived from the cell map. */
function spansFromCells(cells) {
  const out = [];
  let current = null;
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (!cell || !Object.keys(cell).length) {
      current = null;
      continue;
    }
    if (current && current.end === i && sameStyle(current, cell)) {
      current.end = i + 1;
      continue;
    }
    current = { start: i, end: i + 1, ...cell };
    out.push(current);
  }
  return out;
}

/**
 * Canonical form of `spans` for `text` (or for an explicit length).
 *
 * Accepts either (spans, textLength) or (text, spans) so callers cannot get
 * the argument order subtly wrong in a way that silently drops styling.
 */
export function normalizeSpans(a, b) {
  let text = '';
  let spans = null;
  let len = 0;
  if (typeof a === 'string') {
    text = a;
    spans = b;
    len = textLengthOf(text);
  } else {
    spans = a;
    len = Math.max(0, Math.trunc(Number(b) || 0));
  }
  const cells = cellsFor('x'.repeat(len), spans);
  return spansFromCells(cells);
}

/**
 * Split `text` into consecutive runs of identical resolved style.
 *
 * @returns {Array<{start:number,end:number,text:string,style:object}>}
 *          Adjacent runs always differ in style, so the renderer can emit each
 *          run as its own element without a merge pass. `style` holds only the
 *          properties that are actually overridden for that run.
 */
export function buildRuns(text, spans) {
  const str = typeof text === 'string' ? text : '';
  const cells = cellsFor(str, spans);
  const runs = [];
  for (let i = 0; i < str.length; i += 1) {
    const style = cells[i] && Object.keys(cells[i]).length ? cells[i] : {};
    const last = runs[runs.length - 1];
    if (last && sameStyle(last.style, style)) {
      last.end = i + 1;
      last.text += str[i];
      continue;
    }
    runs.push({ start: i, end: i + 1, text: str[i], style });
  }
  return runs;
}

/** Resolve a run's style against the base style (base first, run wins). */
export function resolveRunStyle(style, base) {
  const b = normalizeBase(base);
  const out = {};
  for (const key of STYLE_KEYS) {
    const v = style?.[key] != null && style[key] !== '' ? style[key] : b[key];
    if (v != null) out[key] = v;
  }
  return out;
}

/**
 * Apply a style patch to the half-open character range [start, end).
 *
 * A `null` (or empty-string) value in the patch CLEARS that property for the
 * range; an absent key leaves it alone. Returns a new hook object; the input
 * is never mutated.
 */
export function applyRangeStyle(rich, start, end, patch) {
  const hook = normalizeRichHook(rich);
  const len = textLengthOf(hook.text);
  const from = Math.max(0, Math.min(len, Math.trunc(Number(start) || 0)));
  const to = Math.max(0, Math.min(len, Math.trunc(Number(end) || 0)));
  if (to <= from) return hook;

  const cells = cellsFor(hook.text, hook.spans);
  const clear = {};
  const set = {};
  for (const key of STYLE_KEYS) {
    if (!(key in (patch || {}))) continue;
    const v = patch[key];
    if (v == null || v === '') clear[key] = true;
    else set[key] = v;
  }
  for (let i = from; i < to; i += 1) {
    const cell = { ...(cells[i] || {}) };
    for (const key of STYLE_KEYS) {
      if (clear[key]) delete cell[key];
      else if (key in set) cell[key] = set[key];
    }
    cells[i] = Object.keys(cell).length ? cell : null;
  }
  return { text: hook.text, base: hook.base, spans: spansFromCells(cells) };
}

/**
 * Accept a plain string (legacy hooks), a rich object, or null, and return the
 * canonical rich hook. Legacy plain strings render exactly as before.
 */
export function normalizeRichHook(value) {
  if (value == null) return { text: '', base: emptyBase(), spans: [] };
  if (typeof value === 'string') return { text: value, base: emptyBase(), spans: [] };
  if (typeof value !== 'object') return { text: '', base: emptyBase(), spans: [] };
  const text = typeof value.text === 'string' ? value.text : '';
  return {
    text,
    base: normalizeBase(value.base),
    spans: normalizeSpans(text, value.spans),
  };
}

/** True when the hook carries any range styling (used to pick render paths). */
export function hasRangeStyling(rich) {
  const hook = normalizeRichHook(rich);
  return hook.spans.length > 0;
}

/** True when the hook is not a plain unstyled string. */
export function isRichHook(value) {
  if (typeof value === 'string' || value == null) return false;
  if (typeof value !== 'object') return false;
  const hook = normalizeRichHook(value);
  return hook.spans.length > 0 || !isEmptyBase(hook.base);
}

/** Structural equality on the canonical form (order/whitespace insensitive). */
export function richHooksEqual(a, b) {
  const x = normalizeRichHook(a);
  const y = normalizeRichHook(b);
  if (x.text !== y.text) return false;
  if (!sameStyle(x.base, y.base)) return false;
  if (x.spans.length !== y.spans.length) return false;
  return x.spans.every((span, i) => {
    const other = y.spans[i];
    return span.start === other.start && span.end === other.end && sameStyle(span, other);
  });
}

/** The wire/persistence form. Plain hooks stay plain strings (backward compat). */
export function serializeHook(rich) {
  const hook = normalizeRichHook(rich);
  if (!isRichHook(hook)) return hook.text;
  return {
    text: hook.text,
    base: hook.base,
    spans: hook.spans.map((s) => ({ ...s })),
  };
}

/**
 * The single saved/persisted shape for a hook's rich text — this is what the
 * editor draft stores and what round-trips through save → render → reopen.
 */
export function hookPersistencePayload(rich) {
  return serializeHook(rich);
}
