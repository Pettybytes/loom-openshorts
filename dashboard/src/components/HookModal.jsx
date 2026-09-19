import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from './ui/Modal';
import SegmentedControl from './ui/SegmentedControl';
import TextOverlayPreview from './TextOverlayPreview';
import RangeStyleControls from './RangeStyleControls';
import { buildPreviewState } from '../lib/editorPreviewState';
import { normalizeRich, emptyBase } from '../lib/richText';
import { keepSelection } from '../lib/rangeSelection';
import {
    HOOK_STYLE_OPTIONS,
    HOOK_LOOKS,
    HOOK_POSITION_OPTIONS,
    HOOK_SIZE_OPTIONS,
    HOOK_ENTRANCE_OPTIONS,
    SIZE_SCALE,
} from '../lib/hookStyles';

// Last-used hook settings, restored on the next open (style always reset to
// classic otherwise, which users read as the picker being broken).
function loadHookPrefs() {
    try { return JSON.parse(localStorage.getItem('os_hook_prefs')) || {}; } catch { return {}; }
}

/**
 * Hook modal — edits CONCEPT C (the on-video Hook) and nothing else.
 *
 * The preview is the shared <TextOverlayPreview>, fed by the same
 * `buildPreviewState()` conversion the primary editor preview uses, so the modal
 * and the primary preview cannot disagree. Range styling uses the shared
 * RangeStyleControls — the same component the Header modal uses.
 */
