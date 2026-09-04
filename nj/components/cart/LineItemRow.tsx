"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { fetchOrderItemImageUrl } from "@/lib/supabase/order-item-image";

export function formatItemARS(n: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(n);
}

interface StatusChip {
  label: string;
  color: string;
  bg: string;
}

interface LineItemRowProps {
  imagen?: string;
  /** Fallback si `imagen` vino vacío (p. ej. ítem agregado desde admin Kanban). */
  variantId?: string | null;
  productName: string;
  color?: string;
  size?: string;
  quantity: number;
  unitPrice: number;
  /** Oferta activa: 🔥 tras el talle y precio en rojo. */
  isOffer?: boolean;
  status?: StatusChip;
  onStatusClick?: () => void;
  highlight?: "missing" | "outOfStock" | null;
  mutedPrice?: boolean;
  line2?: ReactNode;
  trailing?: ReactNode;
  below?: ReactNode;
}

/** En filas missing el título se corta por CSS; nombre/color a 5 chars dejan ver el talle. */
function clipLabel(value: string, max = 5): string {
  const t = String(value || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}

function buildTitle(
  productName: string,
  color?: string,
  size?: string,
  isOffer?: boolean,
  compactNameColor = false
) {
  const name = compactNameColor ? clipLabel(productName) : productName;
  const colorPart = color
    ? compactNameColor
      ? clipLabel(color)
      : color
    : undefined;
  const parts = [name];
  if (colorPart) parts.push(colorPart);
  if (size) parts.push(`T. ${size}`);
  const base = parts.join(" · ");
  return isOffer ? `${base} 🔥` : base;
}

export function QuantityUnitLabel({ quantity }: { quantity: number }) {
  return (
    <span className="line-item-qty-label">
      {quantity} uni
    </span>
  );
}

function defaultLine2(quantity: number, unitPrice: number) {
  // Con 1 unidad, el precio unitario es igual al total ya visible a la derecha:
  // repetirlo desperdicia espacio y es lo que provoca el wrap en pantallas de 360px.
  if (quantity <= 1) {
    return <QuantityUnitLabel quantity={quantity} />;
  }
  return (
    <span className="line-item-default-line2">
      <QuantityUnitLabel quantity={quantity} />
      <span className="line-item-unit-price">{formatItemARS(unitPrice)} c/u</span>
    </span>
  );
}

export default function LineItemRow({
  imagen,
  variantId = null,
  productName,
  color,
  size,
  quantity,
  unitPrice,
  isOffer = false,
  status,
  onStatusClick,
  highlight = null,
  mutedPrice = false,
  line2,
  trailing,
  below,
}: LineItemRowProps) {
  const [resolvedImage, setResolvedImage] = useState<string | null>(
    () => String(imagen || "").trim() || null
  );

  useEffect(() => {
    const cached = String(imagen || "").trim();
    if (cached) {
      setResolvedImage(cached);
      return;
    }
    const vid = String(variantId || "").trim();
    if (!vid) {
      setResolvedImage(null);
      return;
    }
    let cancelled = false;
    void fetchOrderItemImageUrl({ imagen: null, variant_id: vid }).then((url) => {
      if (!cancelled) setResolvedImage(url);
    });
    return () => {
      cancelled = true;
    };
  }, [imagen, variantId]);

  const isWarn = highlight === "missing" || highlight === "outOfStock";
  // Sin stock: fila apretada (Alternativas + Quitar) — recortar nombre/color
  // para que el talle no quede en "T. …" (pedido explícito UX móvil).
  const compactTitle = highlight === "missing";
  const displayTitle = buildTitle(productName, color, size, isOffer, compactTitle);
  const fullTitle = buildTitle(productName, color, size, isOffer, false);
  const lineTotal = unitPrice * quantity;
  const statusStyle = status
    ? ({
        "--status-color": status.color,
        "--status-bg": status.bg,
      } as CSSProperties)
    : undefined;

  return (
    <div>
      <div
        className={[
          "line-item-row__main",
          isWarn ? "is-warn" : "",
          isOffer ? "is-offer" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {resolvedImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolvedImage}
            alt={fullTitle}
            className="line-item-row__img"
          />
        ) : (
          <div className="line-item-row__img-ph" />
        )}

        <div className="line-item-row__body">
          <div className="line-item-row__title" title={compactTitle ? fullTitle : undefined}>
            {displayTitle}
          </div>
          <div className="line-item-row__meta">
            {line2 ?? defaultLine2(quantity, unitPrice)}
          </div>
        </div>

        <div className="line-item-row__side">
          {status && (
            onStatusClick ? (
              <button
                type="button"
                onClick={onStatusClick}
                className="line-item-status line-item-status--btn"
                style={statusStyle}
              >
                {status.label}
              </button>
            ) : (
              <span className="line-item-status" style={statusStyle}>
                {status.label}
              </span>
            )
          )}
          <div className="line-item-row__price-wrap">
            <span
              className={[
                "line-item-row__price",
                mutedPrice ? "is-muted" : "",
                isOffer ? "is-offer" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {formatItemARS(lineTotal)}
            </span>
            {trailing}
          </div>
        </div>
      </div>
      {below && (
        <div className="line-item-row__below">
          {below}
        </div>
      )}
    </div>
  );
}
