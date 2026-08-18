"use client";

import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  computeOrderTotalFromItems,
  formatPriceAr,
  formatSignedPriceAr,
  isSpecialExtraItem,
  parseOrderNotesExtrasValues,
  type OrderNotesExtras,
} from "@/lib/orders/domain";
import {
  addItemsToExistingOrder,
  enrichDraftItemsWithStock,
  mergeDraftItem,
  syncOrderTotalAndNotes,
  type OrderEditDraftItem,
} from "@/lib/supabase/order-edit";
import { createManualOrder, findOpenOrderForCustomer } from "@/lib/supabase/order-create";
import {
  ARGENTINA_PROVINCES,
  PROVINCE_CITIES,
  createAdminCustomer,
  findCustomerByDni,
  formatCustomerDisplayName,
  searchCustomersByQuery,
  validateNewCustomerForm,
  type CustomerDirectoryRow,
  type NewCustomerFormInput,
} from "@/lib/supabase/customer-directory";
import { fetchOrderById } from "@/lib/supabase/order-queries";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useOrdersStore, refreshAndMaybeAutoClose } from "@/hooks/useOrders";
import OrderEditExtrasPanel from "./OrderEditExtrasPanel";
import OrderEditProductPicker from "./OrderEditProductPicker";

interface OrderCreateModalProps {
  onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const EMPTY_NOTES_EXTRAS: OrderNotesExtras = {
  shipping: 0,
  discount: 0,
  extras_amount: 0,
  extras_percentage: 0,
  extras_label: "",
};
const EMPTY_CUSTOMER_FORM: NewCustomerFormInput = {
  firstName: "",
  lastName: "",
  dni: "",
  phone: "",
  email: "",
  address: "",
  province: "",
  city: "",
};

export default function OrderCreateModal({ onClose }: OrderCreateModalProps) {
  const addOrderIfMissing = useOrdersStore((s) => s.addOrderIfMissing);
  const patchOrder = useOrdersStore((s) => s.patchOrder);
  const showToast = useOrdersStore((s) => s.showToast);

  const [customer, setCustomer] = useState<CustomerDirectoryRow | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerDirectoryRow[]>([]);
  const [searchingCustomer, setSearchingCustomer] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  const [newCustomerForm, setNewCustomerForm] = useState<NewCustomerFormInput>(EMPTY_CUSTOMER_FORM);
  const [newCustomerError, setNewCustomerError] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const [draft, setDraft] = useState<OrderEditDraftItem[]>([]);
  const [notesExtras, setNotesExtras] = useState<OrderNotesExtras>(EMPTY_NOTES_EXTRAS);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [duplicateOrder, setDuplicateOrder] = useState<
    { id: string; order_number: string | null; status: string } | null
  >(null);

  const draftQty = draft.reduce((n, i) => n + (Number(i.quantity) || 0), 0);
  const previewLineItems = useMemo(
    () => draft.map((i) => ({ price_snapshot: i.price_snapshot, quantity: i.quantity })),
    [draft]
  );
  const previewTotal = useMemo(
    () => computeOrderTotalFromItems(previewLineItems, notesExtras),
    [previewLineItems, notesExtras]
  );

  const handleAddToDraft = (item: OrderEditDraftItem) => {
    setDraft((prev) => mergeDraftItem(prev, item));
    setErrorMsg("");
  };

  const runCustomerSearch = async (value: string) => {
    setSearchingCustomer(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const results = await searchCustomersByQuery(supabase, value);
      setCustomerResults(results);
    } catch {
      setCustomerResults([]);
    } finally {
      setSearchingCustomer(false);
    }
  };

  const handleCustomerQueryChange = (value: string) => {
    setCustomerQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.trim().length < 2) {
      setCustomerResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(() => void runCustomerSearch(value), SEARCH_DEBOUNCE_MS);
  };

  const handleSelectCustomer = (c: CustomerDirectoryRow) => {
    setCustomer(c);
    setCustomerQuery("");
    setCustomerResults([]);
    setDuplicateOrder(null);
    setErrorMsg("");
  };

  const handleChangeCustomer = () => {
    setCustomer(null);
    setDuplicateOrder(null);
  };

  const openCreateCustomer = () => {
    setShowCreateCustomer(true);
    setNewCustomerError("");
    setNewCustomerForm({ ...EMPTY_CUSTOMER_FORM, firstName: customerQuery.trim() });
  };

  const closeCreateCustomer = () => {
    if (creatingCustomer) return;
    setShowCreateCustomer(false);
    setNewCustomerError("");
  };

  const setCustomerField = (key: keyof NewCustomerFormInput, value: string) => {
    setNewCustomerForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "province" && value !== prev.province) next.city = "";
      return next;
    });
  };

  const availableCities = useMemo(() => {
    if (!newCustomerForm.province) return [];
    const raw = PROVINCE_CITIES[newCustomerForm.province] || [];
    return Array.from(new Set(raw));
  }, [newCustomerForm.province]);

  const handleCreateCustomer = async () => {
    setNewCustomerError("");
    const validation = validateNewCustomerForm(newCustomerForm);
    if (!validation.ok) {
      setNewCustomerError(validation.error);
      return;
    }
    setCreatingCustomer(true);
    try {
      const supabase = getSupabaseBrowserClient();
      if (validation.data.dni) {
        const existing = await findCustomerByDni(supabase, validation.data.dni);
        if (existing) {
          handleSelectCustomer(existing);
          setShowCreateCustomer(false);
          showToast(`Ya existía un cliente con ese DNI: ${formatCustomerDisplayName(existing)}`, "info");
          return;
        }
      }
      const created = await createAdminCustomer(supabase, validation.data);
      handleSelectCustomer(created);
      setShowCreateCustomer(false);
      showToast(`Cliente "${created.full_name}" creado`, "success");
    } catch (err) {
      setNewCustomerError(err instanceof Error ? err.message : "Error al crear el cliente.");
    } finally {
      setCreatingCustomer(false);
    }
  };

  const handleCreate = async () => {
    if (!customer || draft.length === 0) return;
    setBusy(true);
    setErrorMsg("");
    try {
      const supabase = getSupabaseBrowserClient();

      if (!duplicateOrder) {
        const openOrder = await findOpenOrderForCustomer(supabase, customer.id);
        if (openOrder) {
          setDuplicateOrder(openOrder);
          setBusy(false);
          return;
        }
      }

      const enriched = await enrichDraftItemsWithStock(supabase, draft);

      if (duplicateOrder) {
        const existingOrder = await fetchOrderById(supabase, duplicateOrder.id);
        if (!existingOrder) throw new Error("No se pudo cargar el pedido existente del cliente.");
        await addItemsToExistingOrder(supabase, existingOrder.id, enriched);
        const existingNotesExtras = parseOrderNotesExtrasValues(existingOrder.notes);
        await syncOrderTotalAndNotes(supabase, existingOrder.id, existingNotesExtras, existingOrder.notes);
        // Si la clienta ya había pedido cerrar (customer_requested_close) y estos
        // productos nuevos (agregados ya apartados) completan el pedido, hay que
        // cerrarlo acá -- sin esto quedaba trabado en Apartados para siempre.
        const { order: refreshed, autoClosed } = await refreshAndMaybeAutoClose(supabase, existingOrder.id);
        if (refreshed) patchOrder(refreshed);
        showToast(
          autoClosed
            ? "Productos agregados y pedido cerrado (la clienta ya lo había enviado)"
            : "Productos agregados al pedido activo del cliente",
          "success"
        );
      } else {
        const newOrderId = await createManualOrder(supabase, customer.id, enriched, notesExtras);
        const created = await fetchOrderById(supabase, newOrderId);
        if (created) addOrderIfMissing(created);
        showToast("Pedido creado", "success");
      }

      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Error al crear el pedido.");
    } finally {
      setBusy(false);
    }
  };

  const canCreate = Boolean(customer) && draft.length > 0 && !busy;
  const customerName = customer ? formatCustomerDisplayName(customer) : null;

  return (
    <>
    <div className="order-modal-backdrop order-modal-backdrop--edit" role="presentation" onClick={onClose}>
      <div
        className="order-modal order-modal--edit"
        role="dialog"
        aria-labelledby="create-order-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="order-edit-modal__header">
          <h3 className="order-modal__title" id="create-order-title">
            Nuevo pedido manual
          </h3>
          <button type="button" className="order-edit-modal__close" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>

        {!customer ? (
          <div className="order-create-customer-bar">
            <div className="order-create-customer-search">
              <input
                type="text"
                className="order-edit-modal__input"
                placeholder="Buscar cliente por nombre, DNI, teléfono o email…"
                value={customerQuery}
                disabled={busy}
                onChange={(e) => handleCustomerQueryChange(e.target.value)}
              />
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={busy}
                onClick={openCreateCustomer}
              >
                + Nuevo cliente
              </button>
            </div>

            {customerQuery.trim().length >= 2 ? (
              <div className="order-create-customer-results">
                {searchingCustomer ? (
                  <p className="order-edit-picker__hint">Buscando…</p>
                ) : customerResults.length === 0 ? (
                  <p className="order-edit-picker__hint">
                    Sin coincidencias. Podés crear un cliente nuevo con “+ Nuevo cliente”.
                  </p>
                ) : (
                  customerResults.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="order-create-customer-result"
                      onClick={() => handleSelectCustomer(c)}
                    >
                      <span className="order-create-customer-result__name">
                        {formatCustomerDisplayName(c)}
                        {c.customer_number ? ` · Nº ${c.customer_number}` : ""}
                      </span>
                      <span className="order-create-customer-result__meta">
                        {c.dni ? `DNI ${c.dni} · ` : ""}
                        {c.phone || ""}
                        {c.city ? ` · ${c.city}` : ""}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="order-edit-modal__customer-bar">
            <div className="order-edit-modal__customer-line">
              <span className="order-edit-modal__customer-name">{customerName}</span>
              {customer.city ? <span className="order-edit-modal__customer-meta">{customer.city}</span> : null}
              {customer.phone ? (
                <span className="order-edit-modal__customer-meta">📞 {customer.phone}</span>
              ) : null}
              {customer.dni ? <span className="order-edit-modal__customer-meta">DNI {customer.dni}</span> : null}
              <button type="button" className="order-create-customer-change" onClick={handleChangeCustomer}>
                Cambiar
              </button>
            </div>
            <div className="order-edit-modal__summary-line">
              <span className="order-edit-modal__summary-count">
                {draftQty} producto{draftQty === 1 ? "" : "s"}
              </span>
              <span className="order-edit-modal__summary-total">{formatPriceAr(previewTotal)}</span>
            </div>
          </div>
        )}

        {duplicateOrder ? (
          <div className="order-create-duplicate-banner">
            <p>
              Este cliente ya tiene un pedido {duplicateOrder.status === "closed" ? "cerrado" : "activo"} (
              {duplicateOrder.order_number ? `Nº ${duplicateOrder.order_number}` : "sin número"}). Los envíos,
              descuentos y extras generales de este formulario no se aplican en este caso: solo se agregarán los
              productos y extras especiales al pedido existente.
              {duplicateOrder.status === "closed" && (
                <> Al estar cerrado, ya no es editable desde la web por el cliente — solo desde el panel.</>
              )}
            </p>
            <div className="order-modal__actions">
              <button type="button" className="order-card__btn" disabled={busy} onClick={() => setDuplicateOrder(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={busy}
                onClick={() => void handleCreate()}
              >
                Agregar al pedido existente
              </button>
            </div>
          </div>
        ) : (
          <div className="order-edit-modal__body">
            <section className="order-edit-modal__panel order-edit-modal__panel--items">
              <h4 className="order-edit-modal__section-title">Productos del pedido</h4>
              <div className="order-edit-modal__scroll">
                {draft.length === 0 ? (
                  <p className="order-edit-modal__empty">
                    Elegí un cliente y agregá productos desde el panel de la derecha.
                  </p>
                ) : (
                  <ul className="order-edit-modal__list order-edit-modal__list--compact">
                    {draft.map((item, idx) => {
                      const special = isSpecialExtraItem(item);
                      return (
                        <li
                          key={`draft-${idx}-${item.variant_id || "x"}-${item.size}`}
                          className={`order-edit-modal__row order-edit-modal__row--compact order-edit-modal__row--split${special ? " order-edit-modal__row--special" : ""}`}
                        >
                          <div className="order-edit-modal__compact-label">
                            {special ? (
                              <>
                                <span className="order-edit-modal__compact-name">
                                  {Number(item.price_snapshot) < 0 ? "➖" : "➕"} {item.product_name || "Extra especial"}
                                </span>
                                <span className="order-edit-modal__compact-meta">Extra especial</span>
                              </>
                            ) : (
                              <>
                                <span className="order-edit-modal__compact-name">
                                  {item.product_name || "Producto"} · {item.color || "-"}
                                </span>
                                <span className="order-edit-modal__compact-meta">
                                  {item.size || "-"} ×{item.quantity}
                                </span>
                              </>
                            )}
                          </div>
                          <div className="order-edit-modal__compact-actions">
                            <span className="order-edit-modal__compact-cell order-edit-modal__compact-cell--price">
                              {formatSignedPriceAr(Number(item.price_snapshot) * (item.quantity || 1))}
                            </span>
                            <button
                              type="button"
                              className="order-edit-modal__remove order-edit-modal__remove--inline order-edit-modal__compact-cell order-edit-modal__compact-cell--remove"
                              disabled={busy}
                              onClick={() => setDraft((prev) => prev.filter((_, i) => i !== idx))}
                            >
                              ✕
                            </button>
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
                disabled={busy || !customer}
              />
              <OrderEditExtrasPanel
                notesExtras={notesExtras}
                onNotesExtrasChange={setNotesExtras}
                onAddSpecialExtra={handleAddToDraft}
                disabled={busy}
              />
            </section>
          </div>
        )}

        {errorMsg ? <p className="order-edit-extras__error order-create-error">{errorMsg}</p> : null}

        <div className="order-edit-modal__footer">
          <button type="button" className="order-card__btn" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="order-card__btn order-card__btn--primary"
            disabled={!canCreate || Boolean(duplicateOrder)}
            onClick={() => void handleCreate()}
          >
            Crear pedido{draftQty > 0 ? ` (${draftQty} u.)` : ""}
          </button>
        </div>
      </div>
    </div>

    {showCreateCustomer && typeof document !== "undefined"
      ? createPortal(
          <div
            className="order-modal-backdrop order-modal-backdrop--stack"
            role="presentation"
            onClick={closeCreateCustomer}
          >
            <div
              className="order-modal order-modal--compact order-create-customer-modal"
              role="dialog"
              aria-labelledby="create-customer-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="order-edit-modal__header">
                <h3 className="order-modal__title" id="create-customer-title">
                  Nuevo cliente
                </h3>
                <button
                  type="button"
                  className="order-edit-modal__close"
                  disabled={creatingCustomer}
                  onClick={closeCreateCustomer}
                  aria-label="Cerrar"
                >
                  ✕
                </button>
              </div>

              <div className="order-edit-extras__grid order-create-customer-form__grid">
                <label className="order-edit-extras__field">
                  <span>Nombre</span>
                  <input
                    type="text"
                    value={newCustomerForm.firstName}
                    disabled={creatingCustomer}
                    onChange={(e) => setCustomerField("firstName", e.target.value)}
                  />
                </label>
                <label className="order-edit-extras__field">
                  <span>Apellido</span>
                  <input
                    type="text"
                    value={newCustomerForm.lastName}
                    disabled={creatingCustomer}
                    onChange={(e) => setCustomerField("lastName", e.target.value)}
                  />
                </label>
                <label className="order-edit-extras__field">
                  <span>Teléfono</span>
                  <input
                    type="text"
                    placeholder="Ej: 3794123456"
                    value={newCustomerForm.phone}
                    disabled={creatingCustomer}
                    onChange={(e) => setCustomerField("phone", e.target.value)}
                  />
                </label>
                <label className="order-edit-extras__field">
                  <span>DNI (opcional)</span>
                  <input
                    type="text"
                    value={newCustomerForm.dni}
                    disabled={creatingCustomer}
                    onChange={(e) => setCustomerField("dni", e.target.value)}
                  />
                </label>
                <label className="order-edit-extras__field">
                  <span>Email (opcional)</span>
                  <input
                    type="email"
                    value={newCustomerForm.email}
                    disabled={creatingCustomer}
                    onChange={(e) => setCustomerField("email", e.target.value)}
                  />
                </label>
                <label className="order-edit-extras__field order-edit-extras__field--block">
                  <span>Dirección</span>
                  <input
                    type="text"
                    value={newCustomerForm.address}
                    disabled={creatingCustomer}
                    onChange={(e) => setCustomerField("address", e.target.value)}
                  />
                </label>
                <label className="order-edit-extras__field">
                  <span>Provincia</span>
                  <select
                    value={newCustomerForm.province}
                    disabled={creatingCustomer}
                    onChange={(e) => setCustomerField("province", e.target.value)}
                  >
                    <option value="">Seleccionar…</option>
                    {ARGENTINA_PROVINCES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="order-edit-extras__field">
                  <span>Ciudad</span>
                  <input
                    type="text"
                    list="order-create-city-options"
                    placeholder={newCustomerForm.province ? "Escribí para buscar…" : "Elegí provincia primero"}
                    value={newCustomerForm.city}
                    disabled={creatingCustomer || !newCustomerForm.province}
                    onChange={(e) => setCustomerField("city", e.target.value)}
                  />
                  <datalist id="order-create-city-options">
                    {availableCities.map((c, i) => (
                      <option key={`${c}-${i}`} value={c} />
                    ))}
                  </datalist>
                </label>
              </div>

              {newCustomerError ? <p className="order-edit-extras__error">{newCustomerError}</p> : null}

              <div className="order-modal__actions">
                <button
                  type="button"
                  className="order-card__btn"
                  disabled={creatingCustomer}
                  onClick={closeCreateCustomer}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="order-card__btn order-card__btn--primary"
                  disabled={creatingCustomer}
                  onClick={() => void handleCreateCustomer()}
                >
                  Crear cliente
                </button>
              </div>
            </div>
          </div>,
          document.body
        )
      : null}
    </>
  );
}
