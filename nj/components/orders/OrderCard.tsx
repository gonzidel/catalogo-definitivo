"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getPrimaryColumnForActions,
  isExpiredPendingAdminDisassembly,
} from "@/lib/orders/classification";
import {
  buildWhatsAppUrl,
  countPickedOrderItems,
  countRegularProductUnits,
  formatOrderNotesExtras,
  formatPriceAr,
  getCancelledItemsPendingStockReturn,
  getCancelledOrderItems,
  getCustomerFromOrder,
  getOrderDisplayNumber,
  isCancelledOrderItem,
  isCustomerSourcedOrder,
  isCommonLocalPickupAwaitingAdminSale,
  isMissingOrderItem,
  isAwaitingApartadoOrderItem,
  isPickedOrderItem,
  isReservedOrderItem,
  isWaitingOrderItem,
  orderHasCancelledItems,
  orderHasMissingItem,
  parseOrderNotesObject,
} from "@/lib/orders/domain";
import {
  calendarDaysUntil,
  formatAdminDeadlineCountdown,
  getOrderDeadlineDate,
  isOrderExpired,
  isOrderExpiringToday,
} from "@/lib/orders/deadline";
import { buildExpiryWarningMessage, buildExpiredOrderMessage } from "@/lib/orders/customer-status-message";
import { useExpiryWarnSentStore } from "@/lib/orders/expiry-warning-sent";
import {
  getWaitingSourceKind,
  orderHasWaitingSource,
} from "@/lib/orders/waiting-source";
import {
  draftDefersCustomerMessage,
  type DraftChangesMap,
} from "@/lib/orders/draft-changes";
import {
  buildMessageFromOrderAndDraft,
  buildPriorDecisionFromOrder,
  collectWaitingFabricaItemIdsFromDraft,
  collectWaitingLocalItemIdsFromDraft,
  resolveMessageProfile,
} from "@/lib/orders/customer-status-message";
import {
  saveLocalWaitSnapshotFromConfirm,
  updateLocalWaitSnapshotPriorFromConfirm,
} from "@/lib/orders/local-wait-notifications";
import { getRetiroActiveOriginTone } from "@/lib/orders/board-scope";
import { getWaitingLocalVisualKind } from "@/lib/orders/retiro-deposit-waiting";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useOrdersStore } from "@/hooks/useOrders";
import type { AdminOrder } from "@/types/orders";
import OrderActions from "./OrderActions";
import OrderCardItems from "./OrderCardItems";

interface OrderCardProps {
  order: AdminOrder;
}

function isOrderCardInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    "button, a, input, select, textarea, .order-card__actions, .order-card__body"
  );
}

