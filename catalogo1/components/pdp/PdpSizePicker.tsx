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
  /** size → qty for the current variant */
  selections: Record<string, number>;
  onSelectionChange: (size: string, qty: number) => void;
}

export default function PdpSizePicker({
  colorDetail,
  sizesWithStock,
  selections,
  onSelectionChange,
}: PdpSizePickerProps) {
  const stockMap = new Map((sizesWithStock ?? []).map((s) => [s.size, s.stock_qty]));
  const hasStockData = stockMap.size > 0;

  // Use variant_sizes as the canonical source (includes out-of-stock talles).
  // Fall back to colorDetail.talles only if no stock data is loaded yet.
  const talles = hasStockData
    ? (sizesWithStock ?? []).map((s) => s.size)
    : (colorDetail?.talles ?? []);
  const sortedTalles = [...talles].sort(compareCatalogSizes);
  if (sortedTalles.length === 0) return null;
  const selectedSizes = sortedTalles.filter((t) => (selections[t] ?? 0) > 0);
  const totalSelected = Object.values(selections).reduce((a, v) => a + v, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Label */}
      <div style={{ fontSize: 13, color: "#666", fontWeight: 500 }}>
        Talle
        {totalSelected > 0 && (
          <span style={{ marginLeft: 8, color: "#CD844D", fontWeight: 700 }}>
            · {totalSelected} seleccionado{totalSelected !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Chip grid — same aesthetic as before, fixed size */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {sortedTalles.map((talle) => {
          const stock = stockMap.get(talle);
          const outOfStock = hasStockData && stock !== undefined && stock <= 0;
          const qty = selections[talle] ?? 0;
          const isSelected = qty > 0;
          const lowStock = hasStockData && stock !== undefined && stock > 0 && stock <= 3;

          return (
            <button
              key={talle}
              onClick={() => {
                if (outOfStock) return;
                onSelectionChange(talle, isSelected ? 0 : 1);
              }}
              aria-pressed={isSelected}
              aria-label={`Talle ${talle}${outOfStock ? " (sin stock)" : ""}${isSelected ? ` (${qty} seleccionado${qty > 1 ? "s" : ""})` : ""}`}
              disabled={outOfStock}
              style={{
                position: "relative",
                minWidth: 48, height: 44, padding: "0 12px",
                borderRadius: 8,
                // selected → solid orange | with stock → dashed orange | no stock → solid gray
                border: isSelected
                  ? "2px solid #CD844D"
                  : outOfStock
                  ? "1.5px solid #ddd"
                  : "2px dashed #f0b988",
                background: isSelected ? "#FFF5EE" : "#fff",
                cursor: outOfStock ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                fontSize: 14,
                fontWeight: isSelected ? 700 : 400,
                color: outOfStock ? "#ccc" : isSelected ? "#CD844D" : "#555",
                overflow: "visible",
                transition: "border 0.12s, background 0.12s, color 0.12s",
              }}
            >
              {/* Diagonal strikethrough for out-of-stock */}
              {outOfStock && (
                <span aria-hidden="true" style={{
                  position: "absolute", inset: 0, pointerEvents: "none", borderRadius: 8,
                  background: "linear-gradient(to top right, transparent calc(50% - 0.7px), #d0d0d0 calc(50% - 0.7px), #d0d0d0 calc(50% + 0.7px), transparent calc(50% + 0.7px))",
                }} />
              )}

              {talle}

              {/* Quantity badge (qty > 1) */}
              {qty > 1 && (
                <span style={{
                  position: "absolute", top: -7, right: -7,
                  width: 18, height: 18, borderRadius: "50%",
                  background: "#CD844D", color: "#fff",
                  fontSize: 10, fontWeight: 800,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  lineHeight: 1, pointerEvents: "none",
                  border: "1.5px solid #fff",
                }}>
                  {qty}
                </span>
              )}

              {/* Low stock dot */}
              {!isSelected && !outOfStock && lowStock && (
                <span style={{
                  position: "absolute", top: -4, right: -4,
                  width: 8, height: 8, borderRadius: "50%",
                  background: "#f59e0b",
                  border: "1.5px solid #fff",
                  pointerEvents: "none",
                }} />
              )}
            </button>
          );
        })}
      </div>

      {/* Quantity controls — only for selected sizes */}
      {selectedSizes.length > 0 && (
        <div style={{
          background: "#faf7f4", borderRadius: 12,
          padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8,
        }}>
          <div style={{ fontSize: 11, color: "#aaa", fontWeight: 500, marginBottom: 2 }}>
            Cantidad por talle
          </div>
          {selectedSizes.map((talle) => {
            const qty = selections[talle] ?? 1;
            const stock = stockMap.get(talle);
            const maxQty = hasStockData && stock !== undefined ? stock : 99;
            return (
              <div key={talle} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <span style={{ fontSize: 14, color: "#555", fontWeight: 600, minWidth: 60 }}>
                  T. {talle}
                  {hasStockData && stock !== undefined && stock <= 5 && (
                    <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 6 }}>
                      ({stock} disp.)
                    </span>
                  )}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
                  <button
                    onClick={() => onSelectionChange(talle, Math.max(0, qty - 1))}
                    aria-label={`Restar talle ${talle}`}
                    style={{
                      width: 36, height: 36, borderRadius: "8px 0 0 8px",
                      border: "1.5px solid #e0d5cb", borderRight: "none",
                      background: "#fff", cursor: "pointer",
                      fontSize: 18, color: "#CD844D", fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    −
                  </button>
                  <div style={{
                    width: 42, height: 36, border: "1.5px solid #e0d5cb",
                    background: "#fff", display: "flex", alignItems: "center",
                    justifyContent: "center", fontSize: 15, fontWeight: 700, color: "#222",
                  }}>
                    {qty}
                  </div>
                  <button
                    onClick={() => onSelectionChange(talle, Math.min(maxQty, qty + 1))}
                    disabled={qty >= maxQty}
                    aria-label={`Sumar talle ${talle}`}
                    style={{
                      width: 36, height: 36, borderRadius: "0 8px 8px 0",
                      border: "1.5px solid #e0d5cb", borderLeft: "none",
                      background: qty >= maxQty ? "#f9f9f9" : "#fff",
                      cursor: qty >= maxQty ? "not-allowed" : "pointer",
                      fontSize: 18, color: qty >= maxQty ? "#ccc" : "#CD844D",
                      fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
