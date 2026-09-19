/**
 * editorPreviewState.js — the ONE draft object → preview model conversion.
 *
 * Every preview surface (the primary editor preview, the Hook modal preview)
 * renders from the object this module returns, so the modal and the primary
 * preview cannot drift apart: they are two views of one computed state.
 *
 * The four text concepts are kept explicitly distinct, because collapsing them
 * is what produced the original bug:
 *   A. Clip Title     → metadata only, never burned  (`title`)
 *   B. On-video Header→ visual overlay               (`title_overlay`)
 *   C. Hook           → separate visual overlay      (`hook` + `hook_rich`)
 *   D. Social Caption → publishing metadata, NEVER visual (`social_caption`)
 */

import { normalizeRichHook, buildRuns, hookPersistencePayload } from './hookRichText.js';

/** Hook is visible from the start of the clip until `durationSec`. */
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
 * Build the preview model for a whole editor draft.
 *
 * @param {object} draft editor draft (any subset; all fields optional)
 * @returns {{header:object, hook:object, subtitles:object, socialCaption:object, clipTitle:object}}
 */
export function buildPreviewState(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};

  // --- C. Hook (visual overlay) -------------------------------------------
  // `hook_rich` is the structured record; `hook` stays the plain string for
  // backward compatibility with drafts saved before rich text existed.
  const rawRich = d.hook_rich != null ? d.hook_rich : d.hook;
  const rich = normalizeRichHook(rawRich);
  const hookText = typeof d.hook === 'string' ? d.hook : rich.text;
  const effectiveRich = normalizeRichHook(
    typeof d.hook === 'string' && d.hook_rich == null
      ? { text: d.hook, base: { color: null, font: null, size: null }, spans: [] }
      : rich,
  );
  // A draft may carry the plain text and the rich record separately; the plain
  // text wins for the string, the rich record wins for the ranges.
  const hookModel = {
    present: hookText.trim().length > 0,
    text: hookText,
    base: effectiveRich.base,
    spans: effectiveRich.spans,
    runs: buildRuns(hookText, effectiveRich.spans),
    position: d.hook_position || 'top',
    size: d.hook_size || 'M',
    style: d.hook_style || 'classic',
    entranceAnimation: d.hook_entrance || 'spring',
    durationSec: num(d.hook_duration, 5),
  };

  // --- B. On-video Header (visual overlay) --------------------------------
  const to = d.title_overlay && typeof d.title_overlay === 'object' ? d.title_overlay : {};
  const headerModel = {
    enabled: !!to.enabled && str(to.text).trim().length > 0,
    text: str(to.text),
    position: to.position || 'top',
    alignment: to.alignment || 'center',
    fontFamily: to.font_family || 'Verdana',
    fontSize: num(to.font_size, 40),
    color: to.text_color || '#FFFFFF',
    background: to.background || 'box',
    backgroundColor: to.background_color || '#000000',
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

/**
 * True when a state has anything to draw over the frame. Used by the preview
 * layer to skip work on an empty draft.
 */
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
  const rich = hookPersistencePayload({ text: hook.text, base: hook.base, spans: hook.spans });
  if (rich && typeof rich === 'object') {
    payload.base = rich.base;
    payload.spans = rich.spans;
  }
  return payload;
}

/**
 * The draft fields the editor persists and re-hydrates for the Hook. Keeping
 * this in one place is what makes "survives save → reload" testable.
 */
export function hookDraftFields(rich, opts = {}) {
  return {
    hook: normalizeRichHook(rich).text,
    hook_rich: hookPersistencePayload(rich),
    hook_position: opts.position ?? 'top',
    hook_size: opts.size ?? 'M',
    hook_style: opts.style ?? 'classic',
    hook_duration: opts.duration ?? 5,
    hook_entrance: opts.entrance ?? 'spring',
  };
}
