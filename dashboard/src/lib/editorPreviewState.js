/**
 * editorPreviewState.js — the ONE draft object → preview model conversion.
 *
 * Every preview surface (the primary editor preview, the Hook modal, the Header
 * modal) renders from the object this module returns, so they cannot drift
 * apart: they are views of one computed state.
 *
 * The four text concepts are kept explicitly distinct, because collapsing them
 * is what produced the original bug:
 *   A. Clip Title     → metadata only, never burned    (`title`)
 *   B. On-video Header→ visual overlay, rich text      (`title_overlay` + `header_rich`)
 *   C. Hook           → separate visual overlay, rich  (`hook` + `hook_rich`)
 *   D. Social Caption → publishing metadata, NEVER visual (`social_caption`)
 */

import { normalizeRich, buildRuns } from './richText.js';

/** An element is visible from the start of the clip until `durationSec`. */
export function hookVisibleAt(currentTimeSec, durationSec) {
  const t = Number(currentTimeSec);
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return true; // no duration = whole clip
  if (!Number.isFinite(t)) return true;
  return t >= 0 && t < d;
}

function str(v, fallback = '') {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve the Header's rich text.
 *
 * `header_rich` is the canonical record. When it is absent (a draft saved before
 * Header rich text existed) the legacy flat fields become the BASE style with no
 * ranges — which renders exactly as it did before, so old headers are unchanged.
 */
export function resolveHeaderRich(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const to = d.title_overlay && typeof d.title_overlay === 'object' ? d.title_overlay : {};
  if (d.header_rich != null) {
    const rich = normalizeRich(d.header_rich);
    // The flat text field stays authoritative for the string when it is set, so
    // the inline text box and the modal can never disagree on the content.
    const text = typeof to.text === 'string' && to.text !== '' ? to.text : rich.text;
    return { text, base: rich.base, spans: rich.spans };
  }
  return normalizeRich({
    text: str(to.text),
    base: { color: to.text_color || null, font: to.font_family || null },
    spans: [],
  });
}

/** Resolve the Hook's rich text the same way (mirrors resolveHeaderRich). */
export function resolveHookRich(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  if (d.hook_rich != null) {
    const rich = normalizeRich(d.hook_rich);
    const text = typeof d.hook === 'string' && d.hook !== '' ? d.hook : rich.text;
    return { text, base: rich.base, spans: rich.spans };
  }
  return normalizeRich(typeof d.hook === 'string' ? d.hook : '');
}

/**
 * Build the preview model for a whole editor draft.
 *
 * @param {object} draft editor draft (any subset; all fields optional)
 * @returns {{header:object, hook:object, subtitles:object, socialCaption:object, clipTitle:object}}
 */
export function buildPreviewState(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const to = d.title_overlay && typeof d.title_overlay === 'object' ? d.title_overlay : {};

  // --- B. On-video Header (visual overlay, rich text) ----------------------
  const headerRich = resolveHeaderRich(d);
  const headerModel = {
    enabled: !!to.enabled && headerRich.text.trim().length > 0,
    text: headerRich.text,
    // Layout mode: 'overlay' (draw over the video; accepted default) or
    // 'dedicated' (a real reserved black band above the video). Normalised here
    // rather than imported from overlayLayout, which depends on this module.
    region: to.region === 'dedicated' ? 'dedicated' : 'overlay',
    base: headerRich.base,
    spans: headerRich.spans,
    runs: buildRuns(headerRich.text, headerRich.spans),
    position: to.position || 'top',
    alignment: to.alignment || 'center',
    // Base font details stay the element's own fields (never duplicated in base).
    fontFamily: headerRich.base.font || to.font_family || 'Verdana',
    fontSize: num(to.font_size, 40),
    color: headerRich.base.color || to.text_color || '#FFFFFF',
    background: to.background || 'box',
    backgroundColor: to.background_color || '#000000',
  };

  // --- C. Hook (visual overlay, rich text) --------------------------------
  const hookRich = resolveHookRich(d);
  const hookModel = {
    present: hookRich.text.trim().length > 0,
    text: hookRich.text,
    base: hookRich.base,
    spans: hookRich.spans,
    runs: buildRuns(hookRich.text, hookRich.spans),
    position: d.hook_position || 'top',
    size: d.hook_size || 'M',
    style: d.hook_style || 'classic',
    entranceAnimation: d.hook_entrance || 'spring',
    durationSec: num(d.hook_duration, 5),
  };

  return {
    // A. Clip title — metadata, deliberately NOT part of the visual layer.
    clipTitle: { text: str(d.title), visual: false },
    header: headerModel,
    hook: hookModel,
    // Spoken subtitles are visual, but are burned/rendered by their own path.
    subtitles: {
      text: str(d.caption_text),
      visual: true,
      position: d.caption_position || 'bottom',
      blocks: Array.isArray(d.caption_blocks) ? d.caption_blocks : [],
    },
    // D. Social caption — publishing metadata. Must never render on the video.
    socialCaption: { text: str(d.social_caption), visual: false },
  };
}

/** True when a state has anything to draw over the frame. */
export function hasVisualOverlays(state) {
  return !!(state?.header?.enabled || state?.hook?.present);
}

/**
 * The payload for the server burn (`POST /api/hook`). `spans`/`base` are the
 * structured rich-text semantics the renderer honours, so the encoded hook and
 * the preview agree.
 */
export function hookRenderPayload(state) {
  const hook = state?.hook;
  if (!hook || !hook.present) return { remove: true };
  const payload = {
    text: hook.text,
    position: hook.position,
    size: hook.size,
    style: hook.style,
    duration_seconds: hook.durationSec,
  };
  const spans = hook.spans.map((s) => ({ ...s }));
  if (spans.length) {
    payload.spans = spans;
    if (hook.base.color || hook.base.font) payload.base = { ...hook.base };
  }
  return payload;
}

/**
 * The Header's render/durable record. Carries the range styling so a render of
 * the Header keeps the same semantics the preview showed, and so the record
 * survives save → render → reopen. Plain headers stay plain strings.
 */
export function headerRenderPayload(state) {
  const header = state?.header;
  if (!header || !header.enabled) return null;
  const record = {
    enabled: true,
    text: header.text,
    position: header.position,
    region: header.region === 'dedicated' ? 'dedicated' : 'overlay',
    alignment: header.alignment,
    font_family: header.fontFamily,
    font_size: header.fontSize,
    text_color: header.color,
    background: header.background,
    background_color: header.backgroundColor,
  };
  if (header.spans.length) {
    record.base = { ...header.base };
    record.spans = header.spans.map((s) => ({ ...s }));
  }
  return record;
}

/**
 * The draft fields the editor persists and re-hydrates for one rich text
 * element. Keeping this in one place is what makes "survives save → reload"
 * testable for BOTH elements instead of hand-rolled twice.
 */
export function richDraftFields(prefix, rich) {
  const value = normalizeRich(rich);
  const record = value.spans.length || value.base.color || value.base.font
    ? { text: value.text, base: { ...value.base }, spans: value.spans.map((s) => ({ ...s })) }
    : null;
  return { [`${prefix}_rich`]: record };
}

/**
 * The draft fields that persist one Header's layout mode. Written inside the
 * EXISTING `title_overlay` record (no new top-level state), so a draft saved
 * before the mode existed simply reads back as the accepted default.
 */
export function headerRegionField(region) {
  return { region: region === 'dedicated' ? 'dedicated' : 'overlay' };
}
