"use client";

import { useMemo, useRef, useState } from "react";
import {
  buildOrderEditSummaryChips,
  buildOrderNoteExtraRows,
  computeItemsLineSubtotal,
  computeOrderTotalFromItems,
  countRegularProductUnits,
  formatSignedPriceAr,
  getCustomerFromOrder,
  getOrderDisplayNumber,
  getOrderItemLineTotal,
  isReturnOrderItem,
  isSpecialExtraItem,
  parseOrderNotesExtrasValues,
  partitionOrderItemsForDisplay,
  type OrderNotesExtras,
} from "@/lib/orders/domain";
import {
  addItemsToExistingOrder,
  enrichDraftItemsWithStock,
  mergeDraftItem,
  syncOrderTotalAndNotes,
  type OrderEditDraftItem,
} from "@/lib/supabase/order-edit";
import { fetchOrderById } from "@/lib/supabase/order-queries";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useOrdersStore, refreshAndMaybeAutoClose } from "@/hooks/useOrders";
import type { AdminOrder } from "@/types/orders";
import ItemStatusBadge from "./ItemStatusBadge";
import OrderItemImageButton from "./OrderItemImageButton";
import OrderEditExtrasPanel from "./OrderEditExtrasPanel";
import OrderEditProductPicker from "./OrderEditProductPicker";
import RetiroCloseModal from "./RetiroCloseModal";

interface OrderEditModalProps {
  order: AdminOrder;
  onClose: () => void;
}

