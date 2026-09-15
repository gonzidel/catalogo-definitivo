"use client";

import { formatPriceAr, getCustomerFromOrder, getOrderDisplayNumber } from "@/lib/orders/domain";
import type { AdminOrder } from "@/types/orders";

const STATUS_LABELS: Record<string, string> = {
  expired: "Vencido",
  sent: "Enviado",
  "devolución": "Devolución",
  devolucion: "Devolución",
};

function formatShortDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

interface OrderSearchResultCardProps {
  order: AdminOrder;
}

/**
 * Resultado del buscador de columna (KanbanColumnSearch) para pedidos que ya
 * no viven en el pool operativo (sent/devolución/expired) -- ver
 * searchOrdersGlobal en order-queries.ts y auditoría 2026-09-15.
 *
 * A propósito NO reusa OrderCard/OrderActions: esos asumen una columna Kanban
 * válida (getOrderKanbanColumn) y acciones operativas (Desarmar, Apartar, etc.)
 * que no tienen sentido sobre un pedido en estado terminal. Esta card es de
 * solo lectura, para poder ubicar el pedido y confirmar que no se perdió.
 */
export default function OrderSearchResultCard({ order }: OrderSearchResultCardProps) {
  const customer = getCustomerFromOrder(order);
  const statusKey = String(order.status || "").toLowerCase();
  const statusLabel = STATUS_LABELS[statusKey] || order.status || "";
  const itemCount = Array.isArray(order.order_items) ? order.order_items.length : 0;

  return (
    <article className="order-search-result">
      <div className="order-search-result__row">
        <span className="order-search-result__number">{getOrderDisplayNumber(order)}</span>
        <span className="order-search-result__status">{statusLabel}</span>
      </div>
      <p className="order-search-result__customer">{customer?.full_name || "Cliente sin nombre"}</p>
      <div className="order-search-result__meta">
        <span>{formatShortDate(order.created_at)}</span>
        <span>
          {itemCount} ítem{itemCount === 1 ? "" : "s"}
        </span>
        <span>{formatPriceAr(order.total_amount)}</span>
      </div>
    </article>
  );
}
