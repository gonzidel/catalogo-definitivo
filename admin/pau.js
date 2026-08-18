// admin/pau.js — Panel de Atención Unificado

import { requireAuth } from "./admin-auth.js?v=m260607";
import { supabase } from "../scripts/supabase-client.js?v=m260607";
import { getAdminPermissions, can } from "./auth-state.js?v=m260607";
import {
  normalizeCustomerSearchText,
  tokenizeCustomerSearch,
  rankCustomersForSearch,
  normalizePhoneDigitsForMatch,
  getPhoneSearchSuffix,
  phonesMatchBySuffix,
  PHONE_SEARCH_SUFFIX_LEN,
} from "./orders-domain.js?v=m260607";
import { normalizeSize } from "../scripts/utils/size-normalizer.js?v=m260607";
import { hasCatalogPrice, catalogPriceGuardMessage } from "../scripts/utils/price.js?v=m260607";
import {
  findActiveOrderForCustomer,
  createApartadoOrder,
  addItemsToOrder,
  enrichDraftItemsWithStock,
  closeOrder,
  sendOrderToLocal,
  removeOrderItemRestoreStock,
  ORDER_PAYMENT_METHOD,
  fetchOrderById,
  getOrderStatusChipForCustomers,
  resolveQrCodeToOrderItem,
  searchProductsGroupedByPrefix,
  mergeDraftItem,
  computeOffersAndPromotionsForItems,
} from "./orders-ops.js?v=m260607";
import {
  validateNewCustomerForm,
  createAdminCustomer,
  initArgentinaLocationAutocomplete,
  resetCustomerCreateForm,
} from "./customer-create-shared.js?v=m260607";

console.log("PAU boot: antes de requireAuth()");
await requireAuth();
console.log("PAU boot: requireAuth() OK, antes de getAdminPermissions()");
await getAdminPermissions();
console.log("PAU boot: getAdminPermissions() OK");
/** Permisos fijados al entrar (no usar can() en runtime: TOKEN_REFRESHED invalida el cache). */
const PAU_PERMISSIONS = {
  ordersView: can("orders", "view"),
  ordersEdit: can("orders", "edit"),
  customersEdit: can("customers", "edit"),
};
console.log("PAU boot: permisos =", JSON.stringify(PAU_PERMISSIONS));
if (!PAU_PERMISSIONS.ordersView) {
  alert("No tenés permiso para ver pedidos.");
  window.location.href = "./index.html";
}
if (!PAU_PERMISSIONS.ordersEdit) {
  alert("PAU requiere permiso para editar pedidos (no solo ver). Pedile a un administrador que active «editar» en el módulo Pedidos.");
  window.location.href = "./index.html";
}

const STORAGE = {
  customerId: "pau_activeCustomerId",
  orderId: "pau_activeOrderId",
  phone: "pau_lastPhoneShared",
  draft: "pau_draftItems",
  recentCustomers: "pau_recentCustomers",
};

const QR_DEBOUNCE_MS = 50;
const QR_MIN_DIGITS = 6;
const CUSTOMER_DEBOUNCE_MS = 280;
const RECENT_CUSTOMERS_MAX = 5;

const els = {
  landing: document.getElementById("pau-landing"),
  phoneConfirm: document.getElementById("pau-phone-confirm"),
  compose: document.getElementById("pau-compose"),
  top: document.getElementById("pau-top"),
  customerHeader: document.getElementById("pau-customer-header"),
  customerSearch: document.getElementById("pau-customer-search"),
  recentToggle: document.getElementById("pau-recent-toggle"),
  recentPanel: document.getElementById("pau-recent-panel"),
  recentList: document.getElementById("pau-recent-list"),
  recentEmpty: document.getElementById("pau-recent-empty"),
  customerResults: document.getElementById("pau-customer-results"),
  customerEmpty: document.getElementById("pau-customer-empty"),
  productInput: document.getElementById("pau-product-input"),
  manualToggle: document.getElementById("pau-manual-toggle"),
  manualPicker: document.getElementById("pau-manual-picker"),
  manualPickerHead: document.getElementById("pau-manual-picker-head"),
  manualBack: document.getElementById("pau-manual-back"),
  manualStepLabel: document.getElementById("pau-manual-step-label"),
  manualChoices: document.getElementById("pau-manual-choices"),
  manualActions: document.getElementById("pau-manual-actions"),
  manualClearPicks: document.getElementById("pau-manual-clear-picks"),
  manualAddPicks: document.getElementById("pau-manual-add-picks"),
  draftList: document.getElementById("pau-draft-list"),
  scannedCount: document.getElementById("pau-scanned-count"),
  orderSummary: document.getElementById("pau-order-summary"),
  orderToggle: document.getElementById("pau-order-toggle"),
  orderItems: document.getElementById("pau-order-items"),
  expandLabel: document.getElementById("pau-expand-label"),
  addBtn: document.getElementById("pau-add-to-order"),
  copyOrderBtn: document.getElementById("pau-copy-order"),
  adjustToggleBtn: document.getElementById("pau-adjust-toggle"),
  adjustPanel: document.getElementById("pau-adjust-panel"),
  adjustPlusBtn: document.getElementById("pau-adjust-plus"),
  adjustMinusBtn: document.getElementById("pau-adjust-minus"),
  adjustDialog: document.getElementById("pau-adjust-dialog"),
  adjustForm: document.getElementById("pau-adjust-form"),
  adjustTitle: document.getElementById("pau-adjust-title"),
  adjustHint: document.getElementById("pau-adjust-hint"),
  adjustDescription: document.getElementById("pau-adjust-description"),
  adjustAmount: document.getElementById("pau-adjust-amount"),
  adjustError: document.getElementById("pau-adjust-error"),
  adjustSave: document.getElementById("pau-adjust-save"),
  adjustCancel: document.getElementById("pau-adjust-cancel"),
  closeBtn: document.getElementById("pau-close-order"),
  searchAnotherBtn: document.getElementById("pau-search-another-customer"),
  closeActionDialog: document.getElementById("pau-close-action-dialog"),
  closeContraRem: document.getElementById("pau-close-contra-rem"),
  closePagado: document.getElementById("pau-close-pagado"),
  closeSendLocal: document.getElementById("pau-close-send-local"),
  closeActionCancel: document.getElementById("pau-close-action-cancel"),
  sendLocalDialog: document.getElementById("pau-send-local-dialog"),
  sendLocalYes: document.getElementById("pau-send-local-yes"),
  sendLocalNo: document.getElementById("pau-send-local-no"),
  phoneConfirmText: document.getElementById("pau-phone-confirm-text"),
  phoneYes: document.getElementById("pau-phone-yes"),
  phoneNo: document.getElementById("pau-phone-no"),
  toast: document.getElementById("pau-toast"),
  createCustomerBtn: document.getElementById("pau-create-customer-btn"),
  createCustomerDialog: document.getElementById("pau-create-customer-dialog"),
  createCustomerForm: document.getElementById("pau-create-customer-form"),
  cfFirstName: document.getElementById("pau-cf-first-name"),
  cfLastName: document.getElementById("pau-cf-last-name"),
  cfDni: document.getElementById("pau-cf-dni"),
  cfPhone: document.getElementById("pau-cf-phone"),
  cfEmail: document.getElementById("pau-cf-email"),
  cfAddress: document.getElementById("pau-cf-address"),
  cfProvince: document.getElementById("pau-cf-province"),
  cfCity: document.getElementById("pau-cf-city"),
  cfProvinceDropdown: document.getElementById("pau-cf-province-dropdown"),
  cfCityDropdown: document.getElementById("pau-cf-city-dropdown"),
  cfError: document.getElementById("pau-cf-error"),
  cfSave: document.getElementById("pau-cf-save"),
  cfCancel: document.getElementById("pau-cf-cancel"),
};