export default function OrderEditModal({ order, onClose }: OrderEditModalProps) {
  const cancelItem = useOrdersStore((s) => s.cancelItem);
  const patchOrder = useOrdersStore((s) => s.patchOrder);
  const showToast = useOrdersStore((s) => s.showToast);
  const loadingAction = useOrdersStore((s) => s.loadingAction);
  const boardScope = useOrdersStore((s) => s.boardScope);
  const showReturnModeToggle = boardScope === "local_pickup";

  const liveOrder =
    useOrdersStore((s) => s.orders.find((o) => o.id === order.id)) ?? order;

  const customer = getCustomerFromOrder(liveOrder);
  const items = liveOrder.order_items || [];

  const initialNotesRef = useRef(parseOrderNotesExtrasValues(order.notes));

  const [draft, setDraft] = useState<OrderEditDraftItem[]>([]);
  const [notesExtras, setNotesExtras] = useState<OrderNotesExtras>(() =>
    parseOrderNotesExtrasValues(liveOrder.notes)
  );
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [returnMode, setReturnMode] = useState(false);
  const [printCloseOrder, setPrintCloseOrder] = useState<AdminOrder | null>(null);

  const pendingRemoveItem = useMemo(
    () => items.find((i) => i.id === pendingRemoveId),
    [items, pendingRemoveId]
  );

  const { products: savedProducts, specialExtras: savedSpecialExtras } = useMemo(
    () => partitionOrderItemsForDisplay(items),
    [items]
  );

  const previewLineItems = useMemo(
    () => [
      ...items.map((item) => ({
        price_snapshot: item.price_snapshot,
        quantity: item.quantity,
      })),
      ...draft.map((item) => ({
        price_snapshot: item.price_snapshot,
        quantity: item.quantity,
      })),
    ],
    [items, draft]
  );

  const itemsSubtotal = useMemo(
    () => computeItemsLineSubtotal(previewLineItems),
    [previewLineItems]
  );

  const noteExtraRows = useMemo(
    () => buildOrderNoteExtraRows(notesExtras, itemsSubtotal),
    [notesExtras, itemsSubtotal]
  );

  const previewTotal = useMemo(
    () => computeOrderTotalFromItems(previewLineItems, notesExtras),
    [previewLineItems, notesExtras]
  );

  const productUnits = useMemo(
    () => countRegularProductUnits(items) + countRegularProductUnits(draft),
    [items, draft]
  );

  const draftQty = draft.reduce((n, i) => n + (Number(i.quantity) || 0), 0);
  const draftHasReturns = useMemo(
    () => draft.some((item) => !isSpecialExtraItem(item) && isReturnOrderItem(item)),
    [draft]
  );
  const notesChanged =
    JSON.stringify(notesExtras) !== JSON.stringify(initialNotesRef.current);
  const hasPendingChanges = draft.length > 0 || notesChanged;
  const isBusy = busy || Boolean(loadingAction);
  // Con devoluciones en el draft: no Guardar; hay que Imprimir (cobrar) como public-sales.
  const mustPrintToApply = showReturnModeToggle && draftHasReturns;

  const specialExtraNames = useMemo(() => {
    const names: string[] = [];
    for (const item of [...savedSpecialExtras, ...draft]) {
      if (!isSpecialExtraItem(item)) continue;
      const name = String(item.product_name || "").trim();
      if (name) names.push(name);
    }
    return names;
  }, [savedSpecialExtras, draft]);

  const summaryChips = useMemo(
    () => buildOrderEditSummaryChips(notesExtras, specialExtraNames, draft.length > 0 || notesChanged),
    [notesExtras, specialExtraNames, draft.length, notesChanged]
  );

  const customerName = customer?.full_name?.trim() || "Sin cliente";
  const customerCity = customer?.city?.trim() || null;
  const customerPhone = customer?.phone?.trim() || null;
  const customerDni = customer?.dni?.trim() || null;

  const handleAddToDraft = (item: OrderEditDraftItem) => {
    setDraft((prev) => mergeDraftItem(prev, item));
  };

  const persistDraftAndNotes = async (): Promise<AdminOrder | null> => {
    const supabase = getSupabaseBrowserClient();

    if (draft.length > 0) {
      const enriched = await enrichDraftItemsWithStock(supabase, draft);
      // Ventas: descuentan stock acá. Devoluciones (precio < 0): solo se insertan;
      // el reingreso ocurre al finalizar con is_return (como public-sales).
      await addItemsToExistingOrder(supabase, liveOrder.id, enriched);
    }

    if (notesChanged || draft.length > 0) {
      await syncOrderTotalAndNotes(
        supabase,
        liveOrder.id,
        notesExtras,
        liveOrder.notes
      );
    }

    const refreshed = await fetchOrderById(supabase, liveOrder.id);
    if (refreshed) {
      patchOrder(refreshed);
      initialNotesRef.current = parseOrderNotesExtrasValues(refreshed.notes);
      setNotesExtras(parseOrderNotesExtrasValues(refreshed.notes));
    }
    setDraft([]);
    return refreshed;
  };

  const handleSave = async () => {
    if (!hasPendingChanges) return;
    if (mustPrintToApply) {
      showToast(
        "Hay devoluciones: usá Imprimir para cobrar y ajustar el stock",
        "error"
      );
      return;
    }
    setBusy(true);
    try {
      const supabase = getSupabaseBrowserClient();
      await persistDraftAndNotes();

      // Si la clienta ya había pedido cerrar y este guardado dejó el pedido
      // completo, cerrarlo acá (sin esto quedaba trabado en Apartados).
      const { order: refreshed, autoClosed } = await refreshAndMaybeAutoClose(
        supabase,
        liveOrder.id
      );
      if (refreshed) {
        patchOrder(refreshed);
        initialNotesRef.current = parseOrderNotesExtrasValues(refreshed.notes);
        setNotesExtras(parseOrderNotesExtrasValues(refreshed.notes));
      }
      showToast(
        autoClosed
          ? "Pedido actualizado y cerrado (la clienta ya lo había enviado)"
          : "Pedido actualizado",
        "success"
      );
      if (autoClosed) onClose();
    } catch (err) {
      const refreshed = await fetchOrderById(getSupabaseBrowserClient(), liveOrder.id);
      if (refreshed) patchOrder(refreshed);
      showToast(err instanceof Error ? err.message : "Error al guardar", "error");
    } finally {
      setBusy(false);
    }
  };

  const handlePrintWithReturns = async () => {
    if (!mustPrintToApply) return;
    setBusy(true);
    try {
      // Igual public-sales: persistir edición ANTES de finalizar (ventas descuentan;
      // devoluciones reingresan stock en rpc_create_public_sale).
      const refreshed = await persistDraftAndNotes();
      if (!refreshed) {
        throw new Error("No se pudo actualizar el pedido antes de imprimir.");
      }
      setPrintCloseOrder(refreshed);
    } catch (err) {
      const refreshed = await fetchOrderById(getSupabaseBrowserClient(), liveOrder.id);
      if (refreshed) patchOrder(refreshed);
      showToast(
        err instanceof Error ? err.message : "Error al preparar la impresión",
        "error"
      );
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRemove = async () => {
    if (!pendingRemoveId) return;
    await cancelItem(liveOrder.id, pendingRemoveId);
    setPendingRemoveId(null);
    if (!useOrdersStore.getState().orders.some((o) => o.id === liveOrder.id)) {
      onClose();
    }
  };

  return (
    <>
      <div
        className="order-modal-backdrop order-modal-backdrop--edit"
        role="presentation"
        onClick={onClose}
      >
        <div
          className="order-modal order-modal--edit"
          role="dialog"
          aria-labelledby={`edit-order-${liveOrder.id}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="order-edit-modal__header">
            <h3 className="order-modal__title" id={`edit-order-${liveOrder.id}`}>
              Editar pedido {getOrderDisplayNumber(liveOrder)}
            </h3>
            <button type="button" className="order-edit-modal__close" onClick={onClose} aria-label="Cerrar">
              ✕
            </button>
          </div>

          <div className="order-edit-modal__customer-bar">
            <div className="order-edit-modal__customer-line">
              <span className="order-edit-modal__customer-name">{customerName}</span>
              {customerCity ? (
                <span className="order-edit-modal__customer-meta">{customerCity}</span>
              ) : null}
              {customerPhone ? (
                <span className="order-edit-modal__customer-meta">📞 {customerPhone}</span>
              ) : null}
              {customerDni ? (
                <span className="order-edit-modal__customer-meta">DNI {customerDni}</span>
              ) : null}
            </div>
            <div className="order-edit-modal__summary-line">
              <span className="order-edit-modal__summary-count">
                {productUnits} producto{productUnits === 1 ? "" : "s"}
              </span>
              <span className="order-edit-modal__summary-total">
                {formatSignedPriceAr(previewTotal)}
              </span>
            </div>
            {summaryChips.length > 0 ? (
              <div className="order-edit-modal__chips" aria-label="Extras del pedido">
                {summaryChips.map((chip) => (
                  <span
                    key={`${chip.tone}-${chip.label}`}
                    className={`order-edit-modal__chip order-edit-modal__chip--${chip.tone}`}
                  >
                    {chip.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="order-edit-modal__body">
            <section className="order-edit-modal__panel order-edit-modal__panel--items">
              <h4 className="order-edit-modal__section-title">Productos del pedido</h4>
              <div className="order-edit-modal__scroll">
                {items.length === 0 && draft.length === 0 && noteExtraRows.length === 0 ? (
                  <p className="order-edit-modal__empty">Sin ítems</p>
                ) : (
                  <ul className="order-edit-modal__list order-edit-modal__list--compact">
                    {savedProducts.map((item) => {
                      const isReturn = isReturnOrderItem(item);
                      return (
                        <li
                          key={item.id}
                          className={`order-edit-modal__row order-edit-modal__row--compact order-edit-modal__row--split${isReturn ? " order-edit-modal__row--return" : ""}`}
                        >
                          <div className="order-edit-modal__compact-label">
                            <span className="order-edit-modal__compact-name">
                              {isReturn ? "[DEV] " : ""}
                              {item.product_name || "Producto"} · {item.color || "-"}
                            </span>
                            <span className="order-edit-modal__compact-meta">
                              {item.size || "-"} ×{item.quantity}
                              {isReturn ? " · devolución" : ""}
                            </span>
                          </div>
                          <div className="order-edit-modal__compact-actions">
                            <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--badge">
                              {isReturn ? (
                                <span className="order-edit-modal__return-badge">DEV</span>
                              ) : (
                                <ItemStatusBadge status={item.status} />
                              )}
                            </span>
                            <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--lupa">
                              <OrderItemImageButton item={item} disabled={isBusy} />
                            </span>
                            <span
                              className={`order-edit-modal__compact-cell order-edit-modal__compact-cell--price${isReturn ? " is-return-price" : ""}`}
                            >
                              {formatSignedPriceAr(getOrderItemLineTotal(item))}
                            </span>
                            <button
                              type="button"
                              className="order-edit-modal__remove order-edit-modal__remove--inline order-edit-modal__compact-cell order-edit-modal__compact-cell--remove"
                              disabled={isBusy || loadingAction === item.id}
                              onClick={() => setPendingRemoveId(item.id)}
                            >
                              ✕
                            </button>
                          </div>
                        </li>
                      );
                    })}

                    {savedSpecialExtras.map((item) => (
                      <li
                        key={item.id}
                        className="order-edit-modal__row order-edit-modal__row--compact order-edit-modal__row--split order-edit-modal__row--special"
                      >
                        <div className="order-edit-modal__compact-label">
                          <span className="order-edit-modal__compact-name">
                            {Number(item.price_snapshot) < 0 ? "➖" : "➕"}{" "}
                            {item.product_name || "Extra especial"}
                          </span>
                          <span className="order-edit-modal__compact-meta">Extra especial</span>
                        </div>
                        <div className="order-edit-modal__compact-actions">
                          <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--badge">
                            <span className="order-edit-modal__special-badge">Extra esp.</span>
                          </span>
                          <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--lupa" />
                          <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--price">
                            {formatSignedPriceAr(Number(item.price_snapshot) * (item.quantity || 1))}
                          </span>
                          <button
                            type="button"
                            className="order-edit-modal__remove order-edit-modal__remove--inline order-edit-modal__compact-cell order-edit-modal__compact-cell--remove"
                            disabled={isBusy || loadingAction === item.id}
                            onClick={() => setPendingRemoveId(item.id)}
                          >
                            ✕
                          </button>
                        </div>
                      </li>
                    ))}

                    {noteExtraRows.map((row) => (
                      <li
                        key={row.key}
                        className="order-edit-modal__row order-edit-modal__row--compact order-edit-modal__row--split order-edit-modal__row--note-extra"
                      >
                        <div className="order-edit-modal__compact-label">
                          <span className="order-edit-modal__compact-name">{row.label}</span>
                          <span className="order-edit-modal__compact-meta">Valor extra del pedido</span>
                        </div>
                        <div className="order-edit-modal__compact-actions">
                          <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--badge">
                            <span
                              className={`order-edit-modal__chip order-edit-modal__chip--${
                                row.key === "discount" ? "discount" : row.key === "shipping" ? "shipping" : "extra"
                              } order-edit-modal__chip--inline`}
                            >
                              {row.badge}
                            </span>
                          </span>
                          <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--lupa" />
                          <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--price">
                            {formatSignedPriceAr(row.amount)}
                          </span>
                          <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--remove" />
                        </div>
                      </li>
                    ))}

                    {draft.map((item, idx) => {
                      const special = isSpecialExtraItem(item);
                      const isReturn = !special && isReturnOrderItem(item);
                      return (
                        <li
                          key={`draft-${idx}-${item.variant_id || "x"}-${item.size}-${isReturn ? "r" : "s"}`}
                          className={`order-edit-modal__row order-edit-modal__row--compact order-edit-modal__row--split order-edit-modal__row--draft${special ? " order-edit-modal__row--special" : ""}${isReturn ? " order-edit-modal__row--return" : ""}`}
                        >
                          <div className="order-edit-modal__compact-label">
                            {special ? (
                              <>
                                <span className="order-edit-modal__compact-name">
                                  {Number(item.price_snapshot) < 0 ? "➖" : "➕"}{" "}
                                  {item.product_name || "Extra especial"}
                                </span>
                                <span className="order-edit-modal__compact-meta">Pendiente · extra especial</span>
                              </>
                            ) : (
                              <>
                                <span className="order-edit-modal__compact-name">
                                  {isReturn ? "[DEV] " : ""}
                                  {item.product_name || "Producto"} · {item.color || "-"}
                                </span>
                                <span className="order-edit-modal__compact-meta">
                                  {item.size || "-"} ×{item.quantity} ·{" "}
                                  {isReturn ? "devolución pendiente" : "pendiente"}
                                </span>
                              </>
                            )}
                          </div>
                          <div className="order-edit-modal__compact-actions">
                            <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--badge">
                              {isReturn ? (
                                <span className="order-edit-modal__return-badge">DEV</span>
                              ) : (
                                <span className="order-edit-modal__chip order-edit-modal__chip--pending order-edit-modal__chip--inline">
                                  Pendiente
                                </span>
                              )}
                            </span>
                            <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--lupa">
                              {!special ? <OrderItemImageButton item={item} disabled={isBusy} /> : null}
                            </span>
                            <span
                              className={`order-edit-modal__compact-cell order-edit-modal__compact-cell--price${isReturn ? " is-return-price" : ""}`}
                            >
                              {formatSignedPriceAr(Number(item.price_snapshot) * (item.quantity || 1))}
                            </span>
                            <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--remove" />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            <section className="order-edit-modal__panel order-edit-modal__panel--add">
              <OrderEditProductPicker
                draft={draft}
                onDraftChange={setDraft}
                onAddToDraft={handleAddToDraft}
                disabled={isBusy}
                showReturnModeToggle={showReturnModeToggle}
                returnMode={showReturnModeToggle && returnMode}
                onReturnModeChange={setReturnMode}
              />
              <OrderEditExtrasPanel
                notesExtras={notesExtras}
                onNotesExtrasChange={setNotesExtras}
                onAddSpecialExtra={handleAddToDraft}
                disabled={isBusy}
              />
            </section>
          </div>

          <div className="order-edit-modal__footer">
            <button type="button" className="order-card__btn" disabled={isBusy} onClick={onClose}>
              Cancelar
            </button>
            {mustPrintToApply ? (
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={isBusy || draft.length === 0}
                onClick={() => void handlePrintWithReturns()}
                title="Con devoluciones hay que cobrar e imprimir (como venta al público)"
              >
                Imprimir
                {draftQty > 0 ? ` (${draftQty} u.)` : ""}
              </button>
            ) : (
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={isBusy || !hasPendingChanges}
                onClick={() => void handleSave()}
              >
                Guardar
                {draftQty > 0 ? ` (${draftQty} u.)` : notesChanged ? " *" : ""}
              </button>
            )}
          </div>
        </div>
      </div>

      {printCloseOrder ? (
        <RetiroCloseModal
          order={printCloseOrder}
          busy={isBusy}
          onClose={() => setPrintCloseOrder(null)}
          onDone={(message) => {
            const closedId = printCloseOrder.id;
            setPrintCloseOrder(null);
            useOrdersStore.getState().removeOrder(closedId);
            showToast(message, "success");
            onClose();
          }}
          onError={(message) => {
            showToast(message, "error");
          }}
        />
      ) : null}

      {pendingRemoveId && pendingRemoveItem ? (
        <div
          className="order-modal-backdrop order-modal-backdrop--item"
          role="presentation"
          onClick={() => setPendingRemoveId(null)}
        >
          <div
            className="order-modal order-modal--compact"
            role="dialog"
            aria-labelledby="edit-remove-item-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="order-modal__title" id="edit-remove-item-title">
              Quitar ítem
            </h3>
            <p className="order-modal__text">
              ¿Quitar este producto del pedido?
              <br />
              {pendingRemoveItem.product_name || "Producto"} · {pendingRemoveItem.color || "-"} ·{" "}
              {pendingRemoveItem.size || "-"}
            </p>
            <div className="order-modal__actions">
              <button
                type="button"
                className="order-card__btn"
                onClick={() => setPendingRemoveId(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--danger"
                disabled={loadingAction === pendingRemoveId}
                onClick={() => void handleConfirmRemove()}
              >
                Quitar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
