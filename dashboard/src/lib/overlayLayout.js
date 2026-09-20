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

/** Dedicated upper black region, in % of frame height (the "overlay" mode band). */
export const HEADER_REGION_BOTTOM_PCT = 14;
export const HEADER_REGION = Object.freeze({ top: 0, bottom: HEADER_REGION_BOTTOM_PCT });

/**
 * The two legitimate Header layout modes.
 *
 *   'overlay'   — the Header draws over the video inside a top band. Accepted
 *                 geometry; the DEFAULT.
 *   'dedicated' — the composition reserves a real black band INSIDE the fixed
 *                 9:16 canvas and the video is fitted below it, by height and
 *                 centred. The canvas stays 9:16 in both modes.
 *
 * NOTE for future work: 'dedicated' was never a persisted concept. The old
 * black band was an artifact of the main preview box having no aspect ratio (a
 * taller-than-video container letterboxed the video, and the header band landed
 * in that letterbox). Commit 41c8d9c pinned the frame to the video and removed
 * it. This flag is the explicit, persisted replacement for that accident.
 */
export const HEADER_REGION_MODES = Object.freeze(['overlay', 'dedicated']);
export const DEFAULT_HEADER_REGION = 'overlay';

/** Share of the fixed 9:16 CANVAS height given to the dedicated black band. */
export const DEDICATED_CANVAS_PCT = 18;

/** Coerce anything into a known mode; unknown/absent -> the accepted default. */
export function normalizeHeaderRegion(value) {
  return value === 'dedicated' ? 'dedicated' : DEFAULT_HEADER_REGION;
}

/** The Header's region for a mode, in % of the CANVAS height. */
export function headerRegionFor(mode) {
  return normalizeHeaderRegion(mode) === 'dedicated'
    ? { top: 0, bottom: DEDICATED_CANVAS_PCT }
    : { top: HEADER_REGION.top, bottom: HEADER_REGION.bottom };
}

/**
 * The canvas for a mode. The canvas is ALWAYS the render's fixed 9:16 frame
 * (canvasAspect === FRAME_ASPECT) in BOTH modes:
 *
 *   'overlay'   — the canvas IS the video; the Header draws over it in a band.
 *   'dedicated' — the black band is reserved INSIDE the canvas at the top and
 *                 the video is fitted into the area BELOW it, by height and
 *                 centred (so it is narrower than the canvas). The band is real
 *                 compositional space rather than an overlay.
 */
export function canvasLayout(mode, videoAspect = FRAME_ASPECT) {
  const resolved = normalizeHeaderRegion(mode);
  const videoTopPct = resolved === 'dedicated' ? DEDICATED_CANVAS_PCT : 0;
  const videoHeightPct = 100 - videoTopPct;
  // The canvas is ALWAYS the render's fixed 9:16 frame, in BOTH modes. The
  // dedicated black band is reserved INSIDE that canvas; it is never added
  // above it, so the canvas is never taller than the render.
  const canvasAspect = FRAME_ASPECT;
  // The video is fitted into the area below the band preserving its aspect
  // ratio. That area is only `videoHeightPct` of a 9:16 canvas, so a 9:16 video
  // fits by HEIGHT: it comes out NARROWER than the canvas and is CENTRED, with
  // bars either side. It is never stretched and never scaled to full width.
  const videoWidthPct = Math.min(100, (videoAspect / canvasAspect) * videoHeightPct);
  const videoLeftPct = (100 - videoWidthPct) / 2;
  return {
    mode: resolved,
    videoTopPct,
    videoHeightPct,
    videoWidthPct,
    videoLeftPct,
    videoAspect,
    canvasAspect,
  };
}

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
export function headerBand(mode = DEFAULT_HEADER_REGION) {
  const region = headerRegionFor(mode);
  return {
    topPct: region.top,
    heightPct: region.bottom - region.top,
  };
}

/**
 * The Header's USABLE band: its region minus the safe inset at both edges.
 * This is what the Header is positioned and centred within, and what bounds a
 * large rich-text range.
 */
