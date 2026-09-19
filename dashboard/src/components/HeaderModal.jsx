import React, { useState, useEffect, useMemo, useRef } from 'react';
import Modal from './ui/Modal';
import PreviewSurface from './PreviewSurface';
import RangeStyleControls from './RangeStyleControls';
import { normalizeRich, buildRuns } from '../lib/richText';
import { keepSelection, normalizeSelection, readSelection } from '../lib/rangeSelection';
import { headerUsableBand } from '../lib/overlayLayout';

/**
 * HeaderModal — edits CONCEPT B (the on-video Header) and nothing else.
 *
 * Same interaction model as the Hook: select text, style just that range.
 * It reuses RangeStyleControls and renders the shared TextOverlayPreview, so a
 * range styled here appears identically in the primary preview.
 *
 * SELECTION DISCIPLINE — three things were wrong before and are fixed here:
 *   1. `onBlur` re-synced the selection from a textarea that had just lost
 *      focus. WebKit reports 0/0 there, so the live range was wiped and the
 *      patch fell through to the BASE style: the whole header changed colour and
 *      the panel said "no selection". There is no blur sync any more.
 *   2. The selection is STICKY (`keepSelection`): an empty reading can never
 *      overwrite a real range, whatever the browser reports.
 *   3. A selection made in the editor's inline header field is carried in as
 *      `initialSelection`, so the interaction works from either entry point.
 *
 * Clip Title and Social Caption are deliberately absent: metadata, never drawn.
 */
export default function HeaderModal({
    isOpen, onClose, onApply,
    videoUrl,
    initialText, initialRich, initialSelection,
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
    // changes). Never wipes a range: the base and spans come from the saved
    // record, and the selection is seeded from wherever the user last selected.
    useEffect(() => {
        if (!isOpen) return;
        const source = initialText || '';
        setText(source);
        setFontFamily(initialFontFamily || 'Verdana');
        setFontSize(initialFontSize || 40);
        setColor(initialColor || '#FFFFFF');
        const hydrated = normalizeRich(initialRich);
        setRichBase(hydrated.base);
        setRichSpans(hydrated.spans);
        setSelection(normalizeSelection(initialSelection, source.length));
    }, [
        isOpen, initialText, initialRich, initialSelection,
        initialFontFamily, initialFontSize, initialColor,
    ]);

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

    /** Read the live selection through the null-safe helper.
     *
     * An unmounted/absent element yields null and we keep what we had, so a
     * missing ref can never crash the editor. A real selection is sticky, so the
     * empty reading a browser reports after focus loss cannot wipe the range. */
    const syncSelection = () => {
        const snapshot = readSelection(textareaRef.current);
        if (!snapshot) return;
        setSelection((current) => keepSelection(current, snapshot, text.length));
    };

    const handleRichChange = (next) => {
        setRichBase(next.base);
        setRichSpans(next.spans);
    };

    const usable = headerUsableBand();

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" eyebrow="EDITOR · HEADER" title="on-video header">
            <div className="flex flex-col md:flex-row gap-6">
                {/* Left: Preview — shared overlay surface, same as the primary preview.
                    The Header's dedicated band is outlined so its region is visible. */}
                <div className="flex-1 flex flex-col items-center justify-center rounded-card border border-rule overflow-hidden">
                    <PreviewSurface
                        videoUrl={videoUrl}
                        header={previewHeader}
                        hook={hookPreview || null}
                        currentTime={currentTime}
                        onTimeUpdate={setCurrentTime}
                        maxWidth={340}
                    >
                        <div
                            className="absolute left-0 right-0 border border-dashed border-white/25 pointer-events-none"
                            style={{ top: `${usable.topPct}%`, height: `${usable.heightPct}%` }}
                            aria-hidden="true"
                        />
                    </PreviewSurface>
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
                                onMouseUp={syncSelection}
                                onClick={syncSelection}
                                rows={3}
                                className="input-field resize-none"
                                placeholder="Text overlaid in the top black region"
                            />
                            <p className="text-[11px] text-muted mt-1.5 leading-relaxed">
                                Select any part of the text — one letter, one word, or
                                several — then restyle just that range.
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
                                The header sits centred in the dashed band at the top
                                of the frame; the hook owns the video area below it.
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
