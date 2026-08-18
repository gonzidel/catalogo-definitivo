"use client";

import { useMemo, useState } from "react";
import type { ColorDetail } from "@/types/catalog";

const MAX_COLLAPSED_COLORS = 8;

interface PdpColorPickerProps {
  colors: ColorDetail[];
  activeColor: string;
  onColorChange: (color: string) => void;
  /** Oculta el label "Color: X" — usar cuando ya se muestra junto al nombre/precio. */
  hideLabel?: boolean;
}

export default function PdpColorPicker({
  colors,
  activeColor,
  onColorChange,
  hideLabel,
}: PdpColorPickerProps) {
  const [showAllColors, setShowAllColors] = useState(false);
  const safeColors = colors ?? [];
  const hasManyColors = safeColors.length > MAX_COLLAPSED_COLORS;
  const visibleColors = useMemo(() => {
    if (!hasManyColors || showAllColors) return safeColors;
    const selectedIndex = safeColors.findIndex(
      (dc) => dc.color.toLowerCase() === activeColor.toLowerCase()
    );
    const initial = safeColors.slice(0, MAX_COLLAPSED_COLORS);
    if (selectedIndex >= 0 && selectedIndex >= MAX_COLLAPSED_COLORS) {
      return [safeColors[selectedIndex], ...initial.slice(0, MAX_COLLAPSED_COLORS - 1)];
    }
    return initial;
  }, [activeColor, safeColors, hasManyColors, showAllColors]);
  const hiddenCount = Math.max(0, safeColors.length - visibleColors.length);

  if (safeColors.length === 0) return null;

  return (
    <div className="pdp-colors">
      {!hideLabel && (
        <div className="pdp-colors__label">
          Color:{" "}
          <span className="pdp-colors__value">{activeColor}</span>
        </div>
      )}
      <div
        className={[
          "pdp-colors__swatches",
          hasManyColors && !showAllColors ? "is-collapsed" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {visibleColors.map((dc) => {
          const selected =
            dc.color.toLowerCase() === activeColor.toLowerCase();
          const oos = dc.hasStock === false;
          return (
            <button
              key={dc.color}
              type="button"
              className={[
                "pdp-color-btn",
                selected ? "is-selected" : "",
                oos ? "is-oos" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={
                { "--swatch-color": dc.hex_color ?? "#ccc" } as React.CSSProperties
              }
              onClick={() => onColorChange(dc.color)}
              aria-label={`Color ${dc.color}${selected ? " seleccionado" : ""}`}
              aria-pressed={selected}
            >
              <span className="pdp-color-swatch" aria-hidden />
              <span className="pdp-color-name">{dc.color}</span>
              {selected && (
                <span className="pdp-color-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          );
        })}
        {hasManyColors && (
          <button
            type="button"
            className="pdp-color-more"
            onClick={() => setShowAllColors((v) => !v)}
            aria-expanded={showAllColors}
          >
            {showAllColors
              ? "Ver menos"
              : `Ver ${hiddenCount} más`}
          </button>
        )}
      </div>
    </div>
  );
}
