import React from 'react';
import { hookLook, HOOK_POSITION_PCT, SIZE_SCALE } from '../lib/hookStyles';
import { hookVisibleAt } from '../lib/editorPreviewState';

/**
 * TextOverlayPreview — THE authoritative overlay surface for the two visual
 * text concepts:
 *
 *   B. On-video Header  (`header`, rich text)
 *   C. Hook             (`hook`, rich text)
 *
 * The primary editor preview, the Hook modal and the Header modal all render
 * this same component from the same `buildPreviewState()` output, which is what
 * makes them agree by construction instead of by luck. Each element supplies its
 * own runs, so a range styled in either modal shows up in every surface.
 *
 * Geometry deliberately mirrors openshorts/hooks.py (hook anchored at 20% / 50%
 * / 70%, sized at 5% of composition width) and the Remotion compositions, so the
 * preview, a browser render and a server burn all agree.
 *
 * Hook font sizes use container query units (`cqw`) against this layer's own
 * width, so the preview scales exactly like the 1080px composition at any
 * preview size without a measuring effect. The Header keeps its pre-existing
 * px scaling so plain headers render identically to before.
 *
 * Clip Title (A) and Social Caption (D) are metadata and are never rendered
 * here — the preview-state tests assert that.
 */
export default function TextOverlayPreview({ header, hook, currentTime = 0, className = '' }) {
  const showHook = !!hook?.present && hookVisibleAt(currentTime, hook?.durationSec);
  const showHeader = !!header?.enabled && !!(header?.text || '').trim();

  if (!showHook && !showHeader) return null;

  return (
    <div
      className={`absolute inset-0 pointer-events-none overflow-hidden ${className}`}
      style={{ containerType: 'inline-size' }}
      data-testid="text-overlay-preview"
    >
      {showHeader && <HeaderLayer header={header} />}
      {showHook && <HookOverlayLayer hook={hook} />}
    </div>
  );
}

function runsOf(element) {
  return element.runs && element.runs.length
    ? element.runs
    : [{ start: 0, end: (element.text || '').length, text: element.text || '', style: {} }];
}

/**
 * B. On-video Header. Base font size/colour/family come from the element's own
 * fields; a run's multiplier scales on top of that base.
 */
function HeaderLayer({ header }) {
  const basePx = header.fontSize * 0.4; // pre-existing preview scale — unchanged

  return (
    <div
      className="absolute left-0 right-0 flex"
      style={{
        top: header.position === 'upper' ? '6%' : '14%',
        paddingLeft: '8%',
        paddingRight: '8%',
        justifyContent: header.alignment === 'left' ? 'flex-start'
          : header.alignment === 'right' ? 'flex-end' : 'center',
      }}
      data-testid="header-overlay"
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
        }}
      >
        {runsOf(header).map((run, i) => (
          <RunSpan key={`${run.start}-${i}`} run={run} basePx={basePx} unit="px" />
        ))}
      </span>
    </div>
  );
}

/**
 * C. Hook. Its own overlay, its own style/position/size/timing, with per-range
 * rich text on top of the hook's own base size.
 */
function HookOverlayLayer({ hook }) {
  const look = hookLook(hook.style);
  const scale = SIZE_SCALE[hook.size] ?? 1;
  const entrance = ENTRANCE_KEYFRAMES[hook.entranceAnimation] ?? null;
  // 5% of the container width, matching hooks.py (target_width * 0.05).
  const baseCqw = 5 * scale;

  return (
    <div
      className="absolute left-0 right-0 flex justify-center px-[5%]"
      style={{
        top: `${HOOK_POSITION_PCT[hook.position] ?? HOOK_POSITION_PCT.top}%`,
        transform: 'translateY(-50%)',
      }}
      data-testid="hook-overlay"
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
