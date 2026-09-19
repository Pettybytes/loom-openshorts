/**
 * overlayLayout.js — the ONE placement contract for the two on-video overlays.
 *
 * Rich text is shared between the Header and the Hook. PLACEMENT IS NOT.
 *
 *   ┌──────────────────────────────┐
 *   │ ON-VIDEO HEADER              │  HEADER_REGION  0% .. 14%
 *   │ dedicated upper black region │
 *   ├──────────────────────────────┤
 *   │ video content                │  HOOK_REGION   16% .. 100%
 *   │ Hook overlay when active     │
 *   └──────────────────────────────┘
 *
 * The two regions are disjoint and the gap between them is the guarantee: the
 * Header's box can never cross into the Hook's region, so a large Header font,
 * a large span, a long wrapped Header, a large Hook, a moving Hook or a Hook
 * that disappears at its duration can none of them move the other element.
 *
 * Every value the renderer uses comes from this module, so the geometry that
 * ships is the geometry the tests assert — not a set of pixel offsets tuned to
 * one fixture.
 */

import { hookVisibleAt } from './editorPreviewState.js';

/** Dedicated upper black region, in % of frame height. */
export const HEADER_REGION = Object.freeze({ top: 0, bottom: 14 });

/** The video region, in % of frame height. Starts below HEADER_REGION. */
export const HOOK_REGION = Object.freeze({ top: 16, bottom: 100 });

/**
 * The Header's two positions, BOTH inside HEADER_REGION:
 *   upper — hugging the top edge of its region
 *   top   — sitting lower inside its region (the previous default)
 */
export const HEADER_ANCHOR_PCT = Object.freeze({ upper: 3, top: 9 });

/** The Hook's anchors inside HOOK_REGION (unchanged: hooks.py uses the same). */
export const HOOK_ANCHOR_PCT = Object.freeze({ top: 20, center: 50, bottom: 70 });

/** Horizontal inset for both elements. */
export const OVERLAY_PADDING_PCT = 8;

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** The Header's band, in frame %. */
export function headerBand() {
  return {
    topPct: HEADER_REGION.top,
    heightPct: HEADER_REGION.bottom - HEADER_REGION.top,
  };
}

/** Resolve a Header position to a frame-% anchor, clamped into its region. */
export function headerAnchorPct(position) {
  const requested = HEADER_ANCHOR_PCT[position];
  const anchor = requested == null ? HEADER_ANCHOR_PCT.top : requested;
  return clamp(anchor, HEADER_REGION.top, HEADER_REGION.bottom);
}

/**
 * The Header's offset from the top of its BAND, in band-relative % — this is
 * literally what the renderer feeds to CSS `top` inside the band element.
 */
export function headerInnerTopPct(position) {
  const band = headerBand();
  const anchor = headerAnchorPct(position);
  return ((anchor - band.topPct) / band.heightPct) * 100;
}

/** Resolve a Hook position to a frame-% anchor, clamped into its region. */
export function hookAnchorPct(position) {
  const requested = HOOK_ANCHOR_PCT[position];
  const anchor = requested == null ? HOOK_ANCHOR_PCT.top : requested;
  return clamp(anchor, HOOK_REGION.top, HOOK_REGION.bottom);
}

/**
 * The Header's box. `bottomPct` is the band floor, not a measured height: the
 * band clips, which is what makes "the Header cannot enter the Hook region" a
 * property of the contract rather than of the current text.
 */
export function headerBox(header) {
  if (!header?.enabled) return null;
  const position = header.position || 'top';
  const topPct = headerAnchorPct(position);
  return {
    region: 'header',
    position,
    topPct,
    bottomPct: HEADER_REGION.bottom,
    heightPct: HEADER_REGION.bottom - topPct,
    innerTopPct: headerInnerTopPct(position),
    paddingPct: OVERLAY_PADDING_PCT,
  };
}

/** The Hook's box. Null when the Hook is absent or outside its time window. */
export function hookBox(hook, { visible = true } = {}) {
  if (!hook?.present || !visible) return null;
  const position = hook.position || 'top';
  return {
    region: 'hook',
    position,
    topPct: hookAnchorPct(position),
    paddingPct: OVERLAY_PADDING_PCT,
  };
}

/** True when the Hook should be on screen at `currentTime` (its own semantics). */
export function hookVisibleAtTime(hook, currentTime) {
  if (!hook?.present) return false;
  return hookVisibleAt(currentTime, hook.durationSec);
}

/**
 * The full layout for a preview state at a given moment.
 *
 * Note what is NOT a parameter: the Header box depends only on the Header, so
 * scrubbing and Hook visibility cannot move it.
 */
export function layoutOverlays({ header, hook, currentTime = 0 } = {}) {
  return {
    header: headerBox(header),
    hook: hookBox(hook, { visible: hookVisibleAtTime(hook, currentTime) }),
  };
}

/** True when the two boxes would occupy the same vertical space. */
export function overlaysCollide(layout) {
  if (!layout?.header || !layout?.hook) return false;
  return layout.header.bottomPct > layout.hook.topPct;
}
