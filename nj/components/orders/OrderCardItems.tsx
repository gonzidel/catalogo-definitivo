"use client";

import { useState } from "react";
import {
  formatPriceAr,
  getOrderItemLineTotal,
  isMissingOrderItem,
  isSpecialExtraItem,
  normalizeOrderItemStatus,
} from "@/lib/orders/domain";
import { getWaitingSourceKind } from "@/lib/orders/waiting-source";
import { draftChangeLabel, type DraftChangesMap } from "@/lib/orders/draft-changes";
import { waitingLocalLabel } from "@/lib/orders/board-scope";
import { getWaitingLocalVisualKind } from "@/lib/orders/retiro-deposit-waiting";
import { useOrdersStore } from "@/hooks/useOrders";
import type { AdminOrderItem } from "@/types/orders";
import ItemStatusBadge from "./ItemStatusBadge";
import OrderCardItemActions from "./OrderCardItemActions";
import OrderItemImageButton from "./OrderItemImageButton";
import PartialAcceptModal from "./PartialAcceptModal";

interface OrderCardItemsProps {
  items: AdminOrderItem[];
  orderId?: string;
  /** "customer" habilita el asistente "¿Cuántas hay disponibles?" para ítems con varias unidades */
  orderSource?: string | null;
  showRemove?: boolean;
  /** Ítems cancelados por la clienta: ✓ confirma y devuelve stock si correspondía */
  confirmCancelledLayout?: boolean;
  /** Ítems que van a devolverse en bloque (ej. pedido vencido pendiente de desarmar):
   *  el badge de status se muestra en gris neutro en vez de su color habitual, para no
   *  leerse como "en curso normal" cuando en realidad están a punto de cancelarse todos juntos. */
  mutedBadges?: boolean;
  showActiveReservedActions?: boolean;
  /** Columna Espera: habilita el ✓ rápido ("waiting-pick") para cualquier ítem
   *  en espera, sin importar si su origen es local o fábrica -- ambos se
   *  muestran juntos, diferenciados solo por la etiqueta de origen. */
  enableWaitingPick?: boolean;
  onRemoveItem?: (itemId: string) => void;
  onConfirmCancelled?: (itemId: string) => void;
  onMarkMissing?: (orderId: string, itemId: string) => Promise<void>;
  onMarkPicked?: (orderId: string, itemId: string) => Promise<void>;
  onMarkWaiting?: (
    orderId: string,
    itemId: string,
    source: "fabrica" | "local"
  ) => Promise<void>;
  loadingItemId?: string | null;
  emptyLabel?: string;
  /**
   * Modo borrador (mobile, columna Activos): las acciones de cada ítem no se
   * aplican al tocarlas, solo quedan marcadas en `draftChanges` hasta que se
   * confirmen desde la barra al final del pedido.
   */
  draftMode?: boolean;
  draftChanges?: DraftChangesMap;
  onStagePicked?: (itemId: string) => void;
  onStageWaiting?: (itemId: string, source: "fabrica" | "local") => void;
  onStageMissing?: (itemId: string) => void;
  onStageSplit?: (
    itemId: string,
    nPicked: number,
    nWaiting: number,
    nMissing: number,
    waitingSource?: "fabrica" | "local"
  ) => void;
}

