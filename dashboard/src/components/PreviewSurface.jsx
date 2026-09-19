import React, { useState } from 'react';
import TextOverlayPreview from './TextOverlayPreview';

/** The render output is 9:16; the video's own metadata overrides this on load. */
export const DEFAULT_FRAME_ASPECT = '9 / 16';

/**
 * PreviewSurface — THE one preview surface.
 *
 * The primary editor preview and both range modals render this same component,
 * so there is exactly one layout calculation feeding every surface and no
 * per-surface offsets can exist.
 *
 * THE POINT OF THIS COMPONENT (the geometry-parity defect it fixes):
 * an overlay position is a percentage of the VIDEO FRAME, which is what
 * hooks.py burns against. The old main preview sized its box with
 * `lg:aspect-auto lg:h-auto`, so its container was ~420x1000 — NOT 9:16 — and
 * the 9:16 video was letterboxed inside it. The header band (0-14%) then fell
 * mostly in the black bar ("too high") and the Hook at 20% landed just under the
 * video's top edge ("sitting on the boundary"). The modal, whose container WAS
 * 9:16, looked right. Same normalized values, different frames.
 *
 * So the frame element's aspect ratio is pinned to the video's own aspect and
 * the video fills it exactly: no letterbox, no coordinate transformation, and
 * identical normalized geometry lands identically on both surfaces.
 *
 * The frame is capped by WIDTH, never by height — a `max-height` would break the
 * aspect ratio and reintroduce exactly the divergence this removes.
 *
 * The frame is also the container-query context, so the Hook's `cqw` font sizing
 * resolves against the frame width (5% of the frame, matching hooks.py) rather
 * than against some wider wrapper.
 */
export default function PreviewSurface({
    videoUrl,
    videoRef,
    header,
    hook,
    currentTime = 0,
    onTimeUpdate,
    maxWidth = 420,
    className = '',
    children,
}) {
    const [aspect, setAspect] = useState(DEFAULT_FRAME_ASPECT);

    return (
        <div className={`w-full flex justify-center ${className}`}>
            <div
                className="relative w-full bg-black"
                // Pinned aspect + width-only cap: the frame IS the video box.
                style={{ aspectRatio: aspect, maxWidth, containerType: 'inline-size' }}
                data-testid="preview-frame"
                data-frame-aspect={aspect}
            >
                <video
                    ref={videoRef}
                    src={videoUrl}
                    className="absolute inset-0 w-full h-full object-contain"
                    controls
                    muted
                    playsInline
                    autoPlay
                    loop
                    onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (v?.videoWidth && v?.videoHeight) {
                            setAspect(`${v.videoWidth} / ${v.videoHeight}`);
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
