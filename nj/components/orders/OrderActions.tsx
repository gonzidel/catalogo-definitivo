"use client";

import { useEffect, useState } from "react";
import {
  getPrimaryColumnForActions,
  isExpiredPendingAdminDisassembly,
} from "@/lib/orders/classification";
import {
  describeStockPendingConflict,
  parseOrderNotesObject,
  parseStockPendingReasonConflict,
} from "@/lib/orders/domain";
import {
  otherBoardButtonLabel,
  otherBoardTitle,
} from "@/lib/orders/board-scope";
import { loadPaymentMethods } from "@/lib/supabase/order-queries";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useOrdersStore } from "@/hooks/useOrders";
import type { AdminOrder, KanbanColumnId, PaymentMethod } from "@/types/orders";
import OrderEditModal from "./OrderEditModal";
import RetiroCloseModal from "./RetiroCloseModal";

interface OrderActionsProps {
  order: AdminOrder;
  /** Mobile/Activos en modo borrador: oculta acciones que aplicarían cambios de inmediato. */
  draftMode?: boolean;
}

const EDITABLE_COLUMNS = new Set<KanbanColumnId>(["picked"]);

/** "Pagado" = verde, "Contra Reembolso" (o variantes de escritura) = amarillo. Cualquier otro método futuro cae en gris neutro en vez de romper. */
function getPaymentMethodColorClass(name: string): "green" | "yellow" | "neutral" {
  const key = name.trim().toLowerCase();
  if (key.startsWith("pagad")) return "green";
  if (key.includes("reembolso") || key.includes("contrarreembolso") || key.includes("contrarrembolso")) return "yellow";
  return "neutral";
}

