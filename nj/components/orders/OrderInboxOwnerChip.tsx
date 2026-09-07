"use client";

import { useState } from "react";
import {
  KANBAN_INBOX_OWNERS,
  getOrderInboxOwner,
  type KanbanInboxOwner,
} from "@/lib/orders/kanban-inbox";
import { useOrdersStore } from "@/hooks/useOrders";
import type { AdminOrder } from "@/types/orders";

interface OrderInboxOwnerChipProps {
  order: AdminOrder;
  /** Mostrar estrella de primer pedido. */
  showFirstOrderStar?: boolean;
}

/** Chip Ani/Fati junto al teléfono — reasigna la clienta. Solo Pedidos. */
export default function OrderInboxOwnerChip({
  order,
  showFirstOrderStar = false,
}: OrderInboxOwnerChipProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const setKanbanInboxOwner = useOrdersStore((s) => s.setKanbanInboxOwner);
  const owner = getOrderInboxOwner(order);
  const customerId = order.customer_id;

  const currentMeta = KANBAN_INBOX_OWNERS.find((o) => o.id === owner);

  const pick = async (next: KanbanInboxOwner) => {
    if (!customerId || busy) return;
    if (next === owner) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const ok = await setKanbanInboxOwner(customerId, next);
    setBusy(false);
    if (ok) setOpen(false);
  };

  return (
    <span className="order-inbox-owner" onClick={(e) => e.stopPropagation()}>
      {showFirstOrderStar ? (
        <span
          className="order-inbox-owner__star"
          title="Primera vez — primer pedido de esta clienta"
          aria-label="Clienta nueva (primer pedido)"
        >
          ★
        </span>
      ) : null}
      <button
        type="button"
        className={`order-inbox-owner__chip${
          currentMeta ? ` ${currentMeta.colorClass}` : " order-inbox-owner__chip--none"
        }${open ? " order-inbox-owner__chip--open" : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
        disabled={busy || !customerId}
        title="Cambiar dueña Ani / Fati"
        onClick={() => setOpen((v) => !v)}
      >
        {currentMeta?.label ?? "¿?"}
      </button>
      {open ? (
        <span className="order-inbox-owner__picker" role="menu" aria-label="Asignar a Ani o Fati">
          {KANBAN_INBOX_OWNERS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="menuitem"
              className={`order-inbox-owner__pick ${opt.colorClass}${
                owner === opt.id ? " order-inbox-owner__pick--current" : ""
              }`}
              disabled={busy}
              onClick={() => void pick(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
