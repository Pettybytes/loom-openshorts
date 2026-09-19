import React, { useState } from 'react';
import TextOverlayPreview from './TextOverlayPreview';
import { FRAME_ASPECT, canvasLayout } from '../lib/overlayLayout';

/** The render output is 9:16; the video's own metadata overrides this on load. */
export const DEFAULT_FRAME_ASPECT = FRAME_ASPECT;

/**
 * PreviewSurface — THE one preview surface.
 *
 * The primary editor preview and both range modals render this same component,
 * so there is exactly one layout calculation feeding every surface and no
 * per-surface offsets can exist.
 *
 * TWO LAYOUT MODES, both legitimate (see overlayLayout.js):
 *
 *   'overlay'  — canvas IS the video; the Header draws over it inside a top
 *                band. The accepted geometry, and the default.
 *   'dedicated'— the canvas is TALLER than the video: a real black band is
 *                reserved at the top for the Header and the video is drawn in
 *                the space below it. The band is compositional space, not an
 *                overlay, so the Header has a genuine black region of its own.
 *
 * In both modes the canvas is pinned to an exact aspect ratio and the frame is
 * capped by WIDTH only. A container without an aspect ratio (or a max-height
 * cap) letterboxes the video and was exactly what made the two surfaces
 * disagree before — so neither is reintroduced here.
 *
 * The frame is also the container-query context, so the Hook's `cqw` font sizing
 * resolves against the video width (5% of it, matching hooks.py) rather than a
 * wider wrapper.
 */
export default function PreviewSurface({
    videoUrl,
    videoRef,
    header,
    hook,
    region = 'overlay',
    currentTime = 0,
    onTimeUpdate,
    maxWidth = 420,
    className = '',
    children,
}) {
    const [videoAspect, setVideoAspect] = useState(FRAME_ASPECT);
    const canvas = canvasLayout(region, videoAspect);

    return (
        <div className={`w-full flex justify-center ${className}`}>
            <div
                className="relative w-full bg-black"
                style={{
                    aspectRatio: `${canvas.canvasAspect}`,
                    maxWidth,
                    containerType: 'inline-size',
                }}
                data-testid="preview-frame"
                data-frame-mode={canvas.mode}
                data-video-top={`${canvas.videoTopPct}`}
            >
                <video
                    ref={videoRef}
                    src={videoUrl}
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        width: '100%',
                        // In 'dedicated' the video starts below the black band and
                        // fills the remaining space exactly; in 'overlay' it is the
                        // whole canvas.
                        top: `${canvas.videoTopPct}%`,
                        height: `${canvas.videoHeightPct}%`,
                        objectFit: 'contain',
                    }}
                    controls
                    muted
                    playsInline
                    autoPlay
                    loop
                    onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (v?.videoWidth && v?.videoHeight) {
                            setVideoAspect(v.videoWidth / v.videoHeight);
                        }
                    }}
                    onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget.currentTime)}
                />
                <TextOverlayPreview
                    header={header}
                    hook={hook}
                    currentTime={currentTime}
                />
                {children}
            </div>
        </div>
    );
}
