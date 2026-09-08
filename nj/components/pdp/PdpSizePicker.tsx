"use client";

import type { CSSProperties, RefObject } from "react";
import { compareCatalogSizes } from "@/lib/utils/size-normalizer";
import {
  formatSellableRemaining,
  type PdpVariantInfo,
  type PdpVariantSize,
} from "@/lib/stock/sellable-stock";
import type { ColorDetail } from "@/types/catalog";

interface SelectedItem {
  variantId: string;
  color: string;
  size: string;
  qty: number;
}

interface PdpSizePickerProps {
  colorDetail: ColorDetail | null;
  activeColor: string;
  selectionLabel?: string;
  sizesWithStock?: PdpVariantSize[];
  /** Variante actualmente en pantalla (según el color elegido arriba). */
  activeVariantId: string;
  /** Todas las variantes de color, con sellable_qty por talle. */
  variantSizes: PdpVariantInfo[];
  sellableStatus: "loading" | "ready" | "error";
  /** Colores del producto — para pintar el punto de color en cada fila. */
  colors: ColorDetail[];
  /** Selección acumulada de TODOS los colores (no solo el que está activo). */
  allSelections: SelectedItem[];
  onSelectionChange: (variantId: string, size: string, qty: number) => void;
  qtyListRef?: RefObject<HTMLDivElement | null>;
}

