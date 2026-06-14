"use client";

import type { ColorDetail } from "@/types/catalog";

interface PdpColorPickerProps {
  colors: ColorDetail[];
  activeColor: string;
  onColorChange: (color: string) => void;
}

export default function PdpColorPicker({
  colors,
  activeColor,
  onColorChange,
}: PdpColorPickerProps) {
  if (!colors || colors.length === 0) return null;

  return (
    <div className="pdp-colors">
      <div className="pdp-colors__label">
        Color:{" "}
        <span className="pdp-colors__value">{activeColor}</span>
      </div>
      <div className="pdp-colors__swatches">
        {colors.map((dc) => {
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
              aria-label={dc.color}
              aria-pressed={selected}
            >
              <span className="pdp-color-swatch" aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}