export default function HookModal({
    isOpen, onClose, onGenerate, onRemove, isProcessing,
    videoUrl, cleanVideoUrl,
    initialText, initialRich, headerPreview,
    initialPosition, initialSize, initialStyle, initialDuration, initialEntrance,
    durationInSeconds, existingSubtitles, hasCaptions, serverRender, burnedHook,
}) {
    const prefs = loadHookPrefs();
    const [text, setText] = useState(initialText || 'POV: You are using the viral hook feature');
    const [position, setPosition] = useState(initialPosition || prefs.position || 'top');
    const [size, setSize] = useState(initialSize || prefs.size || 'M');
    const [style, setStyle] = useState(initialStyle || prefs.style || 'classic');
    const [entranceAnimation, setEntranceAnimation] = useState(initialEntrance || prefs.entranceAnimation || 'spring');
    const [displayDuration, setDisplayDuration] = useState(initialDuration || 5);

    // Range-based rich text: base (colour/font) + half-open [start, end) spans.
    const [richBase, setRichBase] = useState(emptyBase());
    const [richSpans, setRichSpans] = useState([]);
    const [selection, setSelection] = useState({ start: 0, end: 0 });
    const [currentTime, setCurrentTime] = useState(0);

    const textareaRef = useRef(null);

    // Hydrate the CURRENT hook whenever the modal opens (or its source hook
    // changes) so the user edits the existing burned hook rather than starting
    // from unrelated/default text. Runs on every open, not just first mount.
    useEffect(() => {
        if (!isOpen) return;
        setText(initialText || 'POV: You are using the viral hook feature');
        setPosition(initialPosition || prefs.position || 'top');
        setSize(initialSize || prefs.size || 'M');
        setStyle(initialStyle || prefs.style || 'classic');
        setEntranceAnimation(initialEntrance || prefs.entranceAnimation || 'spring');
        setDisplayDuration(initialDuration || 5);
        const hydrated = normalizeRich(initialRich);
        setRichBase(hydrated.base);
        setRichSpans(hydrated.spans);
        setSelection({ start: 0, end: 0 });
    }, [isOpen, initialText, initialRich, initialPosition, initialSize, initialStyle, initialDuration, initialEntrance]);

    // Live preview model — the same conversion the primary preview uses.
    const previewState = useMemo(() => buildPreviewState({
        hook: text,
        hook_rich: { text, base: richBase, spans: richSpans },
        hook_position: position,
        hook_size: size,
        hook_style: style,
        hook_duration: displayDuration,
        hook_entrance: entranceAnimation,
    }), [text, richBase, richSpans, position, size, style, displayDuration, entranceAnimation]);

    if (!isOpen) return null;

    // When the clip already has a burned hook, preview the new hook over the
    // CLEAN source (no burned hook underneath) — replacement, never stacking.
    const previewVideoUrl = cleanVideoUrl || videoUrl;

    const hookConfig = {
        text: text || 'Enter your text...',
        position,
        size,
        style,
        entranceAnimation,
        displayDurationSec: displayDuration,
    };

    /** Read the live selection, but never let an empty reading clear a range.
     *
     * Clicking a swatch blurs the textarea and browsers then report 0/0, which
     * would wipe the range and silently redirect the patch to the base style.
     * A real selection is therefore sticky, and there is no blur sync at all. */
    const syncSelection = () => {
        const el = textareaRef.current;
        if (!el) return;
        const next = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
        setSelection((current) => keepSelection(current, next, text.length));
    };

    // One handler for both scopes: RangeStyleControls decides whether a patch
    // targets the selected range or the hook's base style.
    const handleRichChange = (next) => {
        setRichBase(next.base);
        setRichSpans(next.spans);
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" eyebrow="EDITOR · HOOK" title="viral hook">
            <div className="flex flex-col md:flex-row gap-6">
                {/* Left: Preview — the SAME overlay surface as the primary preview */}
                <div className="flex-1 flex flex-col items-center justify-center bg-black rounded-card border border-rule overflow-hidden relative aspect-[9/16] max-h-[600px]">
                    <video
                        src={previewVideoUrl}
                        className="w-full h-full object-contain"
                        controls
                        muted
                        playsInline
                        autoPlay
                        loop
                        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    />
                    <TextOverlayPreview
                        header={headerPreview}
                        hook={previewState.hook}
                        currentTime={currentTime}
                    />
                </div>

                {/* Right: Controls */}
                <div className="w-full md:w-80 flex flex-col">
                    <div className="space-y-5 flex-1 overflow-y-auto custom-scrollbar pr-1">
                        {/* Text Input */}
                        <div>
                            <p className="eyebrow mb-2">Text</p>
                            <textarea
                                ref={textareaRef}
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                onSelect={syncSelection}
                                onKeyUp={syncSelection}
                                onMouseUp={syncSelection}
                                onClick={syncSelection}
                                rows={4}
                                className="input-field resize-none font-serif"
                                style={{ fontFamily: 'Noto Serif, serif' }}
                                placeholder="Enter text that will stop the scroll..."
                            />
                            <p className="text-[11px] text-muted mt-1.5 leading-relaxed">
                                Select any part of the text to give just that range its
                                own colour, font and size.
                            </p>
                        </div>

                        {/* Shared range styling (identical component in the Header modal) */}
                        <RangeStyleControls
                            text={text}
                            rich={{ text, base: richBase, spans: richSpans }}
                            selection={selection}
                            onChange={handleRichChange}
                            sizeMode="token"
                            baseFontPx={54}
                            hint="Sizes are relative to the hook's own size, so a range can be larger or smaller without resizing the whole hook."
                        />

                        {/* Style (whole-hook look) */}
                        <div>
                            <p className="eyebrow mb-2">Style</p>
                            <div className="grid grid-cols-3 gap-1.5">
                                {HOOK_STYLE_OPTIONS.map((s) => {
                                    const look = HOOK_LOOKS[s.value] || HOOK_LOOKS.classic;
                                    return (
                                        <button
                                            key={s.value}
                                            onClick={() => setStyle(s.value)}
                                            className={`px-1 py-2 rounded-input border text-xs transition-colors
                                                ${style === s.value ? 'border-[color:var(--color-accent)]' : 'border-rule2 hover:border-[color:var(--color-accent)]'}`}
                                            title={s.label}
                                        >
                                            <span
                                                className="block rounded px-1 py-1 font-bold"
                                                style={{
                                                    backgroundColor: look.box ?? 'transparent',
                                                    color: look.text,
                                                    textShadow: look.outlinePx > 0 ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000' : 'none',
                                                }}
                                            >Aa</span>
                                            <span className="block mt-1 text-muted">{s.label}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Position Control */}
                        <div>
                            <p className="eyebrow mb-2">Position</p>
                            <SegmentedControl
                                options={HOOK_POSITION_OPTIONS}
                                value={position}
                                onChange={setPosition}
                                size="sm"
                            />
                            {position === 'bottom' && hasCaptions && (
                                <p className="text-[11px] text-warn mt-1.5 leading-relaxed">
                                    This clip has captions near the bottom — the hook may
                                    overlap them (and TikTok's UI). Top is the safe zone.
                                </p>
                            )}
                        </div>

                        {/* Size Control — the hook's own BASE size */}
                        <div>
                            <p className="eyebrow mb-2">Size</p>
                            <SegmentedControl
                                options={HOOK_SIZE_OPTIONS}
                                value={size}
                                onChange={setSize}
                                size="sm"
                            />
                            <p className="readout mt-1.5">
                                base {Math.round((SIZE_SCALE[size] ?? 1) * 100)}% · range sizes multiply on top
                            </p>
                        </div>

                        {/* Entrance Animation (new) */}
                        <div className={serverRender ? 'opacity-50' : ''}>
                            <p className="eyebrow mb-2">Entrance</p>
                            <SegmentedControl
                                options={HOOK_ENTRANCE_OPTIONS}
                                value={entranceAnimation}
                                onChange={setEntranceAnimation}
                                columns={2}
                                size="sm"
                            />
                            {serverRender && (
                                <p className="text-[11px] text-muted mt-1.5 leading-relaxed">
                                    This clip re-renders on the server, where the hook is
                                    static — the entrance animation won't apply.
                                </p>
                            )}
                        </div>

                        {/* Display Duration (new) */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <p className="eyebrow">Duration</p>
                                <span className="readout">{displayDuration}S</span>
                            </div>
                            <input
                                type="range"
                                min="2"
                                max="15"
                                value={displayDuration}
                                onChange={(e) => setDisplayDuration(parseInt(e.target.value))}
                                className="w-full accent-[var(--color-accent)]"
                            />
                            <div className="flex justify-between">
                                <span className="readout">2S</span>
                                <span className="readout">15S</span>
                            </div>
                            <p className="text-[11px] text-muted mt-1.5 leading-relaxed">
                                The hook shows for the first {displayDuration}s of the clip,
                                then clears — scrub to confirm.
                            </p>
                        </div>

                        {burnedHook && (
                            <div className="p-3 border border-rule rounded-input text-xs text-muted space-y-2">
                                <p>
                                    This clip has a hook burned in ("{burnedHook}").
                                    Generating replaces it with the new one.
                                </p>
                                {onRemove && (
                                    <button
                                        onClick={onRemove}
                                        disabled={isProcessing}
                                        className="text-warn underline underline-offset-2 hover:opacity-80 transition-opacity"
                                    >
                                        remove hook from clip
                                    </button>
                                )}
                            </div>
                        )}

                        <div className="p-3 border border-rule rounded-input text-xs text-muted space-y-1">
                            <p>Tip: keep it short and punchy. Using "POV:" or specific questions works best for retention.</p>
                            <p>
                                This is the on-video hook only — the clip title and the social
                                caption are separate and never drawn over the frame.
                            </p>
                        </div>
                    </div>

                    <div className="flex gap-2 mt-5 shrink-0">
                        <button onClick={onClose} className="btn-ghost">
                            cancel
                        </button>
                        <button
                            onClick={() => {
                                try {
                                    localStorage.setItem('os_hook_prefs', JSON.stringify({
                                        style, position, size, entranceAnimation,
                                    }));
                                } catch { /* ignore */ }
                                onGenerate({
                                    text, position, size, style,
                                    entranceAnimation,
                                    // Structured rich text is the saved shape; the
                                    // plain text still travels for compatibility.
                                    rich: { text, base: richBase, spans: richSpans },
                                    // Remotion data
                                    remotion: hookConfig,
                                });
                            }}
                            disabled={isProcessing || !text.trim()}
                            className="btn-primary flex-1"
                        >
                            {isProcessing && <Loader2 size={16} className="animate-spin text-brassink" />}
                            {isProcessing ? 'generating...' : 'add hook'}
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