export default function OrderCardItems({
  items,
  orderId,
  orderSource = null,
  showRemove = false,
  confirmCancelledLayout = false,
  mutedBadges = false,
  showActiveReservedActions = false,
  enableWaitingPick = false,
  onRemoveItem,
  onConfirmCancelled,
  onMarkMissing,
  onMarkPicked,
  onMarkWaiting,
  loadingItemId,
  emptyLabel = "Sin ítems",
  draftMode = false,
  draftChanges,
  onStagePicked,
  onStageWaiting,
  onStageMissing,
  onStageSplit,
}: OrderCardItemsProps) {
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null);
  const pendingConfirmItem = items.find((i) => i.id === pendingConfirmId);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const pendingItem = items.find((i) => i.id === pendingItemId);
  const [openWaitingItemId, setOpenWaitingItemId] = useState<string | null>(null);
  const [partialAcceptItemId, setPartialAcceptItemId] = useState<string | null>(null);
  const partialAcceptItem = items.find((i) => i.id === partialAcceptItemId);
  const warehouseIds = useOrdersStore((s) => s.warehouseIds);
  const boardScope = useOrdersStore((s) => s.boardScope);
  const orderForVisual = useOrdersStore((s) =>
    orderId ? s.orders.find((o) => o.id === orderId) : undefined
  );
  const waitingLocalVisual = orderForVisual
    ? getWaitingLocalVisualKind(orderForVisual, boardScope, warehouseIds)
    : boardScope === "local_pickup"
      ? "deposito"
      : "local";
  const splitReservedItem = useOrdersStore((s) => s.splitReservedItem);
  const splitReservedItemMixed = useOrdersStore((s) => s.splitReservedItemMixed);
  const getVariantSizeStockQty = useOrdersStore((s) => s.getVariantSizeStockQty);
  const zeroVariantSizeStock = useOrdersStore((s) => s.zeroVariantSizeStock);
  const localWaitingLabel = waitingLocalLabel(boardScope);

  if (!items.length) {
    return <p className="kanban-column__empty">{emptyLabel}</p>;
  }

  const isMultiUnitReserved = (itemForAction: AdminOrderItem) => {
    const st = normalizeOrderItemStatus(itemForAction.status);
    return (
      orderSource === "customer" &&
      itemForAction.quantity > 1 &&
      (st === "reserved" || st === "awaiting_apartado")
    );
  };

  const handleMarkPicked = async (itemForAction: AdminOrderItem) => {
    if (isMultiUnitReserved(itemForAction)) {
      setPartialAcceptItemId(itemForAction.id);
      return;
    }
    if (draftMode) {
      onStagePicked?.(itemForAction.id);
      return;
    }
    if (!onMarkPicked || !orderId) return;
    await onMarkPicked(orderId, itemForAction.id);
  };

  /** Intercepta el toggle del popover ⏳: si hay varias unidades reservadas, abre el asistente en vez del popover fábrica/local */
  const handleToggleWaitingPanel = (itemForAction: AdminOrderItem) => {
    if (isMultiUnitReserved(itemForAction)) {
      setPartialAcceptItemId(itemForAction.id);
      return;
    }
    setOpenWaitingItemId((cur) => (cur === itemForAction.id ? null : itemForAction.id));
  };

  const handleApplyUnits = async (
    nPicked: number,
    nMissing: number,
    nFabrica: number,
    nLocal: number
  ) => {
    if (!partialAcceptItemId) return;
    const targetId = partialAcceptItemId;
    setPartialAcceptItemId(null);
    const nWaiting = nFabrica + nLocal;

    if (draftMode) {
      // El modo borrador (mobile) todavía guarda un solo origen de espera por
      // ítem: si hay mezcla fábrica+local se prioriza fábrica al armar el chip,
      // pero al confirmar cambios se aplica con la misma lógica de abajo.
      const waitingSource: "fabrica" | "local" | undefined =
        nLocal > 0 && nFabrica === 0 ? "local" : nFabrica > 0 ? "fabrica" : undefined;
      onStageSplit?.(targetId, nPicked, nWaiting, nMissing, waitingSource);
      return;
    }
    if (!orderId) return;

    if (nFabrica > 0 && nLocal > 0) {
      await splitReservedItemMixed(orderId, targetId, nPicked, nFabrica, nLocal, nMissing);
      return;
    }
    const waitingSource: "fabrica" | "local" | undefined =
      nLocal > 0 ? "local" : nFabrica > 0 ? "fabrica" : undefined;
    await splitReservedItem(orderId, targetId, nPicked, nWaiting, nMissing, waitingSource);
  };

  const handleConfirmRemove = async () => {
    if (!pendingItemId || !onRemoveItem) return;
    await onRemoveItem(pendingItemId);
    setPendingItemId(null);
  };

  const handleConfirmCancelled = async () => {
    if (!pendingConfirmId || !onConfirmCancelled) return;
    await onConfirmCancelled(pendingConfirmId);
    setPendingConfirmId(null);
  };

  return (
    <>
      <ul className="order-card__items">
        {items.map((item) => {
          const special = isSpecialExtraItem(item);
          const lineTotal = getOrderItemLineTotal(item);
          const waitingKind = getWaitingSourceKind(item, warehouseIds);
          const waitingPick = enableWaitingPick && normalizeOrderItemStatus(item.status) === "waiting";
          const pickedLayout = showRemove && !showActiveReservedActions && !waitingPick && !confirmCancelledLayout;
          const cancelledPending = confirmCancelledLayout;
          const missing = !special && isMissingOrderItem(item);
          return (
            <li
              key={item.id}
              className={`order-card__item-row order-card__item-row--split${special ? " order-card__item-row--special" : ""}${pickedLayout ? " order-card__item-row--picked" : ""}${cancelledPending ? " order-card__item-row--cancelled-pending" : ""}${missing ? " order-card__item-row--missing" : ""}`}
            >
              <div className="order-card__item-label">
                {special ? (
                  <>
                    <span className="order-card__item-name">
                      {Number(item.price_snapshot) < 0 ? "➖" : "➕"}{" "}
                      {item.product_name || "Extra especial"}
                    </span>
                    <span className="order-card__item-meta">Extra especial</span>
                  </>
                ) : (
                  <>
                    <span className="order-card__item-name">
                      {item.product_name || "Producto"} · {item.color || "-"}
                    </span>
                    <span className="order-card__item-meta">
                      <span className="order-card__item-size-qty">
                        {item.size || "-"} ×{item.quantity}
                      </span>
                      {normalizeOrderItemStatus(item.status) === "waiting" ? (
                        <span
                          className={`order-card__item-origin order-card__item-origin--${
                            waitingKind === "local"
                              ? waitingLocalVisual
                              : "fabrica"
                          }`}
                        >
                          {waitingKind === "local"
                            ? waitingLocalVisual === "deposito"
                              ? "Depósito"
                              : localWaitingLabel
                            : "Fábrica"}
                        </span>
                      ) : item.warehouseLabel ? (
                        <span className="order-card__item-warehouse"> · {item.warehouseLabel}</span>
                      ) : null}
                      {missing ? (
                        <span className="order-card__item-missing-tag">⚠ Sin stock</span>
                      ) : null}
                    </span>
                  </>
                )}
              </div>
              <div
                className={`order-card__item-actions${pickedLayout ? " order-card__item-actions--picked" : ""}`}
              >
                <span className="order-card__item-cell order-card__item-cell--badge">
                  {special ? (
                    <span className="order-edit-modal__special-badge">Extra</span>
                  ) : (
                    <ItemStatusBadge status={item.status} compact muted={mutedBadges} />
                  )}
                </span>
                <span className="order-card__item-cell order-card__item-cell--lupa">
                  {special ? null : (
                    <>
                      {item.isOffer ? (
                        <span className="order-card__item-offer-fire" title="Producto en oferta" aria-label="Producto en oferta">
                          🔥
                        </span>
                      ) : null}
                      <OrderItemImageButton item={item} disabled={loadingItemId === item.id} />
                    </>
                  )}
                </span>
                <span className="order-card__item-cell order-card__item-cell--price">
                  {formatPriceAr(lineTotal)}
                </span>
                {showActiveReservedActions &&
                orderId &&
                onMarkMissing &&
                onMarkPicked &&
                onMarkWaiting &&
                draftMode &&
                draftChanges?.[item.id]?.kind === "split" ? (
                  <span className="order-card__item-cell order-card__item-cell--actions">
                    <span className="order-draft-split-chip" title={draftChangeLabel(draftChanges[item.id], localWaitingLabel)}>
                      {draftChangeLabel(draftChanges[item.id], localWaitingLabel)}
                    </span>
                    <button
                      type="button"
                      className="order-draft-split-chip__edit"
                      aria-label="Editar reparto"
                      title="Editar"
                      onClick={() => setPartialAcceptItemId(item.id)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="order-draft-split-chip__remove"
                      aria-label="Quitar cambio"
                      title="Quitar cambio"
                      onClick={() => onStageSplit?.(item.id, 0, 0, 0)}
                    >
                      ×
                    </button>
                  </span>
                ) : showActiveReservedActions &&
                  orderId &&
                  onMarkMissing &&
                  onMarkPicked &&
                  onMarkWaiting ? (
                  <span className="order-card__item-cell order-card__item-cell--actions">
                    <OrderCardItemActions
                      orderId={orderId}
                      itemId={item.id}
                      disabled={loadingItemId === item.id}
                      variant="active"
                      variantId={item.variant_id}
                      size={item.size}
                      waitingPanelOpen={openWaitingItemId === item.id}
                      onToggleWaitingPanel={() => handleToggleWaitingPanel(item)}
                      onCloseWaitingPanel={() => setOpenWaitingItemId(null)}
                      onMarkMissing={onMarkMissing}
                      onMarkPicked={() => handleMarkPicked(item)}
                      onMarkWaiting={onMarkWaiting}
                      getVariantSizeStockQty={getVariantSizeStockQty}
                      onZeroStock={zeroVariantSizeStock}
                      draftMode={draftMode}
                      draftKind={draftChanges?.[item.id]?.kind ?? null}
                      onStagePicked={() => onStagePicked?.(item.id)}
                      onStageWaiting={(source) => onStageWaiting?.(item.id, source)}
                      onStageMissing={() => onStageMissing?.(item.id)}
                      onRequestMissing={() => {
                        if (!isMultiUnitReserved(item)) return false;
                        setPartialAcceptItemId(item.id);
                        return true;
                      }}
                    />
                  </span>
                ) : waitingPick && orderId && onMarkPicked ? (
                  <span className="order-card__item-cell order-card__item-cell--actions order-card__item-cell--waiting-pick">
                    <OrderCardItemActions
                      orderId={orderId}
                      itemId={item.id}
                      disabled={loadingItemId === item.id}
                      variant="waiting-pick"
                      variantId={item.variant_id}
                      size={item.size}
                      onMarkMissing={onMarkMissing!}
                      onMarkPicked={onMarkPicked}
                      onMarkWaiting={onMarkWaiting!}
                      getVariantSizeStockQty={getVariantSizeStockQty}
                      onZeroStock={zeroVariantSizeStock}
                    />
                  </span>
                ) : confirmCancelledLayout && onConfirmCancelled ? (
                  <button
                    type="button"
                    className="order-card__item-confirm-cancel order-card__item-cell order-card__item-cell--remove"
                    disabled={loadingItemId === item.id}
                    aria-label="Confirmar cancelación y devolver stock"
                    title="Confirmar cancelación"
                    onClick={() => setPendingConfirmId(item.id)}
                  >
                    ✓
                  </button>
                ) : showRemove && onRemoveItem ? (
                  <button
                    type="button"
                    className="order-card__item-remove order-card__item-cell order-card__item-cell--remove"
                    disabled={loadingItemId === item.id}
                    aria-label="Quitar ítem"
                    title="Quitar ítem"
                    onClick={() => setPendingItemId(item.id)}
                  >
                    ✕
                  </button>
                ) : (
                  <span className="order-card__item-cell order-card__item-cell--actions" aria-hidden="true" />
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {pendingItemId && pendingItem ? (
        <div
          className="order-modal-backdrop order-modal-backdrop--item"
          role="presentation"
          onClick={() => setPendingItemId(null)}
        >
          <div
            className="order-modal order-modal--compact"
            role="dialog"
            aria-labelledby="remove-item-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id="remove-item-title">
              Quitar ítem
            </h3>
            <p className="order-modal__text">¿Quitar este ítem del pedido?</p>
            <p className="order-modal__text" style={{ fontWeight: 600, color: "#1f2937" }}>
              {pendingItem.product_name || "Producto"} · {pendingItem.color || "-"} ·{" "}
              {pendingItem.size || "-"}
            </p>
            <p className="order-modal__text" style={{ fontWeight: 700, color: "#1f2937", marginBottom: 4 }}>
              {isMissingOrderItem(pendingItem)
                ? "No había stock reservado para este producto — solo se quita del pedido."
                : "El producto vuelve al stock disponible."}
            </p>
            <div className="order-modal__actions order-modal__actions--big">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setPendingItemId(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--danger"
                disabled={loadingItemId === pendingItemId}
                onClick={handleConfirmRemove}
              >
                Quitar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingConfirmId && pendingConfirmItem ? (
        <div
          className="order-modal-backdrop order-modal-backdrop--item"
          role="presentation"
          onClick={() => setPendingConfirmId(null)}
        >
          <div
            className="order-modal order-modal--compact"
            role="dialog"
            aria-labelledby="confirm-cancel-item-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id="confirm-cancel-item-title">
              Confirmar cancelación
            </h3>
            <p className="order-modal__text">
              La clienta quitó este producto del pedido.
              <br />
              {pendingConfirmItem.product_name || "Producto"} · {pendingConfirmItem.color || "-"} ·{" "}
              {pendingConfirmItem.size || "-"}
              <br />
              <strong>
                Al confirmar, el producto se elimina del pedido y vuelve al stock si estaba apartado.
              </strong>
            </p>
            <div className="order-modal__actions">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setPendingConfirmId(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={loadingItemId === pendingConfirmId}
                onClick={() => void handleConfirmCancelled()}
              >
                Confirmar ✓
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {partialAcceptItem ? (
        <PartialAcceptModal
          item={partialAcceptItem}
          disabled={loadingItemId === partialAcceptItem.id}
          onClose={() => setPartialAcceptItemId(null)}
          onApply={(nPicked, nMissing, nFabrica, nLocal) =>
            void handleApplyUnits(nPicked, nMissing, nFabrica, nLocal)
          }
        />
      ) : null}
    </>
  );
}
