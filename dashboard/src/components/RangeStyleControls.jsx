import React from 'react';
import {
    normalizeRich,
    SIZE_SCALE,
    RICH_FONTS,
} from '../lib/richText';
import {
    applySelectionPatch,
    clearSelectionStyle,
    styleAtSelection,
    hasRange,
} from '../lib/rangeSelection';

/**
 * RangeStyleControls — the ONE range-styling UI, shared by the Hook modal and
 * the Header modal, so both elements expose the identical interaction from one
 * implementation.
 *
 * FOCUS DISCIPLINE (this is what made Header selection fail):
 * a swatch/clear button must not steal focus from the textarea. Focus loss makes
 * browsers report an empty selection, and a naive re-sync then wipes the live
 * range and silently redirects the patch to the base style. So:
 *   - action buttons call preventDefault() on mousedown, keeping the caret alive;
 *   - the modal hands us a STICKY selection (an empty reading cannot clear it);
 *   - selects/inputs are left alone, since preventDefault would break the
 *     dropdown and the sticky selection already covers them.
 *
 * `sizeMode` only changes how a size is OFFERED (the Hook's S/M/L vs the
 * Header's px targets); both store a multiplier of the element's base size.
 * Size is meaningless without a range, so it is disabled until text is selected.
 * An element's base size keeps living in its own dedicated control.
 */
export default function RangeStyleControls({
    text,
    rich,
    selection,
    onChange,
    sizeMode = 'token',
    baseFontPx = 40,
    hint,
}) {
    const value = normalizeRich(rich);
    const textLength = (text || '').length;
    const hasText = (text || '').trim().length > 0;
    const selected = hasRange(selection, textLength);
    const selectedText = selected ? text.slice(selection.start, selection.end) : '';
    const disabled = !hasText;

    const applyPatch = (patch) => {
        if (!hasText) return;
        const result = applySelectionPatch(value, selection, patch, { textLength });
        onChange(result.value, { scope: result.scope });
    };

    const clearRange = () => {
        if (!hasText) return;
        const result = clearSelectionStyle(value, selection, { textLength });
        onChange(result.value, { scope: result.scope });
    };

    const activeRun = styleAtSelection(value, selection, { textLength });
    const currentSize = activeRun?.size ?? null;
    const currentPx = currentSize ? Math.round(baseFontPx * currentSize) : null;
    const tokenFor = (multiplier) =>
        Object.keys(SIZE_SCALE).find((k) => SIZE_SCALE[k] === multiplier) || null;

    // Buttons must not blur the textarea — that is the whole ballgame.
    const holdFocus = (e) => e.preventDefault();

    return (
        <div className="border border-rule rounded-input p-3 space-y-3">
            <div>
                <p className="eyebrow mb-1">selected range</p>
                <p className="text-[11px] text-muted break-words" data-testid="selected-range-readout">
                    {selected ? <span className="text-ink">“{selectedText}”</span> : null}{' '}
                    {selected
                        ? `${selectedText.length} char${selectedText.length === 1 ? '' : 's'} · ${selection.start}–${selection.end}`
                        : 'no selection — controls set the base style'}
                </p>
            </div>

            <div>
                <p className="eyebrow mb-1.5">Range colour</p>
                <div className="flex flex-wrap gap-1.5 items-center">
                    {RANGE_SWATCHES.map((c) => (
                        <button
                            key={c}
                            type="button"
                            disabled={disabled}
                            onMouseDown={holdFocus}
                            onClick={() => applyPatch({ color: c })}
                            title={`colour ${c} for the selection`}
                            className="w-7 h-7 rounded border border-rule2 hover:border-[color:var(--color-accent)] disabled:opacity-40"
                            style={{ backgroundColor: c }}
                        />
                    ))}
                    <input
                        type="color"
                        disabled={disabled}
                        value={activeRun?.color || value.base.color || '#FFD600'}
                        onChange={(e) => applyPatch({ color: e.target.value })}
                        title="custom colour"
                        className="input-field !w-14 !h-8 !p-0.5"
                    />
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-muted">Range font
                    <select
                        disabled={disabled}
                        value={activeRun?.font || (selected ? '' : (value.base.font || ''))}
                        onChange={(e) => applyPatch({ font: e.target.value || null })}
                        className="input-field !py-1.5 mt-1"
                    >
                        <option value="">{selected ? 'keep / inherit' : 'default'}</option>
                        {RICH_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                </label>

                <label className="text-[11px] text-muted">
                    {sizeMode === 'px' ? 'Range size (px)' : 'Range size'}
                    {sizeMode === 'px' ? (
                        <input
                            type="number"
                            min="8"
                            max="320"
                            // Enabled as soon as there is text, so a size can be
                            // typed after selecting; the patch still only lands on
                            // a real range.
                            disabled={disabled || !selected}
                            value={currentPx ?? ''}
                            placeholder={selected ? String(baseFontPx) : 'select text'}
                            onChange={(e) => {
                                const px = Number(e.target.value);
                                if (!Number.isFinite(px) || px <= 0) return;
                                applyPatch({ size: px / (baseFontPx || 40) });
                            }}
                            className="input-field !py-1.5 mt-1"
                        />
                    ) : (
                        <select
                            disabled={disabled || !selected}
                            value={tokenFor(currentSize) || ''}
                            onChange={(e) => {
                                const sizeKey = e.target.value || null;
                                applyPatch({ size: sizeKey ? SIZE_SCALE[sizeKey] : null });
                            }}
                            className="input-field !py-1.5 mt-1"
                        >
                            <option value="">{selected ? 'keep / inherit' : 'select text'}</option>
                            {Object.keys(SIZE_SCALE).map((k) => (
                                <option key={k} value={k}>{k} (×{SIZE_SCALE[k]})</option>
                            ))}
                            {currentSize && !tokenFor(currentSize) ? (
                                <option value="">×{currentSize} (custom)</option>
                            ) : null}
                        </select>
                    )}
                </label>
            </div>

            {selected && currentPx ? (
                <p className="readout">this range renders at ≈{currentPx}px (base {Math.round(baseFontPx)}px)</p>
            ) : null}

            <button
                type="button"
                onMouseDown={holdFocus}
                onClick={clearRange}
                disabled={disabled}
                className="text-xs text-muted underline underline-offset-2 hover:text-ink disabled:opacity-40"
            >
                {selected ? 'clear styling on selection' : 'clear base styling'}
            </button>

            {hint ? <p className="text-[11px] text-muted leading-relaxed">{hint}</p> : null}
        </div>
    );
}

const RANGE_SWATCHES = ['#FFD600', '#FF0000', '#FFFFFF', '#000000', '#00E5FF', '#00FF00'];
