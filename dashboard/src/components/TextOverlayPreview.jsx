import React from 'react';
import { hookLook, SIZE_SCALE } from '../lib/hookStyles';
import {
  layoutOverlays,
  headerBand,
} from '../lib/overlayLayout';

/**
 * TextOverlayPreview — THE authoritative overlay surface for the two visual
 * text concepts:
 *
 *   B. On-video Header  (`header`, rich text) — dedicated UPPER region
 *   C. Hook             (`hook`, rich text)   — VIDEO region
 *
 * The Header modal, the Hook modal, and the primary editor preview all render
 * this component from the same `buildPreviewState()` output.
 *
 * PLACEMENT comes from lib/overlayLayout.js, which declares the two regions and
 * is unit-tested: the Header is confined to its band and the Hook is anchored
 * inside the video region, so neither element can move or overlap the other
 * (a large Header, a large Hook, a moving Hook, or the Hook clearing at its
 * duration all leave the other element's box identical).
 *
 * Rich text is shared; geometry is deliberately NOT. Hook font sizes use
 * container query units (`cqw`) against this layer's own width so the preview
 * scales exactly like the 1080px composition at any preview size; the Header
 * keeps its pre-existing px scaling so plain headers render as they always did.
 *
 * Clip Title (A) and Social Caption (D) are metadata and are never rendered
 * here — the preview-state tests assert that.
 */
export default function TextOverlayPreview({ header, hook, currentTime = 0, className = '' }) {
  const layout = layoutOverlays({ header, hook, currentTime });

  if (!layout.header && !layout.hook) return null;

  return (
    <div
      className={`absolute inset-0 pointer-events-none overflow-hidden ${className}`}
      // The overlay is a rendering surface, not content: nothing here should be
      // selectable, or a stray drag highlights it instead of the editor's text.
      style={{ containerType: 'inline-size', userSelect: 'none', WebkitUserSelect: 'none' }}
      data-testid="text-overlay-preview"
    >
      {layout.header && <HeaderLayer header={header} box={layout.header} />}
      {layout.hook && <HookOverlayLayer hook={hook} box={layout.hook} />}
    </div>
  );
}

function runsOf(element) {
  return element.runs && element.runs.length
    ? element.runs
    : [{ start: 0, end: (element.text || '').length, text: element.text || '', style: {} }];
}

/**
 * B. On-video Header.
 *
 * Rendered inside the band element: the band OWNS the geometry and clips, which
 * is what makes "the Header cannot reach the Hook region" a property of the
 * layout contract rather than of how long the text happens to be.
 */
