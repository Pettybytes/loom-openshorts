/**
 * rangeSelection.js — the pure selection → span logic behind range styling.
 *
 * Extracted from the UI so the interaction Bryan performs can be asserted
 * without a DOM: a selection (start/end) plus a patch either mutates that range
 * or — with no range — the element's base style.
 *
 * The subtle part is `keepSelection`. Reading selectionStart/selectionEnd from
 * an element that has LOST FOCUS is not reliable: WebKit reports 0/0. Clicking a
 * colour swatch blurs the textarea, so a naive "re-sync on blur" wipes the range
 * and silently redirects the patch to the base style — the whole header changes
 * colour and the panel reads "no selection". A live, non-empty selection is
 * therefore sticky: an empty reading never overwrites it.
 */

import { applyRangeStyle, normalizeRich, normalizeBase } from './richText.js';

/** Properties that make sense on the base style (size is a range-only concept). */
export const BASE_ONLY_KEYS = ['color', 'font'];

/** Clamp and order a selection against the current text length. */
export function normalizeSelection(selection, textLength) {
  const len = Math.max(0, Math.trunc(Number(textLength) || 0));
  const start = Math.max(0, Math.min(len, Math.trunc(Number(selection?.start) || 0)));
  const end = Math.max(0, Math.min(len, Math.trunc(Number(selection?.end) || 0)));
  return start <= end ? { start, end } : { start: end, end: start };
}

/** True when the selection actually covers characters. */
export function hasRange(selection, textLength) {
  const sel = normalizeSelection(selection, textLength);
  return sel.end > sel.start;
}

/**
 * Adopt `next` unless it is empty while `current` still holds a real range.
 * This is what makes the interaction survive focus loss.
 */
export function keepSelection(current, next, textLength) {
  const incoming = normalizeSelection(next, textLength);
  if (incoming.end > incoming.start) return incoming;
  const held = normalizeSelection(current, textLength);
  return held.end > held.start ? held : incoming;
}

/**
 * Apply a style patch to the selection, or to the base style when there is none.
 *
 * @returns {{value:object, scope:'range'|'base', selection:{start:number,end:number}}}
 */
export function applySelectionPatch(value, selection, patch, { textLength } = {}) {
  const rich = normalizeRich(value);
  const len = Number.isFinite(textLength) ? textLength : rich.text.length;
  const sel = normalizeSelection(selection, len);

  if (sel.end > sel.start) {
    return {
      value: applyRangeStyle(rich, sel.start, sel.end, patch),
      scope: 'range',
      selection: sel,
    };
  }

  const base = normalizeBase(rich.base);
  for (const key of BASE_ONLY_KEYS) {
    if (!(key in (patch || {}))) continue;
    const v = patch[key];
    base[key] = v == null || v === '' ? null : v;
  }
  return { value: { text: rich.text, base, spans: rich.spans }, scope: 'base', selection: sel };
}

/** Clear colour/font/size on the selection, or the base style when there is none. */
export function clearSelectionStyle(value, selection, options = {}) {
  return applySelectionPatch(value, selection, { color: null, font: null, size: null }, options);
}

/** The range's current accumulated style, for honest readouts in the UI. */
export function styleAtSelection(value, selection, options = {}) {
  const rich = normalizeRich(value);
  const len = Number.isFinite(options.textLength) ? options.textLength : rich.text.length;
  const sel = normalizeSelection(selection, len);
  if (sel.end <= sel.start) return null;
  return rich.spans.find((s) => sel.start >= s.start && sel.start < s.end) || null;
}