const cfEls = {
  form: els.createCustomerForm,
  cityInput: els.cfCity,
  provinceDropdown: els.cfProvinceDropdown,
  cityDropdown: els.cfCityDropdown,
  errorEl: els.cfError,
};

const state = {
  customer: null,
  order: null,
  draft: [],
  manualMode: false,
  orderExpanded: false,
  pendingPhoneCustomer: null,
  recentPanelOpen: false,
  pendingAdjustKind: null,
  qrQueue: [],
  qrProcessing: false,
  manual: {
    step: "search",
    products: [],
    product: null,
    variant: null,
    pendingProductId: null,
    pending: new Map(),
  },
};

let customerSearchTimer = null;
let productInputTimer = null;
let manualSearchTimer = null;
/** Incrementa en cada búsqueda manual nueva o al elegir producto; evita que respuestas tardías pisen colores/talles. */
let manualSearchGeneration = 0;
let toastTimer = null;

function parseMoneyInput(rawValue) {
  const normalized = String(rawValue ?? "").trim().replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function showToast(msg, ms = 2800) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

function saveSession() {
  if (state.customer?.id) {
    localStorage.setItem(STORAGE.customerId, state.customer.id);
  } else {
    localStorage.removeItem(STORAGE.customerId);
  }
  if (state.order?.id) {
    localStorage.setItem(STORAGE.orderId, state.order.id);
  } else {
    localStorage.removeItem(STORAGE.orderId);
  }
  try {
    localStorage.setItem(STORAGE.draft, JSON.stringify(state.draft));
  } catch {
    /* ignore */
  }
}

function loadDraftFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE.draft);
    if (raw) state.draft = JSON.parse(raw);
    if (!Array.isArray(state.draft)) state.draft = [];
  } catch {
    state.draft = [];
  }
}

function formatLocality(customer) {
  const city = customer?.city || "";
  const prov = customer?.province || "";
  if (city && prov) return `${city}, ${prov}`;
  return city || prov || "—";
}

function extractPhoneDigits(text) {
  return String(text || "").replace(/\D/g, "");
}

function normalizePhoneForSearch(text) {
  return normalizePhoneDigitsForMatch(text);
}

