/**
 * hookStyles.js — the ONE source of truth for hook/overlay looks and geometry.
 *
 * These values are mirrored by three consumers, which is exactly why they must
 * live in one place:
 *   - the browser previews (TextOverlayPreview)
 *   - the Remotion composition (remotion/compositions/HookOverlay.tsx)
 *   - the server burn (openshorts/hooks.py HOOK_STYLES / overlay geometry)
 *
 * Previews are rendered at their own pixel size, so font sizes are expressed as
 * a FRACTION of the composition width (hooks.py: 5% of target width) and scaled
 * by the S/M/L vocabulary the UI already exposes.
 */

import { SIZE_SCALE } from './richText.js';

export { SIZE_SCALE };

/** Base hook font size as a fraction of composition width (mirrors hooks.py). */
export const HOOK_BASE_FONT_FRACTION = 0.05;

/** Picker options — labels/values must mirror hooks.py HOOK_STYLES keys. */
export const HOOK_STYLE_OPTIONS = [
  { value: 'classic', label: 'Classic' },
  { value: 'dark', label: 'Dark' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'red', label: 'Red' },
  { value: 'outline', label: 'Outline' },
  { value: 'outline_yellow', label: 'Outline+' },
];

/**
 * Render looks. `box: null` means "no card" (outline-only look).
 * Mirrors hooks.py HOOK_STYLES and remotion/compositions/HookOverlay.tsx.
 */
export const HOOK_LOOKS = {
  classic: { box: 'rgba(255, 255, 255, 0.94)', text: '#000000', outlinePx: 0, shadow: true },
  dark: { box: 'rgba(18, 18, 20, 0.92)', text: '#FFFFFF', outlinePx: 0, shadow: true },
  yellow: { box: 'rgba(255, 214, 0, 0.96)', text: '#000000', outlinePx: 0, shadow: true },
  red: { box: 'rgba(220, 38, 38, 0.96)', text: '#FFFFFF', outlinePx: 0, shadow: true },
  outline: { box: null, text: '#FFFFFF', outlinePx: 8, shadow: false },
  outline_yellow: { box: null, text: '#FFD600', outlinePx: 8, shadow: false },
};

export function hookLook(style) {
  return HOOK_LOOKS[style] || HOOK_LOOKS.classic;
}

/**
 * Hook anchors now come from the shared placement contract
 * (lib/overlayLayout.js), so the preview, the geometry tests and hooks.py cannot
 * drift apart. Re-exported under the historical name for existing consumers.
 */
export { HOOK_ANCHOR_PCT as HOOK_POSITION_PCT } from './overlayLayout.js';

export const HOOK_POSITION_OPTIONS = [
  { value: 'top', label: 'top' },
  { value: 'center', label: 'center' },
  { value: 'bottom', label: 'bottom' },
];

export const HOOK_SIZE_OPTIONS = [
  { value: 'S', label: 'Small' },
  { value: 'M', label: 'Medium' },
  { value: 'L', label: 'Large' },
];

export const HOOK_ENTRANCE_OPTIONS = [
  { value: 'spring', label: 'Bounce' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide-up', label: 'Slide Up' },
  { value: 'none', label: 'None' },
];

/**
 * Font size (in px) for a run, given the preview/composition width.
 * `runSize` is an optional per-range S/M/L override.
 */
export function hookFontSizePx(containerWidth, hookSize, runSize) {
  const base = Number(containerWidth) * HOOK_BASE_FONT_FRACTION;
  const globalScale = SIZE_SCALE[hookSize] ?? 1;
  const runScale = runSize ? (SIZE_SCALE[runSize] ?? 1) : 1;
  return Math.max(1, base * globalScale * runScale);
}
