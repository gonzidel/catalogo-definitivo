"use client";

import { useCallback, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchManualConfirmReservationConflicts,
  reservationConflictForItem,
  type OrderEditDraftItem,
  type ReservationCandidate,
  type ReservationConflict,
  type TakenReservation,
} from "@/lib/supabase/order-edit";
import { emitCustomerOrderNotification, fetchOrderById } from "@/lib/supabase/order-queries";
import type { AdminOrder } from "@/types/orders";

const OTHER_PAIR = "__other_pair__";

export class ReservationChoiceCancelledError extends Error {
  constructor() {
    super("Guardado cancelado");
    this.name = "ReservationChoiceCancelledError";
  }
}

type PendingChoice = {
  items: OrderEditDraftItem[];
  conflicts: ReservationConflict[];
  resolve: (items: OrderEditDraftItem[] | null) => void;
};

/**
 * Antes de confirmar a mano un talle sin stock, avisa si otro pedido abierto lo
 * tiene reservado y deja elegir: tomar ese par (el otro pedido queda sin stock)
 * o confirmar que hay otro par. Regla de negocio 2026-10-07 (canonical:370).
 */
export function useReservationConflictResolver() {
  const [pending, setPending] = useState<PendingChoice | null>(null);

  const resolveReservationConflicts = useCallback(
    async (
      supabase: SupabaseClient,
      items: OrderEditDraftItem[],
      excludeOrderId: string | null
    ): Promise<OrderEditDraftItem[]> => {
      const conflicts = await fetchManualConfirmReservationConflicts(supabase, items, excludeOrderId);
      if (!conflicts.length) return items;
      const chosen = await new Promise<OrderEditDraftItem[] | null>((resolve) =>
        setPending({ items, conflicts, resolve })
      );
      setPending(null);
      if (!chosen) throw new ReservationChoiceCancelledError();
      return chosen;
    },
    []
  );

  const conflictModal = pending ? (
    <ReservationConflictModal
      items={pending.items}
      conflicts={pending.conflicts}
      onConfirm={(items) => pending.resolve(items)}
      onCancel={() => pending.resolve(null)}
    />
  ) : null;

  return { resolveReservationConflicts, conflictModal };
}

/** Avisa a cada clienta que perdió el par y refresca su pedido en el tablero. */
export async function notifyTakenReservations(
  supabase: SupabaseClient,
  taken: TakenReservation[],
  patchOrder: (order: AdminOrder) => void
): Promise<void> {
  const byOrder = new Map<string, { customerId: string | null; count: number }>();
  for (const row of taken) {
    const entry = byOrder.get(row.order_id) ?? { customerId: row.customer_id, count: 0 };
    entry.count += 1;
    byOrder.set(row.order_id, entry);
  }

  await Promise.all(
    [...byOrder.entries()].map(async ([orderId, { customerId, count }]) => {
      if (customerId) {
        await emitCustomerOrderNotification(supabase, {
          customerId,
          orderId,
          type: "ORDER_MISSING_ITEMS",
          message:
            count === 1
              ? "1 producto no está disponible. Por favor revisalo en tu pedido."
              : `${count} productos no están disponibles. Por favor revisalos en tu pedido.`,
          payload: { missingCount: count, action_url: "/dashboard?tab=active-order" },
          dedupeTypes: ["ORDER_MISSING_ITEMS", "ORDER_ALL_RESERVED"],
        });
      }
      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) patchOrder(refreshed);
    })
  );
}

export function describeTakenReservations(taken: TakenReservation[]): string {
  const numbers = [...new Set(taken.map((t) => t.order_number || "otro pedido"))];
  return `${numbers.join(", ")} quedó sin stock en ese producto (se le avisó a la clienta)`;
}

function formatReservedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
}

interface ReservationConflictModalProps {
  items: OrderEditDraftItem[];
  conflicts: ReservationConflict[];
  onConfirm: (items: OrderEditDraftItem[]) => void;
  onCancel: () => void;
}

