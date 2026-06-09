"use client";

import { useCallback } from "react";
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
    <div className="pdp-colors" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 13, color: "#666", fontWeight: 500 }}>
        Color:{" "}
        <span style={{ color: "#333", fontWeight: 600 }}>{activeColor}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {colors.map((dc) => (
          <button
            key={dc.color}
            onClick={() => onColorChange(dc.color)}
            aria-label={dc.color}
            aria-pressed={dc.color === activeColor}
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              border:
                dc.color === activeColor
                  ? "3px solid #CD844D"
                  : "2px solid #ddd",
              background: dc.hex_color ?? "#ccc",
              cursor: "pointer",
              transition: "border-color 0.15s ease",
              outline:
                dc.color === activeColor ? "2px solid #CD844D" : "none",
              outlineOffset: 2,
            }}
          />
        ))}
      </div>
    </div>
  );
}