function OrderCardFooter({
  order,
  productCount,
  showTotal,
}: {
  order: AdminOrder;
  productCount: number;
  showTotal: boolean;
}) {
  const extrasLines = formatOrderNotesExtras(order);
  const createdLabel = new Date(order.created_at).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  return (
    <div className="order-card__footer">
      <div className="order-card__footer-totals">
        <span className="order-card__footer-count">
          {productCount} producto{productCount === 1 ? "" : "s"}
        </span>
        {showTotal ? (
          <span className="order-card__total">{formatPriceAr(order.total_amount)}</span>
        ) : null}
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
  const [showPicked, setShowPicked] = useState(false);
  const [showMissingPanel, setShowMissingPanel] = useState(false);
  const loadingAction = useOrdersStore((s) => s.loadingAction);
  const warehouseIds = useOrdersStore((s) => s.warehouseIds);
  const removeItem = useOrdersStore((s) => s.cancelItem);
  const confirmCancelledItem = useOrdersStore((s) => s.confirmCancelledItem);
  const confirmAllCancelledItems = useOrdersStore((s) => s.confirmAllCancelledItems);
  const markItemMissing = useOrdersStore((s) => s.markItemMissing);
  const markItemPicked = useOrdersStore((s) => s.markItemPicked);
  const markItemWaiting = useOrdersStore((s) => s.markItemWaiting);
  const splitReservedItem = useOrdersStore((s) => s.splitReservedItem);

  const isMobile = useIsMobile();
  const [pendingChanges, setPendingChanges] = useState<DraftChangesMap>({});
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [pendingConfirmAllCancelled, setPendingConfirmAllCancelled] = useState(false);
  const hydrateExpiryWarn = useExpiryWarnSentStore((s) => s.hydrate);
  const expiryWarnSent = useExpiryWarnSentStore((s) => s.sentIds.has(order.id));

  useEffect(() => {
    hydrateExpiryWarn();
  }, [hydrateExpiryWarn]);

  const customer = getCustomerFromOrder(order);
  const column = getPrimaryColumnForActions(order);
  // Countdown de vencimiento: solo pedidos con plazo real (dismantle_at) o de clienta.
  // Pedidos admin/PAU sin dismantle_at no muestran chip (no tienen ventana de 7 días).
  // Deferred local (309): sin dismantle_at todavía no hay plazo → no inventar "7 días".
  const hasDeadline =
    Boolean(order.dismantle_at) ||
    (isCustomerSourcedOrder(order) && !order.local_deferred_pickup);
  const deadlineDate = hasDeadline
    ? getOrderDeadlineDate(order.created_at, order.dismantle_at)
    : null;
  const calendarDaysLeft =
    deadlineDate && column !== "closed"
      ? calendarDaysUntil(deadlineDate, Date.now())
      : null;
  const deadlineExpired =
    hasDeadline && column !== "closed" && isOrderExpired(order);
  const boardScope = useOrdersStore((s) => s.boardScope);
  /** ≤2 días para vencer → alerta rosa (solo tablero Pedidos/shipping).
   *  En Retiro no pintar “por vencer”: solo el rojo de ya vencido. */
  const expiringSoon =
    boardScope !== "local_pickup" &&
    calendarDaysLeft !== null &&
    !deadlineExpired &&
    calendarDaysLeft <= 2;
  const countdownLabel =
    calendarDaysLeft === null
      ? null
      : deadlineExpired
        ? "Vencido"
        : formatAdminDeadlineCountdown(calendarDaysLeft);
  const countdownTitle =
    deadlineDate && countdownLabel
      ? deadlineExpired
        ? `Venció el ${deadlineDate.toLocaleString("es-AR")}`
        : `Vence el ${deadlineDate.toLocaleString("es-AR")}`
      : undefined;
  /** Activos en modo borrador: tocar ✓/⏳/✕ solo marca el cambio hasta "Confirmar" (mobile y Retiro desktop). */
  const draftMode =
    column === "active" && (isMobile || boardScope === "local_pickup");
  /** Mobile: tap en la card expande/colapsa — no hace falta el link Expandir. */
  const expandOnCardClick =
    isMobile || column === "active" || column === "waiting" || column === "cancelled";
  const showItemRemove = column === "picked";
  const showActiveReservedActions = column === "active";
  const items = order.order_items || [];
  // En Cancelados todos los ítems visibles están cancelados -- contarlos ahí
  // es justamente el punto de esa columna. En el resto de las columnas un
  // ítem cancelado ya no forma parte del pedido, así que no suma.
  const productCount = useMemo(
    () =>
      countRegularProductUnits(
        column === "cancelled" ? items : items.filter((item) => !isCancelledOrderItem(item))
      ),
    [column, items]
  );
  const operationalProductCount = useMemo(
    () => countRegularProductUnits(items.filter((item) => !isCancelledOrderItem(item))),
    [items]
  );
  const showExpiryWarningBtn =
    isMobile &&
    hasDeadline &&
    isOrderExpiringToday(order) &&
    operationalProductCount >= 4 &&
    (column === "cancelled" ||
      column === "active" ||
      column === "picked" ||
      column === "waiting");
  const showExpiredOrderMessageBtn =
    isMobile &&
    column === "cancelled" &&
    hasDeadline &&
    deadlineExpired &&
    !showExpiryWarningBtn;
  const cancelledItems = useMemo(() => getCancelledOrderItems(order), [order]);
  const cancelledItemsPendingReturn = useMemo(
    () => getCancelledItemsPendingStockReturn(order),
    [order]
  );
  const operationalWhileCancelled = useMemo(
    () =>
      column === "cancelled"
        ? items.filter((item) => !isCancelledOrderItem(item))
        : [],
    [column, items]
  );
  const showCancelledBanner =
    cancelledItemsPendingReturn.length > 0 && column !== "cancelled" && column !== "waiting";
  // Pedido que superó su plazo (o la prórroga de 24hs) sin que se hayan tocado sus
  // ítems: distinto de un pedido con ítems cancelados por la clienta (ahí "Desarmar"
  // ni se ofrece, ver OrderActions). Acá SÍ se ofrece, y todo lo que sigue "activo"
  // (Apartado/Reservado/Espera) vuelve al stock apenas se aprieta ese botón — por
  // eso se muestra distinto (ver renderizado más abajo).
  const isExpiredPending = column === "cancelled" && isExpiredPendingAdminDisassembly(order);
  // Pedido vencido pendiente de desarmar: "Desarmar" ya resuelve TODO en un
  // solo paso (incluidos los ítems cancelados-pendientes de confirmar, ver
  // rpc_cancel_order_full 267), así que no tiene sentido pedirle al admin que
  // primero confirme cada uno a mano con ✓ — se muestra un único resumen de
  // todo lo que vuelve a stock. En cambio, cuando el pedido NO está vencido
  // (ítems activos + algún ítem cancelado suelto, sin botón "Desarmar"
  // disponible), el ✓ individual sigue siendo la única forma de resolverlo.
  const dismantleAllPending = column === "cancelled" && order.status !== "cancelled" && isExpiredPending;
  const showCancelledColumnPending =
    column === "cancelled" &&
    !dismantleAllPending &&
    order.status !== "cancelled" &&
    cancelledItemsPendingReturn.length > 0;
  const confirmAllCancelledBusy = loadingAction === `confirm-all-cancelled:${order.id}`;
  const confirmAllCancelledLabel =
    cancelledItemsPendingReturn.length === 1
      ? "Confirmar cancelación y devolver stock"
      : `Confirmar ${cancelledItemsPendingReturn.length} cancelaciones y devolver stock`;
  const cancelledSummaryItems = useMemo(
    () => (dismantleAllPending ? [...cancelledItems, ...operationalWhileCancelled] : []),
    [dismantleAllPending, cancelledItems, operationalWhileCancelled]
  );
  const hasMissingItem = orderHasMissingItem(order);
  const customerWantsClose = Boolean(parseOrderNotesObject(order.notes)?.customer_requested_close);
  const customerClosedAwaitingSale = isCommonLocalPickupAwaitingAdminSale(
    order,
    order.transportName ?? null
  );
  const missingOnlyItems = useMemo(() => items.filter(isMissingOrderItem), [items]);
  // Usados solo para el tinte de fondo de la tarjeta (ver className más abajo):
  // si el pedido tiene los dos orígenes mezclados, no se tiñe la tarjeta entera
  // (cada ítem ya lleva su propia etiqueta Local/Fábrica, ver OrderCardItems).
  const hasLocalWaiting = orderHasWaitingSource(order, "local", warehouseIds);
  const hasFabricaWaiting = orderHasWaitingSource(order, "fabrica", warehouseIds);
  const waitingLocalVisual = getWaitingLocalVisualKind(order, boardScope, warehouseIds);
  const waitingCardToneClass =
    column === "waiting" && hasLocalWaiting && !hasFabricaWaiting
      ? waitingLocalVisual === "deposito"
        ? " order-card--waiting-deposito"
        : " order-card--waiting-local"
      : column === "waiting" && hasFabricaWaiting && !hasLocalWaiting
        ? " order-card--waiting-fabrica"
        : "";
  const pickedCount = useMemo(
    () => (column === "active" ? countPickedOrderItems(items) : 0),
    [column, items]
  );
  const reservedItems = useMemo(
    () =>
      column === "active"
        ? items.filter(
            (item) =>
              isReservedOrderItem(item) ||
              isAwaitingApartadoOrderItem(item) ||
              isMissingOrderItem(item)
          )
        : items,
    [column, items]
  );
  const pickedItems = useMemo(
    () => (column === "active" ? items.filter(isPickedOrderItem) : []),
    [column, items]
  );
  const pickedColumnItems = useMemo(
    () =>
      column === "picked"
        ? items.filter((item) => isPickedOrderItem(item) || isMissingOrderItem(item))
        : [],
    [column, items]
  );
  const waitingItems = useMemo(
    () => (column === "waiting" ? items.filter(isWaitingOrderItem) : items),
    [column, items]
  );
  /** Espera: productos visibles sin expandir; count/total solo al expandir (footer). */
  const isWaitingColumn = column === "waiting";
  const showWaitingHeaderTotals = !isWaitingColumn;
  const customerName = customer?.full_name?.trim() || "Sin cliente";
  const city = customer?.city?.trim() || null;
  const phone = customer?.phone?.trim() || null;
  const waUrl = buildWhatsAppUrl(phone);
  const fromCustomer = isCustomerSourcedOrder(order);
  /** Solo Apartados en Retiro: verde clienta / amarillo desde Pedidos / celeste admin-local. */
  const retiroActiveTone =
    boardScope === "local_pickup" && column === "picked" && !customerClosedAwaitingSale
      ? getRetiroActiveOriginTone(order)
      : null;
  const customerCardClass =
    !retiroActiveTone && fromCustomer ? " order-card--customer" : "";
  const retiroToneClass = customerClosedAwaitingSale
    ? " order-card--retiro-picked-customer-close"
    : retiroActiveTone
      ? ` order-card--retiro-origin-${retiroActiveTone}`
      : "";

  useEffect(() => {
    if (!expanded) setShowPicked(false);
  }, [expanded]);

  useEffect(() => {
    if (!draftMode) setPendingChanges({});
  }, [draftMode]);

  const sendExpiryWarningMessage = async () => {
    const msg = buildExpiryWarningMessage();
    try {
      await navigator.clipboard.writeText(msg);
    } catch {
      useOrdersStore.getState().showToast("No se pudo copiar el mensaje", "error");
      return;
    }
    try {
      await useExpiryWarnSentStore.getState().markSent(order.id);
    } catch {
      useOrdersStore.getState().showToast("No se pudo registrar el aviso", "error");
      return;
    }
    const url = buildWhatsAppUrl(phone, msg);
    if (!url) {
      useOrdersStore.getState().showToast("Sin teléfono del cliente", "error");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    useOrdersStore.getState().showToast("Mensaje copiado", "success");
  };

  const copyExpiredOrderMessage = async () => {
    const msg = buildExpiredOrderMessage();
    try {
      await navigator.clipboard.writeText(msg);
      useOrdersStore.getState().showToast("Mensaje copiado", "success");
    } catch {
      useOrdersStore.getState().showToast("No se pudo copiar el mensaje", "error");
    }
  };

  const sendExpiredOrderMessage = async () => {
    const msg = buildExpiredOrderMessage();
    try {
      await navigator.clipboard.writeText(msg);
    } catch {
      useOrdersStore.getState().showToast("No se pudo copiar el mensaje", "error");
      return;
    }
    const url = buildWhatsAppUrl(phone, msg);
    if (!url) {
      useOrdersStore.getState().showToast("Sin teléfono del cliente", "error");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    useOrdersStore.getState().showToast("Mensaje copiado", "success");
  };

  const stagePicked = (itemId: string) => {
    setPendingChanges((prev) => {
      const next = { ...prev };
      if (next[itemId]?.kind === "picked") delete next[itemId];
      else next[itemId] = { kind: "picked" };
      return next;
    });
  };

  const stageWaiting = (itemId: string, source: "fabrica" | "local") => {
    const kind = source === "fabrica" ? ("waiting-fabrica" as const) : ("waiting-local" as const);
    setPendingChanges((prev) => {
      const next = { ...prev };
      if (next[itemId]?.kind === kind) delete next[itemId];
      else next[itemId] = { kind };
      return next;
    });
  };

  const stageMissing = (itemId: string) => {
    setPendingChanges((prev) => {
      const next = { ...prev };
      if (next[itemId]?.kind === "missing") delete next[itemId];
      else next[itemId] = { kind: "missing" };
      return next;
    });
  };

  const stageSplit = (
    itemId: string,
    nPicked: number,
    nWaiting: number,
    nMissing: number,
    waitingSource?: "fabrica" | "local"
  ) => {
    setPendingChanges((prev) => {
      const next = { ...prev };
      if (nPicked === 0 && nWaiting === 0 && nMissing === 0) {
        delete next[itemId];
        return next;
      }
      next[itemId] = { kind: "split", nPicked, nWaiting, nMissing, waitingSource };
      return next;
    });
  };

  const discardChanges = () => setPendingChanges({});

  const defersCustomerMessage = draftDefersCustomerMessage(pendingChanges, order);
  const showDraftMessageActions =
    draftMode && Object.keys(pendingChanges).length > 0 && !defersCustomerMessage;

  const copyDraftCustomerMessage = async (): Promise<string | null> => {
    const msg = buildMessageFromOrderAndDraft(items, pendingChanges, warehouseIds, order);
    if (!msg) {
      useOrdersStore.getState().showToast("No hay mensaje para copiar", "info");
      return null;
    }
    try {
      await navigator.clipboard.writeText(msg);
      useOrdersStore.getState().showToast("Mensaje copiado", "success");
      return msg;
    } catch {
      useOrdersStore.getState().showToast("No se pudo copiar el mensaje", "error");
      return null;
    }
  };

  const sendDraftCustomerMessage = async () => {
    const msg = await copyDraftCustomerMessage();
    if (!msg) return;
    const url = buildWhatsAppUrl(phone, msg);
    if (!url) {
      useOrdersStore.getState().showToast("Sin teléfono del cliente", "error");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const confirmChanges = async () => {
    setConfirmBusy(true);
    const draftSnapshot = { ...pendingChanges };
    const defersMessage = draftDefersCustomerMessage(draftSnapshot, order);
    try {
      for (const [itemId, change] of Object.entries(draftSnapshot)) {
        if (change.kind === "picked") await markItemPicked(order.id, itemId);
        else if (change.kind === "waiting-fabrica") await markItemWaiting(order.id, itemId, "fabrica");
        else if (change.kind === "waiting-local") await markItemWaiting(order.id, itemId, "local");
        else if (change.kind === "missing") await markItemMissing(order.id, itemId);
        else if (change.kind === "split")
          await splitReservedItem(
            order.id,
            itemId,
            change.nPicked ?? 0,
            change.nWaiting ?? 0,
            change.nMissing ?? 0,
            change.waitingSource
          );
      }
      setPendingChanges({});

      const refreshed =
        useOrdersStore.getState().orders.find((o) => o.id === order.id) || order;
      const wh = useOrdersStore.getState().warehouseIds;
      const priorFromOrder = buildPriorDecisionFromOrder(
        refreshed.order_items || [],
        wh,
        refreshed
      );

      if (defersMessage && isCustomerSourcedOrder(refreshed)) {
        const waitingLocalItemIds = collectWaitingLocalItemIdsFromDraft(
          draftSnapshot,
          refreshed.order_items || [],
          wh
        );
        const waitingFabricaItemIds = collectWaitingFabricaItemIdsFromDraft(
          draftSnapshot,
          refreshed.order_items || [],
          wh,
          refreshed
        );
        if (waitingLocalItemIds.length > 0 || waitingFabricaItemIds.length > 0) {
          try {
            await saveLocalWaitSnapshotFromConfirm({
              orderId: order.id,
              customerName: customerName || "Cliente",
              phone: phone || null,
              prior: priorFromOrder,
              waitingLocalItemIds,
              waitingFabricaItemIds,
              messageProfile: resolveMessageProfile(refreshed),
              pickupDeadlineAt: refreshed.dismantle_at ?? null,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : "No se pudo guardar aviso de espera";
            useOrdersStore.getState().showToast(msg, "error");
          }
        }
      } else if (Object.keys(draftSnapshot).length > 0) {
        try {
          await updateLocalWaitSnapshotPriorFromConfirm(order.id, priorFromOrder, refreshed);
        } catch {
          // sin snapshot previo en servidor
        }
      }
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleCardClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!expandOnCardClick) return;
    if (isOrderCardInteractiveTarget(event.target)) return;
    setExpanded((v) => !v);
  };

  const handlePickedToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!expanded) {
      setExpanded(true);
      setShowPicked(true);
      return;
    }
    setShowPicked((v) => !v);
  };

  const pickedToggleLabel =
    expanded && showPicked
      ? `Ocultar ${pickedCount} apartado${pickedCount === 1 ? "" : "s"}`
      : `${pickedCount} apartado${pickedCount === 1 ? "" : "s"}`;

  // Mobile: sin X ap. / Enviar / Expandir (tap expande). Transporte sí — es dato clave.
  const showTransport = !!order.transportName;
  const showPickedToggle = !isMobile && pickedCount > 0 && column === "active";
  const showDraftBadge = draftMode && Object.keys(pendingChanges).length > 0;
  const showSendBadge = !isMobile && customerWantsClose && column === "active";
  const showPickedCloseBadge =
    !isMobile && column === "picked" && customerClosedAwaitingSale;
  const showExpandToggle = !isMobile;
  const hasMetaActions =
    showTransport ||
    showPickedToggle ||
    showDraftBadge ||
    isExpiredPending ||
    showSendBadge ||
    showPickedCloseBadge ||
    showExpandToggle;
  const wantsCloseMobile =
    isMobile &&
    ((customerWantsClose && column === "active") ||
      (customerClosedAwaitingSale && column === "picked"));

  return (
    <article
      className={`order-card${deadlineExpired ? " order-card--aged" : ""}${expiringSoon ? " order-card--expiring-soon" : ""}${expanded ? " order-card--expanded" : ""}${customerCardClass}${retiroToneClass}${expandOnCardClick ? " order-card--click-expand" : ""}${wantsCloseMobile ? " order-card--wants-close" : ""}${isWaitingColumn ? " order-card--waiting-inline" : ""}${waitingCardToneClass}`}
      onClick={expandOnCardClick ? handleCardClick : undefined}
    >
      <div className="order-card__header">
        <div className="order-card__header-row">
          <span className="order-card__number">
            {getOrderDisplayNumber(order)}
            {hasMissingItem ? (
              <button
                type="button"
                className="order-card__missing-flag"
                title="Tiene un producto sin stock — tocá para ver"
                aria-label="Tiene un producto sin stock — tocá para ver"
                aria-expanded={column === "picked" ? expanded : showMissingPanel}
                onClick={(event) => {
                  event.stopPropagation();
                  if (column === "picked") {
                    // En Apartados el producto sin stock ya se ve marcado dentro de la
                    // lista normal (con su ✕ para quitarlo) — alcanza con expandir.
                    setExpanded(true);
                    return;
                  }
                  setShowMissingPanel((v) => !v);
                }}
              >
                !
              </button>
            ) : null}
          </span>
          <span className="order-card__customer">{customerName}</span>
          {showWaitingHeaderTotals ? (
            <span className="order-card__header-total">
              <span className="order-card__header-count">
                {productCount} prod.
              </span>
              {column !== "cancelled" ? (
                <span className="order-card__header-price">
                  {formatPriceAr(order.total_amount)}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>

        <div className="order-card__meta-row">
          <div className="order-card__location">
            {city ? <span>{city}</span> : null}
            {city && phone ? <span> · </span> : null}
            {phone ? (
              waUrl ? (
                <a
                  href={waUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={isMobile ? "order-card__wa-btn" : undefined}
                  aria-label={`Abrir WhatsApp de ${customerName}`}
                  title={isMobile ? `WhatsApp ${phone}` : undefined}
                  onClick={(event) => event.stopPropagation()}
                >
                  {isMobile ? "📞" : `📞 ${phone}`}
                </a>
              ) : isMobile ? (
                <span
                  className="order-card__wa-btn order-card__wa-btn--disabled"
                  title={phone}
                  aria-label={`Teléfono ${phone} (sin WhatsApp)`}
                >
                  📞
                </span>
              ) : (
                <span>📞 {phone}</span>
              )
            ) : null}
          </div>
          {countdownLabel ? (
            <span
              className={`order-card__countdown${expiringSoon || deadlineExpired ? " order-card__countdown--urgent" : ""}`}
              title={countdownTitle}
            >
              {countdownLabel}
            </span>
          ) : null}
          {hasMetaActions ? (
            <div className="order-card__meta-actions">
              {showTransport ? (
                <span
                  className={`order-card-transport ${order.transportBadgeClass || "order-card-transport--default"}`}
                >
                  {order.transportName}
                </span>
              ) : null}
              {showPickedToggle ? (
                <button
                  type="button"
                  className="order-card__picked-toggle"
                  onClick={handlePickedToggle}
                  aria-expanded={expanded && showPicked}
                  title={pickedToggleLabel}
                >
                  {expanded && showPicked
                    ? "Ocultar ap."
                    : `${pickedCount} ap.`}
                </button>
              ) : null}
              {showDraftBadge ? (
                <span
                  className="order-card__draft-badge"
                  title="Tiene cambios sin confirmar"
                >
                  {Object.keys(pendingChanges).length} sin confirmar
                </span>
              ) : null}
              {isExpiredPending ? (
                <span
                  className="order-card__draft-badge"
                  title="Superó su plazo (o la prórroga de 24hs) sin resolverse — pendiente de desarmar"
                  style={{ background: "#b45309", color: "#fff" }}
                >
                  ⏰ Vencido
                </span>
              ) : null}
              {showSendBadge ? (
                <span
                  className="order-card__draft-badge"
                  title="El cliente ya presionó 'Enviar pedido' — apartar todos para cerrar automáticamente"
                  style={{ background: "#CD844D", color: "#fff" }}
                >
                  Enviar
                </span>
              ) : null}
              {showPickedCloseBadge ? (
                <span
                  className="order-card__draft-badge"
                  title="La clienta cerró el pedido — listo para cobrar e imprimir"
                  style={{ background: "#7c3aed", color: "#fff" }}
                >
                  Cerró
                </span>
              ) : null}
              {showExpandToggle ? (
                <button
                  type="button"
                  className="order-card__toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    setExpanded((v) => !v);
                  }}
                  aria-expanded={expanded}
                >
                  {expanded ? "Colapsar" : "Expandir"}
                </button>
              ) : null}
            </div>
          ) : null}
          {showWaitingHeaderTotals && column !== "cancelled" ? (
            <span className="order-card__meta-price">
              {formatPriceAr(order.total_amount)}
            </span>
          ) : null}
        </div>
      </div>

      {showMissingPanel && missingOnlyItems.length > 0 && column !== "picked" ? (
        <div className="order-card__missing-panel" onClick={(event) => event.stopPropagation()}>
          <p className="order-card__missing-panel-title">
            {missingOnlyItems.length === 1
              ? "Producto sin stock"
              : `${missingOnlyItems.length} productos sin stock`}
          </p>
          <OrderCardItems
            items={missingOnlyItems}
            showRemove
            onRemoveItem={(itemId) => removeItem(order.id, itemId)}
            loadingItemId={loadingAction}
          />
        </div>
      ) : null}

      {isWaitingColumn ? (
        <div className="order-card__body order-card__body--waiting-inline" onClick={(event) => event.stopPropagation()}>
          <OrderCardItems
            items={waitingItems}
            orderId={order.id}
            orderSource={order.source}
            enableWaitingPick
            onMarkMissing={markItemMissing}
            onMarkPicked={markItemPicked}
            onMarkWaiting={markItemWaiting}
            draftMode={draftMode}
            draftChanges={pendingChanges}
            onStagePicked={stagePicked}
            onStageWaiting={stageWaiting}
            onStageMissing={stageMissing}
            onStageSplit={stageSplit}
            loadingItemId={loadingAction}
            emptyLabel="Sin productos en espera"
          />
        </div>
      ) : null}

      {showCancelledColumnPending ? (
        <div
          className="order-card__body order-card__body--cancelled-pending"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="order-card__cancelled-banner">
            {cancelledItemsPendingReturn.length} producto(s) cancelado(s) por la clienta —
            confirmá con <strong>✓</strong> o el botón de abajo para devolver el stock
          </p>
          <OrderCardItems
            items={cancelledItemsPendingReturn}
            orderId={order.id}
            confirmCancelledLayout
            onConfirmCancelled={(itemId) => confirmCancelledItem(order.id, itemId)}
            loadingItemId={loadingAction}
            emptyLabel="Sin cancelaciones"
          />
          <button
            type="button"
            className="order-card__btn order-card__btn--primary order-card__confirm-all-cancelled"
            disabled={confirmAllCancelledBusy || Boolean(loadingAction)}
            onClick={() => setPendingConfirmAllCancelled(true)}
          >
            {confirmAllCancelledBusy ? "Confirmando…" : confirmAllCancelledLabel}
          </button>
        </div>
      ) : null}

      {expanded ? (
        <>
          {!isWaitingColumn ? (
          <div className="order-card__body">
            {showCancelledBanner ? (
              <div className="order-card__cancelled-panel">
                <p className="order-card__cancelled-banner">
                  {cancelledItemsPendingReturn.length} producto(s) cancelado(s) por la clienta —
                  confirmá para devolver stock
                </p>
                <OrderCardItems
                  items={cancelledItemsPendingReturn}
                  orderId={order.id}
                  confirmCancelledLayout
                  onConfirmCancelled={(itemId) => confirmCancelledItem(order.id, itemId)}
                  loadingItemId={loadingAction}
                  emptyLabel="Sin cancelaciones"
                />
              </div>
            ) : null}
            {column === "cancelled" &&
            cancelledItemsPendingReturn.length > 0 &&
            order.status !== "cancelled" &&
            !dismantleAllPending &&
            !showCancelledColumnPending ? (
              <p className="order-card__cancelled-banner">
                {cancelledItemsPendingReturn.length} producto(s) cancelado(s) — tocá{" "}
                <strong>✓</strong> para confirmar y devolver el stock
              </p>
            ) : null}
            {/* Pedido vencido pendiente de desarmar: se salta la lista individual con ✓
                (más abajo se muestra un único resumen fusionado, ver dismantleAllPending) --
                pedir que confirmen uno por uno no tiene sentido cuando "Desarmar" ya
                resuelve todo en un solo paso. */}
            {!dismantleAllPending && !(column === "cancelled" && showCancelledColumnPending) ? (
              <OrderCardItems
                items={
                  column === "cancelled"
                    ? cancelledItemsPendingReturn
                    : column === "active"
                        ? reservedItems
                        : column === "picked"
                          ? pickedColumnItems
                          : items
                }
                orderId={order.id}
                orderSource={order.source}
                showRemove={showItemRemove}
                confirmCancelledLayout={
                  column === "cancelled" &&
                  order.status !== "cancelled" &&
                  !showCancelledColumnPending
                }
                onConfirmCancelled={
                  column === "cancelled" &&
                  order.status !== "cancelled" &&
                  !showCancelledColumnPending
                    ? (itemId) => confirmCancelledItem(order.id, itemId)
                    : undefined
                }
                showActiveReservedActions={showActiveReservedActions}
                enableWaitingPick={false}
                onRemoveItem={(itemId) => removeItem(order.id, itemId)}
                onMarkMissing={markItemMissing}
                onMarkPicked={markItemPicked}
                onMarkWaiting={markItemWaiting}
                draftMode={draftMode}
                draftChanges={pendingChanges}
                onStagePicked={stagePicked}
                onStageWaiting={stageWaiting}
                onStageMissing={stageMissing}
                onStageSplit={stageSplit}
                loadingItemId={loadingAction}
                emptyLabel={
                  column === "cancelled"
                    ? order.status === "cancelled" ? "Sin productos" : "Sin productos cancelados"
                    : column === "active"
                      ? "Sin productos pendientes de apartar"
                      : "Sin ítems"
                }
              />
            ) : null}
            {dismantleAllPending ? (
              <div className="order-card__cancelled-rest">
                <p className="order-card__cancelled-rest-title">Se devuelve todo el stock al desarmar</p>
                <p className="order-card__cancelled-rest-hint">
                  Lo marcado en amarillo nunca se separó físicamente del depósito (reservado/espera) —
                  el resto sí estaba apartado.
                </p>
                <OrderCardItems
                  items={cancelledSummaryItems}
                  loadingItemId={loadingAction}
                  emptyLabel="Sin productos"
                  mutedBadges
                />
              </div>
            ) : column === "cancelled" && operationalWhileCancelled.length > 0 ? (
              <div className="order-card__cancelled-rest">
                <p className="order-card__cancelled-rest-title">Otros productos del pedido (siguen activos)</p>
                <OrderCardItems
                  items={operationalWhileCancelled}
                  loadingItemId={loadingAction}
                  emptyLabel="Sin otros productos"
                />
              </div>
            ) : null}
            {column === "active" && pickedItems.length > 0 ? (
              <div className="order-card__picked-panel">
                <button
                  type="button"
                  className="order-card__picked-panel-title"
                  aria-expanded={showPicked}
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowPicked((v) => !v);
                  }}
                >
                  Ya apartados ({pickedItems.length})
                  <span className="order-card__picked-panel-chevron" aria-hidden>
                    {showPicked ? "▾" : "▸"}
                  </span>
                </button>
                {showPicked ? (
                  <OrderCardItems
                    items={pickedItems}
                    showRemove={showItemRemove}
                    onRemoveItem={(itemId) => removeItem(order.id, itemId)}
                    loadingItemId={loadingAction}
                  />
                ) : null}
              </div>
            ) : null}
            {draftMode && Object.keys(pendingChanges).length > 0 ? (
              <div className="order-draft-bar" onClick={(event) => event.stopPropagation()}>
                {showDraftMessageActions ? (
                  <div className="order-draft-bar__row order-draft-bar__row--msg">
                    <button
                      type="button"
                      className="order-card__btn order-draft-bar__btn-msg"
                      disabled={confirmBusy}
                      onClick={() => void copyDraftCustomerMessage()}
                    >
                      Mensaje
                    </button>
                    <button
                      type="button"
                      className="order-card__btn order-draft-bar__btn-send"
                      disabled={confirmBusy || !phone}
                      onClick={() => void sendDraftCustomerMessage()}
                    >
                      Enviar
                    </button>
                  </div>
                ) : null}
                <div className="order-draft-bar__row order-draft-bar__row--confirm">
                  <button
                    type="button"
                    className="order-card__btn order-draft-bar__btn-discard"
                    disabled={confirmBusy}
                    onClick={discardChanges}
                  >
                    Descartar
                  </button>
                  <button
                    type="button"
                    className="order-card__btn order-card__btn--primary order-draft-bar__btn-confirm"
                    disabled={confirmBusy}
                    onClick={() => void confirmChanges()}
                  >
                    {confirmBusy ? "Aplicando…" : "Confirmar"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          ) : null}
          <OrderCardFooter order={order} productCount={productCount} showTotal={column !== "cancelled"} />
        </>
      ) : showCancelledColumnPending ? (
        <OrderCardFooter order={order} productCount={productCount} showTotal={false} />
      ) : null}

      {pendingConfirmAllCancelled ? (
        <div
          className="order-modal-backdrop order-modal-backdrop--item"
          role="presentation"
          onClick={() => setPendingConfirmAllCancelled(false)}
        >
          <div
            className="order-modal order-modal--compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`confirm-all-cancelled-${order.id}`}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="order-modal__title" id={`confirm-all-cancelled-${order.id}`}>
              Confirmar cancelaciones
            </h3>
            <p className="order-modal__text">
              {cancelledItemsPendingReturn.length === 1
                ? "Se devolverá el stock del producto cancelado por la clienta."
                : `Se devolverá el stock de ${cancelledItemsPendingReturn.length} productos cancelados por la clienta.`}
            </p>
            <div className="order-modal__actions">
              <button
                type="button"
                className="order-card__btn"
                disabled={confirmAllCancelledBusy}
                onClick={() => setPendingConfirmAllCancelled(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={confirmAllCancelledBusy}
                onClick={() => {
                  setPendingConfirmAllCancelled(false);
                  void confirmAllCancelledItems(order.id);
                }}
              >
                {confirmAllCancelledBusy ? "Confirmando…" : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showExpiryWarningBtn ? (
        <div className="order-expiry-warn" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={`order-expiry-warn__btn${expiryWarnSent ? " order-expiry-warn__btn--sent" : ""}`}
            disabled={expiryWarnSent || !phone}
            onClick={() => void sendExpiryWarningMessage()}
          >
            {expiryWarnSent ? "Mensaje enviado" : "Enviar mensaje"}
          </button>
        </div>
      ) : null}

      {showExpiredOrderMessageBtn ? (
        <div className="order-expiry-warn" onClick={(event) => event.stopPropagation()}>
          <div className="order-draft-bar order-expiry-warn__bar">
            <div className="order-draft-bar__row order-draft-bar__row--msg">
              <button
                type="button"
                className="order-card__btn order-draft-bar__btn-msg"
                onClick={() => void copyExpiredOrderMessage()}
              >
                Mensaje
              </button>
              <button
                type="button"
                className="order-card__btn order-draft-bar__btn-send"
                disabled={!phone}
                onClick={() => void sendExpiredOrderMessage()}
              >
                Enviar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <OrderActions order={order} draftMode={draftMode} />
    </article>
  );
}
