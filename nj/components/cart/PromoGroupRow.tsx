"use client";

import { useState, type ReactNode } from "react";
import {
  formatPromoTitle,
  type PromoGroupableItem,
} from "@/lib/cart/promo-groups";
import { formatItemARS } from "@/components/cart/LineItemRow";

export interface PromoChildControls {
  qty: number;
  atMax?: boolean;
  onQtyDelta?: (delta: number) => void;
  onRemove?: () => void;
  /** Controles extra (p. ej. menú ⋯ de Mi pedido). */
  trailing?: ReactNode;
  below?: ReactNode;
  /** Si false, no muestra stepper (Mi pedido). */
  showStepper?: boolean;
  /** Etiqueta de cantidad estática (Mi pedido). */
  qtyLabel?: ReactNode;
}

interface PromoGroupRowProps {
  promoLabel: string;
  groups: number;
  totalQty: number;
  promoPrice: number;
  items: PromoGroupableItem[];
  /** Controles por key de ítem. */
  childControls?: Record<string, PromoChildControls>;
  /** Modo: carrito muestra −/+; pedido no (salvo que childControls lo pida). */
  mode: "cart" | "order";
}

function StackedThumbs({ items }: { items: PromoGroupableItem[] }) {
  // Una miniatura por unidad cubierta (máx. 3). Si hay 2 iguales (mismo
  // producto/talle), se duplica la imagen para que se vea el apilado.
  const thumbs: { key: string; src: string }[] = [];
  for (const item of items) {
    if (!item.imagen) continue;
    const copies = Math.max(1, Number(item.qty) || 1);
    for (let i = 0; i < copies && thumbs.length < 3; i++) {
      thumbs.push({ key: `${item.key}__t${i}`, src: item.imagen });
    }
  }
  // Fallback: al menos 2 capas si la promo cubre 2+ y solo hay 1 URL.
  const totalUnits = items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
  if (thumbs.length === 1 && totalUnits >= 2) {
    thumbs.push({ key: `${thumbs[0].key}__dup`, src: thumbs[0].src });
  }
  if (thumbs.length === 0) {
    return <div className="promo-group-thumbs promo-group-thumbs--empty" />;
  }
  return (
    <div className="promo-group-thumbs" aria-hidden>
      {thumbs.map((thumb, idx) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={thumb.key}
          src={thumb.src}
          alt=""
          className={`promo-group-thumbs__img promo-group-thumbs__img--${idx}`}
        />
      ))}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

export default function PromoGroupRow({
  promoLabel,
  groups,
  totalQty,
  promoPrice,
  items,
  childControls = {},
  mode,
}: PromoGroupRowProps) {
  const [expanded, setExpanded] = useState(false);
  const title = formatPromoTitle(groups, promoLabel);

  return (
    <div className="promo-group">
      <div className="promo-group__main">
        <StackedThumbs items={items} />

        <div className="promo-group__body">
          <div className="promo-group__title">{title}</div>
          <div className="promo-group__meta">
            <span>
              {totalQty} producto{totalQty !== 1 ? "s" : ""}
            </span>
            <button
              type="button"
              className="promo-group__toggle"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? "Ocultar ∧" : "Ver detalle ∨"}
            </button>
          </div>
        </div>

        {/* Misma columna derecha que LineItemRow: precio + espacio de menú. */}
        <div className="promo-group__side">
          <div className="promo-group__price-wrap">
            <span className="promo-group__price">
              {formatItemARS(promoPrice)}
            </span>
            {mode === "order" && (
              <span className="promo-group__menu-spacer" aria-hidden="true" />
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="promo-group__detail">
          {items.map((item) => {
            const ctrl = childControls[item.key];
            const showStepper =
              mode === "cart" && (ctrl?.showStepper !== false);
            const qty = ctrl?.qty ?? item.qty;

            return (
              <div key={item.key} className="promo-group-child">
                {item.imagen ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.imagen}
                    alt={item.product_name}
                    className="promo-group-child__img"
                  />
                ) : (
                  <div className="promo-group-child__img-ph" />
                )}

                <div className="promo-group-child__body">
                  <div className="promo-group-child__title">
                    {[item.product_name, item.color, item.size ? `T. ${item.size}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div className="promo-group-child__meta">
                    {showStepper && ctrl?.onQtyDelta ? (
                      <div className="cart-tab-stepper">
                        <button
                          type="button"
                          onClick={() => ctrl.onQtyDelta?.(-1)}
                          aria-label="Menos"
                          className="cart-tab-stepper__btn"
                        >
                          −
                        </button>
                        <span className="cart-tab-stepper__value">{qty}</span>
                        <button
                          type="button"
                          onClick={() => ctrl.onQtyDelta?.(1)}
                          aria-label="Más"
                          disabled={ctrl.atMax}
                          className={[
                            "cart-tab-stepper__btn",
                            "cart-tab-stepper__btn--plus",
                            ctrl.atMax ? "is-max" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      ctrl?.qtyLabel ?? (
                        <span className="line-item-qty-label">
                          {qty} uni
                        </span>
                      )
                    )}
                  </div>
                  {ctrl?.below}
                </div>

                <div className="promo-group-child__side">
                  <div className="promo-group-child__actions">
                    {ctrl?.trailing}
                    {ctrl?.onRemove && (
                      <button
                        type="button"
                        onClick={ctrl.onRemove}
                        aria-label="Eliminar"
                        className="cart-tab-remove"
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
