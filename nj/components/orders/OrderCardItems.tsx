"use client";

import { useState } from "react";
import { formatPriceAr } from "@/lib/orders/domain";
import type { AdminOrderItem } from "@/types/orders";
import ItemStatusBadge from "./ItemStatusBadge";

interface OrderCardItemsProps {
  items: AdminOrderItem[];
  showRemove?: boolean;
  onRemoveItem?: (itemId: string) => void;
  loadingItemId?: string | null;
}

export default function OrderCardItems({
  items,
  showRemove = false,
  onRemoveItem,
  loadingItemId,
}: OrderCardItemsProps) {
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const pendingItem = items.find((i) => i.id === pendingItemId);

  if (!items.length) {
    return <p className="kanban-column__empty">Sin ítems</p>;
  }

  const handleConfirmRemove = async () => {
    if (!pendingItemId || !onRemoveItem) return;
    await onRemoveItem(pendingItemId);
    setPendingItemId(null);
  };

  return (
    <>
      <ul className="order-card__items">
        {items.map((item) => (
          <li key={item.id} className="order-card__item-row">
            <div className="order-card__item-main">
              <span>
                {item.product_name || "Producto"} · {item.color || "-"} ·{" "}
                {item.size || "-"} × {item.quantity}
              </span>
              <div className="order-card__item-actions">
                <span>{formatPriceAr(item.price_snapshot)}</span>
                {showRemove && onRemoveItem ? (
                  <button
                    type="button"
                    className="order-card__item-remove"
                    disabled={loadingItemId === item.id}
                    aria-label="Quitar ítem"
                    title="Quitar ítem"
                    onClick={() => setPendingItemId(item.id)}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            </div>
            <div className="order-card__item-meta">
              <ItemStatusBadge status={item.status} />
              {item.warehouseLabel ? (
                <span className="order-card__warehouse">{item.warehouseLabel}</span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {pendingItemId && pendingItem ? (
        <div
          className="order-modal-backdrop order-modal-backdrop--item"
          role="presentation"
          onClick={() => setPendingItemId(null)}
        >
          <div
            className="order-modal order-modal--compact"
            role="dialog"
            aria-labelledby="remove-item-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id="remove-item-title">
              Quitar ítem
            </h3>
            <p className="order-modal__text">
              ¿Quitar este ítem del pedido?
              <br />
              {pendingItem.product_name || "Producto"} · {pendingItem.color || "-"} ·{" "}
              {pendingItem.size || "-"}
            </p>
            <div className="order-modal__actions">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setPendingItemId(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--danger"
                disabled={loadingItemId === pendingItemId}
                onClick={handleConfirmRemove}
              >
                Quitar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
