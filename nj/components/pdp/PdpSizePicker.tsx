"use client";

import { compareCatalogSizes } from "@/lib/utils/size-normalizer";
import type { ColorDetail } from "@/types/catalog";

interface SizeWithStock {
  size: string;
  sku: string;
  stock_qty: number;
}

interface PdpSizePickerProps {
  colorDetail: ColorDetail | null;
  sizesWithStock?: SizeWithStock[];
  activeSize: string;
  onSizeChange: (size: string) => void;
}

export default function PdpSizePicker({
  colorDetail,
  sizesWithStock,
  activeSize,
  onSizeChange,
}: PdpSizePickerProps) {
  const talles = colorDetail?.talles ?? [];
  const sortedTalles = [...talles].sort(compareCatalogSizes);

  if (sortedTalles.length === 0) return null;

  // Stock map: only populated when stock data is available
  const stockMap = new Map(
    (sizesWithStock ?? []).map((s) => [s.size, s.stock_qty])
  );
  const hasStockData = stockMap.size > 0;

  return (
    <div className="pdp-sizes" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 13, color: "#666", fontWeight: 500 }}>
        Talle:{" "}
        <span style={{ color: "#333", fontWeight: 600 }}>
          {activeSize || "—"}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {sortedTalles.map((talle) => {
          const stock = stockMap.get(talle);
          // Only mark as out-of-stock when we actually have stock data
          const outOfStock = hasStockData && stock !== undefined && stock <= 0;
          const isActive = talle === activeSize;

          return (
            <button
              key={talle}
              onClick={() => !outOfStock && onSizeChange(talle)}
              aria-label={`Talle ${talle}${outOfStock ? " (sin stock)" : ""}`}
              aria-pressed={isActive}
              disabled={outOfStock}
              style={{
                position: "relative",
                minWidth: 48,
                height: 44,
                padding: "0 12px",
                borderRadius: 8,
                border: isActive
                  ? "2px solid #CD844D"
                  : outOfStock
                  ? "1px solid #ddd"
                  : "1px solid #ddd",
                background: isActive
                  ? "#FFF5EE"
                  : outOfStock
                  ? "#fafafa"
                  : "#fff",
                cursor: outOfStock ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                fontSize: 14,
                fontWeight: isActive ? 600 : 400,
                color: outOfStock ? "#bbb" : isActive ? "#CD844D" : "#333",
                overflow: "hidden",
                transition: "all 0.15s ease",
              }}
            >
              {/* Diagonal strikethrough line for out-of-stock */}
              {outOfStock && (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    background:
                      "linear-gradient(to top right, transparent calc(50% - 0.5px), #ccc calc(50% - 0.5px), #ccc calc(50% + 0.5px), transparent calc(50% + 0.5px))",
                  }}
                />
              )}
              {talle}
            </button>
          );
        })}
      </div>
    </div>
  );
}
