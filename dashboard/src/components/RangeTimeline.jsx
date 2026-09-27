import React, { useCallback, useMemo, useRef } from 'react';
import { Play, Square, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  MIN_RANGE_SEC,
  rangeGeometry,
  nudgeBoundary,
  normalizeRange,
  describeRange,
  snapToWords,
  roundToMillis,
  formatTimestamp,
  formatSeconds,
} from '../lib/timelineState';

/**
 * RangeTimeline — the visual START/END track.
 *
 * REUSE NOTE (this is the point of the component, not an afterthought):
 * OpenShorts already provides this interaction inside components/ClipEditor.jsx
 * — a multi-segment NLE track with draggable trim handles, a source monitor
 * that scrubs while an edge is dragged, word snapping, and bounds that widen to
 * the whole original source when the source media is present. This component
 * does NOT reimplement that. It reuses ClipEditor's proven mechanics verbatim:
 *
 *   - primary-button-only drags with `preventDefault()` (without it Chrome turns
 *     the gesture into a native text drag, which swallows every later pointer
 *     event and shows a 🚫 cursor instead of dragging);
 *   - `setPointerCapture` on the handle with window-level move/up listeners as
 *     the fallback;
 *   - pxPerSec derived from the track's own bounding rect;
 *   - the monitor scrubs to the edge being moved, so the frame on screen IS the
 *     frame the cut lands on;
 *   - snapping applied on RELEASE, not during the drag;
 *   - edges rounded to milliseconds at commit.
 *
 * The range RULES (minimum window, word snapping, millisecond rounding, and
 * bounds) come from lib/timelineState.js, which ClipEditor also uses — so the
 * two surfaces cannot disagree about what a legal cut is.
 *
 * There is no second trim state here. `start`/`end` are props and every
 * interaction reports a new range through `onCommitRange`; the parent holds the
 * single source of truth that the numeric inputs also write to.
 *
 * The track is a SOURCE axis: `sourceDuration` is how much durable source media
 * actually exists, and the selected band is a window inside it. On the /edit
 * page the LOOM-selected moment is the band's starting position, not a limit —
 * Bryan can drag START earlier or END later across the rest of the source.
 */
