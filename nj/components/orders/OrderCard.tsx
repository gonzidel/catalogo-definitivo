"use client";

import { useState } from "react";
import { getPrimaryColumnForActions } from "@/lib/orders/classification";
import {
  buildWhatsAppUrl,
  formatOrderNotesExtras,
  formatPriceAr,
  getCustomerFromOrder,
  getDaysSinceCreation,
  getOrderDisplayNumber,
  getSourceIcon,
} from "@/lib/orders/domain";
import { useOrdersStore } from "@/hooks/useOrders";
import type { AdminOrder } from "@/types/orders";
import OrderActions from "./OrderActions";
import OrderCardItems from "./OrderCardItems";

interface OrderCardProps {
  order: AdminOrder;
}

function OrderCardFooter({ order }: { order: AdminOrder }) {
  const extrasLines = formatOrderNotesExtras(order);
  const createdLabel = new Date(order.created_at).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  return (
    <div className="order-card__footer">
      <div className="order-card__footer-totals">
        <span className="order-card__total">{formatPriceAr(order.total_amount)}</span>
        {extrasLines.length > 0 ? (
          <div className="order-card__extras">
            {extrasLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        ) : null}
      </div>
      <span>{createdLabel}</span>
    </div>
  );
}

export default function OrderCard({ order }: OrderCardProps) {
  const [expanded, setExpanded] = useState(false);
  const loadingAction = useOrdersStore((s) => s.loadingAction);
  const removeItem = useOrdersStore((s) => s.cancelItem);

  const customer = getCustomerFromOrder(order);
  const days = getDaysSinceCreation(order.created_at);
  const aged = days >= 7;
  const waUrl = buildWhatsAppUrl(customer?.phone);
  const column = getPrimaryColumnForActions(order);
  const showItemRemove = column === "active" || column === "picked";
  const items = order.order_items || [];
  const customerName = customer?.full_name?.trim() || "Sin cliente";

  return (
    <article className={`order-card${aged ? " order-card--aged" : ""}`}>
      <div className="order-card__header">
        <div className="order-card__header-row">
          <span className="order-card__number">{getOrderDisplayNumber(order)}</span>
          <div className="order-card__meta">
            {order.transportName ? (
              <span
                className={`order-card-transport ${order.transportBadgeClass || "order-card-transport--default"}`}
              >
                {order.transportName}
              </span>
            ) : null}
            <span className="order-card__source" title="Origen">
              {getSourceIcon(order.source)}
            </span>
            <span className={`order-card__days${aged ? " order-card__days--warn" : ""}`}>
              {days}d
            </span>
          </div>
        </div>

        <div className="order-card__customer-block">
          {waUrl ? (
            <a
              className="order-card__customer"
              href={waUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {customerName}
            </a>
          ) : (
            <span className="order-card__customer">{customerName}</span>
          )}
          <span className="order-card__header-total">{formatPriceAr(order.total_amount)}</span>
        </div>

        <div className="order-card__toggle-row">
          <button
            type="button"
            className="order-card__toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Colapsar detalle" : "Expandir detalle"}
          </button>
        </div>
      </div>

      {expanded ? (
        <>
          <div className="order-card__body">
            <OrderCardItems
              items={items}
              showRemove={showItemRemove}
              onRemoveItem={(itemId) => removeItem(order.id, itemId)}
              loadingItemId={loadingAction}
            />
          </div>
          <OrderCardFooter order={order} />
        </>
      ) : null}

      <OrderActions order={order} />
    </article>
  );
}
