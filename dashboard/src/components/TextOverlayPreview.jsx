import React from 'react';
import { hookLook, HOOK_POSITION_PCT, SIZE_SCALE } from '../lib/hookStyles';
import { hookVisibleAt } from '../lib/editorPreviewState';

/**
 * TextOverlayPreview — THE authoritative overlay surface for the two visual
 * text concepts:
 *
 *   B. On-video Header  (`header`)
 *   C. Hook             (`hook`, with optional per-range rich text)
 *
 * Both the primary editor preview and the Hook modal render this same
 * component from the same `buildPreviewState()` output, which is what makes the
 * modal and the primary preview agree by construction instead of by luck.
 *
 * Geometry deliberately mirrors openshorts/hooks.py (hook anchored at 20% / 50%
 * / 70% and sized at 5% of composition width) and
 * remotion/compositions/HookOverlay.tsx, so the preview, the browser render and
 * the server burn all agree.
 *
 * Font sizes use container query units (`cqw`) against this layer's own width,
 * so the preview scales exactly like the 1080px composition at any preview size
 * without a measuring effect.
 *
 * Social Caption (D) and Clip Title (A) are metadata and are never rendered
 * here — that is asserted by the preview-state tests.
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
      {/* B. On-video Header — geometry matches the pre-existing editor overlay
          exactly, so header preview behaviour is unchanged. */}
      {showHeader && (
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
              fontSize: `${header.fontSize * 0.4}px`,
              fontWeight: 700,
              color: header.color,
              backgroundColor: header.background === 'none' ? 'transparent' : header.backgroundColor,
              padding: header.background === 'none' ? 0 : '4px 10px',
              borderRadius: header.background === 'none' ? 0 : 6,
              textAlign: header.alignment,
              whiteSpace: 'pre-wrap',
            }}
          >
            {header.text}
          </span>
        </div>
      )}

      {/* C. Hook — its own overlay, its own style/position/size/timing. */}
      {showHook && <HookOverlayLayer hook={hook} />}
    </div>
  );
}

const ENTRANCE_KEYFRAMES = {
  spring: { name: 'loom-hook-pop', duration: '320ms' },
  fade: { name: 'loom-hook-fade', duration: '420ms' },
  'slide-up': { name: 'loom-hook-slide', duration: '380ms' },
  none: null,
};

function HookOverlayLayer({ hook }) {
  const look = hookLook(hook.style);
  const scale = SIZE_SCALE[hook.size] ?? 1;
  const entrance = ENTRANCE_KEYFRAMES[hook.entranceAnimation] ?? null;
  // 5% of the container width, matching hooks.py (target_width * 0.05).
  const baseCqw = 5 * scale;

  const runs = hook.runs && hook.runs.length
    ? hook.runs
    : [{ start: 0, end: hook.text.length, text: hook.text, style: {} }];

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
          {runs.map((run, i) => {
            const style = run.style || {};
            const runScale = style.size ? (SIZE_SCALE[style.size] ?? 1) : 1;
            return (
              <span
                key={`${run.start}-${i}`}
                data-run-start={run.start}
                data-run-end={run.end}
                style={{
                  color: style.color || look.text,
                  fontFamily: style.font ? `'${style.font}', 'Noto Serif', Georgia, serif` : undefined,
                  fontSize: runScale === 1 ? undefined : `${baseCqw * runScale}cqw`,
                }}
              >
                {run.text}
              </span>
            );
          })}
        </span>
      </div>
    </div>
  );
}