export default function PdpSizePicker({
  colorDetail,
  activeColor,
  selectionLabel = "talle",
  sizesWithStock,
  activeVariantId,
  variantSizes,
  sellableStatus,
  colors,
  allSelections,
  onSelectionChange,
  qtyListRef,
}: PdpSizePickerProps) {
  const stockMap = new Map((sizesWithStock ?? []).map((s) => [s.size, s.sellable_qty]));
  const capitalizedSelectionLabel =
    selectionLabel.charAt(0).toUpperCase() + selectionLabel.slice(1);
  const selectionArticle = selectionLabel === "medida" ? "una" : "un";

  // Grilla visual: variant_sizes si ya llegaron; si no, Numeracion del snapshot.
  // El snapshot NUNCA habilita compra: sin sellable live confirmado el chip queda disabled.
  const liveSizes = sizesWithStock ?? [];
  const talles =
    liveSizes.length > 0
      ? liveSizes.map((s) => s.size)
      : (colorDetail?.talles ?? []);
  const sortedTalles = [...talles].sort(compareCatalogSizes);

  // Selección del color activo (para resaltar los chips de arriba).
  const activeSelections: Record<string, number> = {};
  for (const item of allSelections) {
    if (item.variantId === activeVariantId) activeSelections[item.size] = item.qty;
  }

  const totalSelectedAllColors = allSelections.reduce((a, i) => a + Math.max(0, i.qty), 0);

  // Stock por variante+talle, para los steppers de las filas de otros colores.
  const stockByVariant = new Map<string, Map<string, number | null>>();
  for (const v of variantSizes) {
    stockByVariant.set(v.variantId, new Map(v.sizes.map((s) => [s.size, s.sellable_qty])));
  }

  const hexByColor = new Map(colors.map((c) => [c.color.toLowerCase(), c.hex_color]));

  if (sortedTalles.length === 0 && allSelections.length === 0) return null;

  return (
    <div className="pdp-sizes">
      <div className="pdp-sizes__label">
        Elegí {selectionLabel} en {activeColor}
        {totalSelectedAllColors > 0 && (
          <span className="pdp-sizes__count">
            · {totalSelectedAllColors} seleccionado{totalSelectedAllColors !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <div className="pdp-sizes__help">
        Tocá {selectionArticle} {selectionLabel} para abrir el selector de cantidad.
      </div>

      {sortedTalles.length > 0 && (
        <div className="pdp-sizes__chips">
          {sortedTalles.map((talle) => {
            const stock = stockMap.get(talle);
            const confirmed = sellableStatus === "ready" && typeof stock === "number";
            const outOfStock = confirmed && stock <= 0;
            const canSelect = confirmed && stock > 0 && Boolean(activeVariantId);
            const qty = activeSelections[talle] ?? 0;
            const isSelected = talle in activeSelections;

            return (
              <button
                key={talle}
                type="button"
                onClick={() => {
                  if (!canSelect) return;
                  onSelectionChange(activeVariantId, talle, isSelected ? -1 : 0);
                }}
                aria-pressed={isSelected}
                aria-label={`${capitalizedSelectionLabel} ${talle}${outOfStock ? " (sin stock)" : ""}${isSelected ? ` (${qty} seleccionado${qty > 1 ? "s" : ""})` : ""}`}
                disabled={!canSelect}
                className={[
                  "pdp-size-chip",
                  isSelected ? "is-selected" : "",
                  outOfStock ? "is-oos" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {outOfStock && <span aria-hidden="true" className="pdp-size-chip__strike" />}
                {talle}
                {qty > 1 && <span className="pdp-size-chip__qty-badge">{qty}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Quantity controls — junta TODOS los colores elegidos, no solo el que
          está en pantalla. Cada fila muestra talle + color para que, si el
          cliente eligió 38 en beige y después pasa a negro, el 38 beige siga
          visible acá (antes desaparecía y parecía que el carrito se había
          "roto" al cambiar de color). */}
      {allSelections.length > 0 && (
        <div className="pdp-qty-list" ref={qtyListRef}>
          <div className="pdp-qty-list__title">Ahora elegí cantidad</div>
          {allSelections.map((item) => {
            const qty = item.qty;
            const stock = stockByVariant.get(item.variantId)?.get(item.size);
            const maxQty =
              sellableStatus === "ready" && typeof stock === "number" ? stock : 0;
            const hex = hexByColor.get(item.color.toLowerCase()) ?? "#ccc";
            const isActiveColorRow = item.variantId === activeVariantId;
            const atMax = qty >= maxQty;

            return (
              <div
                key={`${item.variantId}:${item.size}`}
                className={[
                  "pdp-qty-row",
                  isActiveColorRow ? "is-active-color" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <div className="pdp-qty-row__left">
                  <button
                    type="button"
                    onClick={() => onSelectionChange(item.variantId, item.size, -1)}
                    aria-label={`Quitar ${selectionLabel} ${item.size} en ${item.color}`}
                    className="pdp-qty-btn pdp-qty-row__remove"
                  >
                    ×
                  </button>
                  <span className="pdp-qty-row__size">{item.size}</span>
                  <span className="pdp-qty-row__meta">
                    <span className="pdp-qty-row__color">
                      <span
                        aria-hidden
                        className="pdp-qty-row__swatch"
                        style={{ "--row-color": hex } as CSSProperties}
                      />
                      <span className="pdp-qty-row__color-name">{item.color}</span>
                    </span>
                    {sellableStatus === "ready" && atMax && typeof stock === "number" && stock > 0 && (
                      <span className="pdp-qty-row__stock-hint">
                        {formatSellableRemaining(stock)}
                      </span>
                    )}
                  </span>
                </div>

                <div className="pdp-stepper">
                  <button
                    type="button"
                    onClick={() =>
                      onSelectionChange(item.variantId, item.size, qty <= 1 ? -1 : qty - 1)
                    }
                    aria-label={`Restar ${selectionLabel} ${item.size} en ${item.color}`}
                    className="pdp-qty-btn pdp-stepper__btn"
                  >
                    −
                  </button>
                  <div className="pdp-stepper__value">{qty}</div>
                  <button
                    type="button"
                    onClick={() =>
                      onSelectionChange(
                        item.variantId,
                        item.size,
                        Math.min(maxQty, qty + 1)
                      )
                    }
                    disabled={atMax}
                    aria-label={`Sumar ${selectionLabel} ${item.size} en ${item.color}`}
                    className={[
                      "pdp-qty-btn",
                      "pdp-stepper__btn",
                      atMax ? "is-max" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
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
