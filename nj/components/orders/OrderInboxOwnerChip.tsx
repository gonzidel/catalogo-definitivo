"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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
  const [pickerStyle, setPickerStyle] = useState<CSSProperties | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const setKanbanInboxOwner = useOrdersStore((s) => s.setKanbanInboxOwner);
  const owner = getOrderInboxOwner(order);
  const customerId = order.customer_id;

  const currentMeta = KANBAN_INBOX_OWNERS.find((o) => o.id === owner);

  const placePicker = () => {
    const el = chipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 6;
    const estimatedHeight = 96;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < estimatedHeight + gap && rect.top > estimatedHeight;

    setPickerStyle({
      position: "fixed",
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 120)),
      top: openUp ? undefined : rect.bottom + gap,
      bottom: openUp ? window.innerHeight - rect.top + gap : undefined,
      zIndex: 60,
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPickerStyle(null);
      return;
    }
    placePicker();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => placePicker();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

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
        ref={chipRef}
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
      {open && pickerStyle ? (
        <>
          <button
            type="button"
            className="order-inbox-owner__catcher"
            aria-label="Cerrar selector"
            onClick={() => setOpen(false)}
          />
          <span
            className="order-inbox-owner__picker"
            role="menu"
            aria-label="Asignar a Ani o Fati"
            style={pickerStyle}
          >
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
        </>
      ) : null}
    </span>
  );
}
