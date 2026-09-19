import React from 'react';
import {
    applyRangeStyle,
    normalizeRich,
    normalizeBase,
    SIZE_SCALE,
    RICH_FONTS,
} from '../lib/richText';

/**
 * RangeStyleControls — the ONE range-styling UI, shared by the Hook modal and
 * the Header modal.
 *
 * Both elements therefore expose the same interaction (select text → style just
 * that range) from the same implementation, instead of two look-alike panels
 * that drift apart. The only difference is how a size is *offered*:
 *
 *   sizeMode="token" — the Hook offers S/M/L (its existing vocabulary)
 *   sizeMode="px"    — the Header offers px targets, relative to its base size
 *
 * Both store the SAME thing: a multiplier of the element's base font size.
 * Sizes are only meaningful for a selection, so with nothing selected the colour
 * and font controls set the base style and the size control is disabled — an
 * element's base size keeps living in its own dedicated control, never here.
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
    const hasText = (text || '').trim().length > 0;
    const hasSelection = hasText && selection.end > selection.start;
    const selectedText = hasSelection ? text.slice(selection.start, selection.end) : '';
    const disabled = !hasText;

    const applyPatch = (patch) => {
        if (!hasText) return;
        if (hasSelection) {
            onChange(applyRangeStyle(value, selection.start, selection.end, patch), { scope: 'range' });
            return;
        }
        // No selection: colour/font are the only honest things to set, and they
        // become the element's base style. A size patch would have no range to
        // apply to, so it is ignored rather than silently applying to everything.
        const nextBase = normalizeBase(value.base);
        for (const key of ['color', 'font']) {
            if (!(key in patch)) continue;
            const v = patch[key];
            nextBase[key] = v == null || v === '' ? null : v;
        }
        onChange({ text: value.text, base: nextBase, spans: value.spans }, { scope: 'base' });
    };

    const clearRange = () => {
        if (hasSelection) {
            onChange(
                applyRangeStyle(value, selection.start, selection.end, { color: null, font: null, size: null }),
                { scope: 'range' },
            );
            return;
        }
        onChange({ text: value.text, base: { color: null, font: null }, spans: value.spans }, { scope: 'base' });
    };

    // Current effective style at the selection start, for honest readouts.
    const activeRun = hasSelection
        ? value.spans.find((s) => selection.start >= s.start && selection.start < s.end)
        : null;
    const currentSize = activeRun?.size ?? null;
    const currentPx = currentSize ? Math.round(baseFontPx * currentSize) : null;
    const tokenFor = (multiplier) =>
        Object.keys(SIZE_SCALE).find((k) => SIZE_SCALE[k] === multiplier) || null;

    return (
        <div className="border border-rule rounded-input p-3 space-y-3">
            <div>
                <p className="eyebrow mb-1">selected range</p>
                <p className="text-[11px] text-muted break-words">
                    {hasSelection ? <span className="text-ink">“{selectedText}”</span> : null}{' '}
                    {hasSelection
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
                        value={activeRun?.font || (hasSelection ? '' : (value.base.font || ''))}
                        onChange={(e) => applyPatch({ font: e.target.value || null })}
                        className="input-field !py-1.5 mt-1"
                    >
                        <option value="">{hasSelection ? 'keep / inherit' : 'default'}</option>
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
                            disabled={disabled || !hasSelection}
                            value={currentPx ?? ''}
                            placeholder={hasSelection ? String(baseFontPx) : 'select text'}
                            onChange={(e) => {
                                const px = Number(e.target.value);
                                if (!Number.isFinite(px) || px <= 0) return;
                                applyPatch({ size: px / (baseFontPx || 40) });
                            }}
                            className="input-field !py-1.5 mt-1"
                        />
                    ) : (
                        <select
                            disabled={disabled || !hasSelection}
                            value={tokenFor(currentSize) || ''}
                            onChange={(e) => {
                                const token = e.target.value;
                                applyPatch({ size: token ? SIZE_SCALE[token] : null });
                            }}
                            className="input-field !py-1.5 mt-1"
                        >
                            <option value="">{hasSelection ? 'keep / inherit' : 'select text'}</option>
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

            {hasSelection && currentPx ? (
                <p className="readout">this range renders at ≈{currentPx}px (base {Math.round(baseFontPx)}px)</p>
            ) : null}

            <button
                type="button"
                onClick={clearRange}
                disabled={disabled}
                className="text-xs text-muted underline underline-offset-2 hover:text-ink disabled:opacity-40"
            >
                {hasSelection ? 'clear styling on selection' : 'clear base styling'}
            </button>

            {hint ? <p className="text-[11px] text-muted leading-relaxed">{hint}</p> : null}
        </div>
    );
}

const RANGE_SWATCHES = ['#FFD600', '#FF0000', '#FFFFFF', '#000000', '#00E5FF', '#00FF00'];
