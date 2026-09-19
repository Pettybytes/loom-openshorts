import React, { useState, useEffect, useMemo, useRef } from 'react';
import Modal from './ui/Modal';
import TextOverlayPreview from './TextOverlayPreview';
import RangeStyleControls from './RangeStyleControls';
import { normalizeRich, buildRuns } from '../lib/richText';

/**
 * HeaderModal — edits CONCEPT B (the on-video Header) and nothing else.
 *
 * This is the SAME interaction model already proven for the Hook: select text,
 * style just that range. It reuses RangeStyleControls and renders the shared
 * TextOverlayPreview, so a range styled here appears identically in the primary
 * preview — and cannot disagree with it, because both render the same model.
 *
 * Clip Title and Social Caption are deliberately absent: they are metadata and
 * are never drawn on the video.
 */
export default function HeaderModal({
    isOpen, onClose, onApply,
    videoUrl,
    initialText, initialRich,
    initialPosition, initialAlignment,
    initialFontFamily, initialFontSize, initialColor,
    initialBackground, initialBackgroundColor,
    hookPreview,
}) {
    const [text, setText] = useState(initialText || '');
    const [richBase, setRichBase] = useState({ color: null, font: null });
    const [richSpans, setRichSpans] = useState([]);
    const [fontFamily, setFontFamily] = useState(initialFontFamily || 'Verdana');
    const [fontSize, setFontSize] = useState(initialFontSize || 40);
    const [color, setColor] = useState(initialColor || '#FFFFFF');
    const [selection, setSelection] = useState({ start: 0, end: 0 });
    const [currentTime, setCurrentTime] = useState(0);

    const textareaRef = useRef(null);

    // Hydrate the CURRENT header whenever the modal opens (or its source
    // changes) so the user edits the existing header, not a blank one.
    useEffect(() => {
        if (!isOpen) return;
        setText(initialText || '');
        setFontFamily(initialFontFamily || 'Verdana');
        setFontSize(initialFontSize || 40);
        setColor(initialColor || '#FFFFFF');
        const hydrated = normalizeRich(initialRich);
        setRichBase(hydrated.base);
        setRichSpans(hydrated.spans);
        setSelection({ start: 0, end: 0 });
    }, [isOpen, initialText, initialRich, initialFontFamily, initialFontSize, initialColor]);

    // The preview model, built through the shared conversion so the modal and
    // the primary preview resolve per-run style identically.
    const previewHeader = useMemo(() => {
        const rich = normalizeRich({ text, base: richBase, spans: richSpans });
        return {
            enabled: text.trim().length > 0,
            text,
            base: rich.base,
            spans: rich.spans,
            runs: buildRuns(text, rich.spans),
            position: initialPosition || 'top',
            alignment: initialAlignment || 'center',
            fontFamily,
            fontSize,
            color,
            background: initialBackground || 'box',
            backgroundColor: initialBackgroundColor || '#000000',
        };
    }, [
        text, richBase, richSpans, fontFamily, fontSize, color,
        initialPosition, initialAlignment, initialBackground, initialBackgroundColor,
    ]);

    if (!isOpen) return null;

    const syncSelection = () => {
        const el = textareaRef.current;
        if (!el) return;
        setSelection({ start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
    };

    const handleRichChange = (next) => {
        setRichBase(next.base);
        setRichSpans(next.spans);
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" eyebrow="EDITOR · HEADER" title="on-video header">
            <div className="flex flex-col md:flex-row gap-6">
                {/* Left: Preview — shared overlay surface, same as the primary preview */}
                <div className="flex-1 flex flex-col items-center justify-center bg-black rounded-card border border-rule overflow-hidden relative aspect-[9/16] max-h-[600px]">
                    <video
                        src={videoUrl}
                        className="w-full h-full object-contain"
                        controls
                        muted
                        playsInline
                        autoPlay
                        loop
                        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    />
                    <TextOverlayPreview
                        header={previewHeader}
                        hook={hookPreview || null}
                        currentTime={currentTime}
                    />
                </div>

                {/* Right: Controls */}
                <div className="w-full md:w-80 flex flex-col">
                    <div className="space-y-5 flex-1 overflow-y-auto custom-scrollbar pr-1">
                        <div>
                            <p className="eyebrow mb-2">Header text</p>
                            <textarea
                                ref={textareaRef}
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                onSelect={syncSelection}
                                onKeyUp={syncSelection}
                                onClick={syncSelection}
                                onBlur={syncSelection}
                                rows={3}
                                className="input-field resize-none"
                                placeholder="Text overlaid in the top black region"
                            />
                            <p className="text-[11px] text-muted mt-1.5 leading-relaxed">
                                Select any part of the text to give just that range its
                                own colour, font and size — exactly like the hook.
                            </p>
                        </div>

                        <RangeStyleControls
                            text={text}
                            rich={{ text, base: richBase, spans: richSpans }}
                            selection={selection}
                            onChange={handleRichChange}
                            sizeMode="px"
                            baseFontPx={fontSize}
                            hint="Sizes are px at the video's resolution, so 55px on a 40px header makes just that range larger."
                        />

                        <div>
                            <p className="eyebrow mb-2">Base style</p>
                            <div className="grid grid-cols-2 gap-2">
                                <select
                                    value={fontFamily}
                                    onChange={(e) => setFontFamily(e.target.value)}
                                    className="input-field !py-1.5"
                                >
                                    <option value="Verdana">Verdana</option>
                                    <option value="Arial">Arial</option>
                                    <option value="Impact">Impact</option>
                                    <option value="Helvetica">Helvetica</option>
                                    <option value="Georgia">Georgia</option>
                                    <option value="Courier New">Courier New</option>
                                </select>
                                <label className="text-[11px] text-muted">size (px)
                                    <input
                                        type="number" min="12" max="160" value={fontSize}
                                        onChange={(e) => setFontSize(Number(e.target.value))}
                                        className="input-field mt-1"
                                    />
                                </label>
                            </div>
                            <label className="text-[11px] text-muted block mt-2">base text colour
                                <input
                                    type="color" value={color}
                                    onChange={(e) => setColor(e.target.value)}
                                    className="input-field mt-1 h-9"
                                />
                            </label>
                        </div>

                        <div className="p-3 border border-rule rounded-input text-xs text-muted space-y-1">
                            <p>
                                This is the on-video header only. The clip title and the
                                social caption are separate and never drawn over the frame.
                            </p>
                            <p>
                                With a selection, controls style just that range. With no
                                selection they set the base style / default font.
                            </p>
                        </div>
                    </div>

                    <div className="flex gap-2 mt-5 shrink-0">
                        <button onClick={onClose} className="btn-ghost">cancel</button>
                        <button
                            onClick={() => onApply({
                                text,
                                rich: { text, base: richBase, spans: richSpans },
                                fontFamily,
                                fontSize,
                                color,
                                enabled: text.trim().length > 0,
                            })}
                            disabled={!text.trim()}
                            className="btn-primary flex-1"
                        >
                            apply header
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