function PaymentMethodIcon({ color }: { color: "green" | "yellow" | "neutral" }) {
  if (color === "green") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function canEditOrder(column: KanbanColumnId, order: AdminOrder): boolean {
  if (!EDITABLE_COLUMNS.has(column)) return false;
  const status = String(order.status || "").trim().toLowerCase();
  return status !== "sent";
}

export default function OrderActions({ order, draftMode = false }: OrderActionsProps) {
  const column = getPrimaryColumnForActions(order);
  const loadingAction = useOrdersStore((s) => s.loadingAction);
  const pickAllReserved = useOrdersStore((s) => s.pickAllReserved);
  const closeOrder = useOrdersStore((s) => s.closeOrder);
  const moveOrderToOtherBoard = useOrdersStore((s) => s.moveOrderToOtherBoard);
  const boardScope = useOrdersStore((s) => s.boardScope);
  const revertOrderToPicked = useOrdersStore((s) => s.revertOrderToPicked);
  const resolveStockPending = useOrdersStore((s) => s.resolveStockPending);
  const cancelStockPendingOrder = useOrdersStore((s) => s.cancelStockPendingOrder);
  const dismantleOrder = useOrdersStore((s) => s.dismantleOrder);
  const extendOrder24h = useOrdersStore((s) => s.extendOrder24h);

  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [dismantleModalOpen, setDismantleModalOpen] = useState(false);
  const [extendModalOpen, setExtendModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [moveBoardConfirmOpen, setMoveBoardConfirmOpen] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [selectedPayment, setSelectedPayment] = useState("");
  const busy = loadingAction === order.id;
  const showEdit = canEditOrder(column, order);
  const moveBoardLabel = otherBoardButtonLabel(boardScope);
  const moveBoardTargetTitle = otherBoardTitle(boardScope);

  useEffect(() => {
    if (!closeModalOpen || boardScope === "local_pickup") return;
    loadPaymentMethods(getSupabaseBrowserClient()).then((methods) => {
      setPaymentMethods(methods);
      if (methods[0]) setSelectedPayment(methods[0].name);
    });
  }, [closeModalOpen, boardScope]);

  const notesObj = parseOrderNotesObject(order.notes);
  const conflictParsed = parseStockPendingReasonConflict(
    String(notesObj.stock_pending_reason || "")
  );
  const conflictDescription = describeStockPendingConflict(
    order,
    conflictParsed,
    String(notesObj.stock_pending_reason || "")
  );

  const handleCloseConfirm = async () => {
    if (!selectedPayment) return;
    await closeOrder(order.id, selectedPayment);
    setCloseModalOpen(false);
  };

  const isRetiroBoard = boardScope === "local_pickup";

  const handleResolveConfirm = async () => {
    await resolveStockPending(order.id);
    setResolveModalOpen(false);
  };

  const handleDismantleConfirm = async () => {
    await dismantleOrder(order.id);
    setDismantleModalOpen(false);
  };

  const handleExtendConfirm = async () => {
    await extendOrder24h(order.id);
    setExtendModalOpen(false);
  };

  const handleMoveBoardConfirm = async () => {
    setMoveBoardConfirmOpen(false);
    await moveOrderToOtherBoard(order.id);
  };

  const editButton = showEdit ? (
    <button
      type="button"
      className="order-card__btn order-card__btn--edit"
      disabled={busy}
      onClick={() => setEditModalOpen(true)}
    >
      Editar
    </button>
  ) : null;

  return (
    <>
      <div
        className={`order-card__actions${
          column === "picked" ? " order-card__actions--picked" : ""
        }`}
      >
        {column === "active" && !draftMode ? (
          <>
            <button
              type="button"
              className="order-card__btn order-card__btn--primary order-card__btn--grow"
              disabled={busy}
              onClick={() => pickAllReserved(order.id)}
            >
              Apartar todos
            </button>
          </>
        ) : null}

        {column === "picked" ? (
          <>
            <button
              type="button"
              className="order-card__btn order-card__btn--primary order-card__btn--grow"
              disabled={busy}
              onClick={() => setCloseModalOpen(true)}
            >
              Cerrar pedido
            </button>
            {editButton}
            <button
              type="button"
              className="order-card__btn order-card__btn--mini"
              disabled={busy}
              title={`Enviar a ${moveBoardTargetTitle}`}
              aria-label={`Enviar a ${moveBoardTargetTitle}`}
              onClick={() => setMoveBoardConfirmOpen(true)}
            >
              {moveBoardLabel}
            </button>
          </>
        ) : null}

        {column === "closed" ? (
          <button
            type="button"
            className="order-card__btn order-card__btn--grow"
            disabled={busy}
            onClick={() => revertOrderToPicked(order.id)}
          >
            Volver a apartado
          </button>
        ) : null}

        {column === "stock_pending" ? (
          <>
            <button
              type="button"
              className="order-card__btn order-card__btn--primary order-card__btn--grow"
              disabled={busy}
              onClick={() => setResolveModalOpen(true)}
            >
              Resolver
            </button>
            <button
              type="button"
              className="order-card__btn order-card__btn--danger"
              disabled={busy}
              onClick={() => cancelStockPendingOrder(order.id)}
            >
              Cancelar
            </button>
          </>
        ) : null}

        {column === "cancelled" && (isExpiredPendingAdminDisassembly(order) || order.status === "cancelled") ? (
          <>
            {isExpiredPendingAdminDisassembly(order) && (
              <button
                type="button"
                className="order-card__btn order-card__btn--grow"
                disabled={busy}
                onClick={() => setExtendModalOpen(true)}
              >
                +24hs
              </button>
            )}
            <button
              type="button"
              className="order-card__btn order-card__btn--danger order-card__btn--grow"
              disabled={busy}
              onClick={() => setDismantleModalOpen(true)}
            >
              Desarmar
            </button>
          </>
        ) : null}
      </div>

      {editModalOpen ? (
        <OrderEditModal order={order} onClose={() => setEditModalOpen(false)} />
      ) : null}

      {moveBoardConfirmOpen ? (
        <div
          className="order-modal-backdrop"
          role="presentation"
          onClick={() => setMoveBoardConfirmOpen(false)}
        >
          <div
            className="order-modal order-modal--compact"
            role="dialog"
            aria-labelledby={`move-board-${order.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id={`move-board-${order.id}`}>
              Enviar a {moveBoardTargetTitle}
            </h3>
            <p className="order-modal__text">
              ¿Confirmar envío a {moveBoardTargetTitle}? El pedido saldrá de esta lista
              y aparecerá en el otro tablero.
            </p>
            <div className="order-modal__actions">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setMoveBoardConfirmOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={busy}
                onClick={() => void handleMoveBoardConfirm()}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {closeModalOpen && isRetiroBoard ? (
        <RetiroCloseModal
          order={order}
          busy={busy}
          onClose={() => setCloseModalOpen(false)}
          onDone={(message) => {
            setCloseModalOpen(false);
            useOrdersStore.getState().removeOrder(order.id);
            useOrdersStore.getState().showToast(message, "success");
          }}
          onError={(message) => {
            useOrdersStore.getState().showToast(message, "error");
          }}
        />
      ) : null}

      {closeModalOpen && !isRetiroBoard ? (
        <div
          className="order-modal-backdrop"
          role="presentation"
          onClick={() => setCloseModalOpen(false)}
        >
          <div
            className="order-modal"
            role="dialog"
            aria-labelledby={`close-modal-${order.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id={`close-modal-${order.id}`}>
              Cerrar pedido
            </h3>
            <p className="order-modal__text">Seleccioná el método de pago</p>
            <div className="order-modal__payment-options">
              {paymentMethods.map((m) => {
                const color = getPaymentMethodColorClass(m.name);
                const isSelected = selectedPayment === m.name;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`order-modal__payment-btn order-modal__payment-btn--${color}${isSelected ? " order-modal__payment-btn--selected" : ""}`}
                    onClick={() => setSelectedPayment(m.name)}
                    aria-pressed={isSelected}
                  >
                    <PaymentMethodIcon color={color} />
                    {m.name}
                  </button>
                );
              })}
            </div>
            <div className="order-modal__actions">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setCloseModalOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={!selectedPayment || busy}
                onClick={handleCloseConfirm}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {resolveModalOpen ? (
        <div
          className="order-modal-backdrop"
          role="presentation"
          onClick={() => setResolveModalOpen(false)}
        >
          <div
            className="order-modal"
            role="dialog"
            aria-labelledby={`resolve-modal-${order.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id={`resolve-modal-${order.id}`}>
              Resolver conflicto de stock
            </h3>
            <p className="order-modal__text">{conflictDescription}</p>
            <p className="order-modal__text">
              Se eliminará el ítem conflictivo y el pedido volverá a estado activo.
            </p>
            <div className="order-modal__actions">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setResolveModalOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--danger"
                disabled={busy}
                onClick={handleResolveConfirm}
              >
                Continuar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dismantleModalOpen ? (
        <div
          className="order-modal-backdrop"
          role="presentation"
          onClick={() => setDismantleModalOpen(false)}
        >
          <div
            className="order-modal"
            role="dialog"
            aria-labelledby={`dismantle-modal-${order.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id={`dismantle-modal-${order.id}`}>
              Desarmar pedido
            </h3>
            <p className="order-modal__text">
              ¿Confirmar desarme? Todo el stock regresa al sistema.
            </p>
            <div className="order-modal__actions order-modal__actions--big">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setDismantleModalOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--danger"
                disabled={busy}
                onClick={handleDismantleConfirm}
              >
                Desarmar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {extendModalOpen ? (
        <div
          className="order-modal-backdrop"
          role="presentation"
          onClick={() => setExtendModalOpen(false)}
        >
          <div
            className="order-modal"
            role="dialog"
            aria-labelledby={`extend-modal-${order.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id={`extend-modal-${order.id}`}>
              Prórroga +24hs
            </h3>
            <p className="order-modal__text">
              ¿Habilitar este pedido por 24 horas más? El cliente podrá volver a operarlo
              temporalmente.
            </p>
            <div className="order-modal__actions">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setExtendModalOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={busy}
                onClick={handleExtendConfirm}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
