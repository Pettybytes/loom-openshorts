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
 * Safe breathing room inside the Header region, in frame %, applied at BOTH
 * edges. The Header never touches the top or the bottom of its region, so it
 * reads as intentionally placed instead of crowded against a boundary.
 */
export const HEADER_SAFE_INSET_PCT = 2;

/**
 * The Header's two positions, both inside the USABLE band:
 *   top   — the default; rendered CENTRED in the usable band
 *   upper — anchored to the safe top inset
 * An explicit anchor can never breach the safe padding (see headerAnchorPct).
 */
export const HEADER_ANCHOR_PCT = Object.freeze({ upper: 2, top: 7 });

/** Vertical alignment semantics per position. */
export const HEADER_ALIGN = Object.freeze({ top: 'center', upper: 'flex-start' });

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

/**
 * The Header's USABLE band: its region minus the safe inset at both edges.
 * This is what the Header is actually positioned and centred within, and what
 * bounds a large rich-text range.
 */
export function headerUsableBand() {
  const regionHeight = HEADER_REGION.bottom - HEADER_REGION.top;
  const inset = Math.min(HEADER_SAFE_INSET_PCT, regionHeight / 3);
  return {
    topPct: HEADER_REGION.top + inset,
    bottomPct: HEADER_REGION.bottom - inset,
    heightPct: regionHeight - (2 * inset),
    insetPct: inset,
  };
}

/** Resolve a Header position to a frame-% anchor, clamped into the USABLE band. */
export function headerAnchorPct(position) {
  const requested = HEADER_ANCHOR_PCT[position];
  const anchor = requested == null ? HEADER_ANCHOR_PCT.top : requested;
  const usable = headerUsableBand();
  return clamp(anchor, usable.topPct, usable.bottomPct);
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
  const band = headerBand();
  const usable = headerUsableBand();
  const topPct = headerAnchorPct(position);
  return {
    region: 'header',
    position,
    // 'top' (the default) is CENTRED inside the usable band; 'upper' hugs the
    // safe top inset. Either way the text stays off both edges.
    align: HEADER_ALIGN[position] ?? HEADER_ALIGN.top,
    topPct,
    bottomPct: HEADER_REGION.bottom,
    heightPct: HEADER_REGION.bottom - topPct,
    usable,
    // Where the usable band starts inside the band element, as a % of the band:
    // literally what the renderer feeds to CSS top/bottom.
    insetInBandPct: ((usable.topPct - band.topPct) / band.heightPct) * 100,
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

/** The render frame's intrinsic aspect (the burn output is 9:16). */
export const FRAME_ASPECT = 9 / 16;

/**
 * Fit the render frame inside a viewport box, applying the same rule
 * `object-contain` applies, and return its rect in viewport pixels.
 *
 * Every overlay position is a percentage of THIS rect, so the surface's own
 * size cancels out: identical normalized geometry yields an identical position
 * within the frame at any viewport size. That is the geometry-parity contract,
 * and it is why the modal and the primary preview can no longer disagree.
 */
export function frameRect(viewportWidth, viewportHeight, aspect = FRAME_ASPECT) {
  const vw = Number(viewportWidth);
  const vh = Number(viewportHeight);
  if (!(vw > 0) || !(vh > 0) || !(aspect > 0)) return null;
  const width = Math.min(vw, vh * aspect);
  const height = width / aspect;
  return {
    left: (vw - width) / 2,
    top: (vh - height) / 2,
    width,
    height,
    aspect,
  };
}

/**
 * A normalized frame coordinate in viewport pixels.
 * `topPct` is a percentage of the frame's height; `leftPct` of its width.
 */
export function framePoint(viewportWidth, viewportHeight, topPct, leftPct = 50, aspect = FRAME_ASPECT) {
  const rect = frameRect(viewportWidth, viewportHeight, aspect);
  if (!rect) return null;
  return {
    x: rect.left + (leftPct / 100) * rect.width,
    y: rect.top + (topPct / 100) * rect.height,
    rect,
  };
}

/**
 * The viewport-independent placement an overlay occupies. Two surfaces showing
 * the same state must return the same value here — that is what "parity" means.
 */
export function normalizedPlacement(box) {
  if (!box) return null;
  return { region: box.region, topPct: box.topPct, align: box.align ?? null };
}

/** True when the two boxes would occupy the same vertical space. */
export function overlaysCollide(layout) {
  if (!layout?.header || !layout?.hook) return false;
  return layout.header.bottomPct > layout.hook.topPct;
}