function loadRecentCustomers() {
  try {
    const raw = localStorage.getItem(STORAGE.recentCustomers);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(0, RECENT_CUSTOMERS_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecentCustomers(list) {
  try {
    localStorage.setItem(
      STORAGE.recentCustomers,
      JSON.stringify(list.slice(0, RECENT_CUSTOMERS_MAX))
    );
  } catch {
    /* ignore */
  }
}

function pushRecentCustomer(customer) {
  if (!customer?.id) return;
  const entry = {
    id: customer.id,
    customer_number: customer.customer_number ?? null,
    full_name: customer.full_name ?? "",
    dni: customer.dni ?? null,
    phone: customer.phone ?? null,
    email: customer.email ?? null,
    city: customer.city ?? null,
    province: customer.province ?? null,
  };
  const list = loadRecentCustomers().filter((c) => c.id !== entry.id);
  list.unshift(entry);
  saveRecentCustomers(list);
}

function setRecentPanelOpen(open) {
  state.recentPanelOpen = open;
  if (els.recentPanel) els.recentPanel.hidden = !open;
  if (els.recentToggle) {
    els.recentToggle.setAttribute("aria-expanded", open ? "true" : "false");
    els.recentToggle.classList.toggle("is-open", open);
  }
  if (open) {
    els.customerResults.innerHTML = "";
    els.customerEmpty.hidden = true;
    void renderRecentPanel();
  } else {
    const q = els.customerSearch?.value?.trim() || "";
    if (q.length >= 2) void searchCustomers(q);
  }
}

function hideRecentPanel() {
  if (!state.recentPanelOpen) return;
  setRecentPanelOpen(false);
}

function toggleRecentPanel() {
  setRecentPanelOpen(!state.recentPanelOpen);
}

async function renderRecentPanel() {
  if (!els.recentList || !els.recentEmpty) return;
  const customers = loadRecentCustomers();
  els.recentList.innerHTML = "";
  els.recentEmpty.hidden = customers.length > 0;
  if (!customers.length) return;

  const chipMap = await getOrderStatusChipForCustomers(customers.map((c) => c.id));
  customers.forEach((c) => {
    const chip = chipMap.get(c.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pau-result-btn";
    btn.innerHTML = `
      <div class="pau-result-main">
        <div class="pau-result-name">${escapeHtml(c.full_name || "Sin nombre")}</div>
        <div class="pau-result-loc">${escapeHtml(formatLocality(c))}</div>
      </div>
      ${chip ? chipHtml(chip) : ""}
    `;
    btn.addEventListener("click", () => {
      hideRecentPanel();
      void selectCustomer(c);
    });
    els.recentList.appendChild(btn);
  });
}

async function searchCustomers(query) {
  const clean = String(query || "").trim();
  if (clean.length < 2) {
    els.customerResults.innerHTML = "";
    els.customerEmpty.hidden = true;
    return;
  }

  hideRecentPanel();

  const normQuery = normalizeCustomerSearchText(clean);
  const tokens = tokenizeCustomerSearch(normQuery);
  const escaped = clean.replace(/[%_]/g, "");
  const phoneNorm = normalizePhoneDigitsForMatch(clean);
  const phoneSuffix7 = getPhoneSearchSuffix(clean, PHONE_SEARCH_SUFFIX_LEN);
  const phoneIlikeSuffix =
    phoneSuffix7 ||
    (phoneNorm.length >= 4 ? phoneNorm.slice(-4) : "");

  const { data, error } = await supabase
    .from("customers")
    .select("id, customer_number, full_name, dni, phone, email, city, province")
    .or(
      [
        `full_name.ilike.%${escaped}%`,
        `dni.ilike.%${escaped}%`,
        `email.ilike.%${escaped}%`,
        `customer_number.ilike.%${escaped}%`,
        ...(phoneIlikeSuffix ? [`phone.ilike.%${phoneIlikeSuffix}%`] : []),
      ].join(",")
    )
    .limit(80);

  if (error) {
    console.error(error);
    return;
  }

  let rows = data || [];

  // Refuerzo: formatos con guiones/espacios no siempre matchean ilike; comparar últimos 7 dígitos.
  if (phoneSuffix7.length >= PHONE_SEARCH_SUFFIX_LEN) {
    const { data: phoneRows, error: phoneErr } = await supabase
      .from("customers")
      .select("id, customer_number, full_name, dni, phone, email, city, province")
      .not("phone", "is", null)
      .ilike("phone", `%${phoneSuffix7.slice(-4)}%`)
      .limit(120);

    if (!phoneErr && phoneRows?.length) {
      const byId = new Map(rows.map((c) => [c.id, c]));
      phoneRows.forEach((c) => {
        if (phonesMatchBySuffix(clean, c.phone)) byId.set(c.id, c);
      });
      rows = [...byId.values()];
    }
  }

  const ranked = rankCustomersForSearch(rows, normQuery, tokens);
  const ids = ranked.map((c) => c.id);
  const chipMap = await getOrderStatusChipForCustomers(ids);
  renderCustomerResults(ranked, chipMap, clean);
}

function renderCustomerResults(customers, chipMap, query) {
  els.customerResults.innerHTML = "";
  els.customerEmpty.hidden = customers.length > 0;

  if (customers.length === 1 && query.length >= 3) {
    const c = customers[0];
    const chip = chipMap.get(c.id);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "pau-result-btn";
    card.innerHTML = `
      <div class="pau-result-main">
        <div class="pau-result-name">${escapeHtml(c.full_name || "Sin nombre")}</div>
        <div class="pau-result-loc">${escapeHtml(formatLocality(c))}</div>
      </div>
      ${chip ? chipHtml(chip) : ""}
    `;
    card.addEventListener("click", () => selectCustomer(c));
    els.customerResults.appendChild(card);
    return;
  }

  customers.forEach((c) => {
    const chip = chipMap.get(c.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pau-result-btn";
    btn.innerHTML = `
      <div class="pau-result-main">
        <div class="pau-result-name">${escapeHtml(c.full_name || "Sin nombre")}</div>
        <div class="pau-result-loc">${escapeHtml(formatLocality(c))}</div>
      </div>
      ${chip ? chipHtml(chip) : ""}
    `;
    btn.addEventListener("click", () => selectCustomer(c));
    els.customerResults.appendChild(btn);
  });
}

function chipHtml(chip) {
  const cls =
    chip.tone === "active"
      ? "pau-chip pau-chip-active"
      : chip.tone === "wait"
        ? "pau-chip pau-chip-wait"
        : chip.tone === "closed"
          ? "pau-chip pau-chip-closed"
          : chip.tone === "cancelled"
            ? "pau-chip pau-chip-cancelled"
            : "pau-chip pau-chip-closed";
  return `<span class="${cls}">${escapeHtml(chip.label)}</span>`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function orderHasLoadedProducts(order) {
  return Array.isArray(order?.order_items) && order.order_items.length > 0;
}

function normOrderStatus(order) {
  return String(order?.status ?? "").trim().toLowerCase();
}

function getDraftTotalQty() {
  return state.draft.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
}

function hasDraftItems() {
  return state.draft.length > 0 && getDraftTotalQty() > 0;
}

function isOrderLockedForDraftAdd(order) {
  if (!order?.id) return false;
  const st = normOrderStatus(order);
  return st === "closed" || st === "cancelled";
}

function canAddDraftToOrder() {
  if (!state.customer?.id) return false;
  if (!hasDraftItems()) return false;
  if (!PAU_PERMISSIONS.ordersEdit) return false;
  if (isOrderLockedForDraftAdd(state.order)) return false;
  return true;
}

function updateAddToOrderButton() {
  const allowed = canAddDraftToOrder();
  els.addBtn.disabled = !allowed;

  if (!allowed && getDraftTotalQty() > 0) {
    if (!state.customer?.id) {
      els.addBtn.title = "Seleccioná una clienta para guardar el pedido";
    } else if (!PAU_PERMISSIONS.ordersEdit) {
      els.addBtn.title = "Sin permiso para editar pedidos";
    } else if (["closed", "cancelled"].includes(normOrderStatus(state.order))) {
      els.addBtn.title = "El pedido está cerrado o cancelado";
    } else {
      els.addBtn.title = "";
    }
  } else {
    els.addBtn.title = allowed
      ? "Guardar los productos en el pedido de la clienta"
      : "";
  }
}

function canCloseCurrentOrder() {
  const st = normOrderStatus(state.order);
  return (
    Boolean(state.order?.id) &&
    orderHasLoadedProducts(state.order) &&
    st !== "closed" &&
    st !== "cancelled" &&
    PAU_PERMISSIONS.ordersEdit
  );
}

function canCopyCurrentOrder() {
  return Boolean(state.order?.id) && orderHasLoadedProducts(state.order);
}

/** Extra/Resta: no exige productos guardados; crea el pedido al confirmar si hace falta. */
function canUseOrderAdjustments() {
  if (!state.customer?.id) return false;
  if (!PAU_PERMISSIONS.ordersEdit) return false;
  if (!state.order?.id) return true;
  const st = normOrderStatus(state.order);
  return st !== "closed" && st !== "cancelled";
}

function getAdjustButtonTitle(canAdjust) {
  if (!canAdjust) {
    if (!state.customer?.id) return "Seleccioná una clienta";
    if (!PAU_PERMISSIONS.ordersEdit) return "Sin permiso para editar pedidos";
    if (state.order?.id && isOrderLockedForDraftAdd(state.order)) {
      return "El pedido está cerrado o cancelado";
    }
    return "No disponible";
  }
  if (!state.order?.id) {
    return "Agregar extra o resta (crea el pedido si todavía no hay uno guardado)";
  }
  return "Agregar extra o resta especial";
}

function refreshOrderFooterButtons() {
  updateAddToOrderButton();
  updateCloseButtonState();
}

function setAdjustPanelOpen(open) {
  if (!els.adjustPanel || !els.adjustToggleBtn) return;
  els.adjustPanel.hidden = !open;
  els.adjustToggleBtn.classList.toggle("is-open", open);
  els.adjustToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function buildSpecialExtraItem(description, amount) {
  return {
    id: `special-${Date.now()}-${Math.random()}`,
    product_name: description,
    color: null,
    size: null,
    quantity: 1,
    price_snapshot: amount,
    imagen: null,
    variant_id: null,
    qty_from_general: 0,
    qty_from_venta: 0,
    status: "picked",
    is_special_extra: true,
  };
}

function isSpecialAdjustmentItem(item) {
  if (!item) return false;
  if (item.is_special_extra === true) return true;
  // Compatibilidad: en algunos entornos no existe `is_special_extra`.
  return !item.variant_id && !item.color && !item.size;
}

function closeAdjustDialog() {
  state.pendingAdjustKind = null;
  if (els.adjustDialog?.open) els.adjustDialog.close();
  if (els.adjustError) els.adjustError.hidden = true;
  if (els.adjustSave) {
    els.adjustSave.disabled = false;
    els.adjustSave.textContent = "Agregar";
  }
}

function openAdjustDialog(kind) {
  if (!canUseOrderAdjustments()) {
    showToast(getAdjustButtonTitle(false) || "No se puede ajustar este pedido ahora");
    return;
  }
  if (!els.adjustDialog) return;

  state.pendingAdjustKind = kind;
  const isMinus = kind === "minus";

  if (els.adjustDialog) {
    els.adjustDialog.classList.toggle("is-minus", isMinus);
    els.adjustDialog.classList.toggle("is-plus", !isMinus);
  }
  if (els.adjustTitle) {
    els.adjustTitle.textContent = isMinus ? "Resta al pedido" : "Extra al pedido";
  }
  if (els.adjustHint) {
    els.adjustHint.textContent = isMinus
      ? "El monto se descontará del total del pedido."
      : "El monto se sumará al total del pedido.";
  }
  if (els.adjustDescription) els.adjustDescription.value = "";
  if (els.adjustAmount) els.adjustAmount.value = "";
  if (els.adjustError) els.adjustError.hidden = true;
  if (els.adjustSave) {
    els.adjustSave.disabled = false;
    els.adjustSave.textContent = isMinus ? "Agregar resta" : "Agregar extra";
  }

  setAdjustPanelOpen(false);
  els.adjustDialog.showModal();
  setTimeout(() => els.adjustDescription?.focus(), 50);
}

async function submitAdjustForm(ev) {
  ev.preventDefault();
  const kind = state.pendingAdjustKind;
  if (!kind || !canUseOrderAdjustments()) return;

  const description = String(els.adjustDescription?.value || "").trim();
  const amountValue = parseMoneyInput(els.adjustAmount?.value);
  if (!description) {
    if (els.adjustError) {
      els.adjustError.textContent = "Ingresá una descripción.";
      els.adjustError.hidden = false;
    }
    els.adjustDescription?.focus();
    return;
  }
  if (!amountValue) {
    if (els.adjustError) {
      els.adjustError.textContent = "Ingresá un monto válido mayor a 0.";
      els.adjustError.hidden = false;
    }
    els.adjustAmount?.focus();
    return;
  }

  if (els.adjustError) els.adjustError.hidden = true;
  if (els.adjustSave) {
    els.adjustSave.disabled = true;
    els.adjustSave.textContent = "Guardando…";
  }

  const signedAmount = kind === "minus" ? -amountValue : amountValue;
  const specialItem = buildSpecialExtraItem(description, signedAmount);

  try {
    if (!state.order?.id) {
      const created = await createApartadoOrder(state.customer.id);
      state.order = created.order;
    }
    await addItemsToOrder(state.order.id, [specialItem]);
    closeAdjustDialog();
    showToast(kind === "minus" ? "Resta agregada al pedido" : "Extra agregado al pedido");
    await refreshOrderUi();
  } catch (err) {
    console.error(err);
    if (els.adjustError) {
      els.adjustError.textContent = err.message || "No se pudo guardar el ajuste.";
      els.adjustError.hidden = false;
    }
  } finally {
    if (els.adjustSave) {
      const isMinus = kind === "minus";
      els.adjustSave.disabled = false;
      els.adjustSave.textContent = isMinus ? "Agregar resta" : "Agregar extra";
    }
  }
}

function updateCloseButtonState() {
  const canClose = canCloseCurrentOrder();
  els.closeBtn.disabled = !canClose;
  els.closeBtn.title = canClose
    ? "Cerrar pedido y moverlo a Cerrados"
    : "Disponible cuando haya un pedido con productos guardados";

  const canCopy = canCopyCurrentOrder();
  if (els.copyOrderBtn) {
    els.copyOrderBtn.disabled = !canCopy;
    els.copyOrderBtn.title = canCopy
      ? "Copiar detalle del pedido para WhatsApp"
      : "Disponible cuando haya productos guardados en el pedido";
  }

  const canAdjust = canUseOrderAdjustments();
  if (els.adjustToggleBtn) {
    els.adjustToggleBtn.disabled = !canAdjust;
    els.adjustToggleBtn.title = getAdjustButtonTitle(canAdjust);
  }
  if (!canAdjust) setAdjustPanelOpen(false);
}

function formatMoneyAr(amount) {
  const n = Number(amount) || 0;
  return `$${n.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}

function formatItemPriceForCopy(item) {
  const unit = Number(item.price_snapshot) || 0;
  const qty = Math.max(Number(item.quantity) || 0, 1);
  const signedUnit =
    unit < 0 ? `- ${formatMoneyAr(Math.abs(unit))}` : formatMoneyAr(unit);
  if (qty > 1) {
    const lineTotal = unit * qty;
    const signedLine =
      lineTotal < 0 ? `- ${formatMoneyAr(Math.abs(lineTotal))}` : formatMoneyAr(lineTotal);
    return `${signedUnit} c/u · ${signedLine}`;
  }
  return signedUnit;
}

/** Texto listo para pegar en WhatsApp (negritas con *). Incluye ofertas/promos. */
async function buildPauOrderWhatsAppText() {
  const order = state.order;
  const items = (order?.order_items || []).filter(
    (i) => normOrderStatus({ status: i.status }) !== "cancelled"
  );
  if (!items.length) return "";

  let breakdown = {
    totalDiscount: 0,
    payable: Number(order?.total_amount) || 0,
    promotions: [],
    itemPromos: new Map(),
    itemOffers: new Map(),
  };
  try {
    breakdown = await computeOffersAndPromotionsForItems(items);
  } catch (e) {
    console.warn("PAU WhatsApp: no se pudieron calcular ofertas/promos", e);
  }

  const lines = [];

  items.forEach((item) => {
    const isSpecial = isSpecialAdjustmentItem(item);
    const qty = Number(item.quantity) || 0;
    const pricePart = formatItemPriceForCopy(item);
    const promoLabel =
      breakdown.itemPromos?.get(item.id) ||
      (breakdown.itemOffers?.has(item.id) ? "Oferta" : "");

    if (isSpecial) {
      const desc = (item.product_name || "Ajuste").trim();
      lines.push(`• ${desc} — x${qty} — ${pricePart}`);
      return;
    }

    const name = (item.product_name || "Producto").trim();
    const color = (item.color || "-").trim();
    const size = (item.size || "-").trim();
    const promoPart = promoLabel ? ` — _${promoLabel}_` : "";
    lines.push(
      `• ${name} — ${color} — Talle ${size} — x${qty} — ${pricePart}${promoPart}`
    );
  });

  const totalQty = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const total =
    Number.isFinite(breakdown.payable)
      ? breakdown.payable
      : Number(order?.total_amount) || 0;

  lines.push("");
  lines.push(`*Cantidad de productos:* ${totalQty}`);
  if (breakdown.totalDiscount > 0) {
    const promoBits = (breakdown.promotions || [])
      .map((p) => {
        const groups =
          p.groups > 0 ? ` (${p.groups} grupo${p.groups === 1 ? "" : "s"})` : "";
        return `${p.type}${groups}`;
      })
      .filter(Boolean);
    if (promoBits.length) {
      lines.push(`*Promo aplicada:* ${promoBits.join(", ")}`);
    }
    lines.push(`*Descuento:* -${formatMoneyAr(breakdown.totalDiscount)}`);
  }
  lines.push(`*Total:* ${formatMoneyAr(total)}`);

  return `*Pedido FYL*\n\n${lines.join("\n")}`.trim();
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function handleCopyOrder() {
  if (!canCopyCurrentOrder()) {
    showToast("No hay pedido con productos para copiar");
    return;
  }

  const text = await buildPauOrderWhatsAppText();
  if (!text) {
    showToast("No hay productos para copiar");
    return;
  }

  const ok = await copyTextToClipboard(text);
  if (ok) showToast("Pedido copiado — pegalo en WhatsApp");
  else alert("No se pudo copiar. Seleccioná y copiá manualmente:\n\n" + text);
}

function getPedidoStatusLabel(order) {
  if (!order || !orderHasLoadedProducts(order)) return "Sin pedido";
  const st = String(order.status || "").trim().toLowerCase();
  if (st === "closed") return "Cerrado";
  if (st === "cancelled") return "Cancelado";
  if (st === "stock_pending") return "Stock pendiente";
  if (st === "sent") return "Enviado";
  const items = order.order_items;
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  if (items.some((i) => norm(i.status) === "waiting")) return "Espera";
  if (items.some((i) => norm(i.status) === "reserved")) return "Activo";
  if (items.every((i) => ["picked", "waiting"].includes(norm(i.status)))) return "Apartado";
  return "Pedido";
}

async function selectCustomer(customer) {
  try {
    let order = await findActiveOrderForCustomer(customer.id);
    // Solo mostrar pedido si ya tiene productos guardados; si no, "Sin pedido" hasta Agregar al pedido.
    if (order && !orderHasLoadedProducts(order)) {
      order = null;
    }
    state.customer = customer;
    state.order = order;
    state.draft = [];
    pushRecentCustomer(customer);
    saveSession();
    hideRecentPanel();
    showComposeMode();
    refreshOrderFooterButtons();
    await refreshOrderUi();
  } catch (err) {
    console.error(err);
    alert(err.message || "No se pudo abrir la clienta.");
  }
}

function showLandingMode() {
  els.landing.hidden = false;
  els.compose.hidden = true;
  els.phoneConfirm.hidden = true;
  els.top.hidden = true;
  hideRecentPanel();
  setAdjustPanelOpen(false);
  els.customerSearch.focus();
}

/** Vuelve al buscador de clientas (p. ej. tras guardar el pedido). */
function goToCustomerSearchLanding() {
  state.customer = null;
  state.order = null;
  state.draft = [];
  state.pendingPhoneCustomer = null;
  state.orderExpanded = false;
  state.qrQueue = [];
  state.qrProcessing = false;
  setAdjustPanelOpen(false);
  closeAdjustDialog();
  resetManualPicker();
  setManualMode(false);

  localStorage.removeItem(STORAGE.customerId);
  localStorage.removeItem(STORAGE.orderId);
  try {
    localStorage.setItem(STORAGE.draft, "[]");
  } catch {
    /* ignore */
  }

  els.customerSearch.value = "";
  els.customerResults.innerHTML = "";
  els.customerEmpty.hidden = true;
  els.orderItems.hidden = true;
  els.expandLabel.textContent = "Desplegar";
  renderDraft();
  refreshOrderFooterButtons();

  showLandingMode();
}

function showPhoneConfirmMode() {
  els.landing.hidden = true;
  els.compose.hidden = true;
  els.phoneConfirm.hidden = false;
  els.top.hidden = true;
  hideRecentPanel();
  setAdjustPanelOpen(false);
}

function showComposeMode() {
  els.landing.hidden = true;
  els.phoneConfirm.hidden = true;
  els.compose.hidden = false;
  els.top.hidden = false;
  renderCustomerHeader();
  refreshOrderFooterButtons();
  setAdjustPanelOpen(false);
  setManualMode(false);
  focusScanInput();
}

function renderCustomerHeader() {
  const c = state.customer;
  const o = state.order;
  if (!c) return;
  const statusLabel = getPedidoStatusLabel(o);
  const contactLine = `${escapeHtml(c.phone || "—")} · ${escapeHtml(formatLocality(c))}`;
  let pedidoLine = "";
  if (statusLabel === "Sin pedido") {
    pedidoLine = `${contactLine} · <span class="pau-status-sin-pedido">Sin pedido</span>`;
  } else if (o?.order_number) {
    pedidoLine = `${contactLine}<br><span>Pedido #${escapeHtml(o.order_number)} · ${escapeHtml(statusLabel)}</span>`;
  } else {
    pedidoLine = `${contactLine} · ${escapeHtml(statusLabel)}`;
  }
  els.customerHeader.innerHTML = `
    <strong>${escapeHtml(c.full_name)}</strong>
    <span>${pedidoLine}</span>
  `;
}

function manualPendingKey(variantId, size) {
  return `${variantId}|${normalizeSize(size)}`;
}

function resetManualPicker() {
  state.manual.step = "search";
  state.manual.products = [];
  state.manual.product = null;
  state.manual.variant = null;
  state.manual.pending.clear();
  state.manual.pendingProductId = null;
  els.manualChoices.innerHTML = "";
  els.manualPicker.hidden = true;
  els.manualBack.hidden = true;
  els.manualActions.hidden = true;
  els.manualStepLabel.textContent = "";
  syncManualPickerHead();
  syncManualChoicesScroll();
}

/** Tras pasar ítems al borrador: ocultar picker y vaciar búsqueda para el próximo producto. */
function clearManualSearchForNextProduct() {
  resetManualPicker();
  els.productInput.value = "";
  if (state.manualMode) {
    focusScanInput();
  }
}

function getManualPendingTotalQty() {
  let n = 0;
  for (const row of state.manual.pending.values()) {
    n += Number(row.quantity) || 0;
  }
  return n;
}

function getVariantPendingQty(variantId) {
  let n = 0;
  const vid = String(variantId || "");
  for (const row of state.manual.pending.values()) {
    if (String(row.variant_id) === vid) {
      n += Number(row.quantity) || 0;
    }
  }
  return n;
}

function decorateChoiceButton(btn, label, qty) {
  btn.title = label;
  btn.textContent = label;
  if (qty > 0) {
    btn.classList.add("is-selected");
    const badge = document.createElement("span");
    badge.className = "pau-choice-badge";
    badge.textContent = String(qty);
    btn.appendChild(badge);
  }
}

function updateManualAddButton() {
  const qty = getManualPendingTotalQty();
  if (qty > 0) {
    els.manualActions.hidden = false;
    els.manualClearPicks.textContent = "Limpiar selección";
    els.manualAddPicks.textContent = `Agregar (${qty})`;
  } else {
    els.manualActions.hidden = true;
  }
}

function clearManualPending() {
  if (getManualPendingTotalQty() === 0) return;
  state.manual.pending.clear();
  state.manual.pendingProductId = null;
  if (state.manual.step === "sizes") {
    renderManualSizes();
  } else if (state.manual.step === "colors") {
    renderManualColors();
  } else {
    updateManualAddButton();
  }
  showToast("Selección manual limpiada");
}

function syncManualPickerHead() {
  const hasBack = !els.manualBack.hidden;
  const hasLabel = Boolean(els.manualStepLabel.textContent.trim());
  els.manualPickerHead.hidden = !(hasBack || hasLabel);
}

function syncManualChoicesScroll() {
  const count = els.manualChoices.querySelectorAll(".pau-choice-btn").length;
  els.manualChoices.classList.toggle("is-scrollable", count > 12);
}

function setManualMode(on) {
  state.manualMode = on;
  els.manualToggle.classList.toggle("is-active", on);
  els.productInput.placeholder = on
    ? "Buscar producto por nombre…"
    : "Escanear código de barras…";
  if (!on) {
    resetManualPicker();
  }
  focusScanInput();
}

function renderManualProducts() {
  state.manual.step = "products";
  state.manual.product = null;
  state.manual.variant = null;
  els.manualBack.hidden = true;
  els.manualStepLabel.textContent = "";
  els.manualChoices.innerHTML = "";

  if (!state.manual.products.length) {
    els.manualChoices.innerHTML = '<p class="pau-manual-add-hint">Sin coincidencias</p>';
    els.manualPicker.hidden = false;
    syncManualPickerHead();
    syncManualChoicesScroll();
    updateManualAddButton();
    return;
  }

  state.manual.products.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pau-choice-btn";
    btn.title = p.product_name;
    btn.textContent = p.product_name;
    btn.addEventListener("click", () => {
      clearTimeout(manualSearchTimer);
      manualSearchGeneration += 1;
      if (
        state.manual.pendingProductId &&
        state.manual.pendingProductId !== p.product_id &&
        getManualPendingTotalQty() > 0
      ) {
        state.manual.pending.clear();
        updateManualAddButton();
      }
      state.manual.product = p;
      state.manual.pendingProductId = p.product_id;
      renderManualColors();
    });
    els.manualChoices.appendChild(btn);
  });
  els.manualPicker.hidden = false;
  syncManualPickerHead();
  syncManualChoicesScroll();
  updateManualAddButton();
}

function renderManualColors() {
  state.manual.step = "colors";
  state.manual.variant = null;
  const p = state.manual.product;
  if (!p) return renderManualProducts();

  els.manualBack.hidden = false;
  els.manualStepLabel.textContent = p.product_name;
  els.manualChoices.innerHTML = "";

  p.variants.forEach((v) => {
    const colorQty = getVariantPendingQty(v.variant_id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pau-choice-btn";
    decorateChoiceButton(btn, v.color || "—", colorQty);
    btn.addEventListener("click", () => {
      state.manual.variant = v;
      renderManualSizes();
    });
    els.manualChoices.appendChild(btn);
  });
  syncManualPickerHead();
  syncManualChoicesScroll();
  updateManualAddButton();
}

function renderManualSizes() {
  state.manual.step = "sizes";
  const p = state.manual.product;
  const v = state.manual.variant;
  if (!p || !v) return renderManualColors();

  els.manualBack.hidden = false;
  els.manualStepLabel.textContent = `${p.product_name} · ${v.color}`;
  els.manualChoices.innerHTML = "";

  v.sizes.forEach((s) => {
    const key = manualPendingKey(v.variant_id, s.size);
    const pending = state.manual.pending.get(key);
    const qty = pending?.quantity || 0;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pau-choice-btn";
    decorateChoiceButton(btn, s.size || "—", qty);
    btn.addEventListener("click", () => {
      if (!hasCatalogPrice(v.price_snapshot)) {
        showToast(catalogPriceGuardMessage(p.product_name));
        return;
      }
      const nextQty = qty + 1;
      state.manual.pending.set(key, {
        product_name: p.product_name,
        color: v.color,
        size: s.size,
        sku: s.sku,
        price_snapshot: v.price_snapshot,
        variant_id: v.variant_id,
        quantity: nextQty,
        status: "picked",
      });
      renderManualSizes();
      updateManualAddButton();
    });
    els.manualChoices.appendChild(btn);
  });
  syncManualPickerHead();
  syncManualChoicesScroll();
  updateManualAddButton();
}

function manualGoBack() {
  if (state.manual.step === "sizes") {
    renderManualColors();
    return;
  }
  if (state.manual.step === "colors") {
    renderManualProducts();
  }
}

async function flushManualPendingToDraft() {
  const qty = getManualPendingTotalQty();
  if (qty === 0) return;

  for (const item of state.manual.pending.values()) {
    mergeDraftItem(state.draft, { ...item });
  }
  state.manual.pending.clear();
  try {
    state.draft = await enrichDraftItemsWithStock(state.draft);
  } catch (e) {
    console.error(e);
    showToast("No se pudo validar stock de los ítems");
  }
  saveSession();
  renderDraft();
  updateManualAddButton();
  showToast(`${qty} unidad(es) agregadas al listado`);
  clearManualSearchForNextProduct();
}

async function runManualProductSearch(query) {
  const val = String(query || "").trim();
  if (val.length < 2) {
    resetManualPicker();
    return;
  }
  const gen = ++manualSearchGeneration;
  try {
    const products = await searchProductsGroupedByPrefix(val);
    if (gen !== manualSearchGeneration) return;
    if (els.productInput.value.trim() !== val) return;
    if (state.manual.step === "colors" || state.manual.step === "sizes") return;
    state.manual.products = products;
    renderManualProducts();
  } catch (e) {
    if (gen !== manualSearchGeneration) return;
    console.error(e);
    showToast("Error buscando productos");
  }
}

function focusScanInput() {
  setTimeout(() => {
    try {
      els.productInput.focus();
    } catch {
      /* ignore */
    }
  }, 30);
}

function isCompleteQr(value) {
  const v = String(value || "").trim();
  return /^\d+$/.test(v) && v.length >= QR_MIN_DIGITS;
}

function enqueueQr(code) {
  els.productInput.value = "";
  state.qrQueue.push(code);
  if (!state.qrProcessing) processQrQueue();
  focusScanInput();
}

async function processQrQueue() {
  if (!state.qrQueue.length) {
    state.qrProcessing = false;
    return;
  }
  state.qrProcessing = true;
  const code = state.qrQueue.shift();
  let addedName = "";
  try {
    const item = await resolveQrCodeToOrderItem(code);
    mergeDraftItem(state.draft, item);
    addedName = item.product_name || "";
    try {
      state.draft = await enrichDraftItemsWithStock(state.draft);
    } catch (enrichErr) {
      console.error(enrichErr);
      showToast("Producto agregado; no se pudo recalcular stock del borrador");
    }
    saveSession();
    if (addedName) showToast(`+ ${addedName}`);
  } catch (err) {
    showToast(err.message || "Error al escanear");
  } finally {
    renderDraft();
  }
  setTimeout(processQrQueue, 0);
}

async function onProductInput() {
  const val = els.productInput.value.trim();
  if (!state.manualMode) {
    if (isCompleteQr(val)) {
      enqueueQr(val);
    }
    return;
  }

  clearTimeout(manualSearchTimer);
  if (state.manual.step === "colors" || state.manual.step === "sizes") {
    state.manual.step = "search";
    state.manual.product = null;
    state.manual.variant = null;
  }
  manualSearchTimer = setTimeout(() => runManualProductSearch(val), 300);
}

function renderDraft() {
  const totalQty = getDraftTotalQty();
  const scannedNumEl = els.scannedCount.querySelector(".pau-scanned-count-num");
  if (scannedNumEl) scannedNumEl.textContent = String(totalQty);
  else els.scannedCount.textContent = `Escaneados: ${totalQty}`;
  refreshOrderFooterButtons();

  els.draftList.innerHTML = "";
  state.draft.forEach((item, idx) => {
    const li = document.createElement("li");
    li.className = "pau-item-row";
    li.innerHTML = `
      <div class="pau-item-main">
        <strong class="pau-item-name">${escapeHtml(item.product_name)}</strong>
        <span class="pau-item-detail">${escapeHtml(item.color || "-")}</span>
        <span class="pau-item-detail">Talle ${escapeHtml(item.size || "-")}</span>
        <span class="pau-item-qty">x${item.quantity}</span>
      </div>
      <button type="button" class="pau-item-remove" data-idx="${idx}">Quitar</button>
    `;
    li.querySelector(".pau-item-remove").addEventListener("click", () => {
      state.draft.splice(idx, 1);
      saveSession();
      renderDraft();
    });
    els.draftList.appendChild(li);
  });
}

async function handleRemoveOrderItem(orderItemId) {
  if (!orderItemId || !state.order?.id) return;
  if (!PAU_PERMISSIONS.ordersEdit) {
    alert("No tenés permiso para editar pedidos.");
    return;
  }

  const st = normOrderStatus(state.order);
  if (st === "closed" || st === "cancelled") {
    showToast("No se puede modificar un pedido cerrado o cancelado");
    return;
  }

  const item = (state.order.order_items || []).find((i) => i.id === orderItemId);
  const label = item
    ? `${item.product_name || "Producto"} · ${item.color || "-"} · Talle ${item.size || "-"} · x${item.quantity}`
    : "este producto";

  if (!confirm(`¿Quitar ${label} del pedido?\n\nEl stock se devolverá como en Pedidos.`)) {
    return;
  }

  try {
    const result = await removeOrderItemRestoreStock(orderItemId);
    if (result.order_deleted) {
      state.order = null;
      showToast("Producto quitado. El pedido quedó vacío.");
    } else {
      showToast("Producto quitado del pedido");
    }
    await refreshOrderUi();
  } catch (err) {
    console.error(err);
    alert(err.message || "No se pudo quitar el producto.");
  }
}

async function refreshOrderUi() {
  renderCustomerHeader();

  if (!state.order?.id) {
    els.orderSummary.innerHTML = '<span class="pau-status-sin-pedido">Sin pedido</span>';
    els.orderItems.innerHTML = "";
    els.orderItems.hidden = true;
    state.orderExpanded = false;
    els.expandLabel.textContent = "Desplegar";
    refreshOrderFooterButtons();
    return;
  }

  state.order = await fetchOrderById(state.order.id);
  if (!state.order) {
    state.order = null;
    els.orderSummary.innerHTML = '<span class="pau-status-sin-pedido">Sin pedido</span>';
    els.orderItems.innerHTML = "";
    els.orderItems.hidden = true;
    refreshOrderFooterButtons();
    return;
  }

  if (!orderHasLoadedProducts(state.order)) {
    state.order = null;
    els.orderSummary.innerHTML = '<span class="pau-status-sin-pedido">Sin pedido</span>';
    els.orderItems.innerHTML = "";
    els.orderItems.hidden = true;
    refreshOrderFooterButtons();
    return;
  }

  const items = state.order.order_items || [];
  const qty = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);

  let breakdown = {
    payable: Number(state.order.total_amount) || 0,
    totalDiscount: 0,
    itemPromos: new Map(),
    itemOffers: new Map(),
    promotions: [],
  };
  try {
    breakdown = await computeOffersAndPromotionsForItems(items);
  } catch (e) {
    console.warn("PAU: no se pudieron calcular ofertas/promos", e);
  }

  const total = Number.isFinite(breakdown.payable)
    ? breakdown.payable
    : Number(state.order.total_amount) || 0;
  const discountNote =
    breakdown.totalDiscount > 0
      ? ` · promo -$${breakdown.totalDiscount.toLocaleString("es-AR")}`
      : "";
  els.orderSummary.textContent = `Pedido: ${qty} producto(s) · $${total.toLocaleString("es-AR")}${discountNote}`;

  const canRemoveSaved = PAU_PERMISSIONS.ordersEdit;
  const orderStatus = normOrderStatus(state.order);
  const orderLocked = orderStatus === "closed" || orderStatus === "cancelled";
  const sortedItems = [...items].sort((a, b) => {
    const aExtra = isSpecialAdjustmentItem(a);
    const bExtra = isSpecialAdjustmentItem(b);
    if (aExtra !== bExtra) return aExtra ? 1 : -1;
    return 0;
  });

  els.orderItems.innerHTML = "";
  sortedItems.forEach((item) => {
    const itemStatus = normOrderStatus({ status: item.status });
    const removable =
      canRemoveSaved &&
      !orderLocked &&
      item.id &&
      itemStatus !== "cancelled";
    const isSpecial = isSpecialAdjustmentItem(item);
    const signedAmount = Number(item.price_snapshot) || 0;
    const specialLabel = isSpecial ? (signedAmount < 0 ? "➖ Resta" : "➕ Extra") : "";
    const displayName = isSpecial
      ? `${specialLabel}: ${item.product_name || "Ajuste"}`
      : (item.product_name || "Producto");
    const detailColor = isSpecial ? "Ajuste" : (item.color || "-");
    const detailSize = isSpecial ? "—" : `Talle ${item.size || "-"}`;
    const promoText =
      breakdown.itemPromos?.get(item.id) ||
      (breakdown.itemOffers?.has(item.id) ? "Oferta" : "");
    const promoBadge = promoText
      ? `<span class="pau-item-promo">${escapeHtml(promoText)}</span>`
      : "";
    const li = document.createElement("li");
    li.className = "pau-item-row";
    li.innerHTML = `
      <div class="pau-item-main">
        <strong class="pau-item-name">${escapeHtml(displayName)}</strong>
        <span class="pau-item-detail">${escapeHtml(detailColor)}</span>
        <span class="pau-item-detail">${escapeHtml(detailSize)}</span>
        <span class="pau-item-qty">x${item.quantity}</span>
        ${promoBadge}
      </div>
      ${
        removable
          ? `<button type="button" class="pau-item-remove" data-order-item-id="${escapeHtml(item.id)}">Quitar</button>`
          : ""
      }
    `;
    els.orderItems.appendChild(li);
  });

  renderCustomerHeader();

  refreshOrderFooterButtons();
}

function openCloseActionDialog() {
  if (!canCloseCurrentOrder()) return;
  els.closeActionDialog.showModal();
}

function setCloseActionButtonsDisabled(disabled) {
  els.closeContraRem.disabled = disabled;
  els.closePagado.disabled = disabled;
  els.closeSendLocal.disabled = disabled;
  els.closeActionCancel.disabled = disabled;
}

async function handleCloseOrderWithPayment(paymentMethod) {
  if (!state.order?.id) return;
  if (!PAU_PERMISSIONS.ordersEdit) {
    alert("No tenés permiso para editar pedidos.");
    return;
  }

  setCloseActionButtonsDisabled(true);
  try {
    await closeOrder(state.order.id, paymentMethod);
    els.closeActionDialog.close();
    showToast("Pedido cerrado");
    goToCustomerSearchLanding();
  } catch (err) {
    console.error(err);
    alert(err.message || "No se pudo cerrar el pedido.");
  } finally {
    setCloseActionButtonsDisabled(false);
  }
}

async function handleSendOrderToLocal() {
  if (!state.order?.id) return;
  if (!PAU_PERMISSIONS.ordersEdit) {
    alert("No tenés permiso para editar pedidos.");
    return;
  }

  els.sendLocalYes.disabled = true;
  els.sendLocalNo.disabled = true;
  try {
    const data = await sendOrderToLocal(state.order.id);
    els.sendLocalDialog.close();
    els.closeActionDialog.close();
    const already = data?.already_exists === true;
    const num = data?.order_number || "N/A";
    showToast(
      already
        ? `Este pedido ya estaba en el local (n.º ${num}).`
        : `Pedido enviado al local (n.º ${num}).`
    );
    await refreshOrderUi();
  } catch (err) {
    console.error(err);
    alert(err.message || "No se pudo enviar el pedido al local.");
  } finally {
    els.sendLocalYes.disabled = false;
    els.sendLocalNo.disabled = false;
  }
}

async function handleAddToOrder() {
  if (!state.customer?.id || !state.draft.length) return;
  if (!PAU_PERMISSIONS.ordersEdit) {
    alert("No tenés permiso para editar pedidos.");
    return;
  }
  if (!canAddDraftToOrder()) {
    showToast(els.addBtn.title || "No se puede agregar al pedido ahora");
    return;
  }
  els.addBtn.disabled = true;
  try {
    const items = state.draft.map((d) => ({ ...d }));

    if (!state.order?.id) {
      const created = await createApartadoOrder(state.customer.id);
      state.order = created.order;
      if (created.created) {
        await addItemsToOrder(state.order.id, items);
        showToast("Pedido creado y productos agregados");
      } else {
        await addItemsToOrder(state.order.id, items);
        showToast("Productos agregados al pedido");
      }
    } else {
      await addItemsToOrder(state.order.id, items);
      showToast("Productos agregados al pedido");
    }

    state.draft = [];
    resetManualPicker();
    els.productInput.value = "";
    saveSession();
    await refreshOrderUi();
    focusScanInput();
  } catch (err) {
    console.error(err);
    const msg = err?.message || "No se pudieron agregar los productos.";
    if (err?.code === "STOCK_CONFLICT_PRECHECK") {
      showToast(msg);
    } else if (/stock_pending/i.test(msg)) {
      showToast("Pedido en stock pendiente — revisalo en Pedidos");
      await refreshOrderUi();
    } else {
      alert(msg);
    }
  } finally {
    renderDraft();
  }
}

function openCloseDialog() {
  if (!canCloseCurrentOrder()) return;
  openCloseActionDialog();
}

function clearActiveCustomerAndShowSearch() {
  if (state.draft.length > 0) {
    const ok = confirm(
      "Hay productos escaneados sin agregar al pedido. ¿Buscar otra clienta? Se descartará el borrador actual."
    );
    if (!ok) return;
  }

  goToCustomerSearchLanding();
}

async function tryRestoreSession() {
  const cid = localStorage.getItem(STORAGE.customerId);
  const oid = localStorage.getItem(STORAGE.orderId);
  loadDraftFromStorage();
  if (!cid) return false;

  const { data: customer } = await supabase.from("customers").select("*").eq("id", cid).maybeSingle();
  if (!customer) return false;

  let order = oid ? await fetchOrderById(oid).catch(() => null) : null;
  if (!order || order.status === "closed" || order.status === "cancelled") {
    order = await findActiveOrderForCustomer(cid);
  }
  if (!order) return false;

  state.customer = customer;
  state.order = order;
  showComposeMode();
  renderDraft();
  await refreshOrderUi();
  return true;
}

async function handleSharedPhoneText(text) {
  const digits = normalizePhoneForSearch(text);
  if (!digits || digits.length < 8) return false;

  localStorage.setItem(STORAGE.phone, digits);
  const phoneSuffix7 = getPhoneSearchSuffix(text, PHONE_SEARCH_SUFFIX_LEN);
  const phoneIlike = phoneSuffix7 || digits.slice(-4);
  const { data } = await supabase
    .from("customers")
    .select("id, full_name, phone, city, province, dni")
    .not("phone", "is", null)
    .ilike("phone", `%${phoneIlike}%`)
    .limit(30);

  let list = (data || []).filter((c) => phonesMatchBySuffix(text, c.phone));
  if (!list.length && phoneSuffix7.length >= PHONE_SEARCH_SUFFIX_LEN) {
    const { data: broader } = await supabase
      .from("customers")
      .select("id, full_name, phone, city, province, dni")
      .not("phone", "is", null)
      .limit(200);
    list = (broader || []).filter((c) => phonesMatchBySuffix(text, c.phone));
  }

  if (!list.length) {
    showToast("No hay clienta con ese teléfono");
    return true;
  }

  const match =
    list.find((c) => normalizePhoneForSearch(c.phone) === digits) ||
    list.find((c) => phonesMatchBySuffix(text, c.phone)) ||
    list[0];

  state.pendingPhoneCustomer = match;
  els.phoneConfirmText.textContent = `¿Es ${match.full_name || "esta clienta"}?`;
  showPhoneConfirmMode();
  return true;
}

function openCreateCustomerDialog() {
  if (!PAU_PERMISSIONS.customersEdit) {
    alert("No tenés permiso para crear clientas. Pedile a un administrador permiso de edición en Clientes.");
    return;
  }
  resetCustomerCreateForm(cfEls);
  els.createCustomerDialog.showModal();
  els.cfFirstName?.focus();
}

function closeCreateCustomerDialog() {
  els.createCustomerDialog.close();
  resetCustomerCreateForm(cfEls);
}

async function handleCreateCustomerSubmit(ev) {
  ev.preventDefault();
  const validation = validateNewCustomerForm({
    firstName: els.cfFirstName?.value,
    lastName: els.cfLastName?.value,
    dni: els.cfDni?.value,
    phone: els.cfPhone?.value,
    email: els.cfEmail?.value,
    address: els.cfAddress?.value,
    province: els.cfProvince?.value,
    city: els.cfCity?.value,
  });

  if (!validation.ok) {
    if (els.cfError) {
      els.cfError.textContent = validation.error;
      els.cfError.hidden = false;
    }
    return;
  }

  if (els.cfError) els.cfError.hidden = true;
  if (els.cfSave) {
    els.cfSave.disabled = true;
    els.cfSave.textContent = "Guardando…";
  }

  try {
    const customer = await createAdminCustomer(supabase, validation.data);
    closeCreateCustomerDialog();
    els.customerSearch.value = "";
    els.customerResults.innerHTML = "";
    els.customerEmpty.hidden = true;
    showToast(`Clienta creada: ${customer.full_name}`);
    await selectCustomer(customer);
  } catch (err) {
    console.error(err);
    if (els.cfError) {
      els.cfError.textContent = err.message || "No se pudo guardar la clienta";
      els.cfError.hidden = false;
    }
  } finally {
    if (els.cfSave) {
      els.cfSave.disabled = false;
      els.cfSave.textContent = "Guardar";
    }
  }
}

function setupCreateCustomerUi() {
  if (PAU_PERMISSIONS.customersEdit && els.createCustomerBtn) {
    els.createCustomerBtn.hidden = false;
  }

  initArgentinaLocationAutocomplete({
    provinceInput: els.cfProvince,
    provinceDropdown: els.cfProvinceDropdown,
    cityInput: els.cfCity,
    cityDropdown: els.cfCityDropdown,
    dialogRoot: els.createCustomerDialog,
  });

  els.createCustomerBtn?.addEventListener("click", openCreateCustomerDialog);
  els.cfCancel?.addEventListener("click", closeCreateCustomerDialog);
  els.createCustomerForm?.addEventListener("submit", handleCreateCustomerSubmit);
  els.createCustomerDialog?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeCreateCustomerDialog();
  });
}

setupCreateCustomerUi();

// Eventos
els.recentToggle?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleRecentPanel();
});

