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
import { loadPaymentMethods } from "@/lib/supabase/order-queries";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useOrdersStore } from "@/hooks/useOrders";
import type { AdminOrder, PaymentMethod } from "@/types/orders";

interface OrderActionsProps {
  order: AdminOrder;
}

export default function OrderActions({ order }: OrderActionsProps) {
  const column = getPrimaryColumnForActions(order);
  const loadingAction = useOrdersStore((s) => s.loadingAction);
  const pickAllReserved = useOrdersStore((s) => s.pickAllReserved);
  const closeOrder = useOrdersStore((s) => s.closeOrder);
  const sendToLocal = useOrdersStore((s) => s.sendToLocal);
  const reopenOrder = useOrdersStore((s) => s.reopenOrder);
  const resolveStockPending = useOrdersStore((s) => s.resolveStockPending);
  const cancelStockPendingOrder = useOrdersStore((s) => s.cancelStockPendingOrder);
  const dismantleOrder = useOrdersStore((s) => s.dismantleOrder);
  const extendOrder24h = useOrdersStore((s) => s.extendOrder24h);

  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [dismantleModalOpen, setDismantleModalOpen] = useState(false);
  const [extendModalOpen, setExtendModalOpen] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [selectedPayment, setSelectedPayment] = useState("");
  const busy = loadingAction === order.id;

  useEffect(() => {
    if (!closeModalOpen) return;
    loadPaymentMethods(getSupabaseBrowserClient()).then((methods) => {
      setPaymentMethods(methods);
      if (methods[0]) setSelectedPayment(methods[0].name);
    });
  }, [closeModalOpen]);

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

  return (
    <>
      <div className="order-card__actions">
        {column === "active" ? (
          <button
            type="button"
            className="order-card__btn order-card__btn--primary"
            disabled={busy}
            onClick={() => pickAllReserved(order.id)}
          >
            Apartar todos
          </button>
        ) : null}

        {column === "picked" ? (
          <>
            <button
              type="button"
              className="order-card__btn order-card__btn--primary"
              disabled={busy}
              onClick={() => setCloseModalOpen(true)}
            >
              Cerrar pedido
            </button>
            <button
              type="button"
              className="order-card__btn"
              disabled={busy}
              onClick={() => sendToLocal(order.id)}
            >
              Enviar al local
            </button>
          </>
        ) : null}

        {column === "closed" ? (
          <>
            <button
              type="button"
              className="order-card__btn"
              disabled={busy}
              onClick={() => reopenOrder(order.id)}
            >
              Reabrir
            </button>
            <button type="button" className="order-card__btn order-card__btn--muted" disabled>
              Finalizado
            </button>
          </>
        ) : null}

        {column === "stock_pending" ? (
          <>
            <button
              type="button"
              className="order-card__btn order-card__btn--primary"
              disabled={busy}
              onClick={() => setResolveModalOpen(true)}
            >
              Resolver conflicto
            </button>
            <button
              type="button"
              className="order-card__btn order-card__btn--danger"
              disabled={busy}
              onClick={() => cancelStockPendingOrder(order.id)}
            >
              Cancelar pedido
            </button>
          </>
        ) : null}

        {column === "cancelled" ? (
          <>
            {isExpiredPendingAdminDisassembly(order) ? (
              <button
                type="button"
                className="order-card__btn"
                disabled={busy}
                onClick={() => setExtendModalOpen(true)}
              >
                Dar prórroga +24hs
              </button>
            ) : null}
            <button
              type="button"
              className="order-card__btn order-card__btn--danger"
              disabled={busy}
              onClick={() => setDismantleModalOpen(true)}
            >
              Desarmar pedido
            </button>
          </>
        ) : null}
      </div>

      {closeModalOpen ? (
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
            <select
              className="order-modal__select"
              value={selectedPayment}
              onChange={(e) => setSelectedPayment(e.target.value)}
            >
              {paymentMethods.map((m) => (
                <option key={m.id} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
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
            <div className="order-modal__actions">
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