export function headerUsableBand(mode = DEFAULT_HEADER_REGION) {
  const region = headerRegionFor(mode);
  const regionHeight = region.bottom - region.top;
  const inset = Math.min(HEADER_SAFE_INSET_PCT, regionHeight / 3);
  return {
    topPct: region.top + inset,
    bottomPct: region.bottom - inset,
    heightPct: regionHeight - (2 * inset),
    insetPct: inset,
  };
}

/** Resolve a Header position to a frame-% anchor, clamped into the USABLE band. */
export function headerAnchorPct(position, mode = DEFAULT_HEADER_REGION) {
  const usable = headerUsableBand(mode);
  const requested = HEADER_ANCHOR_PCT[position];
  const anchor = requested == null ? usable.topPct : requested;
  return clamp(anchor, usable.topPct, usable.bottomPct);
}

/**
 * The Header's offset from the top of its BAND, in band-relative % — this is
 * literally what the renderer feeds to CSS `top` inside the band element.
 */
export function headerInnerTopPct(position, mode = DEFAULT_HEADER_REGION) {
  const band = headerBand(mode);
  const anchor = headerAnchorPct(position, mode);
  return ((anchor - band.topPct) / band.heightPct) * 100;
}

/**
 * Resolve a Hook position to a canvas-% anchor inside the VIDEO area.
 *
 * The Hook is placed relative to the VIDEO region rather than the canvas, so its
 * relative placement is identical in both modes — and in 'dedicated' it begins
 * below the black band, which is what guarantees it can never collide with the
 * Header region.
 */
export function hookAnchorPct(position, mode = DEFAULT_HEADER_REGION) {
  const canvas = canvasLayout(mode);
  const requested = HOOK_ANCHOR_PCT[position];
  const fraction = requested == null ? HOOK_ANCHOR_PCT.top : requested;
  const inCanvas = canvas.videoTopPct + (canvas.videoHeightPct / 100) * fraction;
  return clamp(inCanvas, canvas.videoTopPct, 100);
}

/**
 * The Header's box. `bottomPct` is the band floor, not a measured height: the
 * band clips, which is what makes "the Header cannot enter the Hook region" a
 * property of the contract rather than of the current text.
 */
export function headerBox(header) {
  if (!header?.enabled) return null;
  const position = header.position || 'top';
  const mode = normalizeHeaderRegion(header.region);
  const band = headerBand(mode);
  const usable = headerUsableBand(mode);
  const topPct = headerAnchorPct(position, mode);
  return {
    region: 'header',
    mode,
    position,
    // 'top' (the default) is CENTRED inside the usable band; 'upper' hugs the
    // safe top inset. Either way the text stays off both edges.
    align: HEADER_ALIGN[position] ?? HEADER_ALIGN.top,
    topPct,
    bottomPct: band.topPct + band.heightPct,
    heightPct: (band.topPct + band.heightPct) - topPct,
    usable,
    // Where the usable band starts inside the band element, as a % of the band:
    // literally what the renderer feeds to CSS top/bottom.
    insetInBandPct: ((usable.topPct - band.topPct) / band.heightPct) * 100,
    paddingPct: OVERLAY_PADDING_PCT,
  };
}

/** The Hook's box. Null when the Hook is absent or outside its time window. */
export function hookBox(hook, { visible = true, mode = DEFAULT_HEADER_REGION } = {}) {
  if (!hook?.present || !visible) return null;
  const position = hook.position || 'top';
  return {
    region: 'hook',
    mode: normalizeHeaderRegion(mode),
    position,
    topPct: hookAnchorPct(position, mode),
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
  // One mode for the whole composition. It lives on the Header because that is
  // the element whose placement it defines.
  const mode = normalizeHeaderRegion(header?.region);
  return {
    mode,
    canvas: canvasLayout(mode),
    header: headerBox(header),
    hook: hookBox(hook, { visible: hookVisibleAtTime(hook, currentTime), mode }),
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
  return {
    region: box.region,
    mode: box.mode ?? null,
    topPct: box.topPct,
    align: box.align ?? null,
  };
}

/** True when the two boxes would occupy the same vertical space. */
export function overlaysCollide(layout) {
  if (!layout?.header || !layout?.hook) return false;
  return layout.header.bottomPct > layout.hook.topPct;
}