export default function RangeTimeline({
  sourceDuration = 0,
  start = 0,
  end = 0,
  minDuration = MIN_RANGE_SEC,
  words = [],
  snapToWords: snapEnabled = false,
  onCommitRange,
  onSeek,
  onPreviewSelection,
  onStopPreview,
  previewing = false,
  currentTime = null,
  sourceBoundSource = null, // 'measured' | 'declared' | null — honest bound provenance
  disabled = false,
}) {
  const trackRef = useRef(null);
  const dragRef = useRef(null);

  // Callbacks are read through refs so the drag handlers can keep stable
  // identities ([]) exactly as ClipEditor's do — the listeners registered on
  // pointerdown are removed on pointerup, and stable refs are what make that
  // removal reliable.
  const commitRef = useRef(onCommitRange);
  const seekRef = useRef(onSeek);
  commitRef.current = onCommitRange;
  seekRef.current = onSeek;

  const geom = useMemo(
    () => rangeGeometry({ range: { start, end }, sourceDuration }),
    [start, end, sourceDuration],
  );
  const validity = useMemo(
    // `start`/`end` arrive from the parent already normalized, so this is a
    // readout of honesty (is the window inside the source?) rather than a fix-up.
    () => describeRange({ range: { start, end }, sourceDuration }),
    [start, end, sourceDuration],
  );
  const duration = Number(end) - Number(start);

  const commit = useCallback(
    (range) => {
      if (disabled) return;
      const next = normalizeRange({
        start: range.start,
        end: range.end,
        sourceDuration,
        minDuration,
      });
      commitRef.current?.(next);
    },
    [disabled, sourceDuration, minDuration],
  );

  const nudge = useCallback(
    (boundary, delta) => {
      commit(nudgeBoundary({ range: { start, end }, boundary, delta, sourceDuration, minDuration }));
    },
    [commit, start, end, sourceDuration, minDuration],
  );

  // ---- drag ----------------------------------------------------------------
  const onDragMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const dt = (e.clientX - d.startX) / d.pxPerSec;
    let next;
    if (d.boundary === 'start') {
      // START only ever moves itself; END is untouched.
      next = { start: Math.max(d.lo, Math.min(d.base.start + dt, d.base.end - d.minDuration)), end: d.base.end };
      d.seek?.(next.start);
    } else {
      // END only ever moves itself; START is untouched.
      next = { start: d.base.start, end: Math.min(d.hi, Math.max(d.base.end + dt, d.base.start + d.minDuration)) };
      d.seek?.(next.end);
    }
    d.last = next;
    // Live feedback only — nothing is committed until release.
    d.live?.(next);
  }, []);

  const onDragUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragUp);
    if (!d || !d.last) return;
    // Snap on release (never mid-drag), then round like every other edit path.
    const edge = snapToWords(d.last[d.boundary], d.boundary, d.words, { enabled: d.snapEnabled });
    const committed = d.boundary === 'start'
      ? { start: roundToMillis(edge), end: d.last.end }
      : { start: d.last.start, end: roundToMillis(edge) };
    d.commit?.(normalizeRange({
      start: committed.start,
      end: committed.end,
      sourceDuration: d.sourceDuration,
      minDuration: d.minDuration,
    }));
  }, [onDragMove]);

  const startDrag = useCallback(
    (e, boundary) => {
      if (disabled) return;
      // Only the primary button drags (ClipEditor's rule).
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation(); // the track body scrubs; a handle drag is not a scrub
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !sourceDuration) return;
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* window listeners still fire */ }
      dragRef.current = {
        boundary,
        startX: e.clientX,
        pxPerSec: rect.width / sourceDuration,
        base: { start, end },
        last: null,
        lo: 0,
        hi: sourceDuration,
        minDuration,
        sourceDuration,
        words,
        snapEnabled,
        commit: commitRef.current,
        live: undefined,
        seek: seekRef.current,
      };
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragUp);
      window.addEventListener('pointercancel', onDragUp);
    },
    [disabled, sourceDuration, start, end, minDuration, words, snapEnabled, onDragMove, onDragUp],
  );

  // Clicking the track body parks the monitor there — that alone is how a cut
  // point is found against the picture (ClipEditor's source-track behaviour).
  const onTrackPointerDown = useCallback(
    (e) => {
      if (disabled) return;
      if (e.button !== undefined && e.button !== 0) return;
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !sourceDuration) return;
      const t = ((e.clientX - rect.left) / rect.width) * sourceDuration;
      seekRef.current?.(Math.max(0, Math.min(sourceDuration, t)));
    },
    [disabled, sourceDuration],
  );

  const onHandleKeyDown = useCallback(
    (e, boundary) => {
      if (disabled) return;
      const step = e.shiftKey ? 1 : 0.1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(boundary, -step); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(boundary, step); }
      else if (e.key === 'Home') { e.preventDefault(); commit(nudgeBoundary({ range: { start, end }, boundary: 'start', delta: -sourceDuration, sourceDuration, minDuration })); }
      else if (e.key === 'End') { e.preventDefault(); commit(nudgeBoundary({ range: { start, end }, boundary: 'end', delta: sourceDuration, sourceDuration, minDuration })); }
    },
    [disabled, nudge, commit, start, end, sourceDuration, minDuration],
  );

  const hasSource = Number.isFinite(sourceDuration) && sourceDuration > 0;
  const playheadPct = hasSource && Number.isFinite(Number(currentTime))
    ? Math.max(0, Math.min((Number(currentTime) / sourceDuration) * 100, 100))
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">timeline · source</span>
        <span className="readout">
          {hasSource ? formatTimestamp(sourceDuration) : '—'}
          {sourceBoundSource === 'declared' && <span className="text-muted"> · declared</span>}
          {sourceBoundSource === 'measured' && <span className="text-muted"> · measured</span>}
        </span>
      </div>

      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        data-testid="range-timeline-track"
        className={`relative h-12 rounded-input bg-paper border border-rule overflow-hidden touch-none ${
          disabled ? 'opacity-50' : 'cursor-pointer'
        }`}
      >
        {/* The selected window. Unselected source stays visible underneath so
            it is obvious there is more source to extend into. */}
        <div
          data-testid="range-timeline-selection"
          className="absolute top-1 bottom-1 rounded-[6px] border border-[color:var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_26%,transparent)]"
          style={{ left: `${geom.startPct}%`, width: `${geom.widthPct}%` }}
        />

        {/* START handle — independently draggable */}
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="selection start"
          aria-valuemin={0}
          aria-valuemax={Number.isFinite(sourceDuration) ? sourceDuration : 0}
          aria-valuenow={Number(start)}
          aria-valuetext={formatTimestamp(start)}
          data-testid="range-timeline-start"
          onPointerDown={(e) => startDrag(e, 'start')}
          onKeyDown={(e) => onHandleKeyDown(e, 'start')}
          title="drag to change the start (arrow keys = 0.1s, shift = 1s)"
          className="absolute top-0 bottom-0 w-3 -ml-1.5 touch-none cursor-ew-resize rounded-[5px] bg-[color:var(--color-accent)] border border-paper"
          style={{ left: `${geom.startPct}%` }}
        />

        {/* END handle — independently draggable */}
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="selection end"
          aria-valuemin={0}
          aria-valuemax={Number.isFinite(sourceDuration) ? sourceDuration : 0}
          aria-valuenow={Number(end)}
          aria-valuetext={formatTimestamp(end)}
          data-testid="range-timeline-end"
          onPointerDown={(e) => startDrag(e, 'end')}
          onKeyDown={(e) => onHandleKeyDown(e, 'end')}
          title="drag to change the end (arrow keys = 0.1s, shift = 1s)"
          className="absolute top-0 bottom-0 w-3 -ml-1.5 touch-none cursor-ew-resize rounded-[5px] bg-[color:var(--color-accent)] border border-paper"
          style={{ left: `${geom.endPct}%` }}
        />

        {/* The source monitor's own playhead, when the video has reported one.
            Not interactive: dragging the body scrubs, exactly like the track. */}
        {playheadPct !== null && (
          <div
            data-testid="range-timeline-playhead"
            title="source playhead"
            className="absolute top-1 bottom-1 w-0.5 -ml-px rounded-full bg-ink pointer-events-none"
            style={{ left: `${playheadPct}%` }}
          />
        )}
      </div>

      {/* Readouts — the spec's SOURCE / START / END / DURATION block. */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-input border border-rule bg-paper2 px-2 py-1.5">
          <div className="readout text-muted">start</div>
          <div className="text-sm text-ink tabular-nums" data-testid="range-timeline-start-readout">{formatTimestamp(start)}</div>
        </div>
        <div className="rounded-input border border-rule bg-paper2 px-2 py-1.5">
          <div className="readout text-muted">end</div>
          <div className="text-sm text-ink tabular-nums" data-testid="range-timeline-end-readout">{formatTimestamp(end)}</div>
        </div>
        <div className="rounded-input border border-rule bg-paper2 px-2 py-1.5">
          <div className="readout text-muted">duration</div>
          <div className="text-sm text-ink tabular-nums" data-testid="range-timeline-duration-readout">{formatSeconds(duration)}</div>
        </div>
      </div>

      {/* ±1s — one pair per boundary, so which edge moves is never ambiguous. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-1.5">
          <span className="readout text-muted shrink-0">start ±1s</span>
          <button type="button" disabled={disabled} onClick={() => nudge('start', -1)}
            aria-label="start minus one second"
            data-testid="range-timeline-start-minus"
            className="btn-quiet text-[11px] py-1 px-2 flex items-center gap-0.5 disabled:opacity-40">
            <ChevronLeft size={12} />1s
          </button>
          <button type="button" disabled={disabled} onClick={() => nudge('start', 1)}
            aria-label="start plus one second"
            data-testid="range-timeline-start-plus"
            className="btn-quiet text-[11px] py-1 px-2 flex items-center gap-0.5 disabled:opacity-40">
            1s<ChevronRight size={12} />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="readout text-muted shrink-0">end ±1s</span>
          <button type="button" disabled={disabled} onClick={() => nudge('end', -1)}
            aria-label="end minus one second"
            data-testid="range-timeline-end-minus"
            className="btn-quiet text-[11px] py-1 px-2 flex items-center gap-0.5 disabled:opacity-40">
            <ChevronLeft size={12} />1s
          </button>
          <button type="button" disabled={disabled} onClick={() => nudge('end', 1)}
            aria-label="end plus one second"
            data-testid="range-timeline-end-plus"
            className="btn-quiet text-[11px] py-1 px-2 flex items-center gap-0.5 disabled:opacity-40">
            1s<ChevronRight size={12} />
          </button>
        </div>
      </div>

      {!validity.valid && (
        <p className="text-xs text-warn" data-testid="range-timeline-invalid">
          {validity.reason === 'beyond_source'
            ? 'the selection runs past the end of the available source.'
            : validity.reason === 'end_not_after_start'
              ? 'start must be before end.'
              : 'the selection is not a usable range.'}
        </p>
      )}

      {/* Preview the SELECTION. Browser-native playback only: it seeks the
          existing preview element and stops at END. It does not render, does
          not register an asset version, and does not touch the review card. */}
      <div className="flex items-center gap-2">
        {previewing ? (
          <button type="button" onClick={onStopPreview}
            data-testid="range-timeline-stop-preview"
            className="btn-quiet text-[11px] py-1.5 px-3 flex items-center gap-1.5">
            <Square size={12} /> stop preview
          </button>
        ) : (
          <button type="button" onClick={onPreviewSelection} disabled={disabled || !validity.valid}
            data-testid="range-timeline-preview"
            className="btn-quiet text-[11px] py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-40">
            <Play size={12} /> preview selection
          </button>
        )}
        <span className="readout text-muted">plays the selected range only — nothing is rendered</span>
      </div>
    </div>
  );
}
