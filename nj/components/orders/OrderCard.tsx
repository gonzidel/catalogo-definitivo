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
  isMissingOrderItem,
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
} from "@/lib/orders/deadline";
import { orderHasWaitingSource } from "@/lib/orders/waiting-source";
import { summarizeDraftChanges, type DraftChangesMap } from "@/lib/orders/draft-changes";
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
  const markItemMissing = useOrdersStore((s) => s.markItemMissing);
  const markItemPicked = useOrdersStore((s) => s.markItemPicked);
  const markItemWaiting = useOrdersStore((s) => s.markItemWaiting);
  const splitReservedItem = useOrdersStore((s) => s.splitReservedItem);

  const isMobile = useIsMobile();
  const [pendingChanges, setPendingChanges] = useState<DraftChangesMap>({});
  const [confirmBusy, setConfirmBusy] = useState(false);

  const customer = getCustomerFromOrder(order);
  const column = getPrimaryColumnForActions(order);
  // Countdown de vencimiento: solo pedidos con plazo real (dismantle_at) o de clienta.
  // Pedidos admin/PAU sin dismantle_at no muestran chip (no tienen ventana de 7 días).
  const hasDeadline = Boolean(order.dismantle_at) || isCustomerSourcedOrder(order);
  const deadlineDate = hasDeadline
    ? getOrderDeadlineDate(order.created_at, order.dismantle_at)
    : null;
  const calendarDaysLeft =
    deadlineDate && column !== "closed"
      ? calendarDaysUntil(deadlineDate, Date.now())
      : null;
  const deadlineExpired =
    hasDeadline && column !== "closed" && isOrderExpired(order);
  /** ≤2 días para vencer → alerta rosa (distinta del azul clienta / rojo vencido). */
  const expiringSoon =
    calendarDaysLeft !== null && !deadlineExpired && calendarDaysLeft <= 2;
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
  /** En mobile, Activos pasa a modo borrador: tocar ✓/⏳/✕ no aplica nada hasta "Confirmar cambios" */
  const draftMode = isMobile && column === "active";
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
  const cancelledItems = useMemo(() => getCancelledOrderItems(order), [order]);
  // Solo los cancelados que realmente necesitan que el admin confirme una
  // devolución de stock (excluye los cancelados desde "missing" -- nunca hubo
  // stock real, ver domain.ts cancelledItemNeedsStockConfirmation). Se usa en
  // vez de cancelledItems para no pedirle al admin que confirme algo que no
  // corresponde ni arriesgar una acreditación fantasma de stock.
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
  const cancelledSummaryItems = useMemo(
    () => (dismantleAllPending ? [...cancelledItems, ...operationalWhileCancelled] : []),
    [dismantleAllPending, cancelledItems, operationalWhileCancelled]
  );
  const hasMissingItem = orderHasMissingItem(order);
  const customerWantsClose = Boolean(parseOrderNotesObject(order.notes)?.customer_requested_close);
  const missingOnlyItems = useMemo(() => items.filter(isMissingOrderItem), [items]);
  // Usados solo para el tinte de fondo de la tarjeta (ver className más abajo):
  // si el pedido tiene los dos orígenes mezclados, no se tiñe la tarjeta entera
  // (cada ítem ya lleva su propia etiqueta Local/Fábrica, ver OrderCardItems).
  const hasLocalWaiting = orderHasWaitingSource(order, "local", warehouseIds);
  const hasFabricaWaiting = orderHasWaitingSource(order, "fabrica", warehouseIds);
  const pickedCount = useMemo(
    () => (column === "active" ? countPickedOrderItems(items) : 0),
    [column, items]
  );
  const reservedItems = useMemo(
    () =>
      column === "active"
        ? items.filter((item) => isReservedOrderItem(item) || isMissingOrderItem(item))
        : items,
    [column, items]
  );
  const pickedItems = useMemo(
    () => (showPicked && column === "active" ? items.filter(isPickedOrderItem) : []),
    [showPicked, column, items]
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
  const customerName = customer?.full_name?.trim() || "Sin cliente";
  const city = customer?.city?.trim() || null;
  const phone = customer?.phone?.trim() || null;
  const waUrl = buildWhatsAppUrl(phone);
  const fromCustomer = isCustomerSourcedOrder(order);

  useEffect(() => {
    if (!expanded) {
      setShowPicked(false);
      return;
    }
    // Mobile: sin el toggle "X ap.", al expandir se muestran los apartados solos.
    if (isMobile && column === "active" && pickedCount > 0) setShowPicked(true);
  }, [expanded, isMobile, column, pickedCount]);

  useEffect(() => {
    if (!draftMode) setPendingChanges({});
  }, [draftMode]);

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

  const confirmChanges = async () => {
    setConfirmBusy(true);
    try {
      for (const [itemId, change] of Object.entries(pendingChanges)) {
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
  const showExpandToggle = !isMobile;
  const hasMetaActions =
    showTransport ||
    showPickedToggle ||
    showDraftBadge ||
    isExpiredPending ||
    showSendBadge ||
    showExpandToggle;
  const wantsCloseMobile = isMobile && customerWantsClose && column === "active";

  return (
    <article
      className={`order-card${deadlineExpired ? " order-card--aged" : ""}${expiringSoon ? " order-card--expiring-soon" : ""}${expanded ? " order-card--expanded" : ""}${fromCustomer ? " order-card--customer" : ""}${expandOnCardClick ? " order-card--click-expand" : ""}${wantsCloseMobile ? " order-card--wants-close" : ""}${column === "waiting" && hasLocalWaiting && !hasFabricaWaiting ? " order-card--waiting-local" : ""}${column === "waiting" && hasFabricaWaiting && !hasLocalWaiting ? " order-card--waiting-fabrica" : ""}`}
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
          <span className="order-card__header-total">
            <span className="order-card__header-count">
              {productCount} prod.
            </span>
            {/* Desktop: precio arriba. Mobile: va a la fila de abajo (.order-card__meta-price).
                En Cancelados el total no refleja nada útil (ver domain.ts). */}
            {column !== "cancelled" ? (
              <span className="order-card__header-price">
                {formatPriceAr(order.total_amount)}
              </span>
            ) : null}
          </span>
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
          {column !== "cancelled" ? (
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

      {expanded ? (
        <>
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
            !dismantleAllPending ? (
              <p className="order-card__cancelled-banner">
                {cancelledItemsPendingReturn.length} producto(s) cancelado(s) — tocá{" "}
                <strong>✓</strong> para confirmar y devolver el stock
              </p>
            ) : null}
            {/* Pedido vencido pendiente de desarmar: se salta la lista individual con ✓
                (más abajo se muestra un único resumen fusionado, ver dismantleAllPending) --
                pedir que confirmen uno por uno no tiene sentido cuando "Desarmar" ya
                resuelve todo en un solo paso. */}
            {!dismantleAllPending ? (
              <OrderCardItems
                items={
                  column === "cancelled"
                    ? cancelledItemsPendingReturn
                    : column === "active"
                      ? reservedItems
                      : column === "waiting"
                        ? waitingItems
                        : column === "picked"
                          ? pickedColumnItems
                          : items
                }
                orderId={order.id}
                orderSource={order.source}
                showRemove={showItemRemove}
                confirmCancelledLayout={column === "cancelled" && order.status !== "cancelled"}
                onConfirmCancelled={
                  column === "cancelled" && order.status !== "cancelled"
                    ? (itemId) => confirmCancelledItem(order.id, itemId)
                    : undefined
                }
                showActiveReservedActions={showActiveReservedActions}
                enableWaitingPick={column === "waiting"}
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
                      ? "Sin productos reservados"
                      : column === "waiting"
                        ? "Sin productos en espera"
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
            {showPicked && pickedItems.length > 0 ? (
              <div className="order-card__picked-panel">
                <p className="order-card__picked-panel-title">Ya apartados</p>
                <OrderCardItems
                  items={pickedItems}
                  showRemove={showItemRemove}
                  onRemoveItem={(itemId) => removeItem(order.id, itemId)}
                  loadingItemId={loadingAction}
                />
              </div>
            ) : null}
            {draftMode && Object.keys(pendingChanges).length > 0 ? (
              <div className="order-draft-bar" onClick={(event) => event.stopPropagation()}>
                <p className="order-draft-bar__summary">
                  {Object.keys(pendingChanges).length} cambio
                  {Object.keys(pendingChanges).length === 1 ? "" : "s"} sin confirmar ·{" "}
                  {summarizeDraftChanges(pendingChanges)}
                </p>
                <div className="order-draft-bar__actions">
                  <button
                    type="button"
                    className="order-card__btn"
                    disabled={confirmBusy}
                    onClick={discardChanges}
                  >
                    Descartar
                  </button>
                  <button
                    type="button"
                    className="order-card__btn order-card__btn--primary order-card__btn--grow"
                    disabled={confirmBusy}
                    onClick={() => void confirmChanges()}
                  >
                    {confirmBusy ? "Aplicando…" : "Confirmar cambios"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <OrderCardFooter order={order} productCount={productCount} showTotal={column !== "cancelled"} />
        </>
      ) : null}

      <OrderActions order={order} draftMode={draftMode} />
    </article>
  );
}
