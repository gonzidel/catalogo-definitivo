"use client";

import { useEffect, useState } from "react";
import {
  getPrimaryColumnForActions,
} from "@/lib/orders/classification";
import {
  describeStockPendingConflict,
  parseOrderNotesObject,
  isNetworkStockPendingReason,
  parseStockPendingReasonConflict,
} from "@/lib/orders/domain";
import {
  otherBoardButtonLabel,
  otherBoardTitle,
} from "@/lib/orders/board-scope";
import { fetchPendingStockReturnQty, loadPaymentMethods } from "@/lib/supabase/order-queries";
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
  const reopenExpiredOrder = useOrdersStore((s) => s.reopenExpiredOrder);
  const markExpiredOrderSent = useOrdersStore((s) => s.markExpiredOrderSent);
  const isFullyExpired = order.status === "expired";

  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [dismantleModalOpen, setDismantleModalOpen] = useState(false);
  const [extendModalOpen, setExtendModalOpen] = useState(false);
  const [markSentModalOpen, setMarkSentModalOpen] = useState(false);
  // Cuánto stock real se sumaría al depósito si se archiva este pedido vencido --
  // la mayoría de los 'expired' ya no tienen fuentes reales (el cron las liberó
  // al vencer), pero mostrar el número en vez de asumirlo le da confianza al
  // admin antes de confirmar (ver auditoría 2026-09-15, caso Gonzalo de la Fuente).
  const [stockImpactQty, setStockImpactQty] = useState<number | null>(null);
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

  useEffect(() => {
    if (!dismantleModalOpen || !isFullyExpired) {
      setStockImpactQty(null);
      return;
    }
    let cancelled = false;
    const itemIds = (order.order_items || []).map((i) => i.id);
    fetchPendingStockReturnQty(getSupabaseBrowserClient(), itemIds).then((qty) => {
      if (!cancelled) setStockImpactQty(qty);
    });
    return () => {
      cancelled = true;
    };
  }, [dismantleModalOpen, isFullyExpired, order.order_items]);

  const notesObj = parseOrderNotesObject(order.notes);
  const pendingReason = String(notesObj.stock_pending_reason || "");
  const isNetworkPending = isNetworkStockPendingReason(pendingReason);
  const conflictParsed = parseStockPendingReasonConflict(pendingReason);
  const conflictDescription = isNetworkPending
    ? "Falló la conexión al descontar stock. Los productos ya están en el pedido; reintentamos solo el descuento (sin volver a cargar)."
    : describeStockPendingConflict(order, conflictParsed, pendingReason);

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

  const handleMarkSentConfirm = async () => {
    await markExpiredOrderSent(order.id);
    setMarkSentModalOpen(false);
  };

  const handleExtendConfirm = async () => {
    if (isFullyExpired) {
      await reopenExpiredOrder(order.id);
    } else {
      await extendOrder24h(order.id);
    }
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
              {isNetworkPending ? "Reintentar" : "Resolver"}
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

        {column === "expired" ? (
          <>
            <button
              type="button"
              className="order-card__btn order-card__btn--grow"
              disabled={busy}
              onClick={() => setExtendModalOpen(true)}
            >
              +24hs
            </button>
            {isFullyExpired && (
              <button
                type="button"
                className="order-card__btn order-card__btn--grow"
                disabled={busy}
                title="El pedido en realidad ya se resolvió fuera del sistema (ej. WhatsApp)"
                onClick={() => setMarkSentModalOpen(true)}
              >
                Ya enviado
              </button>
            )}
            <button
              type="button"
              className="order-card__btn order-card__btn--danger order-card__btn--grow"
              disabled={busy}
              onClick={() => setDismantleModalOpen(true)}
            >
              {order.status === "expired" ? "Archivar" : "Desarmar"}
            </button>
          </>
        ) : null}

        {column === "cancelled" && order.status === "cancelled" ? (
          <button
            type="button"
            className="order-card__btn order-card__btn--danger order-card__btn--grow"
            disabled={busy}
            onClick={() => setDismantleModalOpen(true)}
          >
            Desarmar
          </button>
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
            void useOrdersStore.getState().refreshAll("local_pickup");
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
              {isNetworkPending ? "Reintentar descuento de stock" : "Resolver conflicto de stock"}
            </h3>
            <p className="order-modal__text">{conflictDescription}</p>
            {isNetworkPending ? null : (
              <p className="order-modal__text">
                Se eliminará el ítem conflictivo y el pedido volverá a estado activo.
              </p>
            )}
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
                className={`order-card__btn ${isNetworkPending ? "order-card__btn--primary" : "order-card__btn--danger"}`}
                disabled={busy}
                onClick={handleResolveConfirm}
              >
                {isNetworkPending ? "Reintentar" : "Continuar"}
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
              {order.status === "expired" ? "Archivar pedido vencido" : "Desarmar pedido"}
            </h3>
            <p className="order-modal__text">
              {order.status === "expired"
                ? "El stock ya volvió al sistema automáticamente al vencer el plazo. Confirmá para archivar el pedido y sacarlo de Vencido."
                : "¿Confirmar desarme? Todo el stock regresa al sistema."}
            </p>
            {order.status === "expired" ? (
              <p
                className="order-modal__text"
                style={{ fontWeight: 700, color: stockImpactQty ? "#b45309" : "#15803d" }}
              >
                {stockImpactQty === null
                  ? "Revisando stock…"
                  : stockImpactQty > 0
                    ? `Ojo: al archivar se van a sumar ${stockImpactQty} unidad${stockImpactQty === 1 ? "" : "es"} al depósito.`
                    : "No va a sumar nada al depósito (ya se liberó automáticamente al vencer)."}
              </p>
            ) : null}
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
                {order.status === "expired" ? "Archivar" : "Desarmar"}
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
              {isFullyExpired ? "Reabrir pedido vencido" : "Prórroga +24hs"}
            </h3>
            <p className="order-modal__text">
              {isFullyExpired
                ? "El pedido vuelve a Apartados y tiene 24hs más para gestionarse. El stock no se toca: estos productos ya estaban físicamente reservados."
                : "¿Habilitar este pedido por 24 horas más? El cliente podrá volver a operarlo temporalmente."}
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

      {markSentModalOpen ? (
        <div
          className="order-modal-backdrop"
          role="presentation"
          onClick={() => setMarkSentModalOpen(false)}
        >
          <div
            className="order-modal order-modal--compact"
            role="dialog"
            aria-labelledby={`mark-sent-modal-${order.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id={`mark-sent-modal-${order.id}`}>
              Marcar como ya enviado
            </h3>
            <p className="order-modal__text">
              Usá esto cuando el pedido en realidad ya se entregó/envió fuera del
              sistema (ej. WhatsApp) y el cron lo dejó como vencido por error de
              carga. El pedido pasa a &quot;Enviado&quot; y sale de Vencido.
            </p>
            <p className="order-modal__text" style={{ fontWeight: 700, color: "#1f2937" }}>
              No se toca el stock ni los productos del pedido.
            </p>
            <div className="order-modal__actions order-modal__actions--big">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setMarkSentModalOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={busy}
                onClick={() => void handleMarkSentConfirm()}
              >
                Marcar enviado
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