els.customerSearch.addEventListener("input", () => {
  hideRecentPanel();
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(() => searchCustomers(els.customerSearch.value), CUSTOMER_DEBOUNCE_MS);
});

els.productInput.addEventListener("input", onProductInput);
els.productInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !state.manualMode) {
    e.preventDefault();
    const v = els.productInput.value.trim();
    if (v) enqueueQr(v);
  }
});

els.manualToggle.addEventListener("click", () => setManualMode(!state.manualMode));
els.manualBack.addEventListener("click", manualGoBack);
els.manualClearPicks.addEventListener("click", clearManualPending);
els.manualAddPicks.addEventListener("click", flushManualPendingToDraft);
els.addBtn.addEventListener("click", handleAddToOrder);
els.copyOrderBtn?.addEventListener("click", () => void handleCopyOrder());
els.adjustToggleBtn?.addEventListener("click", () => {
  if (!canUseOrderAdjustments()) return;
  setAdjustPanelOpen(Boolean(els.adjustPanel?.hidden));
});
els.adjustPlusBtn?.addEventListener("click", () => openAdjustDialog("plus"));
els.adjustMinusBtn?.addEventListener("click", () => openAdjustDialog("minus"));
els.adjustForm?.addEventListener("submit", (e) => void submitAdjustForm(e));
els.adjustCancel?.addEventListener("click", closeAdjustDialog);
els.adjustDialog?.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeAdjustDialog();
});
els.closeBtn.addEventListener("click", openCloseDialog);
els.closeActionCancel.addEventListener("click", () => els.closeActionDialog.close());
els.closeContraRem.addEventListener("click", () => {
  handleCloseOrderWithPayment(ORDER_PAYMENT_METHOD.CONTRA_REEMBOLSO);
});
els.closePagado.addEventListener("click", () => {
  handleCloseOrderWithPayment(ORDER_PAYMENT_METHOD.PAGADO);
});
els.closeSendLocal.addEventListener("click", () => {
  els.closeActionDialog.close();
  els.sendLocalDialog.showModal();
});
els.sendLocalNo.addEventListener("click", () => {
  els.sendLocalDialog.close();
  els.closeActionDialog.showModal();
});
els.sendLocalYes.addEventListener("click", () => handleSendOrderToLocal());
els.searchAnotherBtn.addEventListener("click", clearActiveCustomerAndShowSearch);

