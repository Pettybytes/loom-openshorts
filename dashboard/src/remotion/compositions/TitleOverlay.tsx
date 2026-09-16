import React from "react";
import { AbsoluteFill } from "remotion";
import type { TitleOverlayConfig } from "../lib/types";
import { getFontStack } from "../lib/fonts";

/**
 * Optional on-video title/header overlay — a distinct layer from the metadata
 * Shorts title. Renders in the top (black) region of the 9:16 frame so it can
 * be positioned without colliding with the hook/captions lower on screen.
 */
interface TitleOverlayProps {
  config: TitleOverlayConfig;
}

const POSITION_MAP: Record<string, React.CSSProperties> = {
  // top = top black region; upper = just under the very top edge
  top: { top: "14%", bottom: "auto" },
  upper: { top: "6%", bottom: "auto" },
};

const ALIGNMENT_MAP: Record<string, "flex-start" | "center" | "flex-end"> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};

export const TitleOverlay: React.FC<TitleOverlayProps> = ({ config }) => {
  if (!config.enabled || !(config.text || "").trim()) return null;

  const positionStyle = POSITION_MAP[config.position] ?? POSITION_MAP.top;
  const justify = ALIGNMENT_MAP[config.alignment] ?? "center";
  const fontStack = getFontStack(config.fontFamily);

  const hasBg = config.background === "box";
  const isHighlight = config.background === "highlight";

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: justify,
          paddingLeft: "8%",
          paddingRight: "8%",
          ...positionStyle,
        }}
      >
        <span
          style={{
            fontFamily: fontStack,
            fontSize: config.fontSize,
            fontWeight: 700,
            color: config.textColor,
            lineHeight: 1.25,
            textAlign: config.alignment,
            backgroundColor: hasBg
              ? config.backgroundColor
              : isHighlight
                ? config.backgroundColor
                : "transparent",
            padding: hasBg || isHighlight ? "6px 16px" : 0,
            borderRadius: hasBg || isHighlight ? 8 : 0,
            boxShadow: hasBg
              ? "0 4px 14px rgba(0,0,0,0.45)"
              : isHighlight
                ? `0 0 0 4px ${config.backgroundColor}`
                : "none",
            maxWidth: "100%",
          }}
        >
          {config.text}
        </span>
      </div>
    </AbsoluteFill>
  );
};
