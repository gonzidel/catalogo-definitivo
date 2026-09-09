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
  const [pendingOwner, setPendingOwner] = useState<KanbanInboxOwner | null>(null);
  const [pickerStyle, setPickerStyle] = useState<CSSProperties | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const setKanbanInboxOwner = useOrdersStore((s) => s.setKanbanInboxOwner);
  const owner = getOrderInboxOwner(order);
  const customerId = order.customer_id;

  const displayOwner = pendingOwner ?? owner;
  const currentMeta = KANBAN_INBOX_OWNERS.find((o) => o.id === displayOwner);

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
    setPendingOwner(next);
    setBusy(true);
    setOpen(false);
    const ok = await setKanbanInboxOwner(customerId, next);
    setBusy(false);
    setPendingOwner(null);
    if (!ok) {
      // Rollback visual: el store ya revirtió; reabrir no hace falta.
    }
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
        }${open ? " order-inbox-owner__chip--open" : ""}${
          busy ? " order-inbox-owner__chip--busy" : ""
        }`}
        aria-expanded={open}
        aria-haspopup="true"
        aria-busy={busy}
        disabled={busy || !customerId}
        title={busy ? "Guardando…" : "Cambiar dueña Ani / Fati"}
        onClick={() => {
          if (busy) return;
          setOpen((v) => !v);
        }}
      >
        {busy ? (
          <span className="order-inbox-owner__spinner" aria-hidden />
        ) : (
          currentMeta?.label ?? "¿?"
        )}
        {busy ? (
          <span className="order-inbox-owner__busy-label">
            {currentMeta?.label ?? "…"}
          </span>
        ) : null}
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