function ReservationConflictModal({ items, conflicts, onConfirm, onCancel }: ReservationConflictModalProps) {
  const rows = items
    .map((item, index) => ({ item, index, conflict: reservationConflictForItem(item, conflicts) }))
    .filter((row): row is { item: OrderEditDraftItem; index: number; conflict: ReservationConflict } =>
      Boolean(row.conflict)
    );

  const [choices, setChoices] = useState<Record<number, string>>({});
  const complete = rows.every((row) => Boolean(choices[row.index]));

  const takenByOtherRow = (candidateId: string, rowIndex: number) =>
    Object.entries(choices).some(([idx, value]) => value === candidateId && Number(idx) !== rowIndex);

  const handleConfirm = () => {
    if (!complete) return;
    onConfirm(
      items.map((item, index) => {
        const choice = choices[index];
        if (!choice || choice === OTHER_PAIR) return item;
        return { ...item, take_from_order_item_id: choice };
      })
    );
  };

  const renderCandidate = (row: (typeof rows)[number], candidate: ReservationCandidate) => {
    const qtyMismatch = Number(candidate.quantity) !== Number(row.item.quantity);
    const disabled = qtyMismatch || takenByOtherRow(candidate.order_item_id, row.index);
    const selected = choices[row.index] === candidate.order_item_id;
    const orderLabel = candidate.order_number || "Pedido";
    return (
      <button
        key={candidate.order_item_id}
        type="button"
        className={`reservation-conflict__option${selected ? " is-selected" : ""}`}
        disabled={disabled}
        aria-pressed={selected}
        onClick={() => setChoices((prev) => ({ ...prev, [row.index]: candidate.order_item_id }))}
      >
        <span className="reservation-conflict__option-title">
          Es el par de {orderLabel} · {candidate.customer_name}
          {candidate.local_deferred_pickup ? " (Retiro)" : ""}
        </span>
        <span className="reservation-conflict__option-sub">
          {qtyMismatch
            ? `Tiene ${candidate.quantity} u. reservadas: no se puede pasar parcial`
            : `Reservado el ${formatReservedDate(candidate.item_created_at)} · ${orderLabel} queda sin stock`}
        </span>
      </button>
    );
  };

  return (
    <div className="order-modal-backdrop order-modal-backdrop--item" role="presentation">
      <div
        className="order-modal order-modal--compact"
        role="dialog"
        aria-labelledby="reservation-conflict-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="order-modal__title" id="reservation-conflict-title">
          Talle reservado por otro pedido
        </h3>
        <p className="order-modal__text">
          Lo estás confirmando sin stock, pero el sistema ya lo tiene apartado para otro pedido.
          ¿El par que tenés es ese?
        </p>

        <div className="reservation-conflict__list">
          {rows.map((row) => (
            <div key={row.index} className="reservation-conflict__item">
              <p className="reservation-conflict__product">
                {row.item.product_name} · {row.item.color || "-"} · T{row.item.size} ×{row.item.quantity}
              </p>
              {row.conflict.candidates.map((candidate) => renderCandidate(row, candidate))}
              <button
                type="button"
                className={`reservation-conflict__option${
                  choices[row.index] === OTHER_PAIR ? " is-selected" : ""
                }`}
                aria-pressed={choices[row.index] === OTHER_PAIR}
                onClick={() => setChoices((prev) => ({ ...prev, [row.index]: OTHER_PAIR }))}
              >
                <span className="reservation-conflict__option-title">Hay otro par en el local</span>
                <span className="reservation-conflict__option-sub">
                  Los dos pedidos conservan su par
                </span>
              </button>
            </div>
          ))}
        </div>

        <div className="order-modal__actions">
          <button type="button" className="order-card__btn" onClick={onCancel}>
            Cancelar
          </button>
          <button
            type="button"
            className="order-card__btn order-card__btn--primary"
            disabled={!complete}
            onClick={handleConfirm}
          >
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}