els.orderToggle.addEventListener("click", () => {
  state.orderExpanded = !state.orderExpanded;
  els.orderItems.hidden = !state.orderExpanded;
  els.expandLabel.textContent = state.orderExpanded ? "Ocultar" : "Desplegar";
});

els.orderItems.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".pau-item-remove[data-order-item-id]");
  if (!btn) return;
  const itemId = btn.getAttribute("data-order-item-id");
  if (itemId) void handleRemoveOrderItem(itemId);
});

els.phoneYes.addEventListener("click", async () => {
  if (state.pendingPhoneCustomer) {
    await selectCustomer(state.pendingPhoneCustomer);
    state.pendingPhoneCustomer = null;
  }
});

els.phoneNo.addEventListener("click", () => {
  state.pendingPhoneCustomer = null;
  showLandingMode();
});

document.addEventListener("paste", async (e) => {
  const text = e.clipboardData?.getData("text") || "";
  if (!state.customer && text.length > 6) {
    const handled = await handleSharedPhoneText(text);
    if (handled) e.preventDefault();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.order?.id) {
    refreshOrderUi();
    focusScanInput();
  }
});

// Web Share Target / query ?text=
const params = new URLSearchParams(window.location.search);
const sharedText = params.get("text") || params.get("phone") || "";

// Al recargar PAU no debe mantener la clienta/pedido seleccionado:
// se arranca siempre en modo búsqueda, salvo que venga texto compartido
// (Android/WebView wrapper).
localStorage.removeItem(STORAGE.customerId);
localStorage.removeItem(STORAGE.orderId);
localStorage.removeItem(STORAGE.draft);

state.customer = null;
state.order = null;
state.draft = [];
state.pendingPhoneCustomer = null;
state.orderExpanded = false;
state.qrQueue = [];
state.qrProcessing = false;

showLandingMode();
els.customerSearch.value = "";
els.customerResults.innerHTML = "";
els.customerEmpty.hidden = true;

if (sharedText) {
  await handleSharedPhoneText(sharedText);
}

// DEBUG: marca de inicialización completa (lo lee el panel de debug de pau.html)
try { window.__PAU_BOOT_OK__ = true; console.log("✅ pau.js: inicialización completa, listeners activos"); } catch (e) { /* noop */ }