function HeaderLayer({ header, box }) {
  const band = headerBand();
  const basePx = header.fontSize * 0.4; // pre-existing preview scale — unchanged

  return (
    <div
      data-testid="header-region"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: `${band.topPct}%`,
        height: `${band.heightPct}%`,
        // The region owns its geometry: whatever the text does, it cannot
        // leave the region or reach the Hook below it.
        overflow: 'hidden',
      }}
    >
      {/* The USABLE band — the region minus the safe inset at each edge. The
          Header is centred (or top-anchored) within THIS box, so it never sits
          crowded against a boundary. */}
      <div
        data-testid="header-usable"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: `${box.insetInBandPct}%`,
          bottom: `${box.insetInBandPct}%`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: box.align === 'center' ? 'center' : 'flex-start',
        }}
      >
        <div
          data-testid="header-overlay"
          className="flex"
          style={{
            paddingLeft: `${box.paddingPct}%`,
            paddingRight: `${box.paddingPct}%`,
            justifyContent: header.alignment === 'left' ? 'flex-start'
              : header.alignment === 'right' ? 'flex-end' : 'center',
          }}
        >
          <span
            style={{
              fontFamily: header.fontFamily,
              fontSize: `${basePx}px`,
              fontWeight: 700,
              color: header.color,
              backgroundColor: header.background === 'none' ? 'transparent' : header.backgroundColor,
              padding: header.background === 'none' ? 0 : '4px 10px',
              borderRadius: header.background === 'none' ? 0 : 6,
              textAlign: header.alignment,
              whiteSpace: 'pre-wrap',
              maxWidth: '100%',
            }}
          >
            {runsOf(header).map((run, i) => (
              <RunSpan key={`${run.start}-${i}`} run={run} basePx={basePx} unit="px" />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * C. Hook. Its own overlay, its own region, its own visibility semantics, with
 * per-range rich text on top of the hook's own base size.
 */
function HookOverlayLayer({ hook, box }) {
  const look = hookLook(hook.style);
  const scale = SIZE_SCALE[hook.size] ?? 1;
  const entrance = ENTRANCE_KEYFRAMES[hook.entranceAnimation] ?? null;
  // 5% of the container width, matching hooks.py (target_width * 0.05).
  const baseCqw = 5 * scale;

  return (
    <div
      data-testid="hook-overlay"
      className="absolute left-0 right-0 flex justify-center"
      style={{
        top: `${box.topPct}%`,
        paddingLeft: `${box.paddingPct}%`,
        paddingRight: `${box.paddingPct}%`,
        transform: 'translateY(-50%)',
      }}
    >
      {entrance && (
        <style>{`
          @keyframes ${entrance.name} {
            from { opacity: 0; transform: ${entrance.name === 'loom-hook-slide' ? 'translateY(24px)' : 'scale(0.86)'}; }
            to   { opacity: 1; transform: ${entrance.name === 'loom-hook-slide' ? 'translateY(0)' : 'scale(1)'}; }
          }
        `}</style>
      )}
      <div
        // Re-keying on text/style restarts the entrance animation, which is the
        // honest reading of "the hook appears" in a live preview.
        key={`${hook.text}|${hook.style}|${hook.size}|${hook.position}|${hook.entranceAnimation}`}
        style={{
          maxWidth: '90%',
          backgroundColor: look.box ?? 'transparent',
          borderRadius: 20,
          padding: look.box ? `${25 * scale * 0.05}cqw ${30 * scale * 0.05}cqw` : 0,
          boxShadow: look.shadow ? '5px 5px 15px rgba(0, 0, 0, 0.25)' : 'none',
          textAlign: 'center',
          animation: entrance ? `${entrance.name} ${entrance.duration} ease-out` : undefined,
        }}
      >
        <span
          style={{
            fontFamily: "'Noto Serif', Georgia, serif",
            fontWeight: 700,
            fontSize: `${baseCqw}cqw`,
            lineHeight: 1.4,
            color: look.text,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            ...(look.outlinePx > 0
              ? { WebkitTextStroke: `${look.outlinePx * scale * 0.05}cqw #000000`, paintOrder: 'stroke fill' }
              : {}),
          }}
        >
          {runsOf(hook).map((run, i) => (
            <RunSpan
              key={`${run.start}-${i}`}
              run={run}
              basePx={baseCqw}
              unit="cqw"
              fallbackColor={look.text}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

/**
 * One styled run. `size` is a MULTIPLIER of the element's base size, so this is
 * the single place the range-size semantics are applied for both elements.
 */
function RunSpan({ run, basePx, unit, fallbackColor }) {
  const style = run.style || {};
  const multiplier = style.size ?? 1;
  const scaled = multiplier !== 1;

  return (
    <span
      data-run-start={run.start}
      data-run-end={run.end}
      data-run-size={scaled ? multiplier : undefined}
      style={{
        color: style.color || fallbackColor || undefined,
        fontFamily: style.font ? `'${style.font}', 'Noto Serif', Georgia, serif` : undefined,
        fontSize: scaled ? `${basePx * multiplier}${unit}` : undefined,
      }}
    >
      {run.text}
    </span>
  );
}

const ENTRANCE_KEYFRAMES = {
  spring: { name: 'loom-hook-pop', duration: '320ms' },
  fade: { name: 'loom-hook-fade', duration: '420ms' },
  'slide-up': { name: 'loom-hook-slide', duration: '380ms' },
  none: null,
};
