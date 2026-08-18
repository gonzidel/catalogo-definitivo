"use client";

import type { CSSProperties, ReactNode } from "react";

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

function buildTitle(
  productName: string,
  color?: string,
  size?: string,
  isOffer?: boolean
) {
  const parts = [productName];
  if (color) parts.push(color);
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
  const isWarn = highlight === "missing" || highlight === "outOfStock";
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
        {imagen ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imagen}
            alt={productName}
            className="line-item-row__img"
          />
        ) : (
          <div className="line-item-row__img-ph" />
        )}

        <div className="line-item-row__body">
          <div className="line-item-row__title">
            {buildTitle(productName, color, size, isOffer)}
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
