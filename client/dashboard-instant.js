import { fylDevLog } from "../scripts/config.js";
import { supabase } from "../scripts/supabase-client.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";
import { hasInitialProfileComplete } from "./auth-helper.js";
import { maybeShowProfileOnboardingModal } from "../scripts/profile-onboarding-modal.js";
import { parseARSNumber, resolveOrderItemUnitPrice } from "../scripts/utils/price.js";
import {
  getTransportesDisponibles,
  guardarTransporteElegido,
} from "./transportes-data.js";
import { fylAnalytics } from "../scripts/analytics.js";
import { canonicalizeTransportName } from "../scripts/transport-canonical.js";

let fylDashboardViewOnce = false;
if (typeof window !== "undefined") {
  window.__FYL_DASHBOARD_INSTANT_ACTIVE__ = true;
}

const __dashBootStartTs =
  typeof performance !== "undefined" ? performance.now() : Date.now();
const __dashPerfMarks = {};

function shouldLogDashboardPerf() {
  if (typeof window === "undefined") return false;
  if (window.FYL_DEBUG_DASHBOARD_PERF === true) return true;
  const search = String(window.location?.search || "");
  return /(?:^|[?&])debug=dashboardperf(?:&|$)/.test(search);
}

function markDashboardPerf(stage, data = {}) {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const ms = Math.max(0, Math.round(now - __dashBootStartTs));
  __dashPerfMarks[stage] = ms;
  if (shouldLogDashboardPerf()) {
    console.debug("[perf][dashboard]", stage, `${ms}ms`, data);
  }
}

function flushDashboardPerfSummary(tag = "boot_complete") {
  if (typeof window === "undefined") return;
  const summary = {
    tag,
    ...__dashPerfMarks,
  };
  window.__FYL_DASHBOARD_PERF = summary;
  if (shouldLogDashboardPerf()) {
    console.info("[perf][dashboard] summary", summary);
  }
}

function fylDashboardCartLinesForGa(items) {
  return (items || []).map((it) => ({
    articulo: it.product_name,
    color: it.color,
    talle: it.size,
    cantidad: it.quantity ?? it.qty,
    precio: it.price_snapshot,
    id: it.variant_id || it.id,
  }));
}

const FALLBACK_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' rx='12' fill='%23f2f2f2'/%3E%3Cpath d='M24 88L44 62l12 14 16-22 24 34H24z' fill='none' stroke='%23cd844d' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='46' cy='42' r='10' fill='%23cd844d' opacity='0.35'/%3E%3Ctext x='60' y='108' fill='%23777' font-family='Poppins,Arial,sans-serif' font-size='12' text-anchor='middle'%3ESin imagen%3C/text%3E%3C/svg%3E";
const GUEST_AVATAR_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 24 24' fill='none' stroke='%23CD844D' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='8' r='4'/%3E%3Cpath d='M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'/%3E%3C/svg%3E";

function setUserAvatarWithFallback(userAvatar, displayName, primaryUrl) {
  if (!userAvatar) return;
  const safeName = displayName || "Usuario";
  const uiAvatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(
    safeName
  )}&background=CD844D&color=fff&size=96`;

  userAvatar.onerror = () => {
    if (userAvatar.src !== uiAvatarUrl) {
      userAvatar.src = uiAvatarUrl;
      return;
    }
    userAvatar.onerror = null;
    userAvatar.src = GUEST_AVATAR_ICON;
  };
  userAvatar.src = primaryUrl || uiAvatarUrl;
  userAvatar.alt = `Avatar de ${safeName}`;
}

/** Colores largos en títulos compactos: primeras 5 letras + ".." (ej. Chocolate → Choco..) */
function abbreviateColorLabel(raw) {
  const s = String(raw ?? "").trim();
  if (s.length <= 5) return s;
  return s.slice(0, 5) + "..";
}

/**
 * Inserción segura: `referenceNode` debe ser hijo directo de `parent`.
 * Evita "The node before which the new node is to be inserted is not a child of this node."
 */
function safeInsertBefore(parent, newNode, referenceNode, fallback = "append") {
  if (!parent || !newNode) return;
  if (referenceNode && referenceNode.parentNode === parent) {
    parent.insertBefore(newNode, referenceNode);
    return;
  }
  if (referenceNode) {
    console.warn("[dashboard] safeInsertBefore fallback", { parent, referenceNode });
  }
  if (fallback === "prepend") {
    parent.prepend(newNode);
  } else {
    parent.appendChild(newNode);
  }
}

// PDP real del catálogo usa hash route: index.html#/pdp/<SKU>
const __variantSkuCache = new Map(); // variant_id -> sku (string)
/** Precio de catálogo por variante (para corregir price_snapshot corrupto en pedidos) */
const __variantPriceCache = new Map(); // variant_id string -> raw price from DB
const DASH_WAREHOUSE_CACHE_TTL_MS = 10 * 60 * 1000;
const DASH_IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const DASH_VARIANT_INFO_CACHE_TTL_MS = 20 * 1000;
const __dashImageCache = new Map(); // key -> { value, until }
const __dashImageInFlight = new Map(); // key -> Promise<string>
const __dashVariantInfoCache = new Map(); // key -> { value, until }
const __dashVariantInfoInFlight = new Map(); // key -> Promise<object|null>
const __dashWarehouseCache = {
  value: null,
  until: 0,
  promise: null,
};
const DASHBOARD_SCROLL_TO_BAG_ONCE_KEY = "fyl_dashboard_scroll_to_bag_once";

function getCachedMapValue(cacheMap, key) {
  const entry = cacheMap.get(key);
  if (!entry) return undefined;
  if (entry.until <= Date.now()) {
    cacheMap.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCachedMapValue(cacheMap, key, value, ttlMs) {
  cacheMap.set(key, {
    value,
    until: Date.now() + Math.max(1000, Number(ttlMs) || 1000),
  });
  return value;
}

function buildCatalogImageCacheKey(articulo, color) {
  const a = String(articulo || "").trim();
  const c = String(color || "").trim();
  return `${a}__${c}`;
}

function buildVariantInfoCacheKey(articulo, color, talle, variantId = null) {
  const vid = variantId != null && variantId !== "" ? String(variantId).trim() : "";
  const a = String(articulo || "").trim();
  const c = String(color || "Único").trim();
  const s = normalizeSize(talle) || String(talle || "").trim();
  return vid ? `vid:${vid}__sz:${s}` : `row:${a}__${c}__${s}`;
}

function clearDashboardVariantInfoCaches() {
  __dashVariantInfoCache.clear();
  __dashVariantInfoInFlight.clear();
}

function maybeAutoScrollToBagFromStickyCart() {
  try {
    if (sessionStorage.getItem(DASHBOARD_SCROLL_TO_BAG_ONCE_KEY) !== "1") return;
    sessionStorage.removeItem(DASHBOARD_SCROLL_TO_BAG_ONCE_KEY);
  } catch (_e) {
    return;
  }

  // Solo aplicar cuando hay muchos productos en "Mi pedido" (aparece "Ver todo el pedido").
  const hasOrderExpandToggle = !!document.querySelector("#orders-section .dash-order__list-toggle");
  if (!hasOrderExpandToggle) return;

  const bagSection = document.getElementById("section-bag");
  if (!bagSection) return;

  requestAnimationFrame(() => {
    bagSection.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function getDashboardWarehouseIdsCached(options = {}) {
  const forceFresh = options.forceFresh === true;
  const now = Date.now();
  if (!forceFresh && __dashWarehouseCache.value && __dashWarehouseCache.until > now) {
    return __dashWarehouseCache.value;
  }
  if (!forceFresh && __dashWarehouseCache.promise) {
    return __dashWarehouseCache.promise;
  }

  const requestPromise = (async () => {
    const { data: whs } = await supabase
      .from("warehouses")
      .select("id, code")
      .in("code", ["general", "venta-publico"]);
    const whMap = new Map((whs || []).map((w) => [w.code, w.id]));
    const resolved = {
      generalId: whMap.get("general") || null,
      ventaId: whMap.get("venta-publico") || null,
    };
    __dashWarehouseCache.value = resolved;
    __dashWarehouseCache.until = Date.now() + DASH_WAREHOUSE_CACHE_TTL_MS;
    return resolved;
  })();

  __dashWarehouseCache.promise = requestPromise;
  try {
    return await requestPromise;
  } finally {
    __dashWarehouseCache.promise = null;
  }
}

function orderItemUnitForDisplay(item) {
  const vid =
    item?.variant_id != null ? String(item.variant_id).trim() : "";
  const pvRaw = vid ? __variantPriceCache.get(vid) : undefined;
  return resolveOrderItemUnitPrice(item?.price_snapshot, pvRaw);
}

function buildCatalogPdpHrefFromSku(sku) {
  if (!sku) return "";
  return `../index.html#/pdp/${encodeURIComponent(String(sku).trim())}`;
}

function buildCatalogFallbackHrefFromProductName(productName) {
  const name = String(productName || "").trim();
  return `../index.html?articulo=${encodeURIComponent(name)}`;
}

function buildCatalogHrefFromVariantOrName(variantId, productName) {
  const vid = variantId != null ? String(variantId).trim() : "";
  const sku = vid ? __variantSkuCache.get(vid) : null;
  if (sku) return buildCatalogPdpHrefFromSku(sku);
  return buildCatalogFallbackHrefFromProductName(productName);
}

async function ensureVariantSkusLoaded(variantIds = []) {
  if (!supabase) return;
  const ids = Array.from(new Set((variantIds || []).map((v) => String(v || "").trim()).filter(Boolean)));
  const missing = ids.filter(
    (id) => !__variantSkuCache.has(id) || !__variantPriceCache.has(id)
  );
  if (missing.length === 0) return;

  const { data, error } = await supabase
    .from("product_variants")
    .select("id, sku, price")
    .in("id", missing);

  if (error) {
    console.warn("No se pudieron cargar SKU de variantes:", error.message || error);
    return;
  }
  (data || []).forEach((row) => {
    const id = row?.id != null ? String(row.id).trim() : "";
    const sku = row?.sku != null ? String(row.sku).trim() : "";
    if (id) {
      __variantSkuCache.set(id, sku || "");
      if (row?.price != null && row.price !== "") {
        __variantPriceCache.set(id, row.price);
      } else {
        __variantPriceCache.set(id, null);
      }
    }
  });
}

function normalizeGuestCartStorageItems(items = []) {
  const map = new Map();

  items.forEach((item) => {
    const articulo = String(item?.articulo || item?.product_name || "Producto").trim();
    const color = String(item?.color || "Color único").trim();
    const rawSize = item?.talle || item?.size || "Talle único";
    const talle = normalizeSize(rawSize) || String(rawSize || "Talle único").trim();
    const qty = Number(item?.cantidad ?? item?.quantity ?? item?.qty ?? 0) || 0;
    const price = parseARSNumber(item?.precio ?? item?.price_snapshot ?? 0);
    if (qty <= 0) return;

    const key = `${articulo}__${color}__${talle}`;
    if (!map.has(key)) {
      map.set(key, {
        articulo,
        color,
        talle,
        cantidad: qty,
        precio: price,
        imagen: item?.imagen || FALLBACK_IMAGE,
      });
      return;
    }

    const existing = map.get(key);
    const existingQty = Number(existing.cantidad) || 0;
    // Guest safety: same line repeated in storage should not keep inflating.
    if (qty > existingQty) {
      existing.cantidad = qty;
    }
    if (!existing.imagen && item?.imagen) existing.imagen = item.imagen;
    if (!existing.precio && price) existing.precio = price;
  });

  return Array.from(map.values());
}

let cartSyncedListenerRegistered = false;
let cartActionsInitialized = false;
let historyControlsInitialized = false;
let accountSheetControlsInitialized = false;
let modalControlsInitialized = false;
let historyVisible = false;
const HISTORY_NOTIFICATION_KEY = "fyl_dashboard_history_notification";
let currentUserId = null;
let currentCartId = null;
let currentCartItems = [];
const currentOrderUiStateById = new Map();
let ordersRealtimeSubscription = null;
let ordersRealtimeSetupPromise = null;
let ordersRealtimeActiveUserId = null;
let ordersRealtimeRetryTimeoutId = null;
let isSubmittingCurrentCart = false;

// ─── Sprint 3: idempotencia fuerte en checkout ────────────────────────────────
// operation_id persiste entre intentos del mismo intento de checkout para que
// un retry tras error de red obtenga el resultado idempotente del servidor.
// Se resetea en éxito o cuando el fingerprint cambió (operation_id_conflict).
let _checkoutOperationId = null;

function generateOperationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildCartFingerprint(items) {
  if (!Array.isArray(items) || !items.length) return "empty";
  const lines = items
    .map((item) => ({
      vid: String(item?.variant_id || "").trim(),
      sz: String(item?.size || item?.talle || "").trim().toLowerCase(),
      qty: Number(item?.quantity ?? item?.cantidad ?? item?.qty ?? 0),
      price: Number(item?.price_snapshot ?? item?.precio ?? item?.price ?? 0),
    }))
    .sort((a, b) => {
      const k1 = `${a.vid}|${a.sz}`;
      const k2 = `${b.vid}|${b.sz}`;
      return k1 < k2 ? -1 : k1 > k2 ? 1 : 0;
    });
  // djb2: hash ligero y determinista (no criptográfico, solo fingerprint)
  const raw = JSON.stringify(lines);
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = (((h << 5) + h) + raw.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
// ─────────────────────────────────────────────────────────────────────────────

const closeOrderInFlight = new Set();
let pendingCheckoutOrderFeedback = null;
const pendingCloseOrderFeedbackById = new Map();

const DASH_FX_DURATION_MS = 220;
const ORDER_COMPLETE_ANIMATION_TOTAL_MS = 1120;

/** Días hasta desarme del pedido (alineado a dismantle_at en checkout / mantenimiento). */
const ORDER_DISMANTLE_DAYS = 7;
const MIN_UNITS_TO_FINALIZE = 4;
const ORDERS_REALTIME_DEBOUNCE_MS = 320;
const ORDERS_REALTIME_RETRY_MS = 2000;
const ORDERS_MAINTENANCE_MIN_INTERVAL_MS = 60 * 1000;
const DASH_ENABLE_ORDERS_MAINTENANCE =
  typeof window !== "undefined" && window.FYL_ENABLE_ORDERS_MAINTENANCE === true;

let lastOrderDeadlineReminderContext = null;
let lastOrderExpiredPendingDisassemblyContext = null;
let lastOrdersMaintenanceAtMs = 0;
let ordersMaintenanceRpcAvailable = true;
let ordersRefreshTimerId = null;
let ordersRefreshInFlight = null;
let ordersRefreshPending = false;
let ordersRefreshPendingIncludeClosed = false;
let knownOrderIdsByCurrentUser = new Set();

function clearOrdersRealtimeRetryTimer() {
  if (!ordersRealtimeRetryTimeoutId) return;
  clearTimeout(ordersRealtimeRetryTimeoutId);
  ordersRealtimeRetryTimeoutId = null;
}

function scheduleOrdersRealtimeReconnect(userId, reason) {
  if (!userId) return;
  clearOrdersRealtimeRetryTimer();
  ordersRealtimeRetryTimeoutId = setTimeout(() => {
    ordersRealtimeRetryTimeoutId = null;
    if (!currentUserId || currentUserId !== userId) return;
    fylDevLog(`🔁 Reintentando suscripción realtime (${reason || "unknown"})`);
    setupOrdersRealtimeSubscription(userId);
  }, ORDERS_REALTIME_RETRY_MS);
}

function replaceKnownOrderIds(ordersRows = []) {
  const next = new Set();
  for (const row of ordersRows || []) {
    const oid = row?.id;
    if (oid) next.add(oid);
  }
  knownOrderIdsByCurrentUser = next;
}

function rememberKnownOrderId(orderId) {
  if (!orderId) return;
  knownOrderIdsByCurrentUser.add(orderId);
}

function forgetKnownOrderId(orderId) {
  if (!orderId) return;
  knownOrderIdsByCurrentUser.delete(orderId);
}

function shouldRunOrdersMaintenance(forceRun = false) {
  const now = Date.now();
  if (forceRun || now - lastOrdersMaintenanceAtMs >= ORDERS_MAINTENANCE_MIN_INTERVAL_MS) {
    lastOrdersMaintenanceAtMs = now;
    return true;
  }
  return false;
}

async function runScheduledOrdersRefresh() {
  if (ordersRefreshInFlight || !ordersRefreshPending || !currentUserId) return;

  const userId = currentUserId;
  const includeClosedOrders = ordersRefreshPendingIncludeClosed;
  ordersRefreshPending = false;
  ordersRefreshPendingIncludeClosed = false;

  ordersRefreshInFlight = (async () => {
    try {
      await loadOrders(userId, { source: "realtime" });
      if (includeClosedOrders) {
        const modal = document.getElementById("previous-orders-modal");
        if (modal && modal.classList.contains("active")) {
          await loadClosedOrders(userId);
        }
      }
    } finally {
      ordersRefreshInFlight = null;
      if (ordersRefreshPending && currentUserId) {
        scheduleOrdersRefresh({
          userId: currentUserId,
          immediate: true,
          includeClosedOrders: ordersRefreshPendingIncludeClosed,
          reason: "flush-pending",
        });
      }
    }
  })();

  return ordersRefreshInFlight;
}

function scheduleOrdersRefresh({
  userId = currentUserId,
  immediate = false,
  includeClosedOrders = false,
  reason = "unknown",
} = {}) {
  if (!userId || !currentUserId || userId !== currentUserId) return;

  ordersRefreshPending = true;
  if (includeClosedOrders) ordersRefreshPendingIncludeClosed = true;

  if (ordersRefreshTimerId) {
    clearTimeout(ordersRefreshTimerId);
    ordersRefreshTimerId = null;
  }

  const delay = immediate ? 0 : ORDERS_REALTIME_DEBOUNCE_MS;
  ordersRefreshTimerId = setTimeout(() => {
    ordersRefreshTimerId = null;
    runScheduledOrdersRefresh();
  }, delay);

  fylDevLog(`🔄 Refresh pedidos programado (${reason})`);
}

function orderDaysRemaining(createdAtIso, dismantleAtIso) {
  const oneDayMs = 1000 * 60 * 60 * 24;
  const now = Date.now();
  if (dismantleAtIso) {
    const t = new Date(dismantleAtIso).getTime();
    if (!Number.isNaN(t)) {
      return Math.max(0, Math.ceil((t - now) / oneDayMs));
    }
  }
  const created = new Date(createdAtIso).getTime();
  const daysElapsed = Math.floor((now - created) / oneDayMs);
  return Math.max(0, ORDER_DISMANTLE_DAYS - daysElapsed);
}

function getOrderNonCancelledItems(order) {
  const items = Array.isArray(order?.order_items) ? order.order_items : [];
  return items.filter((item) => String(item?.status || "").toLowerCase().trim() !== "cancelled");
}

function isOrderStillVisibleInMyOrder(order) {
  const status = String(order?.status || "").toLowerCase().trim();
  return status === "active" || status === "closing_soon" || status === "closed";
}

function hasOrderPassedCustomerEditWindow(order) {
  const nowMs = Date.now();
  const dismantleAtMs = order?.dismantle_at ? new Date(order.dismantle_at).getTime() : NaN;
  if (Number.isFinite(dismantleAtMs)) {
    return nowMs >= dismantleAtMs;
  }
  const createdAtMs = order?.created_at ? new Date(order.created_at).getTime() : NaN;
  if (!Number.isFinite(createdAtMs)) return false;
  const daysElapsed = (nowMs - createdAtMs) / (1000 * 60 * 60 * 24);
  return daysElapsed >= ORDER_DISMANTLE_DAYS;
}

function isOrderCompletelyDisassembledByAdmin(order) {
  const operationalStatuses = new Set(["reserved", "picked", "waiting", "missing"]);
  const nonCancelledItems = getOrderNonCancelledItems(order);
  if (nonCancelledItems.length === 0) return true;
  const hasOperationalItems = nonCancelledItems.some((item) =>
    operationalStatuses.has(String(item?.status || "").toLowerCase().trim())
  );
  return !hasOperationalItems;
}

function isOrderExpiredPendingAdminDisassembly(order) {
  if (!order) return false;
  if (!hasOrderPassedCustomerEditWindow(order)) return false;
  if (!isOrderStillVisibleInMyOrder(order)) return false;
  const nonCancelledItems = getOrderNonCancelledItems(order);
  if (nonCancelledItems.length === 0) return false;
  if (isOrderCompletelyDisassembledByAdmin(order)) return false;
  return true;
}

function deriveOrderUiState(order) {
  const isExpiredPendingDisassembly = isOrderExpiredPendingAdminDisassembly(order);
  return {
    isExpiredPendingDisassembly,
    isReadOnly: isExpiredPendingDisassembly,
    canEdit: !isExpiredPendingDisassembly,
    canContactWhatsApp: isExpiredPendingDisassembly,
  };
}

function getOrderUiState(orderId) {
  if (!orderId) return null;
  return currentOrderUiStateById.get(orderId) || null;
}

function resolveOrderIdFromElement(triggerEl, fallbackOrderId = "") {
  if (fallbackOrderId) return fallbackOrderId;
  const card = triggerEl?.closest?.(".dash-order");
  return card?.dataset?.orderId || "";
}

function showReadOnlyOrderBlockedMessage() {
  const message =
    "Este pedido está vencido y en proceso de desarme. Escribinos por WhatsApp para ayudarte.";
  if (typeof window.showToast === "function") {
    window.showToast(message, "info");
    return;
  }
  alert(message);
}

function guardReadOnlyOrderAction({ triggerEl = null, orderId = "" } = {}) {
  const resolvedOrderId = resolveOrderIdFromElement(triggerEl, orderId);
  const uiState = getOrderUiState(resolvedOrderId);
  if (!uiState?.isReadOnly) return false;
  showReadOnlyOrderBlockedMessage();
  return true;
}

function hasExpiredPendingDisassemblyOrderInView() {
  for (const state of currentOrderUiStateById.values()) {
    if (state?.isExpiredPendingDisassembly) return true;
  }
  const domCard = document.querySelector(
    ".dash-order[data-order-expired-pending-disassembly='true']"
  );
  return !!domCard;
}

async function showOrderExpiredCartSubmitBlockedModal() {
  const bodyHtml = `
    <p class="dash-app-message-modal__text">Tu pedido alcanzó el plazo de 7 días y ya no podés hacer un nuevo pedido desde la web.</p>
    <p class="dash-app-message-modal__text">Si querés que lo preparemos o tenés dudas, escribinos por <a href="${WHATSAPP_ENVIOS_HREF}" target="_blank" rel="noopener noreferrer">WhatsApp</a> y te ayudamos.</p>
  `;
  await showDashboardMessageModal({
    title: "Pedido cerrado por vencimiento",
    bodyHtml,
    confirmLabel: "Entendido",
  });
}

function buildSyntheticDeadlineNotificationsList(ctx) {
  if (!ctx || ctx.daysRemaining == null) return [];
  const dr = ctx.daysRemaining;
  if (dr !== 1 && dr !== 2) return [];
  const tier = dr === 2 ? 5 : 6;
  const hasMin = !!ctx.hasMinimum;
  const x = ctx.missingForFinalize;
  let message = "";
  if (tier === 5) {
    message = hasMin
      ? "Faltan 2 días para que se cierre tu pedido. Finalizalo cuando quieras para que lo preparemos y enviemos."
      : `Faltan 2 días para que se cierre tu pedido.<br>Te faltan ${x} productos para alcanzar el mínimo y poder enviarlo.`;
  } else {
    message = hasMin
      ? "Tu pedido se cierra mañana.<br>Finalizalo hoy para asegurarte el envío."
      : `Tu pedido se cierra mañana.<br>Te faltan ${x} productos para alcanzar el mínimo.<br>Si no lo completás, el pedido se desarmará.`;
  }
  const sortTs = ctx.dismantleAtIso || ctx.createdAtIso || new Date().toISOString();
  return [
    {
      id: `synthetic-order-deadline-${ctx.orderId}-${tier}`,
      type: "ORDER_DEADLINE_REMINDER",
      message,
      read: false,
      created_at: sortTs,
      payload: { action_url: "dashboard.html#section-active-order" },
    },
  ];
}

function buildSyntheticExpiredPendingDisassemblyNotificationsList(ctx) {
  if (!ctx?.orderId) return [];
  const sortTs = ctx.dismantleAtIso || ctx.createdAtIso || new Date().toISOString();
  return [
    {
      id: `synthetic-order-expired-pending-disassembly-${ctx.orderId}`,
      type: "ORDER_EXPIRED_PENDING_DISASSEMBLY",
      message:
        "Tu pedido alcanzó el plazo de 7 días. Ya no se puede editar desde la web y está pendiente de desarme por administración.",
      read: false,
      created_at: sortTs,
      payload: { action_url: "dashboard.html#section-active-order" },
    },
  ];
}

function syncOrderDeadlineSyntheticNotifications() {
  try {
    window.__fylGetSyntheticNotifications = () => [
      ...buildSyntheticExpiredPendingDisassemblyNotificationsList(
        lastOrderExpiredPendingDisassemblyContext
      ),
      ...buildSyntheticDeadlineNotificationsList(lastOrderDeadlineReminderContext),
    ];
    window.dispatchEvent(new CustomEvent("fyl-synthetic-notifications-changed"));
  } catch (_) {
    /* ignore */
  }
}

function clearOrderDeadlineSyntheticNotifications() {
  lastOrderDeadlineReminderContext = null;
  lastOrderExpiredPendingDisassemblyContext = null;
  try {
    window.__fylGetSyntheticNotifications = () => [];
    window.dispatchEvent(new CustomEvent("fyl-synthetic-notifications-changed"));
  } catch (_) {
    /* ignore */
  }
}

const ORDER_DISMANTLED_TIMEOUT_NOTIFICATION_TYPE = "ORDER_DISMANTLED_TIMEOUT";
const DISMANTLED_TIMEOUT_MODAL_SEEN_IDS_KEY = "fyl_dashboard_dismantled_seen_ids_v1";

function getSeenDismantledTimeoutNotificationIds() {
  try {
    const raw = window.localStorage.getItem(DISMANTLED_TIMEOUT_MODAL_SEEN_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((id) => String(id || "").trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function persistSeenDismantledTimeoutNotificationIds(idsSet) {
  try {
    const arr = Array.from(idsSet || []).map((id) => String(id || "").trim()).filter(Boolean);
    window.localStorage.setItem(DISMANTLED_TIMEOUT_MODAL_SEEN_IDS_KEY, JSON.stringify(arr));
  } catch (_) {
    /* ignore */
  }
}

async function maybeShowDismantledTimeoutNoticeModal(userId) {
  if (!userId || !supabase) return;
  const seenIds = getSeenDismantledTimeoutNotificationIds();

  const { data, error } = await supabase
    .from("customer_notifications")
    .select("id, type, message, created_at")
    .eq("customer_id", userId)
    .eq("type", ORDER_DISMANTLED_TIMEOUT_NOTIFICATION_TYPE)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error || !Array.isArray(data) || data.length === 0) return;

  const unseen = data.find((row) => !seenIds.has(String(row?.id || "").trim()));
  if (!unseen) return;

  const bodyHtml = `
    <p class="dash-app-message-modal__text">Tu pedido fue desarmado porque alcanzó el tiempo límite de edición.</p>
    <p class="dash-app-message-modal__text">Si querés, podés volver a armar uno nuevo ahora mismo.</p>
    <div style="margin-top:12px;">
      <a href="/index.html" class="btn btn-primary" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none;">Ir al catálogo</a>
    </div>
  `;
  await showDashboardMessageModal({
    title: "Pedido desarmado por vencimiento",
    bodyHtml,
    confirmLabel: "Entendido",
  });

  seenIds.add(String(unseen.id || "").trim());
  persistSeenDismantledTimeoutNotificationIds(seenIds);
}

fylDevLog("dashboard-instant.js cargado");

function prefersReducedMotion() {
  try {
    return !!window.matchMedia("(prefers-reduced-motion: reduce)")?.matches;
  } catch (_) {
    return false;
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTransitionEnd(el, fallbackMs = DASH_FX_DURATION_MS + 120) {
  return new Promise((resolve) => {
    if (!el || prefersReducedMotion()) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (evt) => {
      if (evt.target === el) {
        finish();
      }
    };
    el.addEventListener("transitionend", onEnd);
    setTimeout(finish, fallbackMs);
  });
}

function setButtonLoading(button, loadingText) {
  if (!button) return () => {};
  const prevText = button.textContent;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.classList.add("is-loading");
  if (loadingText) {
    button.textContent = loadingText;
  }
  return () => {
    button.classList.remove("is-loading");
    button.disabled = wasDisabled;
    button.textContent = prevText;
  };
}

function clearCartTransientState() {
  const bagSection = document.getElementById("section-bag");
  if (bagSection) bagSection.classList.remove("dash-fx-pending");
  document
    .querySelectorAll("#section-bag .dash-bolsa-item.dash-fx-leave, #section-bag #cart-info.dash-fx-leave")
    .forEach((el) => el.classList.remove("dash-fx-leave"));
}

async function runCartExitTransition() {
  const bagSection = document.getElementById("section-bag");
  const cartInfo = document.getElementById("cart-info");
  if (!bagSection || !cartInfo || prefersReducedMotion()) return;

  const rows = Array.from(cartInfo.querySelectorAll(".dash-bolsa-item"));
  if (rows.length === 0) return;

  await nextFrame();

  // Evitar animación pesada cuando hay muchos items.
  if (rows.length <= 2) {
    rows.forEach((row) => row.classList.add("dash-fx-leave"));
    await Promise.all(rows.map((row) => waitForTransitionEnd(row)));
    return;
  }

  cartInfo.classList.add("dash-fx-leave");
  await waitForTransitionEnd(cartInfo);
}

function clearOrderInlineFeedback() {
  document.querySelectorAll(".dash-order-inline-feedback").forEach((node) => node.remove());
}

function clearOrderVisualTransientState() {
  document
    .querySelectorAll(".dash-order.dash-fx-highlight, .dash-order.dash-fx-pulse-soft, .dash-order.dash-order--finalized, .dash-order.is-finalizing")
    .forEach((card) => {
      card.classList.remove("dash-fx-highlight", "dash-fx-pulse-soft", "dash-order--finalized", "is-finalizing");
    });
  clearOrderInlineFeedback();
}

function insertInlineOrderFeedback(orderCard, opts) {
  if (!orderCard || !opts?.message) return;
  const previous = orderCard.querySelector(".dash-order-inline-feedback");
  if (previous) previous.remove();

  const feedback = document.createElement("div");
  feedback.className = "dash-order-inline-feedback";
  if (opts.kind === "close-success") {
    feedback.classList.add("is-finalized");
  }
  const chipClass =
    opts.kind === "close-success"
      ? "dash-order-header-chip dash-order-header-chip--preparing"
      : "dash-order-header-chip dash-order-header-chip--state";
  feedback.innerHTML = `
    <div class="dash-order-inline-feedback__line">
      <span class="${chipClass}">${opts.chipText || ""}</span>
      <span class="dash-order-inline-feedback__text">${opts.message}</span>
    </div>
  `;

  const insertAfterNode = orderCard.querySelector(".dash-order__head--compact");
  if (insertAfterNode) {
    const headParent = insertAfterNode.parentNode;
    if (headParent) {
      safeInsertBefore(headParent, feedback, insertAfterNode.nextSibling, "append");
    } else {
      safeInsertBefore(orderCard, feedback, null, "append");
    }
  } else {
    safeInsertBefore(orderCard, feedback, null, "prepend");
  }
}

function bindInlineFeedbackCleanup(ordersSection) {
  if (!ordersSection || ordersSection.dataset.inlineFeedbackCleanupBound === "true") return;
  const clearHandler = () => clearOrderInlineFeedback();
  ordersSection.addEventListener("click", clearHandler);
  ordersSection.addEventListener("change", clearHandler);
  ordersSection.dataset.inlineFeedbackCleanupBound = "true";
}

function applyPendingOrderFeedback(ordersSection) {
  if (!ordersSection) return;
  bindInlineFeedbackCleanup(ordersSection);

  const cards = Array.from(ordersSection.querySelectorAll(".dash-order[data-order-id]"));
  if (cards.length === 0) return;

  if (pendingCheckoutOrderFeedback) {
    const targetCard = cards[0];
    if (targetCard) {
      targetCard.classList.add("dash-fx-highlight");
      insertInlineOrderFeedback(targetCard, pendingCheckoutOrderFeedback);
    }
    pendingCheckoutOrderFeedback = null;
  }

  pendingCloseOrderFeedbackById.forEach((feedback, orderId) => {
    const targetCard = ordersSection.querySelector(`.dash-order[data-order-id="${CSS.escape(orderId)}"]`);
    if (!targetCard) return;
    targetCard.classList.add("dash-order--finalized");
    const finalizeBtn = targetCard.querySelector(".close-order-btn");
    if (finalizeBtn) {
      finalizeBtn.disabled = true;
      finalizeBtn.classList.add("dash-fx-hidden");
    }
    const modifyLink = targetCard.querySelector(`.dash-order-modify-link[data-order-id="${CSS.escape(orderId)}"]`);
    if (modifyLink) {
      requestAnimationFrame(() => {
        modifyLink.classList.add("is-visible");
      });
    }
    pendingCloseOrderFeedbackById.delete(orderId);
  });
}

function hideLoader() {
  const loader = document.getElementById("loader");
  if (document.body) {
    document.body.classList.remove("dashboard-loading");
  }
  if (loader) {
    loader.style.display = "none";
    loader.style.visibility = "hidden";
    loader.style.opacity = "0";
    loader.style.position = "absolute";
    loader.style.left = "-9999px";
  }
  document.querySelectorAll(".spinner").forEach((spinner) => {
    spinner.style.display = "none";
  });
}

function setHistoryNotificationVisible(visible) {
  const toggleBtn = document.getElementById("toggle-history-btn");
  if (toggleBtn) {
    toggleBtn.classList.toggle("has-notification", !!visible);
  }
  try {
    if (visible) {
      window.localStorage.setItem(HISTORY_NOTIFICATION_KEY, "1");
    } else {
      window.localStorage.removeItem(HISTORY_NOTIFICATION_KEY);
    }
  } catch (_) {
    /* ignore storage */
  }
}

function syncHistoryNotificationFromStorage() {
  try {
    const visible = window.localStorage.getItem(HISTORY_NOTIFICATION_KEY) === "1";
    const toggleBtn = document.getElementById("toggle-history-btn");
    if (toggleBtn) {
      toggleBtn.classList.toggle("has-notification", visible);
    }
  } catch (_) {
    /* ignore storage */
  }
}

function showContent() {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (!dashboardContent) return;
    dashboardContent.innerHTML = `
      <div class="cart-section">
        <h2 class="section-title">ðŸ›’ Carrito Actual</h2>
        <div id="cart-info">
          <p>Verificando información del carrito...</p>
        </div>
      <div id="cart-actions" class="cart-actions" style="display:none; gap:12px; margin-top:16px; flex-wrap:wrap;">
        <button id="submit-cart-btn" class="btn">Enviar mi pedido</button>
        <button id="clear-cart-btn" class="btn btn-secondary">Limpiar Carrito</button>
      </div>
      </div>
      <div class="orders-section">
        <h2 class="section-title">ðŸ“‹ Mis Pedidos</h2>
        <div id="orders-section">
          <p>Verificando historial de pedidos...</p>
        </div>
      <button id="toggle-history-btn" class="btn btn-secondary" style="margin-top:12px;">Ver pedidos anteriores</button>
      </div>
    `;
  historyControlsInitialized = false;
  modalControlsInitialized = false;
  historyVisible = false;
}

function setContentVisibility(isVisible) {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (!dashboardContent) return;
  if (isVisible) {
    dashboardContent.style.visibility = "visible";
    dashboardContent.style.opacity = "1";
  } else {
    dashboardContent.style.visibility = "hidden";
    dashboardContent.style.opacity = "0";
  }
}

// FunciÃ³n para obtener variant_id basado en product_name, color y size
async function findVariantIdForItem(productName, color, size, variantId = null) {
  if (variantId) return variantId;
  if (!productName || !color || !size) return null;
  
  try {
    const { data: productData } = await supabase
      .from('products')
      .select('id')
      .eq('name', productName)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    
    if (!productData) return null;
    
    const { data: variantData } = await supabase
      .from('product_variants')
      .select('id')
      .eq('product_id', productData.id)
      .eq('color', color)
      .eq('size', size)
      .eq('active', true)
      .limit(1)
      .maybeSingle();
    
    return variantData?.id || null;
  } catch (error) {
    console.error('Error buscando variant_id:', error);
    return null;
  }
}

// FunciÃ³n para obtener ofertas y promociones para items
async function getOffersAndPromotionsForItems(items) {
  if (!items || items.length === 0) {
    return { itemOffers: new Map(), itemPromos: new Map(), totalDiscount: 0 };
  }

  const normalizeText = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const variantIds = [];
  const itemVariantMap = new Map();
  const itemMetaByKey = new Map();
  const productNames = new Set();

  for (const item of items) {
    const itemKey = item.id || `${item.product_name}-${item.color}-${item.size}`;
    const productName = String(item.product_name || item.articulo || "").trim();
    const color = String(item.color || "").trim();
    const size = String(item.size || item.talle || "").trim();
    const variantId =
      item.variant_id != null && item.variant_id !== "" ? String(item.variant_id).trim() : "";

    if (productName) productNames.add(productName);
    itemMetaByKey.set(itemKey, { item, productName, color, size, variantId });

    if (variantId) {
      variantIds.push(variantId);
      if (!itemVariantMap.has(variantId)) {
        itemVariantMap.set(variantId, []);
      }
      itemVariantMap.get(variantId).push(item);
    }
  }

  const productIdByName = new Map();
  const productNamesList = Array.from(productNames);
  if (productNamesList.length > 0) {
    const { data: productsData, error: productsError } = await supabase
      .from("products")
      .select("id,name")
      .in("name", productNamesList)
      .eq("status", "active");
    if (productsError) {
      console.warn("⚠️ Error cargando productos para ofertas/promos:", productsError.message || productsError);
    } else {
      (productsData || []).forEach((row) => {
        const name = String(row?.name || "").trim();
        if (name) productIdByName.set(name, row.id);
      });
    }
  }

  const productIds = Array.from(new Set(Array.from(productIdByName.values()).filter(Boolean)));
  if (productIds.length > 0) {
    const { data: variantsData, error: variantsError } = await supabase
      .from("product_variants")
      .select("id,product_id,color,size")
      .in("product_id", productIds)
      .eq("active", true);
    if (!variantsError && variantsData) {
      const variantByKey = new Map();
      variantsData.forEach((row) => {
        const key = `${row.product_id}|${normalizeText(row.color)}|${normalizeSize(row.size) || normalizeText(row.size)}`;
        if (!variantByKey.has(key)) variantByKey.set(key, String(row.id));
      });
      itemMetaByKey.forEach((meta) => {
        if (meta.variantId) return;
        const productId = productIdByName.get(meta.productName);
        if (!productId) return;
        const vKey = `${productId}|${normalizeText(meta.color)}|${normalizeSize(meta.size) || normalizeText(meta.size)}`;
        const foundVariantId = variantByKey.get(vKey);
        if (!foundVariantId) return;
        meta.variantId = foundVariantId;
        variantIds.push(foundVariantId);
        if (!itemVariantMap.has(foundVariantId)) {
          itemVariantMap.set(foundVariantId, []);
        }
        itemVariantMap.get(foundVariantId).push(meta.item);
      });
    }
  }

  const uniqueVariantIds = Array.from(new Set(variantIds.filter(Boolean)));
  const promotions =
    uniqueVariantIds.length > 0
      ? (await supabase
          .rpc("get_active_promotions_for_variants", {
            p_variant_ids: uniqueVariantIds,
          })
          .then(({ data, error }) => {
            if (error) return [];
            return data || [];
          })
          .catch(() => []))
      : [];

  const itemOffersMap = new Map();
  const itemPromosMap = new Map();

  // Procesar promociones (tienen prioridad)
  for (const promo of promotions) {
    const variantIdsInPromo = promo.variant_ids || [];
    const promoText = promo.promo_type === "2x1"
      ? "2x1"
      : promo.promo_type === "2xMonto" && promo.fixed_amount
      ? `2x$${promo.fixed_amount}`
      : null;

    if (promoText) {
      for (const variantId of variantIdsInPromo) {
        const itemsInPromo = itemVariantMap.get(String(variantId)) || [];
        for (const item of itemsInPromo) {
          itemPromosMap.set(item.id || `${item.product_name}-${item.color}-${item.size}`, promoText);
        }
      }
    }
  }

  const latestOfferByProductColor = new Map();
  if (productIds.length > 0) {
    const today = new Date().toISOString().split("T")[0];
    const { data: offersData, error: offersError } = await supabase
      .from("color_price_offers")
      .select("product_id,color,offer_price,created_at")
      .in("product_id", productIds)
      .eq("status", "active")
      .lte("start_date", today)
      .gte("end_date", today);
    if (!offersError && offersData) {
      offersData.forEach((offer) => {
        const oKey = `${offer.product_id}|${normalizeText(offer.color)}`;
        const prev = latestOfferByProductColor.get(oKey);
        if (!prev) {
          latestOfferByProductColor.set(oKey, offer);
          return;
        }
        const prevTs = new Date(prev.created_at || 0).getTime();
        const currTs = new Date(offer.created_at || 0).getTime();
        if (currTs >= prevTs) latestOfferByProductColor.set(oKey, offer);
      });
    }
  }

  itemMetaByKey.forEach((meta, itemKey) => {
    if (itemPromosMap.has(itemKey)) return;
    const productId = productIdByName.get(meta.productName);
    if (!productId || !meta.color) return;
    const offer = latestOfferByProductColor.get(`${productId}|${normalizeText(meta.color)}`);
    if (!offer) return;
    const originalPrice = meta.item.price_snapshot || meta.item.variantInfo?.price || 0;
    itemOffersMap.set(itemKey, {
      offerPrice: offer.offer_price,
      originalPrice: originalPrice,
      promoText: "Oferta",
    });
  });

  // Calcular descuentos totales
  let totalDiscount = 0;

  // Descuentos de promociones
  for (const promo of promotions) {
    const variantIdsInPromo = promo.variant_ids || [];
    const itemsInPromo = [];

    for (const variantId of variantIdsInPromo) {
      itemsInPromo.push(...(itemVariantMap.get(String(variantId)) || []));
    }

    if (itemsInPromo.length === 0) continue;

    let totalQuantity = 0;
    let totalPrice = 0;

    for (const item of itemsInPromo) {
      const qty = Number(item.quantity || item.qty || 0);
      const price = parseARSNumber(item.price_snapshot ?? item.variantInfo?.price ?? 0);
      totalQuantity += qty;
      totalPrice += qty * price;
    }

    if (totalQuantity > 0) {
      const groups = Math.floor(totalQuantity / 2);
      let discount = 0;

      if (promo.promo_type === "2x1") {
        const averagePrice = totalPrice / totalQuantity;
        discount = groups * averagePrice;
      } else if (promo.promo_type === "2xMonto" && promo.fixed_amount) {
        const promoPrice = groups * promo.fixed_amount;
        discount = totalPrice - promoPrice;
      }

      totalDiscount += discount;
    }
  }

  // Descuentos de ofertas
  for (const [itemKey, offerInfo] of itemOffersMap.entries()) {
    const item = itemMetaByKey.get(itemKey)?.item;
    if (item) {
      const qty = Number(item.quantity || item.qty || 0);
      const discount = (offerInfo.originalPrice - offerInfo.offerPrice) * qty;
      totalDiscount += discount;
    }
  }

  return {
    itemOffers: itemOffersMap,
    itemPromos: itemPromosMap,
    totalDiscount: totalDiscount,
  };
}

async function resolveItemImage(item) {
  if (item.imagen) return item.imagen;
  const imageKey = buildCatalogImageCacheKey(
    item.product_name || item.articulo || "",
    item.color || ""
  );
  const cached = getCachedMapValue(__dashImageCache, imageKey);
  if (cached !== undefined) return cached;
  const inFlight = __dashImageInFlight.get(imageKey);
  if (inFlight) return inFlight;

  const requestPromise = (async () => {
  try {
    const { data, error } = await supabase
      .from("catalog_public_view")
      .select(`"Imagen Principal","Imagen 1","Imagen 2"`)
      .eq("Articulo", item.product_name || item.articulo || "")
      .eq("Color", item.color || "")
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("âš ï¸ No se pudo obtener imagen desde catÃ¡logo:", error.message);
      return setCachedMapValue(
        __dashImageCache,
        imageKey,
        FALLBACK_IMAGE,
        DASH_IMAGE_CACHE_TTL_MS
      );
    }
    if (data) {
      return setCachedMapValue(
        __dashImageCache,
        imageKey,
        data["Imagen Principal"] ||
        data["Imagen 1"] ||
        data["Imagen 2"] ||
        FALLBACK_IMAGE,
        DASH_IMAGE_CACHE_TTL_MS
      );
    }
  } catch (error) {
    console.warn("âš ï¸ Error resolviendo imagen:", error.message);
  }
  return setCachedMapValue(
    __dashImageCache,
    imageKey,
    FALLBACK_IMAGE,
    DASH_IMAGE_CACHE_TTL_MS
  );
  })();

  __dashImageInFlight.set(imageKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    __dashImageInFlight.delete(imageKey);
  }
}

async function fetchVariantInfo(articulo, color, talle, variantId = null, options = {}) {
  const forceFresh = options.forceFresh === true;
  const cacheKey = buildVariantInfoCacheKey(articulo, color, talle, variantId);
  if (!forceFresh) {
    const cached = getCachedMapValue(__dashVariantInfoCache, cacheKey);
    if (cached !== undefined) return cached;
    const inFlight = __dashVariantInfoInFlight.get(cacheKey);
    if (inFlight) return inFlight;
  }

  const requestPromise = (async () => {
  try {
    const normalizedArticulo = (articulo || "").trim();
    const normalizedColor = (color || "Único").trim();
    const normalizedSizeForStock = normalizeSize(talle) || (talle || "").trim();

    if (!normalizedArticulo || !normalizedColor) return null;

    let vid = variantId;
    let price = 0;
    let reserved = 0;

    if (vid) {
      const { data: pv, error: pvErr } = await supabase
        .from("product_variants")
        .select("id, price, color")
        .eq("id", vid)
        .maybeSingle();
      if (!pvErr && pv) {
        price = Number(pv.price ?? 0) || 0;
      }
    }
    if (!vid) {
      const { data: product, error: productError } = await supabase
        .from("products")
        .select("id")
        .ilike("name", normalizedArticulo)
        .maybeSingle();
      if (productError || !product) return null;
      const { data: pv, error: pvErr } = await supabase
        .from("product_variants")
        .select("id, price, color")
        .eq("product_id", product.id)
        .ilike("color", normalizedColor)
        .eq("active", true)
        .maybeSingle();
      if (pvErr || !pv) return null;
      vid = pv.id;
      price = Number(pv.price ?? 0) || 0;
    }
    if (!vid) return null;

    const { generalId, ventaId } = await getDashboardWarehouseIdsCached({
      forceFresh,
    });

    let stockTotal = 0;
    if (generalId && ventaId && normalizedSizeForStock) {
      const { data: sws } = await supabase
        .from("variant_size_warehouse_stock")
        .select("size, warehouse_id, stock_qty")
        .eq("variant_id", vid)
        .in("warehouse_id", [generalId, ventaId]);
      (sws || []).forEach((s) => {
        if (normalizeSize(s.size) === normalizedSizeForStock) stockTotal += Number(s.stock_qty || 0);
      });
    }
    const { data: reservedRows, error: reservedErr } = await supabase
      .rpc("rpc_get_variant_size_reserved", { p_variant_ids: [vid] });
    if (!reservedErr && Array.isArray(reservedRows) && normalizedSizeForStock) {
      const reservedRow = reservedRows.find((r) => normalizeSize(r.size) === normalizedSizeForStock);
      reserved = Number(reservedRow?.reserved_qty || 0) || 0;
    }
    const available = Math.max(0, stockTotal - reserved);
    return setCachedMapValue(
      __dashVariantInfoCache,
      cacheKey,
      {
      id: vid,
      stock: stockTotal,
      reserved,
      available,
      price,
      color: normalizedColor,
      size: normalizedSizeForStock || talle?.trim(),
      },
      DASH_VARIANT_INFO_CACHE_TTL_MS
    );
  } catch (error) {
    console.warn("âš ï¸ Error obteniendo informaciÃ³n de la variante:", error.message);
    return setCachedMapValue(
      __dashVariantInfoCache,
      cacheKey,
      null,
      DASH_VARIANT_INFO_CACHE_TTL_MS
    );
  }
  })();

  if (!forceFresh) {
    __dashVariantInfoInFlight.set(cacheKey, requestPromise);
  }
  try {
    return await requestPromise;
  } finally {
    if (!forceFresh) {
      __dashVariantInfoInFlight.delete(cacheKey);
    }
  }
}

async function removeItemFromSupabase(itemId) {
  try {
    if (!itemId) {
      console.warn("âš ï¸ removeItemFromSupabase llamado sin itemId");
      return false;
    }

    // Intento 1: borrar directamente en Supabase por id
    let deleteQuery = supabase
      .from("cart_items")
      .delete()
      .eq("id", itemId);
    if (currentCartId) {
      deleteQuery = deleteQuery.eq("cart_id", currentCartId);
    }
    const { error } = await deleteQuery;

    if (!error) {
      window.dispatchEvent(new CustomEvent("cart:synced"));
      return true;
    }

    if (error) {
      console.warn("âš ï¸ Supabase DELETE por id fallÃ³:", error.message || error);
    } else {
      console.warn("âš ï¸ Supabase DELETE por id no afectÃ³ filas (posible id desincronizado)");
    }

    // Intento 2 (fallback): usar el helper global que sincroniza contra Supabase
    if (typeof window.removeCartItem === "function") {
      const ok = await window.removeCartItem(itemId);
      if (ok) {
        // removeCartItem ya sincroniza y emite cart:synced.
        return true;
      }
    }

    // Intento 3: re-cargar y reintentar encontrar el item por id visible
    try {
      const { data: row } = await supabase
        .from("cart_items")
        .select("id")
        .eq("id", itemId)
        .maybeSingle();
      if (!row) {
        // Ya no existe: considerarlo eliminado
        return true;
      }
    } catch (_) {}

    return false;
  } catch (err) {
    console.warn("âš ï¸ Error eliminando item del carrito:", err?.message || err);
    // Fallback final
    if (typeof window.removeCartItem === "function") {
      try {
        const ok = await window.removeCartItem(itemId);
        if (ok) {
          // removeCartItem ya sincroniza y emite cart:synced.
          return true;
        }
      } catch (_) {}
    }
    return false;
  }
}

function attachRemoveHandlers(userId) {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;

  // Menú ⋯ en ítems de la Bolsa: Quitar de la bolsa
  cartInfo.querySelectorAll(".item-row__menuitem[data-action='remove-bag-item']").forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const itemId = btn.dataset.id;
      if (!itemId) return;
      const wrap = btn.closest(".item-row__menu-wrap");
      const popover = wrap?.querySelector(".item-row__popover");
      if (popover) {
        popover.classList.remove("is-open");
        popover.setAttribute("aria-hidden", "true");
        wrap?.querySelector(".item-row__kebab")?.setAttribute("aria-expanded", "false");
      }
      const confirmed = await confirmRemoveCartItemInApp();
      if (!confirmed) return;
      const success = await removeItemFromSupabase(itemId);
      if (!success) {
        await loadCart(userId);
        alert("No se pudo eliminar el producto. Intenta nuevamente.");
      }
    };
  });

  // Abrir/cerrar popover al hacer clic en ⋯ (Bolsa)
  cartInfo.querySelectorAll(".dash-bolsa-item .item-row__kebab").forEach((kebabBtn) => {
    kebabBtn.onclick = (e) => {
      e.stopPropagation();
      const wrap = kebabBtn.closest(".item-row__menu-wrap");
      const popover = wrap?.querySelector(".item-row__popover");
      if (!popover) return;
      const isOpen = popover.classList.contains("is-open");
      cartInfo.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
        p.classList.remove("is-open");
        p.setAttribute("aria-hidden", "true");
      });
      cartInfo.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
      if (!isOpen) {
        popover.classList.add("is-open");
        popover.setAttribute("aria-hidden", "false");
        kebabBtn.setAttribute("aria-expanded", "true");
      }
    };
  });
}

function attachBolsaPopoverCloseOnOutsideClick() {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo || document.body.dataset.bolsaPopoverCloseBound) return;
  document.body.dataset.bolsaPopoverCloseBound = "true";
  document.addEventListener("click", (e) => {
    if (e.target.closest(".item-row__menu-wrap") || e.target.closest(".item-row__popover")) return;
    cartInfo.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
      p.classList.remove("is-open");
      p.setAttribute("aria-hidden", "true");
    });
    cartInfo.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
  });
}

// FunciÃ³n para manejar botones "Ver alternativas" en productos agotados
async function attachAlternativasHandlers(userId) {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;

  cartInfo.querySelectorAll(".btn-ver-alternativas").forEach((btn) => {
    btn.onclick = async (event) => {
      const articulo = event.currentTarget.dataset.articulo;
      const color = event.currentTarget.dataset.color;
      const talle = event.currentTarget.dataset.talle;
      const agotadoItemId = event.currentTarget.dataset.itemId; // capturar antes del modal
      
      if (!articulo || !talle) {
        alert("No se pudo obtener la informaciÃ³n del producto.");
        return;
      }

      // Obtener tags del producto desde el catÃ¡logo
      try {
        const { data: productoCatalogo, error: catalogError } = await supabase
          .from("catalog_public_view")
          .select('"Filtro1","Filtro2","Filtro3"')
          .eq("Articulo", articulo)
          .limit(1)
          .maybeSingle();

        const tags = [];
        if (!catalogError && productoCatalogo) {
          if (productoCatalogo.Filtro1) tags.push(productoCatalogo.Filtro1);
          if (productoCatalogo.Filtro2) tags.push(productoCatalogo.Filtro2);
          if (productoCatalogo.Filtro3) tags.push(productoCatalogo.Filtro3);
        }

        // Buscar productos alternativos
        if (!window.buscarProductosAlternativos || !window.mostrarModalAlternativas) {
          alert("El sistema de alternativas no estÃ¡ disponible. Por favor, elimina este producto del carrito.");
          return;
        }

        const productos = await window.buscarProductosAlternativos({
          articulo,
          talle,
          tags,
          color,
          limit: 6,
        });

        // Mostrar modal con alternativas
        window.mostrarModalAlternativas({
          mensaje: `Productos alternativos disponibles en talle ${talle} (reemplazo para ${articulo}):`,
          productos,
          onProductoSeleccionado: async (productoSeleccionado) => {
            // Agregar el producto seleccionado al carrito
            if (window.addToCart) {
              const productData = {
                articulo: productoSeleccionado.articulo,
                color: productoSeleccionado.color,
                talle: productoSeleccionado.talle,
                cantidad: 1,
                precio: productoSeleccionado.precio,
                imagen: productoSeleccionado.imagen,
                descripcion: productoSeleccionado.descripcion,
                variant_id: productoSeleccionado.variant_id,
              };
              
              const added = await window.addToCart(productData);
              if (added) {
                // Si tenemos el itemId faltante, cancelarlo automÃ¡ticamente
                if (agotadoItemId) {
                  try {
                    const { error: cancelError } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: agotadoItemId });
                    if (cancelError) {
                      console.warn("âš ï¸ No se pudo cancelar el item faltante:", cancelError.message || cancelError);
                    }
                  } catch (e) {
                    console.warn("âš ï¸ Error cancelando item faltante:", e?.message || e);
                  }
                }
                
                alert(`âœ… ${productoSeleccionado.articulo} agregado al carrito`);
                // Recargar el carrito y pedidos para reflejar cambios
                if (currentUserId) {
                  await loadCart(currentUserId);
                  await loadOrders(currentUserId);
                }
              } else {
                alert(`No se pudo agregar ${productoSeleccionado.articulo} al carrito.`);
              }
            } else {
              alert("No se pudo agregar el producto al carrito. Por favor, recarga la pÃ¡gina.");
            }
          },
          onCerrar: () => {
            fylDevLog("Modal de alternativas cerrado");
          },
        });
      } catch (error) {
        console.error("âŒ Error mostrando alternativas:", error);
        alert("No se pudieron cargar productos alternativos. Por favor, intenta nuevamente.");
      }
    };
  });
}

/** Opciones del select de cantidad en la bolsa (tope = stock disponible). Misma UI que stock OK: 0, 1 u…, Más+; sin fila placeholder. */
function buildDashBolsaQtySelectOptions(qty, maxQtyCap) {
  const useCompactQtyLabel =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(max-width: 360px)").matches;
  const cap = Math.max(0, Math.floor(Number(maxQtyCap) || 0));
  const cartQ = Math.max(0, Math.floor(Number(qty) || 0));
  const overshoot = cartQ > cap;

  if (cap === 0) {
    return `<option value="0" selected>0</option>`;
  }

  const maxOption = Math.min(4, cap);
  const qtyOptions = [0, ...Array.from({ length: maxOption }, (_, i) => i + 1)];
  const cartOver4WithinCap = cartQ > 4 && cartQ <= cap;
  const cartOver4Overshoot = cartQ > 4 && overshoot && cap > 4;

  let effectiveSelectedSmall = null;
  if (overshoot && cap <= 4) {
    effectiveSelectedSmall = Math.min(cap, maxOption);
  } else if (!overshoot && cartQ <= 4 && cartQ <= cap) {
    effectiveSelectedSmall = Math.min(cartQ, maxOption);
  }

  const parts = [];

  for (const n of qtyOptions) {
    const label =
      n === 0
        ? "0"
        : `${n} uni`;
    const sel =
      effectiveSelectedSmall !== null && n === effectiveSelectedSmall ? "selected" : "";
    parts.push(`<option value="${n}" ${sel}>${label}</option>`);
  }

  if (cartOver4WithinCap && cartQ > maxOption) {
    const label = `${cartQ} uni`;
    parts.push(`<option value="${cartQ}" selected>${label}</option>`);
  }

  if (cartOver4Overshoot) {
    const label = `${cap} uni`;
    parts.push(`<option value="${cap}" selected>${label}</option>`);
  }

  if (cap > 4) {
    parts.push(`<option value="mas">Más+</option>`);
  }

  return parts.join("");
}

function attachQuantityHandlers(userId) {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;

  const readCap = (el) => {
    const raw = el.dataset.max;
    if (
      raw == null ||
      String(raw).trim() === "" ||
      !Number.isFinite(Number(raw))
    ) {
      return null;
    }
    return Math.floor(Number(raw));
  };

  // Si el carrito tiene más unidades que el stock pero el select ya muestra un valor válido,
  // elegir de nuevo el mismo número no dispara `change`. Al cerrar el desplegable (blur)
  // aplicamos esa cantidad para que la tarjeta vuelva al estado normal.
  const maybeSyncOvershootOnBlur = async (selectEl) => {
    const itemId = selectEl.dataset.id;
    if (!itemId) return;
    const v = selectEl.value;
    if (v === "mas" || v === "" || v === "0") return;
    const num = Number(v);
    if (!Number.isFinite(num)) return;
    const latestCur = Number(selectEl.dataset.currentQty);
    const latestCap = readCap(selectEl);
    if (latestCap == null || !Number.isFinite(latestCur)) return;
    if (latestCur <= latestCap) return;
    if (num > latestCap) return;
    const ok = await updateCartItemQuantity(itemId, num);
    if (ok) await loadCart(userId);
  };

  // Selector de cantidad: 0 = quitar producto; 1-4 o valor numérico = actualizar; "mas" = pedir cantidad > 4
  cartInfo.querySelectorAll(".cart-qty-select").forEach((sel) => {
    const curQ = Number(sel.dataset.currentQty);
    const capQ = readCap(sel);
    if (Number.isFinite(curQ) && capQ != null && curQ > capQ && capQ > 0) {
      sel.addEventListener("blur", () => {
        void maybeSyncOvershootOnBlur(sel);
      });
    }

    sel.onchange = async (event) => {
      const selectEl = event.currentTarget;
      const itemId = selectEl.dataset.id;
      const max = readCap(selectEl);
      if (!itemId) return;

      const value = selectEl.value;
      if (value === "") return;

      if (value === "mas") {
        const raw = window.prompt(`Ingresá la cantidad (máximo ${max} por stock disponible):`, "5");
        if (raw == null) {
          await loadCart(userId);
          return;
        }

        let qty = Math.floor(Number(raw) || 0);
        if (qty < 5) {
          alert("Para cantidades de 1 a 4 usá el desplegable.");
          return;
        }
        if (max != null && qty > max) {
          alert(`Solo hay ${max} unidades disponibles para este producto.`);
          qty = max;
        }

        const ok = await updateCartItemQuantity(itemId, qty);
        if (!ok) {
          await loadCart(userId);
          alert("No se pudo actualizar la cantidad. Verifica el stock disponible.");
        } else {
          await loadCart(userId);
        }
        return;
      }

      const numValue = Number(value) || 0;

      if (numValue === 0) {
        const success = await removeItemFromSupabase(itemId);
        if (success) {
          await loadCart(userId);
        } else {
          await loadCart(userId);
          alert("No se pudo eliminar el producto. Intenta nuevamente.");
        }
        return;
      }

      const finalQty = max != null && numValue > max ? max : numValue;
      const ok = await updateCartItemQuantity(itemId, finalQty);
      if (!ok) {
        await loadCart(userId);
        alert("No se pudo actualizar la cantidad. Verifica el stock disponible.");
      } else {
        await loadCart(userId);
      }
    };
  });
}

function setupCartActions() {
  if (cartActionsInitialized) return;
  cartActionsInitialized = true;

  const cartActions = document.getElementById("cart-actions");
  if (cartActions) {
    cartActions.style.gap = "12px";
    cartActions.style.marginTop = "16px";
    cartActions.style.flexWrap = "wrap";
  }

  const submitBtn = document.getElementById("submit-cart-btn");
  const clearBtn = document.getElementById("clear-cart-btn");

  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      if (!currentUserId) {
        showGuestLoginRequiredModal();
        return;
      }
      await submitCurrentCart();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      if (!currentUserId) {
        const confirmClearGuest = await showDashboardConfirmModal({
          title: "¿Quieres vaciar completamente tu carrito?",
          message: "",
          confirmLabel: "Aceptar",
          cancelLabel: "Cancelar",
        });
        if (!confirmClearGuest) return;
        localStorage.setItem("fyl_cart", JSON.stringify([]));
        showNoSession();
        return;
      }
      const confirmClear = await showDashboardConfirmModal({
        title: "¿Quieres vaciar completamente tu carrito?",
        message: "",
        confirmLabel: "Aceptar",
        cancelLabel: "Cancelar",
      });
      if (!confirmClear) return;
      await clearCurrentCart();
    });
  }
}

/**
 * Modal de confirmación in-app (misma UI que quitar de la bolsa).
 * @param {{ title: string, message?: string, bodyHtml?: string, confirmLabel?: string, cancelLabel?: string }} opts
 * @returns {Promise<boolean>}
 */
function showDashboardConfirmModal(opts) {
  const {
    title,
    message = "",
    bodyHtml = "",
    confirmLabel = "Aceptar",
    cancelLabel = "Cancelar",
  } = opts;

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-app-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-app-confirm-modal";
      modal.className = "dash-remove-cart-item-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "dash-app-confirm-title");
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML = `
        <div class="dash-remove-cart-item-modal__panel">
          <h3 id="dash-app-confirm-title" class="dash-remove-cart-item-modal__title"></h3>
          <div id="dash-app-confirm-message" class="dash-remove-cart-item-modal__hint dash-app-confirm-message"></div>
          <div class="dash-remove-cart-item-modal__actions">
            <button type="button" class="btn btn-ghost" id="dash-app-confirm-cancel"></button>
            <button type="button" class="btn btn-primary" id="dash-app-confirm-ok"></button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    const titleEl = modal.querySelector("#dash-app-confirm-title");
    const msgEl = modal.querySelector("#dash-app-confirm-message");
    const okBtn = modal.querySelector("#dash-app-confirm-ok");
    const cancelBtn = modal.querySelector("#dash-app-confirm-cancel");

    titleEl.textContent = title;
    msgEl.classList.remove("dash-app-confirm-message--html");
    if (bodyHtml) {
      msgEl.innerHTML = bodyHtml;
      msgEl.style.display = "";
      msgEl.classList.add("dash-app-confirm-message--html");
    } else if (message) {
      msgEl.textContent = message;
      msgEl.style.display = "";
    } else {
      msgEl.textContent = "";
      msgEl.innerHTML = "";
      msgEl.style.display = "none";
    }
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = (value) => {
      cleanup();
      resolve(value);
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done(false);
    }

    modal.onclick = (e) => {
      if (e.target === modal) done(false);
    };
    okBtn.onclick = (e) => {
      e.stopPropagation();
      done(true);
    };
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      done(false);
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    cancelBtn.focus();
  });
}

/**
 * Modal de selección (1..N). Devuelve número o null si cancela.
 * @param {{ title: string, max: number, confirmLabel?: string, cancelLabel?: string, label?: string }} opts
 * @returns {Promise<number|null>}
 */
function showDashboardQuantitySelectModal(opts) {
  const {
    title,
    max,
    confirmLabel = "Aceptar",
    cancelLabel = "Cancelar",
    label = "¿Cuántas unidades?",
  } = opts || {};

  const maxInt = Math.max(1, Number(max || 1) | 0);
  const optionsHtml = Array.from({ length: maxInt }, (_, i) => {
    const n = i + 1;
    return `<option value="${n}">${n}</option>`;
  }).join("");

  const bodyHtml = `
    <div class="dash-qty-select">
      <div class="dash-qty-select__label">${label}</div>
      <select id="dash-qty-select" class="dash-qty-select__select" aria-label="${label.replace(/"/g, "&quot;")}">
        ${optionsHtml}
      </select>
    </div>
  `;

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-app-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-app-confirm-modal";
      modal.className = "dash-remove-cart-item-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "dash-app-confirm-title");
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML = `
        <div class="dash-remove-cart-item-modal__panel">
          <h3 id="dash-app-confirm-title" class="dash-remove-cart-item-modal__title"></h3>
          <div id="dash-app-confirm-message" class="dash-remove-cart-item-modal__hint dash-app-confirm-message"></div>
          <div class="dash-remove-cart-item-modal__actions">
            <button type="button" class="btn btn-ghost" id="dash-app-confirm-cancel"></button>
            <button type="button" class="btn btn-primary" id="dash-app-confirm-ok"></button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    if (!modal) return resolve(null);

    const titleEl = modal.querySelector("#dash-app-confirm-title");
    const msgEl = modal.querySelector("#dash-app-confirm-message");
    const okBtn = modal.querySelector("#dash-app-confirm-ok");
    const cancelBtn = modal.querySelector("#dash-app-confirm-cancel");

    titleEl.textContent = title || "";
    msgEl.classList.add("dash-app-confirm-message--html");
    msgEl.style.display = "";
    msgEl.innerHTML = bodyHtml;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    const selectEl = modal.querySelector("#dash-qty-select");

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = (value) => {
      cleanup();
      resolve(value);
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done(null);
    }

    modal.onclick = (e) => {
      if (e.target === modal) done(null);
    };
    okBtn.onclick = (e) => {
      e.stopPropagation();
      const v = Number(selectEl?.value || 0) | 0;
      done(v > 0 ? v : 1);
    };
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      done(null);
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    // En mobile es más cómodo caer en el select
    (selectEl || cancelBtn).focus();
  });
}

/**
 * Modal para elegir una opción (ej. talle). Devuelve el `value` elegido o null si cancela.
 * @param {{ title: string, options: Array<{ value: string, label: string, sublabel?: string }>, confirmLabel?: string, cancelLabel?: string }} opts
 * @returns {Promise<string|null>}
 */
function showDashboardOptionButtonsModal(opts) {
  const {
    title,
    options = [],
    confirmLabel = "Aceptar",
    cancelLabel = "Cancelar",
  } = opts || {};

  const safeOptions = (options || [])
    .map((o) => ({
      value: String(o?.value ?? "").trim(),
      label: String(o?.label ?? "").trim(),
      sublabel: String(o?.sublabel ?? "").trim(),
    }))
    .filter((o) => o.value && o.label);

  const bodyHtml = `
    <div class="dash-opt-select">
      <div class="dash-opt-select__grid">
        ${safeOptions
          .map(
            (o) => `
              <button type="button" class="dash-opt-select__btn" data-opt-value="${o.value.replace(/"/g, "&quot;")}">
                <span class="dash-opt-select__btn-label">${o.label}</span>
                ${o.sublabel ? `<span class="dash-opt-select__btn-sub">${o.sublabel}</span>` : ""}
              </button>
            `
          )
          .join("")}
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-app-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-app-confirm-modal";
      modal.className = "dash-remove-cart-item-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "dash-app-confirm-title");
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML = `
        <div class="dash-remove-cart-item-modal__panel">
          <h3 id="dash-app-confirm-title" class="dash-remove-cart-item-modal__title"></h3>
          <div id="dash-app-confirm-message" class="dash-remove-cart-item-modal__hint dash-app-confirm-message"></div>
          <div class="dash-remove-cart-item-modal__actions">
            <button type="button" class="btn btn-ghost" id="dash-app-confirm-cancel"></button>
            <button type="button" class="btn btn-primary" id="dash-app-confirm-ok"></button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    if (!modal) return resolve(null);

    const titleEl = modal.querySelector("#dash-app-confirm-title");
    const msgEl = modal.querySelector("#dash-app-confirm-message");
    const okBtn = modal.querySelector("#dash-app-confirm-ok");
    const cancelBtn = modal.querySelector("#dash-app-confirm-cancel");

    titleEl.textContent = title || "";
    msgEl.classList.add("dash-app-confirm-message--html");
    msgEl.style.display = "";
    msgEl.innerHTML = bodyHtml;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    let pickedValue = safeOptions[0]?.value || null;
    const btns = Array.from(modal.querySelectorAll(".dash-opt-select__btn"));
    btns.forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        btns.forEach((x) => x.classList.remove("is-selected"));
        b.classList.add("is-selected");
        pickedValue = String(b.dataset.optValue || "").trim() || pickedValue;
      };
    });
    // Seleccionar la primera por defecto
    if (btns[0]) {
      btns[0].classList.add("is-selected");
      pickedValue = String(btns[0].dataset.optValue || "").trim() || pickedValue;
    }

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = (value) => {
      cleanup();
      resolve(value);
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done(null);
    }

    modal.onclick = (e) => {
      if (e.target === modal) done(null);
    };
    okBtn.onclick = (e) => {
      e.stopPropagation();
      done(pickedValue);
    };
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      done(null);
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    (btns[0] || cancelBtn).focus();
  });
}

/** Quitar ítem de la bolsa — usa el modal genérico del dashboard. */
function confirmRemoveCartItemInApp() {
  return showDashboardConfirmModal({
    title: "¿Quitar este producto del carrito?",
    message: "Se eliminará solo esta línea de tu bolsa.",
    confirmLabel: "Quitar",
    cancelLabel: "Cancelar",
  });
}

/** Reloj inline (historial) — mismo estilo trazo que el resto del dashboard. */
const DASH_MESSAGE_CLOCK_SVG = `<svg class="dash-app-message-modal__clock-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

/**
 * Modal in-app de un solo botón (sustituye alert() del navegador).
 * @param {{ title?: string, bodyHtml: string, confirmLabel?: string }} opts
 * @returns {Promise<void>}
 */
function showDashboardMessageModal(opts) {
  const {
    title = "",
    bodyHtml,
    confirmLabel = "Entendido",
  } = opts;

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-app-message-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-app-message-modal";
      modal.className = "dash-remove-cart-item-modal";
      modal.setAttribute("role", "alertdialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML = `
        <div class="dash-remove-cart-item-modal__panel">
          <h3 id="dash-app-message-title" class="dash-remove-cart-item-modal__title"></h3>
          <div id="dash-app-message-body" class="dash-app-message-modal__body"></div>
          <div class="dash-remove-cart-item-modal__actions dash-app-message-modal__actions--single">
            <button type="button" class="btn btn-primary" id="dash-app-message-ok"></button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    const titleEl = modal.querySelector("#dash-app-message-title");
    const bodyEl = modal.querySelector("#dash-app-message-body");
    const okBtn = modal.querySelector("#dash-app-message-ok");

    if (title) {
      titleEl.textContent = title;
      titleEl.style.display = "";
      modal.setAttribute("aria-labelledby", "dash-app-message-title");
    } else {
      titleEl.textContent = "";
      titleEl.style.display = "none";
      modal.removeAttribute("aria-labelledby");
    }
    bodyEl.innerHTML = bodyHtml;
    modal.setAttribute("aria-describedby", "dash-app-message-body");
    okBtn.textContent = confirmLabel;

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      okBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = () => {
      cleanup();
      resolve();
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done();
    }

    modal.onclick = (e) => {
      if (e.target === modal) done();
    };
    okBtn.onclick = (e) => {
      e.stopPropagation();
      done();
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    okBtn.focus();
  });
}

/** WhatsApp envíos (mismo enlace que index2 / footer Envíos). */
const WHATSAPP_ENVIOS_HREF = "https://wa.me/5493624118637";

const DASH_TRANSPORT_GEAR_SVG = `<svg class="dash-transport-config-hint__gear" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;

function escapeHtmlAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

async function fetchCustomerShippingRow() {
  if (!currentUserId) return null;
  const { data, error } = await supabase
    .from("customers")
    .select("transport_id, province, city")
    .eq("id", currentUserId)
    .maybeSingle();
  if (error) {
    console.warn("No se pudo leer datos de envío del cliente:", error.message);
    return null;
  }
  return data;
}

async function fetchCustomerProfileRow() {
  if (!currentUserId) return null;
  const { data, error } = await supabase
    .from("customers")
    .select("full_name, email")
    .eq("id", currentUserId)
    .maybeSingle();
  if (error) {
    console.warn("No se pudo leer perfil del cliente:", error.message);
    return null;
  }
  return data;
}

/**
 * Paso de transporte antes del cierre definitivo (solo si aún no hay transport_id en cuenta).
 * @returns {Promise<{ ok: boolean, transportName?: string }>}
 */
function showTransportFinalizeModal({ province, city, opciones }) {
  function normalizeForMatch(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/\u0301/g, "")
      .replace(/\u0300/g, "")
      .replace(/[\u0300-\u036f]/g, "");
  }

  const chacoSpecialLocalities = new Set(
    [
      "resistencia",
      "puerto vilela",
      "puerto vilelas",
      "barranqueras",
      "fontana",
      "puerto tirol",
      "margarita belen",
      "margarita belén",
      "colonia benites",
      "colonia benítez",
    ].map(normalizeForMatch)
  );

  const isChacoSpecial = normalizeForMatch(province) === "chaco" && chacoSpecialLocalities.has(normalizeForMatch(city));
  // Regla: para esas localidades, el transporte efectivo es solo "Retiro de Local".
  if (isChacoSpecial) opciones = ["Retiro de Local"];
  opciones = Array.from(
    new Set((opciones || []).map((o) => canonicalizeTransportName(o)).filter(Boolean))
  );

  const soloSedeUnico = opciones.length === 1 && opciones[0] === "SEDE";
  const soloRetiroLocalUnico = opciones.length === 1 && opciones[0] === "Retiro de Local";

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-transport-finalize-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-transport-finalize-modal";
      modal.className = "dash-remove-cart-item-modal dash-transport-finalize-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "dash-transport-finalize-title");
      document.body.appendChild(modal);
    }

    const waLink = `<a href="${WHATSAPP_ENVIOS_HREF}" target="_blank" rel="noopener noreferrer" class="dash-transport-wa-link">WhatsApp</a>`;

    let bodyInner;
    if (soloRetiroLocalUnico) {
      bodyInner = `
        <h3 id="dash-transport-finalize-title" class="dash-remove-cart-item-modal__title">Transporte asignado</h3>
        <div class="dash-transport-assigned">Retiro de Local</div>
        <p class="dash-transport-lead">Acordar en el local.</p>
        <div class="dash-transport-block">
          <p class="dash-transport-block__text">¿Tenés dudas? Escribinos por ${waLink}.</p>
        </div>
      `;
    } else if (soloSedeUnico) {
      bodyInner = `
        <h3 id="dash-transport-finalize-title" class="dash-remove-cart-item-modal__title">Transporte asignado</h3>
        <div class="dash-transport-assigned">SEDE</div>
        <p class="dash-transport-lead">El pago es contra reembolso (abonás el total del pedido + envío al recibirlo).</p>
        <div class="dash-transport-block">
          <p class="dash-transport-block__text">¿Tenés dudas? Escribinos por ${waLink}.</p>
        </div>
      `;
    } else {
      const selectAria = escapeHtmlAttr("Elegí cómo querés recibir tu pedido");
      let selectHtml;
      if (opciones.length === 1) {
        const only = opciones[0];
        selectHtml = `<select id="dash-transport-select" class="dash-transport-select" aria-label="${selectAria}">
            <option value="${escapeHtmlAttr(only)}">${escapeHtmlAttr(only)}</option>
          </select>`;
      } else {
        selectHtml = `<select id="dash-transport-select" class="dash-transport-select" aria-label="${selectAria}">
            <option value="" disabled selected>Elegí cómo querés recibir tu pedido</option>
            ${opciones
              .map(
                (o) =>
                  `<option value="${escapeHtmlAttr(o)}">${escapeHtmlAttr(o)}</option>`
              )
              .join("")}
          </select>`;
      }

      bodyInner = `
        <h3 id="dash-transport-finalize-title" class="dash-remove-cart-item-modal__title">Seleccioná tu transporte</h3>
        <p class="dash-transport-sub">Te mostramos las opciones disponibles según tu localidad.</p>
        <div class="dash-transport-select-wrap">${selectHtml}</div>
        <div class="dash-transport-block" id="dash-transport-pago-block">
          <div class="dash-transport-block__title">Forma de pago</div>
          <p class="dash-transport-block__text">Acordar en el local.</p>
        </div>
        <div class="dash-transport-block dash-transport-block--muted" id="dash-transport-correo-block" style="display:none;">
          <div class="dash-transport-block__title">Correo Argentino</div>
          <p class="dash-transport-block__text">Si elegís Correo Argentino, te informaremos el costo total (pedido + envío) para abonarlo antes del despacho.</p>
        </div>
        <div class="dash-transport-block">
          <p class="dash-transport-block__text">¿Tenés dudas? Escribinos por ${waLink}.</p>
        </div>
        <div class="dash-transport-config-hint">
          ${DASH_TRANSPORT_GEAR_SVG}
          <span class="dash-transport-config-hint__text">Podés cambiar tu transporte en cualquier momento desde la <a href="profile.html" class="dash-transport-profile-link">configuración</a>.</span>
        </div>
      `;
    }

    modal.innerHTML = `
      <div class="dash-remove-cart-item-modal__panel dash-transport-finalize-modal__panel">
        ${bodyInner}
        <div class="dash-remove-cart-item-modal__actions">
          <button type="button" class="btn btn-ghost" id="dash-transport-cancel">Cancelar</button>
          <button type="button" class="btn btn-primary" id="dash-transport-continue">Continuar</button>
        </div>
      </div>
    `;

    const cancelBtn = modal.querySelector("#dash-transport-cancel");
    const continueBtn = modal.querySelector("#dash-transport-continue");
    const selectEl = modal.querySelector("#dash-transport-select");
    const pagoBlock = modal.querySelector("#dash-transport-pago-block");
    const correoBlock = modal.querySelector("#dash-transport-correo-block");

    function syncPaymentBlocks() {
      if (!selectEl) return;
      const selected = selectEl.value;
      const showCorreo = selected === "Correo Argentino";
      if (correoBlock) correoBlock.style.display = showCorreo ? "" : "none";
      if (pagoBlock) pagoBlock.style.display = showCorreo ? "none" : "";
    }

    function syncContinueDisabled() {
      if ((soloSedeUnico || soloRetiroLocalUnico) || !selectEl) {
        continueBtn.disabled = false;
        return;
      }
      continueBtn.disabled = !selectEl.value;
    }

    if (selectEl) {
      selectEl.addEventListener("change", () => {
        syncContinueDisabled();
        syncPaymentBlocks();
      });
    }
    syncContinueDisabled();
    syncPaymentBlocks();

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      cancelBtn.onclick = null;
      continueBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = (result) => {
      cleanup();
      resolve(result);
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done({ ok: false });
    }

    modal.onclick = (e) => {
      if (e.target === modal) done({ ok: false });
    };
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      done({ ok: false });
    };
    continueBtn.onclick = (e) => {
      e.stopPropagation();
      if (soloSedeUnico) {
        done({ ok: true, transportName: "SEDE" });
        return;
      }
      if (soloRetiroLocalUnico) {
        done({ ok: true, transportName: "Retiro de Local" });
        return;
      }
      const v = selectEl ? selectEl.value : "";
      if (!v) return;
      done({ ok: true, transportName: canonicalizeTransportName(v) });
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    if (selectEl && opciones.length > 1) {
      selectEl.focus();
    } else {
      continueBtn.focus();
    }
  });
}

function showGuestLoginRequiredModal() {
  let modal = document.getElementById("guest-login-required-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "guest-login-required-modal";
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      z-index: 1300;
    `;
    modal.innerHTML = `
      <div style="width:min(420px, 100%); background:#fff; border-radius:16px; padding:20px; box-shadow:0 10px 28px rgba(0,0,0,.22);">
        <h3 style="margin:0 0 8px 0; font-size:20px; color:#2d2d2d;">Inicia sesión para continuar</h3>
        <p style="margin:0 0 16px 0; color:#5f5f5f; font-size:14px; line-height:1.45;">
          Para hacer el pedido es necesario loguearse.
        </p>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button type="button" id="guest-login-cancel-btn" class="btn btn-ghost">Cancelar</button>
          <button type="button" id="guest-login-go-btn" class="btn btn-primary">Iniciar sesión</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const closeModal = () => {
      modal.remove();
    };

    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal();
    });

    const cancelBtn = modal.querySelector("#guest-login-cancel-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", closeModal);
    }

    const goBtn = modal.querySelector("#guest-login-go-btn");
    if (goBtn) {
      goBtn.addEventListener("click", () => {
        window.location.href = "./login.html?return=dashboard";
      });
    }
    return;
  }

  modal.style.display = "flex";
}

function attachGuestCartHandlers() {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;

  const readGuestCart = () => {
    try {
      const raw = localStorage.getItem("fyl_cart");
      const parsed = raw ? JSON.parse(raw) : [];
      const normalized = normalizeGuestCartStorageItems(
        Array.isArray(parsed) ? parsed : []
      );
      localStorage.setItem("fyl_cart", JSON.stringify(normalized));
      return normalized;
    } catch (_e) {
      return [];
    }
  };

  cartInfo.querySelectorAll(".cart-qty-select").forEach((sel) => {
    sel.onchange = (event) => {
      const idx = Number(event.currentTarget.dataset.id);
      let qty = Number(event.currentTarget.value) || 0;
      const items = readGuestCart();
      if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) return;
      if (qty <= 0) {
        items.splice(idx, 1);
      } else {
        const prev = items[idx] || {};
        items[idx] = {
          ...prev,
          cantidad: qty,
          quantity: qty,
          qty: qty,
        };
      }
      localStorage.setItem("fyl_cart", JSON.stringify(items));
      showNoSession();
    };
  });

  cartInfo.querySelectorAll(".item-row__menuitem[data-action='remove-bag-item']").forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.id);
      const items = readGuestCart();
      if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) return;
      const wrap = btn.closest(".item-row__menu-wrap");
      const popover = wrap?.querySelector(".item-row__popover");
      if (popover) {
        popover.classList.remove("is-open");
        popover.setAttribute("aria-hidden", "true");
        wrap?.querySelector(".item-row__kebab")?.setAttribute("aria-expanded", "false");
      }
      const confirmed = await confirmRemoveCartItemInApp();
      if (!confirmed) return;
      items.splice(idx, 1);
      localStorage.setItem("fyl_cart", JSON.stringify(items));
      showNoSession();
    };
  });

  cartInfo.querySelectorAll(".dash-bolsa-item .item-row__kebab").forEach((kebabBtn) => {
    kebabBtn.onclick = (e) => {
      e.stopPropagation();
      const wrap = kebabBtn.closest(".item-row__menu-wrap");
      const popover = wrap?.querySelector(".item-row__popover");
      if (!popover) return;
      const isOpen = popover.classList.contains("is-open");
      cartInfo.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
        p.classList.remove("is-open");
        p.setAttribute("aria-hidden", "true");
      });
      cartInfo.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
      if (!isOpen) {
        popover.classList.add("is-open");
        popover.setAttribute("aria-hidden", "false");
        kebabBtn.setAttribute("aria-expanded", "true");
      }
    };
  });
}

async function clearCurrentCart() {
  try {
    const clearBtn = document.getElementById("clear-cart-btn");
    if (clearBtn) clearBtn.disabled = true;

    if (!currentCartId) {
      const cartIds = currentCartItems.map((item) => item.id).filter(Boolean);
      if (!cartIds.length) {
        await loadCart(currentUserId);
        if (clearBtn) clearBtn.disabled = false;
        return;
      }
      const { error } = await supabase.from("cart_items").delete().in("id", cartIds);
      if (error) {
        alert("No se pudo limpiar el carrito. Intenta nuevamente.");
        if (clearBtn) clearBtn.disabled = false;
        return;
      }
    } else {
      const { error } = await supabase.from("cart_items").delete().eq("cart_id", currentCartId);
      if (error) {
        alert("No se pudo limpiar el carrito. Intenta nuevamente.");
        if (clearBtn) clearBtn.disabled = false;
        return;
      }
    }

    window.dispatchEvent(new CustomEvent("cart:synced"));
    await loadCart(currentUserId);
  } catch (error) {
    console.error("âŒ Error limpiando carrito:", error);
  } finally {
    const clearBtn = document.getElementById("clear-cart-btn");
    if (clearBtn) clearBtn.disabled = false;
  }
}

async function submitCurrentCart() {
  if (isSubmittingCurrentCart) return;
  isSubmittingCurrentCart = true;
  let releaseSubmitBtnLoading = () => {};
  try {
    if (hasExpiredPendingDisassemblyOrderInView()) {
      await showOrderExpiredCartSubmitBlockedModal();
      return;
    }

    // Verificar si hay productos agotados antes de enviar
    const hasOutOfStockItems = currentCartItems && currentCartItems.some(item => item.isOutOfStock);
    if (hasOutOfStockItems) {
      alert(
        "No podés enviar el pedido: hay productos que superan el stock disponible (marcados en rosa). Ajustá las cantidades o quitá esos productos."
      );
      return;
    }

    const hasMissingVariantId = (currentCartItems || []).some(
      (it) => it.variant_id == null || it.variant_id === ""
    );
    if (hasMissingVariantId) {
      alert(
        "Hay un producto del carrito que ya no está disponible o necesita actualizarse. Eliminá ese producto y volvé a intentar."
      );
      return;
    }

    // Confirmar con el usuario cuántos productos quiere enviar
    const totalUnits = (currentCartItems || []).reduce(
      (sum, item) => sum + (Number(item.quantity) || 0),
      0
    );
    if (!totalUnits) {
      alert("Tu carrito está vacío. Agrega productos antes de hacer un pedido.");
      return;
    }

    // Datos de perfil obligatorios antes de confirmar/enviar (ignora "modal ya visto" en la sesión)
    let profileReady = await hasInitialProfileComplete();
    if (!profileReady) {
      const saved = await maybeShowProfileOnboardingModal({ force: true });
      profileReady = saved && (await hasInitialProfileComplete());
    }
    if (!profileReady) {
      const msg =
        "Completá tus datos (nombre, teléfono, DNI, dirección, provincia y localidad) para hacer el pedido.";
      if (typeof window.showToast === "function") {
        window.showToast(msg, "info");
      } else {
        alert(msg);
      }
      return;
    }

    const productosLabel = totalUnits === 1 ? "1 producto" : `${totalUnits} productos`;

    const confirmed = await new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.className = "alternativas-modal active";
      modal.innerHTML = `
        <div class="alternativas-modal-content" style="max-width: 420px;">
          <div class="alternativas-modal-header">
            <h2>Confirmar pedido</h2>
            <button class="alternativas-modal-close" type="button">&times;</button>
          </div>
          <div class="alternativas-modal-body">
            <p class="alternativas-modal-message">¿Querés hacer un pedido de <strong>${productosLabel}</strong>?</p>
          </div>
          <div class="alternativas-modal-footer" style="gap: 12px; display: flex; justify-content: flex-end;">
            <button class="alternativas-cerrar-btn" type="button" data-action="cancelar-pedido">Cancelar</button>
            <button class="alternativa-select-btn" type="button" data-action="confirmar-pedido">Hacer pedido</button>
          </div>
        </div>
      `;

      const cleanup = (result) => {
        if (modal && modal.parentNode) {
          modal.parentNode.removeChild(modal);
        }
        resolve(result);
      };

      modal.addEventListener("click", (e) => {
        if (e.target === modal) {
          cleanup(false);
        }
      });

      const closeBtn = modal.querySelector(".alternativas-modal-close");
      const cancelBtn = modal.querySelector("[data-action='cancelar-pedido']");
      const confirmBtn = modal.querySelector("[data-action='confirmar-pedido']");

      if (closeBtn) {
        closeBtn.addEventListener("click", () => cleanup(false));
      }
      if (cancelBtn) {
        cancelBtn.addEventListener("click", () => cleanup(false));
      }
      if (confirmBtn) {
        confirmBtn.addEventListener("click", () => cleanup(true));
      }

      document.body.appendChild(modal);
    });

    if (!confirmed) {
      return;
    }

    try {
      if (fylAnalytics.isReady()) {
        const lines = fylDashboardCartLinesForGa(currentCartItems);
        const gaItems = fylAnalytics.buildCartItemsFromLines(lines);
        const val = gaItems.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
        fylAnalytics.ecommerceEvent("begin_checkout", { currency: "ARS", value: val, items: gaItems });
      }
    } catch (_e) {}

    try {
      const skusArray = Array.isArray(currentCartItems)
        ? currentCartItems
            .map((item) =>
              String(
                item?.sku ||
                item?.variant_id ||
                item?.articulo ||
                item?.product_name ||
                ""
              ).trim()
            )
            .filter(Boolean)
        : [];
      const totalRaw = Array.isArray(currentCartItems)
        ? currentCartItems.reduce((sum, item) => {
            const qty = Number(item?.cantidad ?? item?.quantity ?? item?.qty ?? 0) || 0;
            const unit = Number(item?.precio ?? item?.price_snapshot ?? item?.price ?? 0) || 0;
            return sum + qty * unit;
          }, 0)
        : 0;
      const total = Number.isFinite(totalRaw) ? totalRaw : 0;

      if (typeof fbq === "function") {
        fbq("track", "InitiateCheckout", {
          content_ids: skusArray,
          content_type: "product",
          value: total,
          currency: "ARS",
        });
      }
    } catch (_e) {}

    const submitBtn = document.getElementById("submit-cart-btn");
    releaseSubmitBtnLoading = setButtonLoading(submitBtn, "Enviando...");
    const bagSection = document.getElementById("section-bag");
    if (bagSection) bagSection.classList.add("dash-fx-pending");

    // Generar o reutilizar operation_id. Se mantiene entre intentos para que
    // un retry tras error de red reciba el resultado idempotente del servidor.
    if (!_checkoutOperationId) {
      _checkoutOperationId = generateOperationId();
    }
    const checkoutOpId = _checkoutOperationId;
    const checkoutRequest = {
      source: "dashboard",
      action: "checkout_cart",
      cart_fingerprint: buildCartFingerprint(currentCartItems),
    };

    const { data, error } = await supabase.rpc("rpc_checkout_cart", {
      p_operation_id: checkoutOpId,
      p_request: checkoutRequest,
    });

    if (error) {
      const errMsg = error?.message || "";
      if (errMsg.includes("conflict_in_progress")) {
        console.warn("⏳ [checkout] conflict_in_progress — otra operación en curso. operation_id=", checkoutOpId);
        alert("Hay un pedido en proceso. Esperá unos segundos e intentá nuevamente.");
      } else if (errMsg.includes("operation_id_conflict")) {
        console.warn("🚫 [checkout] operation_id_conflict — carrito modificado entre intentos. Reseteando operation_id.");
        _checkoutOperationId = null;
        alert("El carrito cambió entre intentos. Por favor, intentá nuevamente.");
      } else if (/no tiene variante asociada/i.test(errMsg)) {
        alert(
          "Hay un producto del carrito que ya no está disponible o necesita actualizarse. Eliminá ese producto y volvé a intentar."
        );
      } else {
        console.error("❌ [checkout] Error enviando pedido:", error);
        alert(error.message || "No se pudo enviar el pedido. Intenta nuevamente.");
      }
      clearCartTransientState();
      return;
    }

    if (data?.idempotent_replay === true) {
      console.info("♻️ [checkout] Replay: pedido ya existía — devolviendo resultado previo. order_id=", data?.order_id);
    } else {
      console.info("✅ [checkout] Pedido enviado correctamente. order_id=", data?.order_id, "order_number=", data?.order_number);
    }

    // Checkout exitoso: resetear para que el próximo intento sea una operación nueva.
    _checkoutOperationId = null;

    const checkoutOrderKey = String(
      (data && (data.order_number || data.order_id)) || ""
    ).trim();

    await runCartExitTransition();

    try {
      if (fylAnalytics.isReady()) {
        const lines = fylDashboardCartLinesForGa(currentCartItems);
        const gaItems = fylAnalytics.buildCartItemsFromLines(lines);
        const val = gaItems.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
        fylAnalytics.event("order_submitted", { value: val, item_count: gaItems.length });
      }
    } catch (_e) {}

    pendingCheckoutOrderFeedback = {
      kind: "checkout-success",
      chipText: "Reserva",
      message: "Se agregó a tu pedido y quedó en reserva.",
    };
    window.dispatchEvent(new CustomEvent("cart:synced"));
    await loadCart(currentUserId);
    await loadOrders(currentUserId);
    if (window.showToast) {
      window.showToast("Se agregó a tu pedido y quedó en reserva.", "success");
    }

    if (checkoutOrderKey && typeof window.schedulePwaPromptAfterSuccessfulOrder === "function") {
      window.schedulePwaPromptAfterSuccessfulOrder(checkoutOrderKey);
    }
  } catch (error) {
    console.error("âŒ Error enviando pedido:", error);
    alert("OcurriÃ³ un error inesperado al enviar el pedido.");
  } finally {
    clearCartTransientState();
    releaseSubmitBtnLoading();
    isSubmittingCurrentCart = false;
  }
}

function openPreviousOrdersModal() {
  setHistoryNotificationVisible(false);
  const modal = document.getElementById("previous-orders-modal");
  const modalContent = document.getElementById("modal-orders-content");
  
  if (!modal || !modalContent) {
    console.error("âŒ No se encontrÃ³ el modal de pedidos anteriores");
    return;
  }
  
  // Abrir pantalla historial
  modal.classList.add("active");
  historyVisible = true;
  try {
    document.body.classList.add("history-open");
  } catch (_) {
    /* ignore */
  }

  // Deep-link: ?view=history
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") !== "history") {
      url.searchParams.set("view", "history");
      window.history.replaceState({}, "", url.toString());
    }
  } catch (_) {
    /* ignore */
  }
  
  // Cargar pedidos
  if (!currentUserId) {
    console.error("âŒ currentUserId no estÃ¡ disponible");
    modalContent.innerHTML = `<p style="text-align: center; color: #dc3545; padding: 40px;">Error: No se pudo identificar al usuario.</p>`;
    return;
  }
  
  modalContent.innerHTML = `<p style="text-align: center; color: #666; padding: 40px;">Cargando pedidos anteriores...</p>`;
  fylDevLog("ðŸ“‹ Cargando pedidos anteriores para usuario:", currentUserId);
  loadClosedOrders(currentUserId);
}

function closePreviousOrdersModal() {
  const modal = document.getElementById("previous-orders-modal");
  
  if (!modal) {
    console.error("âŒ No se encontrÃ³ el modal de pedidos anteriores");
    return;
  }
  
  // Cerrar pantalla historial
  modal.classList.remove("active");
  historyVisible = false;
  try {
    document.body.classList.remove("history-open");
  } catch (_) {
    /* ignore */
  }

  // Limpiar deep-link
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") === "history") {
      url.searchParams.delete("view");
      window.history.replaceState({}, "", url.toString());
    }
  } catch (_) {
    /* ignore */
  }
}

function setupModalControls() {
  if (modalControlsInitialized) return;
  
  const modal = document.getElementById("previous-orders-modal");
  const closeBtn = document.getElementById("history-back-btn");
  
  if (!modal || !closeBtn) {
    console.warn("âš ï¸ No se encontraron los elementos del modal");
    return;
  }
  
  modalControlsInitialized = true;
  
  // Volver con flecha
  closeBtn.addEventListener("click", () => {
    closePreviousOrdersModal();
  });
  
  // Cerrar con tecla ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closePreviousOrdersModal();
    }
  });
  
  fylDevLog("âœ… Controles del modal configurados");
}

function setupHistoryControls() {
  if (historyControlsInitialized) {
    fylDevLog("â„¹ï¸ setupHistoryControls ya inicializado, omitiendo...");
    return;
  }

  const toggleBtn = document.getElementById("toggle-history-btn");
  
  if (!toggleBtn) {
    console.warn("âš ï¸ No se encontrÃ³ el botÃ³n de historial, reintentando en 100ms...");
    // Reintentar despuÃ©s de un breve delay
    setTimeout(() => {
      setupHistoryControls();
    }, 100);
    return;
  }

  historyControlsInitialized = true;
  fylDevLog("âœ… Configurando controles del historial");
  syncHistoryNotificationFromStorage();

  // Configurar controles del modal (esto solo se hace una vez)
  setupModalControls();

  // Al hacer clic en "Ver pedidos anteriores", abrir el modal
  toggleBtn.addEventListener("click", () => {
    fylDevLog("ðŸ”˜ BotÃ³n 'Ver pedidos anteriores' presionado");
    setHistoryNotificationVisible(false);
    openPreviousOrdersModal();
  });
  
  fylDevLog("âœ… Event listener agregado al botÃ³n 'Ver pedidos anteriores'");
}

/** Abre/cierra el bottom-sheet de cuenta (#account-trigger / #dash-account-sheet). Antes no tenía listeners. */
function setupAccountSheetControls() {
  if (accountSheetControlsInitialized) return;

  const trigger = document.getElementById("account-trigger");
  const sheet = document.getElementById("dash-account-sheet");
  const backdrop = document.getElementById("account-sheet-backdrop");
  const closeBtn = document.getElementById("account-sheet-close");
  const logoutBtn = document.getElementById("logout-btn");
  const profileLink = sheet?.querySelector('a[href="profile.html"]');

  if (!trigger || !sheet) {
    setTimeout(() => setupAccountSheetControls(), 100);
    return;
  }

  accountSheetControlsInitialized = true;

  function openAccountSheet() {
    sheet.classList.add("is-open");
    sheet.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    try {
      document.body.classList.add("modal-open");
    } catch (_) {
      /* ignore */
    }
  }

  function closeAccountSheet() {
    sheet.classList.remove("is-open");
    sheet.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-expanded", "false");
    try {
      document.body.classList.remove("modal-open");
    } catch (_) {
      /* ignore */
    }
  }

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    if (sheet.classList.contains("is-open")) {
      closeAccountSheet();
    } else {
      openAccountSheet();
    }
  });

  if (backdrop) {
    backdrop.addEventListener("click", () => closeAccountSheet());
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => closeAccountSheet());
  }

  if (profileLink) {
    profileLink.addEventListener("click", () => closeAccountSheet());
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        closeAccountSheet();
        if (supabase?.auth?.signOut) {
          await supabase.auth.signOut();
        }
      } catch (error) {
        console.warn("No se pudo cerrar sesión en dashboard:", error?.message || error);
      } finally {
        window.location.href = "../index.html#/";
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheet.classList.contains("is-open")) {
      closeAccountSheet();
    }
  });
}

// FunciÃ³n para cancelar un producto individual del pedido
async function cancelOrderItem(itemId) {
  try {
    fylDevLog("ðŸ”„ Cancelando producto del pedido:", itemId);

    // Obtener estado actual del item para decidir la acciÃ³n y capturar el order_id
    const { data: itemRow, error: itemErr } = await supabase
      .from("order_items")
      .select("id, order_id, status, quantity, price_snapshot")
      .eq("id", itemId)
      .maybeSingle();

    if (itemErr || !itemRow) {
      console.error("âŒ No se pudo obtener el item del pedido:", itemErr);
      alert("No se encontrÃ³ el producto a cancelar.");
      return;
    }

    const orderId = itemRow.order_id;

    if ((itemRow.status || '').toLowerCase() === 'missing') {
      // Si el item fue marcado faltante por el admin, eliminarlo directamente
      const qty = Number(itemRow.quantity || 0) || 0;
      const price = parseARSNumber(itemRow.price_snapshot || 0);
      const itemTotal = qty * price;

      const { error: delErr } = await supabase
        .from("order_items")
        .delete()
        .eq("id", itemId);
      if (delErr) {
        console.error("âŒ Error eliminando item faltante:", delErr);
        alert("No se pudo eliminar el producto faltante.");
        return;
      }

      if (orderId && itemTotal > 0) {
        const { data: orderData } = await supabase
          .from("orders")
          .select("total_amount")
          .eq("id", orderId)
          .maybeSingle();
        if (orderData) {
          const newTotal = Math.max(0, Number(orderData.total_amount || 0) - itemTotal);
          await supabase
            .from("orders")
            .update({ total_amount: newTotal, updated_at: new Date().toISOString() })
            .eq("id", orderId);
        }
      }

      // Si el pedido queda sin items, eliminar el pedido
      await maybeDeleteEmptyOrder(orderId);

      // Recargar pedidos para mostrar los cambios
      if (currentUserId) {
        await loadOrders(currentUserId);
      }

      alert("âœ… Producto faltante eliminado correctamente del pedido.");
      return;
    }

    // Para otros estados, usar el RPC estÃ¡ndar (puede notificar al admin si estaba picked)
    const { data, error } = await supabase.rpc("rpc_cancel_order_item", {
      p_item_id: itemId,
    });

    if (error) {
      console.error("âŒ Error cancelando producto:", error);
      alert(error.message || "No se pudo cancelar el producto.");
      return;
    }

    fylDevLog("âœ… Producto cancelado correctamente:", data);

    // Si el pedido queda sin items, eliminar el pedido
    await maybeDeleteEmptyOrder(orderId);

    // Recargar pedidos para mostrar los cambios
    if (currentUserId) {
      await loadOrders(currentUserId);
    }

    // Mostrar mensaje segÃºn el estado del producto
    if (data?.was_picked) {
      alert("âœ… Producto cancelado correctamente. Se ha enviado una notificaciÃ³n al administrador ya que este producto estaba apartado.");
    } else {
      alert("âœ… Producto cancelado correctamente.");
    }
  } catch (error) {
    console.error("âŒ Error cancelando producto:", error);
    alert("OcurriÃ³ un error al cancelar el producto.");
  }
}

// Si un pedido no tiene items, eliminarlo para que no quede 'Activo' vacÃ­o
async function maybeDeleteEmptyOrder(orderId) {
  try {
    if (!orderId) return;
    const { count, error: countErr } = await supabase
      .from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId)
      .neq("status", "cancelled");
    if (!countErr && (Number(count) || 0) === 0) {
      const { error: delErr } = await supabase.rpc("rpc_delete_empty_order", { p_order_id: orderId });
      fylDevLog(`ðŸ—‘ï¸ Pedido ${orderId} eliminado por quedar sin productos`);
    }
  } catch (e) {
    console.warn("âš ï¸ No se pudo verificar/eliminar pedido vacÃ­o:", e?.message || e);
  }
}

function isSupabaseRpcMissingError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    err?.code === "PGRST202" ||
    msg.includes("could not find the function") ||
    msg.includes("schema cache")
  );
}

async function closeOrder(orderId, opts = {}) {
  if (!orderId || closeOrderInFlight.has(orderId)) return;
  closeOrderInFlight.add(orderId);
  const triggerBtn = opts.triggerBtn || null;
  const orderCard = triggerBtn?.closest(".dash-order[data-order-id]") || document.querySelector(`.dash-order[data-order-id="${CSS.escape(orderId)}"]`);
  let releaseCloseBtnLoading = () => {};
  try {
    const customerRow = await fetchCustomerShippingRow();
    if (!customerRow) {
      alert(
        "No se pudieron cargar tus datos. Verificá tu conexión e intentá de nuevo."
      );
      return;
    }

    const { data: orderSnap } = await supabase
      .from("orders")
      .select("transport_id")
      .eq("id", orderId)
      .maybeSingle();

    const needTransportStep =
      !customerRow.transport_id && !orderSnap?.transport_id;

    let province = "";
    let city = "";
    let opciones = [];
    if (needTransportStep) {
      province = (customerRow.province || "").trim();
      city = (customerRow.city || "").trim();
      if (!province || !city) {
        await showDashboardMessageModal({
          title: "Completá tu perfil",
          bodyHtml:
            '<p class="dash-app-message-modal__text">Necesitamos tu provincia y localidad para asignar el envío. Entrá a <a href="profile.html">Mi perfil</a>, guardá los datos y volvé a finalizar el pedido.</p>',
          confirmLabel: "Entendido",
        });
        return;
      }

      opciones = getTransportesDisponibles(province, city);
      if (!opciones.length) {
        await showDashboardMessageModal({
          title: "No pudimos calcular el envío",
          bodyHtml:
            '<p class="dash-app-message-modal__text">Revisá provincia y localidad en <a href="profile.html">Mi perfil</a>. Si el problema sigue, escribinos por WhatsApp.</p>',
          confirmLabel: "Entendido",
        });
        return;
      }
    }

    const isPickupOnly =
      needTransportStep &&
      opciones.length === 1 &&
      ["retiro de local", "retiro del local"].includes(
        String(opciones[0] || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
      );

    const confirmClose = await showDashboardConfirmModal({
      title: "¿Cerrar tu pedido?",
      message:
        isPickupOnly
          ? "¿Estás seguro de que querés cerrar tu pedido?"
          : "¿Estás seguro de que querés cerrar tu pedido y que te lo enviemos?",
      confirmLabel: "Sí, enviar",
      cancelLabel: "Cancelar",
    });
    if (!confirmClose) return;
    releaseCloseBtnLoading = setButtonLoading(triggerBtn, "Finalizando...");
    if (orderCard) orderCard.classList.add("is-finalizing");

    let transportOnlyLocal = false;
    if (needTransportStep) {
      const transportResult = await showTransportFinalizeModal({
        province,
        city,
        opciones,
      });
      if (!transportResult.ok) return;

      const { error: trErr } = await supabase.rpc(
        "rpc_set_transport_before_close_order",
        {
          p_order_id: orderId,
          p_transport_name: transportResult.transportName,
        }
      );
      if (trErr) {
        if (isSupabaseRpcMissingError(trErr)) {
          transportOnlyLocal = true;
          guardarTransporteElegido(
            province,
            city,
            transportResult.transportName
          );
          console.warn(
            "rpc_set_transport_before_close_order no está en Supabase; transporte solo en localStorage.",
            trErr
          );
          if (typeof window.showToast === "function") {
            window.showToast(
              "El transporte quedó en este dispositivo. Para guardarlo en tu cuenta, ejecutá en Supabase el SQL: supabase/canonical/134_rpc_set_transport_before_close.sql",
              "info"
            );
          }
        } else {
          console.error("Error guardando transporte:", trErr);
          alert(
            trErr.message || "No se pudo guardar el transporte. Intentá de nuevo."
          );
          return;
        }
      } else {
        guardarTransporteElegido(
          province,
          city,
          transportResult.transportName
        );
      }
    }

    fylDevLog("ðŸ”„ Cerrando pedido:", orderId);

    const { error } = await supabase.rpc("rpc_close_order", {
      p_order_id: orderId,
    });

    if (error) {
      console.error("âŒ Error cerrando pedido:", error);
      alert(error.message || "No se pudo cerrar el pedido.");
      return;
    }

    fylDevLog("âœ… Pedido cerrado correctamente");

    if (orderCard) {
      orderCard.classList.add("is-order-completing");
      await waitMs(prefersReducedMotion() ? 180 : ORDER_COMPLETE_ANIMATION_TOTAL_MS);
      orderCard.classList.remove("is-order-completing");
    }

    pendingCloseOrderFeedbackById.set(orderId, {
      kind: "close-success",
    });
    await loadOrders(currentUserId);

    let successBody = `<p class="dash-app-message-modal__text dash-app-message-modal__text--status-line">Se está <span class="dash-app-status-chip">Preparando pedido</span>.</p><p class="dash-app-message-modal__text">Podrá cambiarlo o modificarlo presionando <strong>Modificar pedido</strong>. Cuando su pedido se envíe, podrá consultarlo en el historial <span class="dash-app-message-modal__clock-wrap" role="img" aria-label="Historial de pedidos">${DASH_MESSAGE_CLOCK_SVG}</span></p>`;
    if (transportOnlyLocal) {
      successBody +=
        '<p class="dash-app-message-modal__text" style="margin-top:14px;">El envío no se registró en el servidor todavía. Ejecutá la migración SQL <strong>134_rpc_set_transport_before_close.sql</strong> en Supabase para que quede guardado en tu cuenta.</p>';
    }

    await showDashboardMessageModal({
      title: "",
      bodyHtml: successBody,
      confirmLabel: "Entendido",
    });
  } catch (error) {
    console.error("âŒ Error cerrando pedido:", error);
    alert("Ocurrió un error al cerrar el pedido.");
    clearOrderVisualTransientState();
  } finally {
    releaseCloseBtnLoading();
    if (orderCard) orderCard.classList.remove("is-finalizing");
    closeOrderInFlight.delete(orderId);
  }
}

async function updateCartItemQuantity(itemId, desiredQuantity) {
  try {
    let newQuantity = Math.floor(Number(desiredQuantity) || 1);
    if (newQuantity <= 0) {
      newQuantity = 1;
    }

    const { data: item, error } = await supabase
      .from("cart_items")
      .select("id, product_name, color, size, quantity, price_snapshot, variant_id")
      .eq("id", itemId)
      .maybeSingle();

    if (error || !item) {
      console.warn("âš ï¸ No se pudo obtener el item del carrito para actualizar.");
      return false;
    }

    const variantInfo = await fetchVariantInfo(
      item.product_name,
      item.color,
      item.size,
      item.variant_id,
      { forceFresh: true }
    );

    if (!variantInfo) {
      alert(
        `No se pudo verificar el stock de ${item.product_name} (${item.color} • ${item.size}).`
      );
      return false;
    }

    const maxAllowed = Math.max(0, Math.floor(Number(variantInfo.available ?? 0) || 0));

    if (maxAllowed <= 0) {
      alert(
        `No hay stock disponible para ${item.product_name} (${item.color} • ${item.size}).`
      );
      return false;
    }

    if (newQuantity > maxAllowed) {
      alert(
        `Solo puedes reservar hasta ${maxAllowed} unidades de ${item.product_name} (${item.color} • ${item.size}).`
      );
      newQuantity = maxAllowed;
    }

    const { error: updateError } = await supabase
      .from("cart_items")
      .update({
        quantity: newQuantity,
        qty: newQuantity,
        variant_id: variantInfo.id,
        price_snapshot:
          item.price_snapshot ?? variantInfo.price ?? item.price_snapshot ?? 0,
      })
      .eq("id", itemId);

    if (updateError) {
      console.error("âŒ Error actualizando cantidad del carrito:", updateError);
      return false;
    }

    window.dispatchEvent(new CustomEvent("cart:synced"));
    return true;
  } catch (error) {
    console.error("âŒ Error actualizando cantidad:", error);
    return false;
  }
}

let isCleaningCart = false;

/**
 * Clave para agrupar solo líneas realmente duplicadas (mismo producto + color + talle).
 * Importante: `product_variants.id` es una fila por color; los talles viven en `variant_sizes`.
 * Por eso la misma variant_id puede tener 37, 38, etc. — no deben fusionarse en una sola línea.
 */
function cartItemDedupeKey(item) {
  const vid =
    item.variant_id != null && item.variant_id !== ""
      ? String(item.variant_id).trim()
      : "";
  const sizeKey =
    normalizeSize(item.size ?? "") || String(item.size ?? "").trim();
  const name = String(item.product_name ?? "").trim();
  const color = String(item.color ?? "").trim();
  if (vid) {
    return `variant:${vid}__sz:${sizeKey}`;
  }
  return `row:${name}__${color}__${sizeKey}`;
}

/**
 * Varias filas duplicadas por bug: si todas tienen la misma cantidad, NO sumar (416+416→832).
 * Si las cantidades difieren, sí sumar (p. ej. líneas legítimas distintas que tocaron el mismo key).
 */
function consolidatedQuantityForDuplicateGroup(primary, duplicates) {
  const rows = [primary, ...duplicates];
  const qtys = rows.map((r) => Number(r.quantity ?? r.qty ?? 0) || 0);
  if (qtys.length === 0) return 0;
  const first = qtys[0];
  const allSame = qtys.every((q) => q === first);
  if (allSame) {
    return first;
  }
  return qtys.reduce((a, b) => a + b, 0);
}

async function cleanupDuplicateCartItems(cartId, items) {
  if (isCleaningCart) return false;

  const groups = new Map();
  items.forEach((item) => {
    const key = cartItemDedupeKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        primary: item,
        duplicates: [],
      });
    } else {
      const group = groups.get(key);
      group.duplicates.push(item);
    }
  });

  let cleaned = false;
  isCleaningCart = true;
  try {
    for (const group of groups.values()) {
      if (group.duplicates.length === 0) continue;

      const idsToDelete = [group.primary, ...group.duplicates]
        .map((row) => row.id)
        .filter(Boolean);

      if (idsToDelete.length === 0) continue;

      const primary = group.primary;
      const totalQty = consolidatedQuantityForDuplicateGroup(
        group.primary,
        group.duplicates
      );

      let resolvedVariantId = primary.variant_id;
      if (resolvedVariantId == null || resolvedVariantId === "") {
        const vi = await fetchVariantInfo(
          primary.product_name,
          primary.color || "Único",
          primary.size,
          null,
          { forceFresh: true }
        );
        resolvedVariantId = vi?.id || null;
      }
      if (!resolvedVariantId) {
        console.warn(
          "No se pudo consolidar duplicados: falta variant_id resoluble para",
          primary?.product_name
        );
        continue;
      }

      // Insertar la fila consolidada ANTES de borrar las duplicadas.
      // Si el insert falla, no borramos: evita carrito vacío en DB con UI mostrando ítems fantasma.
      const { error: insertError } = await supabase.from("cart_items").insert({
        cart_id: cartId,
        product_name: primary.product_name,
        color: primary.color,
        size: normalizeSize(primary.size ?? "") || primary.size,
        quantity: totalQty,
        qty: totalQty,
        price_snapshot: primary.price_snapshot,
        status: primary.status || "reserved",
        imagen: primary.imagen || null,
        variant_id: resolvedVariantId,
      });

      if (insertError) {
        console.warn(
          "âš ï¸ Error insertando item consolidado (duplicados no eliminados):",
          insertError.message
        );
        continue;
      }

      const { error: deleteError } = await supabase
        .from("cart_items")
        .delete()
        .in("id", idsToDelete);

      if (deleteError) {
        console.warn(
          "âš ï¸ Error eliminando duplicados tras consolidar:",
          deleteError.message
        );
      }

      cleaned = true;
    }
  } finally {
    isCleaningCart = false;
  }

  return cleaned;
}

/**
 * Líneas sin variant_id hacen fallar rpc_checkout_cart. Origen típico: sync con carrito
 * local (invitado) o filas antiguas. Intenta resolver y persistir variant_id.
 */
async function repairCartItemsMissingVariantIds(_cartId, items) {
  if (!Array.isArray(items) || !items.length) return;
  for (const row of items) {
    if (!row || (row.variant_id != null && row.variant_id !== "")) continue;
    const vi = await fetchVariantInfo(
      row.product_name,
      row.color || "Único",
      row.size,
      null,
      { forceFresh: true }
    );
    if (!vi?.id) {
      fylDevLog("⚠️ [dashboard] No se pudo reparar variant_id para", row.id, row.product_name);
      continue;
    }
    const { error } = await supabase
      .from("cart_items")
      .update({ variant_id: vi.id })
      .eq("id", row.id);
    if (!error) {
      row.variant_id = vi.id;
    }
  }
}

async function loadCart(userId, options = {}) {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;
  const retryAttempt = Number(options.retryAttempt || 0);
  const maxEmptyRetries = Number(options.maxEmptyRetries || 2);
  const retryDelayMs = Number(options.retryDelayMs || 450);

  function getCartProductsCount(cartItems = []) {
    return cartItems.reduce((sum, item) => {
      const qty = Number(item?.quantity ?? item?.qty ?? 0);
      return sum + (Number.isFinite(qty) ? qty : 0);
    }, 0);
  }

  function formatProductsCount(count) {
    const n = Number(count) || 0;
    return `${n} ${n === 1 ? "producto" : "productos"} en el carrito`;
  }

  function hasLocalCartItems() {
    try {
      const raw = localStorage.getItem("fyl_cart");
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
      const total = parsed.reduce((sum, item) => {
        const qty = Number(item?.cantidad ?? item?.quantity ?? item?.qty ?? 0);
        return sum + (Number.isFinite(qty) ? qty : 0);
      }, 0);
      return total > 0;
    } catch (_error) {
      return false;
    }
  }

  function shouldRetryEmptyState() {
    if (retryAttempt >= maxEmptyRetries) return false;
    let navFromSticky = false;
    try {
      navFromSticky =
        sessionStorage.getItem(DASHBOARD_SCROLL_TO_BAG_ONCE_KEY) === "1";
    } catch (_error) {}
    return navFromSticky || hasLocalCartItems();
  }

  async function retryLoadCartIfNeeded() {
    if (!shouldRetryEmptyState()) return false;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    await loadCart(userId, {
      ...options,
      retryAttempt: retryAttempt + 1,
      maxEmptyRetries,
      retryDelayMs,
    });
    return true;
  }

  try {
    const perfStart =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const { data: cart, error: cartError } = await supabase
      .from("carts")
      .select("id, created_at")
      .eq("customer_id", userId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cartError || !cart) {
      if (await retryLoadCartIfNeeded()) return;
        cartInfo.innerHTML = `
          <p class="empty-cart">
            Todavía no agregaste productos
            <br><span class="subtext">Explorá el catálogo y armá tu pedido</span>
          </p>
          <a href="../index.html" class="btn" style="margin:12px auto 0; display:block; width:fit-content;">Explorar catálogo</a>
        `;
      const cartFooter = document.getElementById("cart-footer");
      if (cartFooter) cartFooter.style.display = "none";
      currentCartId = null;
      currentCartItems = [];
      return;
    }

    currentCartId = cart.id;

    const CART_ITEM_COLS =
      "id, product_name, color, size, quantity, qty, price_snapshot, imagen, status, variant_id";

    let { data: cartItems, error } = await supabase
      .from("cart_items")
      .select(CART_ITEM_COLS)
      .eq("cart_id", cart.id);

      if (error) {
        cartInfo.innerHTML = `
          <h3>Carrito Actual</h3>
          <p style="color: #dc3545;">Error cargando carrito</p>
        `;
      return;
    }

    cartItems = cartItems || [];

    await repairCartItemsMissingVariantIds(cart.id, cartItems);

    const cleaned = await cleanupDuplicateCartItems(cart.id, cartItems);
    if (cleaned) {
      await loadCart(userId);
      return;
    }

    // Precargar SKUs para que "Ver producto" en carrito vaya al PDP real
    await ensureVariantSkusLoaded(cartItems.map((it) => it?.variant_id).filter(Boolean));

    if (!cartItems || cartItems.length === 0) {
      if (await retryLoadCartIfNeeded()) return;
        cartInfo.innerHTML = `
          <p class="empty-cart">
            Todavía no agregaste productos
            <br><span class="subtext">Explorá el catálogo y armá tu pedido</span>
          </p>
          <a href="../index.html" class="btn" style="margin:12px auto 0; display:block; width:fit-content;">Explorar catálogo</a>
        `;
      const cartFooter = document.getElementById("cart-footer");
      if (cartFooter) cartFooter.style.display = "none";
      currentCartId = null;
      currentCartItems = [];
      return;
    }

    const enrichedItems = await Promise.all(
      cartItems.map(async (item) => {
        const resolvedImage = await resolveItemImage(item);
        const variantInfo = await fetchVariantInfo(
          item.product_name,
          item.color,
          item.size,
          item.variant_id
        );
        const qtyValue = Number(item.quantity ?? item.qty ?? 0) || 0;
        
        // Verificar stock REAL disponible (sin contar lo que estÃ¡ en el carrito del usuario)
        // El stock disponible es: stock_qty - reserved_qty
        // No restamos qtyValue porque los productos en el carrito NO estÃ¡n reservados aÃºn
        const realAvailableStock = variantInfo
          ? Math.max(0, variantInfo.available ?? 0)
          : 0;
        
        // Si la cantidad en el carrito es mayor que el stock disponible REAL, estÃ¡ agotado
        const isOutOfStock = qtyValue > realAvailableStock;
        
        const remainingStock = Math.max(0, realAvailableStock - qtyValue);
        // Tope seleccionable = stock real (si hay más unidades en bolsa que stock, el desplegable debe ir hasta este máximo)
        const maxQty = Math.max(0, Math.floor(realAvailableStock));

        return {
          ...item,
          resolvedImage,
          variantInfo,
          maxQty,
          remainingStock,
          isOutOfStock,
          realAvailableStock,
        };
      })
    );

    currentCartItems = enrichedItems;

    // Verificar si hay productos agotados
    const hasOutOfStockItems = enrichedItems.some(item => item.isOutOfStock);
    
    const cartFooter = document.getElementById("cart-footer");
    if (cartFooter) {
      if (enrichedItems.length > 0) {
        cartFooter.style.display = "block";
        
        // Deshabilitar botÃ³n de envÃ­o si hay productos agotados
        const submitBtn = document.getElementById("submit-cart-btn");
        if (submitBtn) {
          if (hasOutOfStockItems) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = "0.5";
            submitBtn.style.cursor = "not-allowed";
            submitBtn.title = "No puedes enviar el pedido mientras haya productos agotados. Elimina los productos agotados para continuar.";
            fylDevLog("ðŸ”´ BotÃ³n de envÃ­o deshabilitado - hay productos agotados");
      } else {
            submitBtn.disabled = false;
            submitBtn.style.opacity = "1";
            submitBtn.style.cursor = "pointer";
            submitBtn.title = "";
            fylDevLog("ðŸŸ¢ Botones de carrito visibles y habilitados");
          }
        }
        
        // Sin banner global extra: el aviso queda solo en cada ítem (p. ej. Máx. N disponibles).
        document.getElementById("cart-actions")?.querySelector(".out-of-stock-warning")?.remove();
        cartFooter
          .querySelector(".dash-bolsa-sticky-inner")
          ?.querySelector(":scope > .out-of-stock-warning")
          ?.remove();
      } else {
        cartFooter.style.display = "none";
      }
    }

    // Obtener ofertas y promociones para los items del carrito
    const offersData = await getOffersAndPromotionsForItems(enrichedItems);
    if (window.FYL_DEBUG_CATALOG === true || window.FYL_DEBUG_DASHBOARD_PERF === true) {
      const perfEnd =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      console.debug("[perf][dashboard] loadCart_ms", Math.round(perfEnd - perfStart), {
        items: enrichedItems.length,
      });
    }
    
    const totalUnits = getCartProductsCount(enrichedItems);

    const totalPrice = enrichedItems.reduce((sum, item) => {
      const qty = Number(item.quantity ?? item.qty ?? 0);
      // Preferir precio actual de la variante para que el total sea siempre cantidad × precio unitario actual
      const price = parseARSNumber(item.variantInfo?.price ?? item.price_snapshot ?? 0);
      return sum + (Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0);
    }, 0);

    const itemsHtml = enrichedItems
      .map((item) => {
        const itemKey = item.id || `${item.product_name}-${item.color}-${item.size}`;
        const promoText = offersData.itemPromos?.get(itemKey);
        const offerInfo = offersData.itemOffers?.get(itemKey);
        
        const qty = Number(item.quantity ?? item.qty ?? 0) || 0;
        // Preferir precio actual de la variante para que Total = cantidad × precio unitario correcto
        let price = parseARSNumber(item.variantInfo?.price ?? item.price_snapshot ?? 0);
        let originalPrice = null;
        
        if (promoText) {
          originalPrice = price;
        } else if (offerInfo) {
          originalPrice = offerInfo.originalPrice;
          price = offerInfo.offerPrice;
        }
        
        const lineTotal = qty * price;
        const thumb = item.resolvedImage || FALLBACK_IMAGE;
        const productName = item.product_name || "Producto";
        const colorFull = item.color || "Color único";
        const color = abbreviateColorLabel(colorFull);
        const size = item.size || "Talle único";
        const maxQty = Math.max(0, Math.floor(Number(item.maxQty) || 0));
        const remainingStock =
          Math.max(0, Math.floor(Number(item.remainingStock) || 0)) || 0;
        const isOutOfStock = item.isOutOfStock || false;
        const realAvailableStock = item.realAvailableStock || 0;
        
        // Mostrar leyenda de oferta o promoción
        let offerPromoBadge = '';
        if (promoText) {
          offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #ff9800; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">${promoText}</div>`;
        } else if (offerInfo) {
          offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #e74c3c; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">Oferta</div>`;
        }
        
        // Estilos para producto agotado (tonos rosas)
        const outOfStockStyles = isOutOfStock
          ? `background: #fce4ec; border: 2px solid #f48fb1; opacity: 0.9;`
          : ``;
        const outOfStockTextStyles = isOutOfStock
          ? `color: #c2185b; font-weight: 600;`
          : ``;

        const unitPriceFormatted = price.toLocaleString('es-AR');
        const unitPriceMeta = `· $${unitPriceFormatted} c/u`;
        
        return `
          <div class="dash-bolsa-item ${isOutOfStock ? 'cart-item-out-of-stock' : ''}" style="${outOfStockStyles}" data-item-id="${item.id}">
            <div class="dash-bolsa-item__row1">
              <img src="${thumb}" alt="${productName}" class="dash-bolsa-item__thumb" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" style="opacity: ${isOutOfStock ? '0.6' : '1'};">
              <div class="dash-bolsa-item__main">
                <div class="dash-bolsa-item__head">
                  <div class="dash-bolsa-item__line1">
                    <span class="dash-bolsa-item__title" style="${outOfStockTextStyles}">
                      <span class="dash-bolsa-item__title-main">${productName} · ${color}</span>
                      <span class="dash-bolsa-item__title-group">
                        <span class="dash-bolsa-item__title-sep" aria-hidden="true">·</span>
                        <span class="dash-bolsa-item__title-size">${size}</span>
                        ${isOutOfStock ? `
                          <span class="dash-bolsa-item__alt-sep" aria-hidden="true">·</span>
                          <button type="button" class="btn-ver-alternativas dash-bolsa-item__alt-link"
                                  data-articulo="${productName}" 
                                  data-color="${colorFull}" 
                                  data-talle="${size}"
                                  data-item-id="${item.id}">
                            Ver alternativas
                          </button>
                        ` : ""}
                      </span>
                    </span>
                  </div>
                  <div class="dash-bolsa-item__right order-item-actions">
                    <span class="dash-bolsa-item__price item-row__price-total" style="${outOfStockTextStyles}">$${lineTotal.toLocaleString('es-AR')}</span>
                    <div class="item-row__menu-wrap">
                      <button type="button" class="item-row__kebab" aria-label="Opciones" aria-haspopup="true" aria-expanded="false">⋯</button>
                      <div class="item-row__popover" role="menu" aria-hidden="true">
                        <button type="button" class="item-row__menuitem item-row__menuitem--danger" data-action="remove-bag-item" data-id="${item.id}">Quitar de la bolsa</button>
                        <a href="${buildCatalogHrefFromVariantOrName(item.variant_id || item.variantInfo?.id, productName)}" class="item-row__menuitem" data-action="view-product">Ver producto</a>
                      </div>
                    </div>
                  </div>
                </div>
                ${offerPromoBadge}
                ${isOutOfStock ? `
                <div class="dash-bolsa-item__stock-row">
                  <div class="dash-bolsa-item__out-of-stock-msg">
                    <span>⚠ Máx. ${realAvailableStock} disponibles</span>
                  </div>
                </div>
                ` : ""}
                <div class="dash-bolsa-item__line2">
                  <select class="cart-qty-select dash-bolsa-item__qty-select" data-id="${item.id}" data-max="${maxQty}" data-current-qty="${qty}" aria-label="Cantidad">
                    ${buildDashBolsaQtySelectOptions(qty, maxQty)}
                  </select>
                  <span class="dash-bolsa-item__unit-price">${unitPriceMeta}</span>
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join("");
    
    // Agregar resumen de descuentos si hay
    let discountSummaryHtml = '';
    if (offersData.totalDiscount > 0) {
      discountSummaryHtml = `
        <div style="margin-top: 12px; padding: 12px; background: #fff3e0; border-left: 4px solid #ff9800; border-radius: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong style="font-size: 15px;">Ofertas y promociones</strong>
              <div style="font-size: 14px; color: #ff9800; margin-top: 4px; font-weight: 600;">
                Descuento: -$${offersData.totalDiscount.toLocaleString('es-AR')}
              </div>
            </div>
          </div>
        </div>
      `;
    }

    const displayTotal = offersData.totalDiscount > 0 ? totalPrice - offersData.totalDiscount : totalPrice;
        cartInfo.innerHTML = `
      <p class="dash-bolsa-hint" aria-hidden="true">
        Enviá el pedido para reservarlos.
      </p>
      <div class="cart-items-list dash-bolsa-list">
        ${itemsHtml}
      </div>
      ${discountSummaryHtml}
    `;

    attachRemoveHandlers(userId);
    attachBolsaPopoverCloseOnOutsideClick();
    attachQuantityHandlers(userId);
    attachAlternativasHandlers(userId);

    const cartTotalValue = document.getElementById("cart-total-value");
    if (cartTotalValue) cartTotalValue.textContent = `$${displayTotal.toLocaleString("es-AR")}`;

    const cartProductsCount = document.getElementById("cart-products-count");
    if (cartProductsCount) cartProductsCount.textContent = formatProductsCount(totalUnits);
    const submitBtn = document.getElementById("submit-cart-btn");
    if (submitBtn) submitBtn.textContent = "Hacer pedido";

    // Actualizar almacenamiento local para mantener sincronizados catálogo y dashboard
    try {
      const storageItems = enrichedItems.map((item) => ({
        id: item.id,
        articulo: item.product_name,
        color: item.color,
        talle: item.size,
        cantidad: Number(item.quantity ?? item.qty ?? 0) || 0,
        precio:
          parseARSNumber(item.price_snapshot ?? item.variantInfo?.price ?? 0),
        imagen: item.imagen || item.resolvedImage || null,
        descripcion: null,
        variant_id: item.variant_id || item.variantInfo?.id || null,
      }));
      window.localStorage.setItem("fyl_cart", JSON.stringify(storageItems));
    } catch (storageError) {
      console.warn("âš ï¸ No se pudo actualizar el carrito local:", storageError);
    }
  } catch (error) {
    console.warn("âš ï¸ Error cargando carrito:", error.message);
      cartInfo.innerHTML = `
        <h3>Carrito Actual</h3>
        <p style="color: #dc3545;">Error cargando carrito</p>
      `;
  }
}

async function loadOrders(userId, options = {}) {
  const ordersSection = document.getElementById("orders-section");
  if (!ordersSection) return;
  currentOrderUiStateById.clear();

  function getOrderStatusSummary(orderItems = []) {
    const normStatus = (s) => String(s || "").toLowerCase().trim();
    // Los ítems confirmados manualmente (missing + admin_confirmed_missing, o picked +
    // admin_confirmed_missing) son operativamente equivalentes a "confirmado":
    // el admin garantizó que la unidad existe físicamente.
    const isManualConfirmed = (item) => Boolean(item?.admin_confirmed_missing);
    const counters = {
      confirmed: 0, // picked o confirmado manual
      pending: 0,   // reserved/waiting
      missing: 0,   // missing real (sin stock, sin confirmación manual)
    };

    orderItems.forEach((item) => {
      if (!item || normStatus(item.status) === "cancelled") return;
      const qty = Math.max(0, Number(item.quantity || 0) || 0);
      const st = normStatus(item.status);

      // Confirmación manual: cuenta como confirmado sin importar el status (missing o picked)
      if (isManualConfirmed(item)) {
        counters.confirmed += qty;
        return;
      }
      if (st === "missing") {
        counters.missing += qty;
        return;
      }
      if (st === "picked") {
        counters.confirmed += qty;
        return;
      }
      // reserved / waiting / otros → pendiente
      counters.pending += qty;
    });

    const formatPart = (count, singular, plural) =>
      `${count} ${count === 1 ? singular : plural}`;

    const hasConfirmed = counters.confirmed > 0;
    const hasPending = counters.pending > 0;
    const hasMissing = counters.missing > 0;

    if (hasMissing) {
      if (hasConfirmed) {
        return `${formatPart(counters.confirmed, "confirmado", "confirmados")} · ${formatPart(counters.missing, "sin stock", "sin stock")}`;
      }
      if (hasPending) {
        return `${formatPart(counters.pending, "pendiente", "pendientes")} · ${formatPart(counters.missing, "sin stock", "sin stock")}`;
      }
      return formatPart(counters.missing, "sin stock", "sin stock");
    }

    if (hasConfirmed && hasPending) {
      return `${formatPart(counters.confirmed, "confirmado", "confirmados")} · ${formatPart(counters.pending, "pendiente", "pendientes")}`;
    }
    if (hasConfirmed) {
      return formatPart(counters.confirmed, "confirmado", "confirmados");
    }
    if (hasPending) {
      return formatPart(counters.pending, "pendiente", "pendientes");
    }
    return "Sin productos";
  }

  try {
    // Evitar ejecutar mantenimiento en ráfagas realtime.
    const shouldRunMaintenance = shouldRunOrdersMaintenance(options?.forceMaintenance === true);
    if (DASH_ENABLE_ORDERS_MAINTENANCE && shouldRunMaintenance && ordersMaintenanceRpcAvailable) {
      try {
        await supabase.rpc("rpc_orders_daily_maintenance");
      } catch (e) {
        const msg = String(e?.message || e || "");
        const code = String(e?.code || "");
        if (code === "PGRST202" || /rpc_orders_daily_maintenance/i.test(msg)) {
          ordersMaintenanceRpcAvailable = false;
          fylDevLog(
            "ℹ️ rpc_orders_daily_maintenance no disponible en este entorno; se omite en siguientes cargas."
          );
        } else {
          console.warn("rpc_orders_daily_maintenance:", msg);
        }
      }
    }

    // Mi pedido: traer primero solo metadata para evitar payload grande de items históricos.
    const { data: ordersMetaRaw, error } = await supabase
      .from("orders")
      .select("id, order_number, status, total_amount, created_at, updated_at, expires_at, dismantle_at")
      .eq("customer_id", userId)
      .in("status", ["active", "closing_soon", "closed"])
      .order("created_at", { ascending: false });

    const statusRank = (s) => {
      const x = String(s || "").toLowerCase().trim();
      if (x === "active") return 0;
      if (x === "closing_soon") return 1;
      return 2;
    };
    replaceKnownOrderIds(ordersMetaRaw || []);
    const ordersMeta = (ordersMetaRaw || [])
      .slice()
      .sort((a, b) => {
        const ra = statusRank(a.status);
        const rb = statusRank(b.status);
        if (ra !== rb) return ra - rb;
        return new Date(b.created_at) - new Date(a.created_at);
      });

    const selectedOrder = ordersMeta[0] || null;

    if (error) {
      ordersSection.innerHTML = `
        <div class="order-item" style="border:1px solid #f5c6cb; background:#f8d7da; padding:16px; border-radius:8px;">
          <p style="color:#721c24; margin:0;">Error cargando pedidos activos.</p>
        </div>
        `;
      currentOrderUiStateById.clear();
      clearOrderDeadlineSyntheticNotifications();
      return;
    }

    if (!selectedOrder) {
      replaceKnownOrderIds([]);
      currentOrderUiStateById.clear();
      ordersSection.innerHTML = `
        <div class="order-item" style="border:1px solid #e0e0e0; padding:16px; border-radius:8px; background:#fafafa;">
          <div class="section-title dash-title" style="margin-bottom:12px;">📦 Mi pedido</div>
          <p style="margin:0;">Todavía no tienes pedidos. Envía tu carrito para crear uno nuevo.</p>
        </div>
      `;
      clearOrderDeadlineSyntheticNotifications();
      return;
    }

    lastOrderDeadlineReminderContext = null;
    lastOrderExpiredPendingDisassemblyContext = null;

    const { data: selectedItemsRaw, error: selectedItemsError } = await supabase
      .from("order_items")
      .select("id, order_id, product_name, color, size, quantity, price_snapshot, imagen, status, admin_confirmed_missing, variant_id")
      .eq("order_id", selectedOrder.id);
    if (selectedItemsError) {
      console.warn("⚠️ Error cargando items del pedido activo:", selectedItemsError.message || selectedItemsError);
    }
    const orders = [
      {
        ...selectedOrder,
        order_items: Array.isArray(selectedItemsRaw) ? selectedItemsRaw : [],
      },
    ];
    const selectedVisibleItems = getOrderNonCancelledItems(orders[0]).filter(
      (item) => Math.max(0, Number(item?.quantity || 0) || 0) > 0
    );
    if (selectedVisibleItems.length === 0) {
      currentOrderUiStateById.clear();
      ordersSection.innerHTML = `
        <div class="order-item" style="border:1px solid #e0e0e0; padding:16px; border-radius:8px; background:#fafafa;">
          <div class="section-title dash-title" style="margin-bottom:12px;">📦 Mi pedido</div>
          <p style="margin:0;">No tienes productos en tu pedido actual.</p>
        </div>
      `;
      clearOrderDeadlineSyntheticNotifications();
      return;
    }

    // Precargar SKUs para que "Ver producto" vaya al PDP real (index#/pdp/<sku>)
    const allVariantIds = [];
    for (const o of orders) {
      for (const it of (o?.order_items || [])) {
        if (it?.variant_id) allVariantIds.push(it.variant_id);
      }
    }
    await ensureVariantSkusLoaded(allVariantIds);

    function formatOrderPrice(num) {
      return (
        "$" +
        Math.round(Number(num) || 0).toLocaleString("es-AR", {
          maximumFractionDigits: 0,
        })
      );
    }

    const ordersHtml = await Promise.all(orders.map(async (order) => {
        const items = order.order_items || [];
        const orderStatus = (order.status || "").toLowerCase().trim();
        const isActive = orderStatus === "active";
        const isClosingSoon = orderStatus === "closing_soon";
        const isClosed = orderStatus === "closed";
        const uiState = deriveOrderUiState(order);
        currentOrderUiStateById.set(order.id, uiState);
        
        // Calcular total excluyendo items faltantes (con precios normalizados)
        const validItems = items.filter((item) => {
          const isMissing = String(item?.status || "").toLowerCase().trim() === "missing";
          return !isMissing || Boolean(item?.admin_confirmed_missing);
        });
        const total = validItems.reduce((sum, item) => {
          const qty = Number(item.quantity || 0) || 0;
          const price = orderItemUnitForDisplay(item);
          return sum + (qty * price);
        }, 0);
        
        // Obtener nÃºmero de pedido o usar ID como fallback
        const orderDisplayNumber = order.order_number || order.id.substring(0, 8);
        
        // Determinar el estado a mostrar
        let statusLabel = "Activo";
        let statusStyle = "background:#e6f4ea; color:#1b5e20;";
        
        if (isClosingSoon) {
          statusLabel = "Cierre próximo";
          statusStyle = "background:#fff4e0; color:#b45309;";
        } else if (isActive) {
          statusLabel = "Activo";
          statusStyle = "background:#e6f4ea; color:#1b5e20;";
        }
        const visibleItems = getOrderNonCancelledItems(order);
        const normStatus = (s) => (String(s || "").toLowerCase().trim());
        /**
         * Espera (waiting) es solo interno; el cliente ve todo como reserva.
         * admin_confirmed_missing=true: el admin garantizó la unidad → el cliente
         * lo ve como "picked" (Listo), sea cual sea el status técnico.
         * Acepta el ítem completo (objeto) o solo el status (string).
         */
        const clientVisibleStatus = (itemOrStatus) => {
          const isObj = itemOrStatus !== null && typeof itemOrStatus === "object";
          const n = normStatus(isObj ? itemOrStatus.status : itemOrStatus);
          if (n === "waiting") return "reserved";
          if (n === "missing" && isObj && Boolean(itemOrStatus.admin_confirmed_missing)) return "picked";
          return n;
        };
        const missingItemsReal = visibleItems.filter(
          (item) => normStatus(item.status) === "missing" && !Boolean(item.admin_confirmed_missing)
        );
        const missingItemsManual = visibleItems.filter(
          (item) => normStatus(item.status) === "missing" && Boolean(item.admin_confirmed_missing)
        );
        const itemsForGroups = visibleItems.filter(
          (item) => !(normStatus(item.status) === "missing" && !Boolean(item.admin_confirmed_missing))
        );

        const groupsMap = new Map();
        itemsForGroups.forEach((item) => {
          const key = `${(item.product_name || "Producto").trim()}|${(item.color || "Color unico").trim()}`;
          if (!groupsMap.has(key)) groupsMap.set(key, []);
          groupsMap.get(key).push(item);
        });

        const groupedItems = Array.from(groupsMap.values());
        const groupedHtml = groupedItems
          .map((group) => {
            const base = group[0];
            const productName = base.product_name || "Producto";
            const color = abbreviateColorLabel(base.color || "Color unico");
            const totalQty = group.reduce((sum, g) => sum + (Number(g.quantity || 0) || 0), 0);
            const lineTotal = group.reduce((sum, g) => {
              const qty = Number(g.quantity || 0) || 0;
              const price = orderItemUnitForDisplay(g);
              return sum + qty * price;
            }, 0);
            const unitPrice =
              totalQty > 0 ? lineTotal / totalQty : orderItemUnitForDisplay(base);

            // Agrupar por combinación talla + estado para mostrar cada una como sublínea independiente
            const sizeStatusMap = new Map();
            group.forEach((g) => {
              const size = g.size || "Unico";
              const st = clientVisibleStatus(g); // pasa el ítem completo para evaluar admin_confirmed_missing
              const key = `${size}|${st || "reserved"}`;
              const qty = Number(g.quantity || 0) || 0;
              if (!sizeStatusMap.has(key)) {
                sizeStatusMap.set(key, { size, status: st || "reserved", qty: 0 });
              }
              sizeStatusMap.get(key).qty += qty;
            });

            const sizeStatusList = Array.from(sizeStatusMap.values());
            sizeStatusList.sort((a, b) => {
              const na = Number(a.size), nb = Number(b.size);
              if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
              const sa = String(a.size), sb = String(b.size);
              if (sa !== sb) return sa.localeCompare(sb);
              // Ordenar estados: apartado, reserva (incluye ex-waiting), sin stock
              const order = { picked: 0, reserved: 1, missing: 2 };
              const ra = order[a.status] ?? 99;
              const rb = order[b.status] ?? 99;
              return ra - rb;
            });

            const distinctSizes = Array.from(new Set(sizeStatusList.map((s) => String(s.size))));
            const multiSize = distinctSizes.length > 1;
            const hasMultipleVariants = sizeStatusList.length > 1;

            const sizeLabel = String(distinctSizes[0] || "").trim();
            const normSize = sizeLabel
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .trim();
            const isUniqueSize =
              normSize === "unico" ||
              normSize === "talle unico" ||
              normSize === "talle unico." ||
              normSize === "talle: unico" ||
              normSize === "talle unico (unico)";

            const showInlineSize = !multiSize && sizeLabel && !isUniqueSize;

            const titleHtml = showInlineSize
              ? `<span class="item-row__title-name">${productName}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-color">${color}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-size">${sizeLabel}</span>`
              : `<span class="item-row__title-name">${productName}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-color">${color}</span>`;

            const sizeHtml =
              !multiSize && sizeLabel && !showInlineSize
                ? `<div class="item-row__variant-size">${sizeLabel}${totalQty > 1 ? ` · x ${totalQty} unidades` : ""}</div>`
                : "";

            const orderItemIds = group.map((g) => g.id).filter(Boolean).join(",");

            // El status ya viene normalizado por clientVisibleStatus:
            // "missing + admin_confirmed_missing" ya se convirtió en "picked".
            function getStatusMeta(status) {
              const st = normStatus(status);
              if (st === "picked") {
                return {
                  className: "item-row__status--st-picked",
                  text: "Listo",
                  info: "Listo: el producto ya se encuentra en su pedido.",
                };
              }
              if (st === "missing") {
                return {
                  className: "item-row__status--st-missing",
                  text: "Sin stock",
                  info: "Esta unidad no tiene stock disponible.",
                };
              }
              // reserved u otros
              return {
                className: "item-row__status--st-reserved",
                text: "Reserva",
                info: "El vendedor está confirmando el stock.",
              };
            }

            // Estado principal del grupo (se muestra en la fila principal)
            const groupStatuses = new Set(group.map((g) => clientVisibleStatus(g)));
            let mainStatus = "reserved";
            if (groupStatuses.size === 1) {
              mainStatus = groupStatuses.values().next().value || "reserved";
            } else if (groupStatuses.has("reserved")) {
              mainStatus = "reserved";
            } else if (groupStatuses.has("picked")) {
              mainStatus = "picked";
            } else if (groupStatuses.has("missing")) {
              mainStatus = "missing";
            }

            const mainMeta = getStatusMeta(mainStatus);
            const statusPicked = `<span class="item-row__status ${mainMeta.className}" data-status-info="${mainMeta.info.replace(/"/g, "&quot;")}" tabindex="0" role="button"><span class="item-row__status-full">${mainMeta.text}</span><span class="item-row__status-short">${mainMeta.text}</span></span><div class="item-row__status-tooltip" aria-hidden="true"></div>`;

            const subitemLabel = (s) => `${color} · ${s.size} x${s.qty}`;
            const sizesLineHtml = hasMultipleVariants
              ? sizeStatusList
                  .map((s) => {
                    const meta = getStatusMeta(s.status);
                    return `<div class="item-row__size-subitem"><span class="item-row__size-subitem-label">${subitemLabel(s)}</span><span class="item-row__size-subitem-spacer" aria-hidden="true"></span><span class="item-row__size-subitem-badge ${meta.className}">${meta.text}</span></div>`;
                  })
                  .join("")
              : "";

            return `
              <div class="item-row item-row--order">
                <div class="item-row__left">
                  <img class="item-row__thumb" src="${base.imagen || FALLBACK_IMAGE}" alt="${productName}" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
                  <div class="item-row__body">
                    <div class="item-row__line1">
                      <div class="item-row__title">${titleHtml}</div>
                    </div>
                    ${sizeHtml}
                    <div class="item-row__line2">
                      <div class="item-row__order-meta">${totalQty} uni · ${formatOrderPrice(unitPrice)} c/u</div>
                    </div>
                  </div>
                </div>
                <div class="item-row__right">
                  <div class="item-row__col-toggle">${multiSize ? `<button type="button" class="item-row__sizes-toggle" aria-expanded="false">▾</button>` : ""}</div>
                  <div class="item-row__col-status">${statusPicked}</div>
                  <span class="item-row__price-total">${formatOrderPrice(lineTotal)}</span>
                  ${
                    uiState.canEdit
                      ? `<div class="item-row__menu-wrap">
                          <button type="button" class="item-row__kebab" aria-label="Opciones" aria-haspopup="true" aria-expanded="false">⋯</button>
                          <div class="item-row__popover" role="menu" aria-hidden="true">
                            <button type="button" class="item-row__menuitem item-row__menuitem--danger" data-action="remove-order-item" data-order-item-ids="${orderItemIds.replace(/"/g, "&quot;")}">Quitar del pedido</button>
                            <a href="${buildCatalogHrefFromVariantOrName(base.variant_id, productName)}" class="item-row__menuitem" data-action="view-product">Ver producto</a>
                          </div>
                        </div>`
                      : `<span class="item-row__kebab item-row__kebab--static" aria-hidden="true">⋯</span>`
                  }
                </div>
                ${multiSize ? `<div class="item-row__sizes-line" hidden>${sizesLineHtml}</div>` : ""}
              </div>
            `;
          })
          .join("");

        const missingCardsHtml = missingItemsReal
          .map((m) => {
            const productName = m.product_name || "Producto";
            const color = abbreviateColorLabel(m.color || "Color unico");
            const size = m.size || "Unico";
            const sizeLabel = String(m.size || "").trim();
            const qty = Number(m.quantity || 0) || 1;
            const unitPrice = orderItemUnitForDisplay(m);
            const lineTotal = qty * unitPrice;
            const normSize = sizeLabel
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .trim();
            const isUniqueSize =
              normSize === "unico" ||
              normSize === "talle unico" ||
              normSize === "talle unico." ||
              normSize === "talle: unico" ||
              normSize === "talle unico (unico)";
            const showInlineSize = Boolean(sizeLabel) && !isUniqueSize;

            const titleHtml = showInlineSize
              ? `<span class="item-row__title-name">${productName}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-color">${color}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-size">${sizeLabel}</span>`
              : `<span class="item-row__title-name">${productName}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-color">${color}</span>`;

            const sizeHtml =
              sizeLabel && !showInlineSize
                ? `<div class="item-row__variant-size">${sizeLabel}${qty > 1 ? ` · x ${qty} unidades` : ""}</div>`
                : "";
            const missingMeta = { className: "item-row__status--st-missing", text: "Sin stock", info: "Esta unidad no tiene stock disponible." };
            const statusHtml = `<span class="item-row__status ${missingMeta.className}" data-status-info="${missingMeta.info.replace(/"/g, "&quot;")}" tabindex="0" role="button"><span class="item-row__status-full">${missingMeta.text}</span><span class="item-row__status-short">${missingMeta.text}</span></span><div class="item-row__status-tooltip" aria-hidden="true"></div>`;
            return `
              <div class="item-row item-row--order item-row--missing-standalone">
                <div class="item-row__left">
                  <img class="item-row__thumb" src="${m.imagen || FALLBACK_IMAGE}" alt="${productName}" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
                  <div class="item-row__body">
                    <div class="item-row__line1">
                      <div class="item-row__title">${titleHtml}</div>
                    </div>
                    ${sizeHtml}
                    <div class="item-row__line2">
                      <div class="item-row__order-meta">${qty} uni · ${formatOrderPrice(unitPrice)} c/u</div>
                    </div>
                  </div>
                </div>
                <div class="item-row__right">
                  <div class="item-row__col-toggle"></div>
                  <div class="item-row__col-status">${statusHtml}</div>
                  <span class="item-row__price-total">${formatOrderPrice(lineTotal)}</span>
                  ${
                    uiState.canEdit
                      ? `<div class="item-row__menu-wrap">
                          <button type="button" class="item-row__kebab" aria-label="Opciones" aria-haspopup="true" aria-expanded="false">⋯</button>
                          <div class="item-row__popover" role="menu" aria-hidden="true">
                            <button type="button" class="item-row__menuitem item-row__menuitem--danger" data-action="remove-order-item" data-order-item-ids="${(m.id || "").replace(/"/g, "&quot;")}">Quitar del pedido</button>
                            <a href="../index.html?similares=1&articulo=${encodeURIComponent(productName)}&talle=${encodeURIComponent(size)}" class="item-row__menuitem" data-action="view-similares">Ver similares</a>
                            <a href="${buildCatalogHrefFromVariantOrName(m.variant_id, productName)}" class="item-row__menuitem" data-action="view-product">Ver producto</a>
                          </div>
                        </div>`
                      : `<span class="item-row__kebab item-row__kebab--static" aria-hidden="true">⋯</span>`
                  }
                </div>
              </div>
            `;
          })
          .join("");

        const itemsHtmlAll = missingCardsHtml + groupedHtml;

        const daysRemaining = orderDaysRemaining(order.created_at, order.dismantle_at);

        const totalUnits = visibleItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
        const allPickedForOrder = visibleItems.length > 0 && visibleItems.every((item) => (item.status || "").toLowerCase() === "picked");
        const hasReservedInOrder = visibleItems.some((item) => {
          const s = (item.status || "").toLowerCase();
          return s === "reserved" || s === "waiting";
        });
        // Solo los missing reales bloquean el flujo del cliente (los manuales son confirmados).
        const hasMissingItems = missingItemsReal.length > 0;
        // Regla UX: 4+ productos habilita, y los items "reservados" no bloquean.
        const canFinalize = totalUnits >= MIN_UNITS_TO_FINALIZE && !hasMissingItems && (allPickedForOrder || hasReservedInOrder);
        const finalizeBtnClass = canFinalize ? "btn-finalize-order--enabled" : "btn-finalize-order--disabled";
        const finalizeBtnText =
          totalUnits < MIN_UNITS_TO_FINALIZE
            ? `${Math.max(0, totalUnits)} de ${MIN_UNITS_TO_FINALIZE} productos`
            : "Finalizar pedido";
        const missingForFinalize = Math.max(0, MIN_UNITS_TO_FINALIZE - totalUnits);
        let finalizeTitle = "";
        if (hasMissingItems) {
          finalizeTitle = "Para finalizar el pedido elimine o cambie el producto sin stock.";
        } else if (totalUnits < MIN_UNITS_TO_FINALIZE && missingForFinalize > 0) {
          finalizeTitle = missingForFinalize === 1 ? "Te falta 1 par para cerrar el pedido" : `Te faltan ${missingForFinalize} pares para cerrar el pedido`;
        } else if (!allPickedForOrder && !hasReservedInOrder) {
          finalizeTitle = "Para finalizar el pedido debe esperar a que el vendedor confirme el stock de la reserva.";
        }

        if ((isActive || isClosingSoon) && !uiState.isReadOnly) {
          lastOrderDeadlineReminderContext = {
            orderId: order.id,
            createdAtIso: order.created_at,
            dismantleAtIso: order.dismantle_at,
            daysRemaining,
            hasMinimum: totalUnits >= MIN_UNITS_TO_FINALIZE,
            missingForFinalize,
          };
        } else {
          lastOrderDeadlineReminderContext = null;
        }
        if (uiState.isExpiredPendingDisassembly) {
          lastOrderExpiredPendingDisassemblyContext = {
            orderId: order.id,
            createdAtIso: order.created_at,
            dismantleAtIso: order.dismantle_at,
          };
        }

        const closedStateChip = isClosed
          ? `<span class="dash-order-header-chip dash-order-header-chip--preparing">Preparando pedido</span>`
          : "";
        const daysChip = `<span class="dash-order-header-chip dash-order-header-chip--days" title="Quedan ${daysRemaining} días para cerrar el pedido (plazo total ${ORDER_DISMANTLE_DAYS} días desde la creación)">${daysRemaining} días</span>`;
        const orderCardClass = uiState.isReadOnly
          ? "dash-order order-item dash-order--readonly-expired"
          : "dash-order order-item";
        const readonlyCriticalOverlayHtml = uiState.isExpiredPendingDisassembly
          ? `<div class="dash-order-readonly-critical" role="status" aria-live="polite">
               <div class="dash-order-readonly-critical__panel">
                 <h3 class="dash-order-readonly-critical__title">Tu pedido alcanzó el plazo de 7 días</h3>
                 <p class="dash-order-readonly-critical__text">Ya no podés modificarlo desde la web, pero todavía no fue desarmado.</p>
                 <p class="dash-order-readonly-critical__emphasis">Si querés que lo preparemos o tenés dudas, escribinos por WhatsApp y te ayudamos.</p>
                 <a href="${WHATSAPP_ENVIOS_HREF}" target="_blank" rel="noopener noreferrer" class="btn btn-primary dash-order-readonly-critical__cta">Escribir por WhatsApp</a>
               </div>
             </div>`
          : "";
        const actionCtaHtml = uiState.isReadOnly
          ? `<div class="dash-order__cta" aria-hidden="true"></div>`
          : (isActive || isClosingSoon
              ? `<div class="dash-order__cta"><div class="dash-order-finalize-wrap"><button type="button" class="btn btn-finalize-order close-order-btn ${finalizeBtnClass}" data-order-id="${order.id}" data-order-items-count="${totalUnits}" data-all-picked="${allPickedForOrder ? "true" : "false"}" data-has-reserved="${hasReservedInOrder ? "true" : "false"}" data-has-missing-items="${hasMissingItems ? "true" : "false"}" data-finalize-title="${(finalizeTitle || "").replace(/"/g, "&quot;")}" ${canFinalize ? "" : (totalUnits < MIN_UNITS_TO_FINALIZE ? "disabled" : "")} ${finalizeTitle ? `title="${finalizeTitle.replace(/"/g, "&quot;")}"` : ""}>${finalizeBtnText}</button><div class="dash-order-finalize-tooltip" id="finalize-tooltip-${order.id}" role="tooltip" aria-hidden="true"></div></div></div>`
              : `<div class="dash-order__cta"><button type="button" class="dash-order-modify-link" data-order-id="${order.id}">Modificar pedido</button></div>`);

        return `
          <div class="${orderCardClass}" data-order-id="${order.id}" data-order-closed="${isClosed ? "true" : "false"}" data-order-readonly="${uiState.isReadOnly ? "true" : "false"}" data-order-expired-pending-disassembly="${uiState.isExpiredPendingDisassembly ? "true" : "false"}">
            <div class="dash-order__readonly-content">
              <div class="dash-order__head--compact dash-order__head--summary">
                <div class="dash-order__head-left">
                  <div class="dash-order__title">📦 Mi pedido</div>
                </div>
                <div class="dash-order__head-right">
                  ${daysChip}
                  ${
                    (isActive || isClosingSoon) && uiState.canEdit
                      ? `<div class="dash-order-header-menu-wrap">
                           <button type="button" class="dash-order-header-kebab" aria-label="Opciones del pedido" aria-haspopup="true" aria-expanded="false"><svg class="dash-order-header-kebab__icon" width="14" height="4" viewBox="0 0 14 4" aria-hidden="true" focusable="false"><circle cx="2" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/><circle cx="12" cy="2" r="1.2"/></svg></button>
                           <div class="dash-order-header-popover" role="menu" aria-hidden="true">
                             <button type="button" class="dash-order-header-menuitem" data-cancel-entire-order="${order.id}">Cancelar pedido</button>
                           </div>
                         </div>`
                      : `<span class="dash-order-header-kebab" aria-hidden="true"><svg class="dash-order-header-kebab__icon" width="14" height="4" viewBox="0 0 14 4" aria-hidden="true" focusable="false"><circle cx="2" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/><circle cx="12" cy="2" r="1.2"/></svg></span>`
                  }
                </div>
                <div class="dash-order__status-row">
                  <div class="dash-order__status-left">
                    <span class="dash-order-header-chip dash-order-header-chip--state">${getOrderStatusSummary(visibleItems)}</span>
                  </div>
                  <div class="dash-order__status-right">
                    ${closedStateChip}
                  </div>
                </div>
              </div>
              <div class="dash-divider"></div>
              <div class="dash-order__head--compact">
                <div>
                  <div class="dash-order__number">Pedido #${orderDisplayNumber}</div>
                  <div class="dash-order__total-line">Total: ${formatOrderPrice(total)}</div>
                </div>
                ${actionCtaHtml}
              </div>
              <div class="dash-divider"></div>
              <div class="dash-order__sub">Productos del pedido (${totalUnits})</div>
              <div class="dash-order__list cart-items-list dash-order__list--collapsible" style="margin-top:8px;" data-max-collapsed-items="4">
                ${itemsHtmlAll || "<p>No hay productos asociados al pedido.</p>"}
              </div>
              ${(groupedItems.length + missingItemsReal.length + missingItemsManual.length) > 4
                ? `<button type="button" class="dash-order__list-toggle" data-order-id="${order.id}" aria-expanded="false">
                    Ver todo el pedido ▾
                  </button>`
                : ""}
            </div>
            ${readonlyCriticalOverlayHtml}
          </div>
        `;
      }));
    
    const ordersHtmlFinal = ordersHtml.join("");

        ordersSection.innerHTML = `
          <div class="orders-list">
        ${ordersHtmlFinal}
              </div>
        `;

    syncOrderDeadlineSyntheticNotifications();

    document.querySelectorAll(".close-order-btn").forEach((btn) => {
      btn.onclick = async () => {
        const orderId = btn.dataset.orderId;
        const itemsCount = parseInt(btn.dataset.orderItemsCount || "0", 10);
        const allPicked = btn.dataset.allPicked === "true";
        const hasReserved = btn.dataset.hasReserved === "true";
        const hasMissingItems = btn.dataset.hasMissingItems === "true";
        const finalizeTitle = (btn.dataset.finalizeTitle || "").replace(/&quot;/g, '"');
        if (!orderId) return;
        if (guardReadOnlyOrderAction({ triggerEl: btn, orderId })) return;
        if (closeOrderInFlight.has(orderId) || btn.classList.contains("is-loading")) return;

        if (hasMissingItems) {
          const text =
            finalizeTitle || "Para finalizar el pedido elimine o cambie el producto sin stock.";
          const wrap = btn.closest(".dash-order-finalize-wrap");
          const tooltip = wrap ? wrap.querySelector(".dash-order-finalize-tooltip") : null;
          if (tooltip) {
            tooltip.textContent = text;
            tooltip.classList.add("is-visible");
            tooltip.setAttribute("aria-hidden", "false");
            setTimeout(() => {
              tooltip.classList.remove("is-visible");
              tooltip.setAttribute("aria-hidden", "true");
            }, 5000);
          } else {
            alert(text);
          }
          return;
        }

        // Permitir finalizar si el pedido tiene "reservados" (regla nueva).
        if (!allPicked && !hasReserved) {
          const text = finalizeTitle || "Para finalizar el pedido debe esperar a que el vendedor confirme el stock de la reserva.";
          const wrap = btn.closest(".dash-order-finalize-wrap");
          const tooltip = wrap ? wrap.querySelector(".dash-order-finalize-tooltip") : null;
          if (tooltip) {
            tooltip.textContent = text;
            tooltip.classList.add("is-visible");
            tooltip.setAttribute("aria-hidden", "false");
            setTimeout(() => {
              tooltip.classList.remove("is-visible");
              tooltip.setAttribute("aria-hidden", "true");
            }, 5000);
          } else {
            alert(text);
          }
          return;
        }

        const MIN_ITEMS_TO_CLOSE = 4;
        if (itemsCount < MIN_ITEMS_TO_CLOSE) {
          const missing = MIN_ITEMS_TO_CLOSE - itemsCount;
          const text = missing === 1
            ? "Te falta 1 par para cerrar el pedido"
            : `Te faltan ${missing} pares para cerrar el pedido`;
          const wrap = btn.closest(".dash-order-finalize-wrap");
          const tooltip = wrap ? wrap.querySelector(".dash-order-finalize-tooltip") : null;
          if (tooltip) {
            tooltip.textContent = text;
            tooltip.classList.add("is-visible");
            tooltip.setAttribute("aria-hidden", "false");
            setTimeout(() => {
              tooltip.classList.remove("is-visible");
              tooltip.setAttribute("aria-hidden", "true");
            }, 4000);
          } else {
            alert(text);
          }
          return;
        }

        if (hasReserved) {
          const confirmText =
            "Tu pedido incluye productos en reserva, pendientes de confirmación. Si alguno no tuviera stock, te avisaremos. ?quiere finalizar el pedido?";
          const confirmed = await showDashboardConfirmModal({
            title: "Finalizar pedido",
            message: confirmText,
            confirmLabel: "Aceptar",
            cancelLabel: "Cancelar",
          });
          if (!confirmed) return;
        }

        await closeOrder(orderId, { triggerBtn: btn });
      };
    });

    applyPendingOrderFeedback(ordersSection);

    ordersSection.querySelectorAll(".dash-order-modify-link").forEach((btn) => {
      btn.onclick = async () => {
        const orderId = btn.dataset.orderId;
        if (!orderId || !currentUserId) return;
        if (guardReadOnlyOrderAction({ triggerEl: btn, orderId })) return;
        btn.disabled = true;
        try {
          const { error } = await supabase.rpc("rpc_reopen_order", { p_order_id: orderId });
          if (error) {
            alert(error.message || "No se pudo modificar el pedido.");
            return;
          }
          await loadOrders(currentUserId);
          await showDashboardMessageModal({
            title: "Pedido listo para modificar",
            bodyHtml:
              '<p class="dash-app-message-modal__text">Podés agregar o quitar productos.</p>',
            confirmLabel: "Aceptar",
          });
        } catch (e) {
          alert(e?.message || "Error al reabrir el pedido.");
        } finally {
          btn.disabled = false;
        }
      };
    });

    ordersSection.querySelectorAll(".item-row__sizes-toggle").forEach((btn) => {
      btn.onclick = () => {
        const line = btn.closest(".item-row")?.querySelector(".item-row__sizes-line");
        if (!line) return;
        const row = btn.closest(".item-row");
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", expanded ? "false" : "true");
        btn.textContent = expanded ? "▸" : "▾";
        line.hidden = expanded;
        if (row) row.classList.toggle("is-expanded", !expanded);
      };
    });

    // Lista de productos del pedido: mostrar solo 4 y expandir/colapsar
    ordersSection.querySelectorAll(".dash-order__list--collapsible").forEach((listEl) => {
      const maxItems = parseInt(listEl.dataset.maxCollapsedItems || "4", 10);
      const itemRows = Array.from(listEl.querySelectorAll(".item-row--order"));
      if (itemRows.length <= maxItems) return;

      listEl.dataset.collapsed = "true";
      listEl.classList.remove("dash-order__list--expanded");
      itemRows.forEach((row, index) => {
        if (index >= maxItems) {
          row.classList.add("is-hidden-collapsed");
        }
      });
    });

    ordersSection.querySelectorAll(".dash-order__list-toggle").forEach((toggleBtn) => {
      toggleBtn.addEventListener("click", () => {
        const orderCard = toggleBtn.closest(".dash-order");
        if (!orderCard) return;
        const listEl = orderCard.querySelector(".dash-order__list--collapsible");
        if (!listEl) return;
        const isCollapsed = listEl.dataset.collapsed !== "false";
        const itemRows = Array.from(listEl.querySelectorAll(".item-row--order"));

        if (isCollapsed) {
          listEl.dataset.collapsed = "false";
          listEl.classList.add("dash-order__list--expanded");
          itemRows.forEach((row) => row.classList.remove("is-hidden-collapsed"));
          toggleBtn.setAttribute("aria-expanded", "true");
          toggleBtn.textContent = "Ver menos ▴";
        } else {
          const maxItems = parseInt(listEl.dataset.maxCollapsedItems || "4", 10);
          listEl.dataset.collapsed = "true";
          listEl.classList.remove("dash-order__list--expanded");
          itemRows.forEach((row, index) => {
            if (index >= maxItems) {
              row.classList.add("is-hidden-collapsed");
            }
          });
          toggleBtn.setAttribute("aria-expanded", "false");
          toggleBtn.textContent = "Ver todo el pedido ▾";
        }
      });
    });

    // Información al pulsar sobre el estado del producto (Reserva / Apartado)
    ordersSection.querySelectorAll(".item-row__status[data-status-info]").forEach((el) => {
      const infoText = el.getAttribute("data-status-info");
      if (!infoText) return;
      const actions = el.closest(".item-row__col-status") || el.closest(".order-item-actions");
      const tooltip = actions ? actions.querySelector(".item-row__status-tooltip") : null;
      if (!tooltip) return;
      let hideTimeout;

      const showInfo = (evt) => {
        if (evt) evt.preventDefault();
        tooltip.textContent = infoText;
        tooltip.classList.add("is-visible");
        tooltip.setAttribute("aria-hidden", "false");
        clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
          tooltip.classList.remove("is-visible");
          tooltip.setAttribute("aria-hidden", "true");
        }, 4000);
      };

      el.addEventListener("click", showInfo);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          showInfo(e);
        }
      });
    });

    // Menú ⋯ en ítems del pedido: abrir/cerrar popover
    ordersSection.querySelectorAll(".item-row__kebab").forEach((kebabBtn) => {
      kebabBtn.onclick = (e) => {
        if (guardReadOnlyOrderAction({ triggerEl: kebabBtn })) {
          e.preventDefault();
          return;
        }
        e.stopPropagation();
        const wrap = kebabBtn.closest(".item-row__menu-wrap");
        const popover = wrap?.querySelector(".item-row__popover");
        if (!popover) return;
        const isOpen = popover.classList.contains("is-open");
        ordersSection.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
          p.classList.remove("is-open");
          p.setAttribute("aria-hidden", "true");
        });
        ordersSection.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
        if (!isOpen) {
          popover.classList.add("is-open");
          popover.setAttribute("aria-hidden", "false");
          kebabBtn.setAttribute("aria-expanded", "true");
        }
      };
    });
    if (!document.body.dataset.orderItemPopoverCloseBound) {
      document.body.dataset.orderItemPopoverCloseBound = "true";
      document.addEventListener("click", (e) => {
        if (e.target.closest(".item-row__menu-wrap") || e.target.closest(".item-row__popover")) return;
        document.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
          p.classList.remove("is-open");
          p.setAttribute("aria-hidden", "true");
        });
        document.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
      });
    }

    ordersSection.querySelectorAll(".item-row__menuitem[data-action='remove-order-item']").forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        if (guardReadOnlyOrderAction({ triggerEl: btn })) return;
        const orderCard = btn.closest(".dash-order");
        const isOrderClosed = orderCard?.dataset.orderClosed === "true";
        if (isOrderClosed) {
          const wrap = btn.closest(".item-row__menu-wrap");
          const popover = wrap?.querySelector(".item-row__popover");
          if (popover) {
            popover.classList.remove("is-open");
            popover.setAttribute("aria-hidden", "true");
            wrap?.querySelector(".item-row__kebab")?.setAttribute("aria-expanded", "false");
          }
          alert("Para quitar productos del pedido primero debes presionar \"Modificar pedido\".");
          return;
        }
        const idsStr = btn.dataset.orderItemIds || "";
        const ids = idsStr.split(",").map((id) => id.trim()).filter(Boolean);
        if (ids.length === 0) return;
        const wrap = btn.closest(".item-row__menu-wrap");
        const popover = wrap?.querySelector(".item-row__popover");
        if (popover) {
          popover.classList.remove("is-open");
          popover.setAttribute("aria-hidden", "true");
          wrap?.querySelector(".item-row__kebab")?.setAttribute("aria-expanded", "false");
        }
        // Obtener cantidades reales para permitir quitar unidades (no solo líneas)
        const { data: rows, error: rowsErr } = await supabase
          .from("order_items")
          .select("id, quantity, size")
          .in("id", ids);
        if (rowsErr || !rows || rows.length === 0) {
          console.error("No se pudieron cargar cantidades de order_items:", rowsErr);
          alert("No se pudo obtener la cantidad de este producto.");
          return;
        }

        // Elegir talle primero (si hay más de uno)
        const sizeCounts = new Map(); // size -> total units
        rows.forEach((r) => {
          const size = String(r?.size ?? "Unico").trim() || "Unico";
          const q = Math.max(0, Number(r?.quantity || 0) || 0);
          if (!sizeCounts.has(size)) sizeCounts.set(size, 0);
          sizeCounts.set(size, (sizeCounts.get(size) || 0) + q);
        });
        const sizes = Array.from(sizeCounts.entries())
          .map(([size, q]) => ({ size, q }))
          .filter((x) => x.q > 0);

        let chosenSize = sizes[0]?.size || "Unico";
        if (sizes.length > 1) {
          const pickedSize = await showDashboardOptionButtonsModal({
            title: "¿Qué talle desea quitar?",
            options: sizes.map((s) => ({
              value: s.size,
              label: s.size,
              sublabel: `${s.q} Uni`,
            })),
            confirmLabel: "Aceptar",
            cancelLabel: "Cancelar",
          });
          if (!pickedSize) return;
          chosenSize = String(pickedSize).trim() || chosenSize;
        }

        const rowsForSize = rows.filter((r) => String(r?.size ?? "Unico").trim() === chosenSize);
        const totalUnitsForSize = rowsForSize.reduce((sum, r) => sum + (Math.max(0, Number(r?.quantity || 0) || 0)), 0);
        const maxUnits = Math.max(1, totalUnitsForSize || 1);

        let unitsToRemove = 1;
        // El modal de cantidad SOLO aparece si ese talle tiene más de 1 unidad
        if (maxUnits > 1) {
          const pickedUnits = await showDashboardQuantitySelectModal({
            title: "¿Cuántas unidades querés quitar?",
            max: maxUnits,
            confirmLabel: "Aceptar",
            cancelLabel: "Cancelar",
          });
          if (!pickedUnits) return;
          unitsToRemove = Math.max(1, Math.min(maxUnits, Number(pickedUnits) | 0));
        }

        const secondConfirm = await showDashboardConfirmModal({
          title:
            unitsToRemove === 1
              ? "¿Quiere quitar 1 producto de su pedido?"
              : `¿Quiere quitar ${unitsToRemove} productos de su pedido?`,
          message: "",
          confirmLabel: "Quitar",
          cancelLabel: "Cancelar",
        });
        if (!secondConfirm) return;

        // Quitar unidades distribuyéndolas entre líneas (si una línea tiene quantity > 1, se cancela parcialmente).
        let remaining = unitsToRemove;
        for (const r of rowsForSize) {
          if (remaining <= 0) break;
          const rowQty = Math.max(0, Number(r.quantity || 0) || 0);
          if (!r.id || rowQty <= 0) continue;
          const cancelQty = Math.min(remaining, rowQty);

          const { error: rpcErr } = await supabase.rpc("rpc_cancel_order_item_units", {
            p_item_id: r.id,
            p_units: cancelQty,
          });
          if (rpcErr) {
            console.error("Error quitando unidades del pedido:", rpcErr);
            alert(rpcErr.message || "No se pudo quitar el producto del pedido.");
            return;
          }

          remaining -= cancelQty;
        }

        if (currentUserId) await loadOrders(currentUserId);
      };
    });

    // Menú ⋯ del encabezado de la tarjeta (Pedido abierto | 12 días): abrir/cerrar y opción Cancelar pedido
    ordersSection.querySelectorAll(".dash-order-header-menu-wrap .dash-order-header-kebab").forEach((kebabBtn) => {
      kebabBtn.onclick = (e) => {
        if (guardReadOnlyOrderAction({ triggerEl: kebabBtn })) {
          e.preventDefault();
          return;
        }
        e.stopPropagation();
        const wrap = kebabBtn.closest(".dash-order-header-menu-wrap");
        const popover = wrap?.querySelector(".dash-order-header-popover");
        if (!popover) return;
        const isOpen = popover.classList.contains("is-open");
        document.querySelectorAll(".dash-order-header-popover.is-open").forEach((p) => {
          p.classList.remove("is-open");
          p.setAttribute("aria-hidden", "true");
        });
        document.querySelectorAll(".dash-order-header-menu-wrap .dash-order-header-kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
        if (!isOpen) {
          popover.classList.add("is-open");
          popover.setAttribute("aria-hidden", "false");
          kebabBtn.setAttribute("aria-expanded", "true");
        }
      };
    });
    if (!document.body.dataset.orderHeaderPopoverCloseBound) {
      document.body.dataset.orderHeaderPopoverCloseBound = "true";
      document.addEventListener("click", (e) => {
        if (e.target.closest(".dash-order-header-menu-wrap") || e.target.closest(".dash-order-header-popover")) return;
        document.querySelectorAll(".dash-order-header-popover.is-open").forEach((p) => {
          p.classList.remove("is-open");
          p.setAttribute("aria-hidden", "true");
        });
        document.querySelectorAll(".dash-order-header-kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
      });
    }

    // Nuevo: cancelar pedido completo
    document.querySelectorAll("[data-cancel-entire-order]").forEach((btn) => {
      btn.onclick = async () => {
        const orderId = btn.dataset.cancelEntireOrder;
        if (!orderId) return;
        if (guardReadOnlyOrderAction({ triggerEl: btn, orderId })) return;
        const popover = btn.closest(".dash-order-header-popover");
        if (popover) {
          popover.classList.remove("is-open");
          popover.setAttribute("aria-hidden", "true");
          popover.closest(".dash-order-header-menu-wrap")?.querySelector(".dash-order-header-kebab")?.setAttribute("aria-expanded", "false");
        }
        await cancelEntireOrder(orderId);
      };
    });

    // Pedido cerrado: menú ⋯ -> Modificar pedido (misma acción que el botón)
    document.querySelectorAll("[data-modify-order]").forEach((btn) => {
      btn.onclick = async () => {
        const orderId = btn.dataset.modifyOrder;
        if (!orderId) return;
        if (guardReadOnlyOrderAction({ triggerEl: btn, orderId })) return;
        const popover = btn.closest(".dash-order-header-popover");
        if (popover) {
          popover.classList.remove("is-open");
          popover.setAttribute("aria-hidden", "true");
          popover
            .closest(".dash-order-header-menu-wrap")
            ?.querySelector(".dash-order-header-kebab")
            ?.setAttribute("aria-expanded", "false");
        }
        const card = document.querySelector(`.dash-order[data-order-id="${CSS.escape(orderId)}"]`);
        const modifyBtn = card?.querySelector(`.dash-order-modify-link[data-order-id="${CSS.escape(orderId)}"]`);
        if (modifyBtn) {
          modifyBtn.click();
          return;
        }
      };
    });
    
    // Configurar botones de cancelar producto
    document.querySelectorAll(".btn-cancel-item").forEach((btn) => {
      btn.onclick = async () => {
        const itemId = btn.dataset.itemId;
        const productName = btn.dataset.productName || "este producto";
        if (!itemId) return;

        const picked = !!btn
          .closest(".order-item-product")
          ?.querySelector(".item-status-picked");
        const detail = picked
          ? "Este producto ya fue apartado por el administrador; se le enviará una notificación."
          : "Este producto está en proceso de reserva y no afectará al administrador.";

        const confirmed = await showDashboardConfirmModal({
          title: `¿Cancelar "${productName}"?`,
          message: detail,
          confirmLabel: "Sí, cancelar",
          cancelLabel: "No",
        });

        if (!confirmed) return;

        await cancelOrderItem(itemId);
      };
    });
    
    // Configurar botones de ver alternativas para productos faltantes
    document.querySelectorAll(".btn-ver-alternativas-faltante").forEach((btn) => {
      btn.onclick = async () => {
        const articulo = btn.dataset.articulo;
        const color = btn.dataset.color;
        const talle = btn.dataset.talle;
        const itemId = btn.dataset.itemId;
        
        if (!articulo || !talle) {
          alert("No se pudo obtener la informaciÃ³n del producto faltante.");
          return;
        }
        
        await mostrarAlternativasParaProductoFaltante({
          articulo,
          color,
          talle,
          itemId,
        });
      };
    });
    
    setupHistoryControls();
  } catch (error) {
    console.warn("âš ï¸ Error cargando pedidos:", error.message);
    currentOrderUiStateById.clear();
        ordersSection.innerHTML = `
      <div class="order-item" style="border:1px solid #f5c6cb; background:#f8d7da; padding:16px; border-radius:8px;">
        <p style="color:#721c24; margin:0;">Error cargando pedidos activos.</p>
          </div>
        `;
    clearOrderDeadlineSyntheticNotifications();
  }
}

async function loadClosedOrders(userId) {
  // Usar el contenedor del modal en lugar del contenedor de historial
  const historyContainer = document.getElementById("modal-orders-content");
  const historySummary = document.getElementById("history-modal-summary");
  if (!historyContainer) {
    console.error("âŒ No se encontrÃ³ el contenedor del modal");
    return;
  }

  if (!userId) {
    console.error("âŒ userId no proporcionado");
    historyContainer.innerHTML = `
      <p style="text-align: center; color: #dc3545; padding: 40px;">Error: No se pudo identificar al usuario.</p>
    `;
    return;
  }

  try {
    fylDevLog("ðŸ“‹ Buscando pedidos cerrados/enviados para usuario:", userId);
    
    // Primero, verificar todos los pedidos del usuario para depuraciÃ³n
    const { data: allOrders, error: allOrdersError } = await supabase
      .from("orders")
      .select("id, order_number, status, customer_id")
      .eq("customer_id", userId);
    
    if (allOrdersError) {
      console.error("âŒ Error obteniendo todos los pedidos:", allOrdersError);
    } else if (allOrders) {
      fylDevLog("ðŸ“‹ Todos los pedidos del usuario:", allOrders.length, "pedidos encontrados");
      allOrders.forEach(o => {
        fylDevLog(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}", customer_id="${o.customer_id}"`);
      });
      
      // Verificar cuÃ¡ntos pedidos tienen estado sent (solo estos aparecen en Pedidos Anteriores)
      const sentOrders = allOrders.filter(o => {
        const status = (o.status || "").toLowerCase().trim();
        return status === "sent";
      });
      fylDevLog(`ðŸ“‹ Pedidos con estado "sent" (Pedidos Anteriores):`, sentOrders.length);
      sentOrders.forEach(o => {
        fylDevLog(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}", customer_id="${o.customer_id}"`);
      });
      
      // Verificar pedidos "closed" (aparecen en Mis Pedidos con "En preparación")
      const closedOrders = allOrders.filter(o => {
        const status = (o.status || "").toLowerCase().trim();
        return status === "closed";
      });
      fylDevLog(`📋 Pedidos con estado "closed" (Mis Pedidos - En preparación):`, closedOrders.length);
      
      // Verificar si hay pedidos con estados diferentes
      const otherStatuses = allOrders.filter(o => {
        const status = (o.status || "").toLowerCase().trim();
        return status !== "closed" && status !== "sent" && status !== "active";
      });
      if (otherStatuses.length > 0) {
        fylDevLog(`ðŸ“‹ Pedidos con otros estados:`, otherStatuses.length);
        otherStatuses.forEach(o => {
          fylDevLog(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}"`);
        });
      }
      } else {
      fylDevLog("âš ï¸ No se encontraron pedidos para el usuario");
    }
    
    // Intentar obtener pedidos cerrados/enviados
    // Primero intentar con consultas separadas que son mÃ¡s confiables
    fylDevLog("ðŸ“‹ Intentando consultas separadas para closed y sent...");
    
    // Historial: solo pedidos finalizados reales (sent), más recientes primero
    const { data: sentOrders, error: sentError } = await supabase
      .from("orders")
      .select(
        "id, order_number, status, total_amount, created_at, updated_at, order_items(id, product_name, color, size, quantity, price_snapshot, imagen, status, admin_confirmed_missing, variant_id)"
      )
      .eq("customer_id", userId)
      .eq("status", "sent")
      .order("created_at", { ascending: false });
    
    // Verificar errores
    if (sentError) {
      console.error("âŒ Error obteniendo pedidos enviados:", sentError);
    } else {
      fylDevLog("ðŸ“‹ Pedidos enviados encontrados:", sentOrders?.length || 0);
    }
    
    const finalOrders = sentOrders || [];
    const error = sentError || null;

    if (error) {
      console.error("âŒ Error cargando pedidos anteriores:", error);
      console.error("âŒ Detalles del error:", JSON.stringify(error, null, 2));
      
      historyContainer.innerHTML = `
        <div class="order-item" style="border:1px solid #f5c6cb; background:#f8d7da; padding:16px; border-radius:8px;">
          <p style="color:#721c24; margin:0;">Error cargando pedidos anteriores: ${error.message}</p>
          <p style="color:#721c24; margin:4px 0 0 0; font-size:12px;">Por favor, revisa la consola para mÃ¡s detalles.</p>
        </div>
      `;
      return;
    }

    fylDevLog("ðŸ“‹ Total de pedidos enviados (sent):", finalOrders.length);
    if (finalOrders && finalOrders.length > 0) {
      finalOrders.forEach(o => {
        fylDevLog(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}", items=${o.order_items?.length || 0}`);
      });
    }
    
    if (!finalOrders || finalOrders.length === 0) {
      fylDevLog("ℹ️ No se encontraron pedidos en historial (sent)");
      if (historySummary) {
        historySummary.innerHTML = `
          <p class="history-modal__support history-modal__support--inline">Revisá tus pedidos anteriores.</p>
        `;
      }
      
      historyContainer.innerHTML = `
        <p style="text-align: center; color: #666; padding: 40px;">No tenés pedidos en el historial todavía.</p>
      `;
      return;
    }

    fylDevLog("âœ… Mostrando", finalOrders.length, "pedidos anteriores");

    const historyVariantIds = [];
    for (const o of finalOrders || []) {
      for (const it of o?.order_items || []) {
        if (it?.variant_id) historyVariantIds.push(it.variant_id);
      }
    }
    await ensureVariantSkusLoaded(historyVariantIds);

    // Ordenar pedidos por fecha mÃ¡s reciente primero
    const sortedOrders = [...finalOrders].sort((a, b) => {
      const dateA = new Date(a.updated_at || a.created_at);
      const dateB = new Date(b.updated_at || b.created_at);
      return dateB - dateA; // MÃ¡s reciente primero
    });

    if (historySummary) {
      historySummary.innerHTML = `
        <p class="history-modal__support history-modal__support--inline">Revisá tus pedidos anteriores.</p>
      `;
    }
    
    const ordersHtml = sortedOrders
      .map((order) => {
        const orderDate = new Date(order.updated_at || order.created_at);
        const formattedDate = orderDate.toLocaleDateString("es-AR", {
          year: "numeric",
          month: "long",
          day: "numeric"
        });
        const formattedTime = orderDate.toLocaleTimeString("es-AR", {
          hour: "2-digit",
          minute: "2-digit",
        });
        const orderNumber = order.order_number || order.id.substring(0, 8);
        const histStatus = String(order.status || "").toLowerCase().trim();
        const histBadgeText = histStatus === "sent" ? "Enviado" : "Cerrado";
        const items = order.order_items || [];
        
        // Calcular total excluyendo solo faltantes reales (missing manual sí cuenta).
        const validItems = items.filter((item) => {
          const isMissing = String(item?.status || "").toLowerCase().trim() === "missing";
          return !isMissing || Boolean(item?.admin_confirmed_missing);
        });
        const total = validItems.reduce((sum, item) => {
          const qty = Number(item.quantity || 0) || 0;
          const price = orderItemUnitForDisplay(item);
          return sum + (qty * price);
        }, 0);
        
        // Generar HTML de items del pedido
        const visibleItems = items.slice(0, 3);
        const hiddenCount = Math.max(0, items.length - visibleItems.length);
        const itemsHtml = items.length > 0
          ? visibleItems.map(item => {
              const itemImage = item.imagen || FALLBACK_IMAGE;
              const itemQuantity = Number(item.quantity || 0);
              const itemPrice = orderItemUnitForDisplay(item);
              const itemSubtotal = itemQuantity * itemPrice;
              const isMissing = item.status === 'missing';
              // Ítems confirmados manualmente: no son faltantes reales, se muestran como normales
              const isManualConfirmed = Boolean(item.admin_confirmed_missing);
              const isRealMissing = isMissing && !isManualConfirmed;
              const itemClass = isRealMissing ? 'order-item-detail missing' : 'order-item-detail';
              
              return `
                <div class="${itemClass}">
                  <img src="${itemImage}" alt="${item.product_name || 'Producto'}" class="order-item-detail-image" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
                  <div class="order-item-detail-info">
                    <div class="order-item-detail-name">${item.product_name || "Producto sin nombre"} ${isRealMissing ? '<span style="color: #dc3545; font-size: 12px;">(Faltante)</span>' : ''}</div>
                    <div class="order-item-detail-meta">Color: ${item.color || "-"} • Talle: ${item.size || "-"}</div>
                    <div class="order-item-detail-quantity">Cantidad: ${itemQuantity}</div>
                  </div>
                  <div class="order-item-detail-price" style="${isRealMissing ? 'text-decoration: line-through; opacity: 0.5;' : ''}">$${itemSubtotal.toLocaleString("es-AR")}</div>
                </div>
              `;
            }).join("")
          : "<p style='color: #666; font-size: 14px;'>No hay productos en este pedido.</p>";
        const extraItemsHtml =
          hiddenCount > 0
            ? `<div class="order-items-more">+${hiddenCount} ${hiddenCount === 1 ? "producto más" : "productos más"}</div>`
            : "";
        
        return `
          <div class="order-date-item history-order-card" data-order-id="${order.id}">
            <div class="history-order-card__top">
              <span class="order-number">Pedido #${orderNumber}</span>
              <span class="history-order-card__status-chip history-order-card__status-chip--${histStatus}">${histBadgeText}</span>
            </div>
            <div class="order-date">${formattedDate} · ${formattedTime}</div>
            <div class="history-order-card__total-row">
              <div class="order-total">Total: $${total.toLocaleString("es-AR")}</div>
              <button type="button" class="history-order-card__toggle" data-order-toggle="${order.id}" aria-expanded="false">Ver detalle</button>
            </div>
            <div class="order-items-detail" id="order-items-${order.id}">
              ${itemsHtml}
              ${extraItemsHtml}
              ${items.length > 0 ? `<div class="order-items-summary">Total del pedido: $${total.toLocaleString("es-AR")}</div>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    historyContainer.innerHTML = `
      <div class="orders-list">
        ${ordersHtml}
      </div>
    `;
    
    // Agregar event listeners para expandir/contraer pedidos dentro del modal
    const modalOrdersList = historyContainer.querySelector(".orders-list");
    if (modalOrdersList) {
      modalOrdersList.querySelectorAll("[data-order-toggle]").forEach(toggleBtn => {
        toggleBtn.addEventListener("click", (e) => {
          e.stopPropagation(); // Evitar que se propague el evento
          
          const orderId = toggleBtn.dataset.orderToggle;
          const orderItem = modalOrdersList.querySelector(`[data-order-id="${orderId}"]`);
          const itemsDetail = document.getElementById(`order-items-${orderId}`);
          
          if (orderItem && itemsDetail) {
            // Toggle expanded
            if (orderItem.classList.contains("expanded")) {
              orderItem.classList.remove("expanded");
              itemsDetail.classList.remove("visible");
              toggleBtn.setAttribute("aria-expanded", "false");
              toggleBtn.textContent = "Ver detalle";
            } else {
              // Cerrar otros pedidos expandidos
              modalOrdersList.querySelectorAll(".order-date-item.expanded").forEach(expanded => {
                expanded.classList.remove("expanded");
                const expandedId = expanded.dataset.orderId;
                const expandedDetail = document.getElementById(`order-items-${expandedId}`);
                if (expandedDetail) {
                  expandedDetail.classList.remove("visible");
                }
                const otherToggle = expanded.querySelector("[data-order-toggle]");
                if (otherToggle) {
                  otherToggle.setAttribute("aria-expanded", "false");
                  otherToggle.textContent = "Ver detalle";
                }
              });
              
              // Expandir este pedido
              orderItem.classList.add("expanded");
              itemsDetail.classList.add("visible");
              toggleBtn.setAttribute("aria-expanded", "true");
              toggleBtn.textContent = "Ocultar detalle";
            }
          }
        });
      });

      modalOrdersList.querySelectorAll("[data-history-modify-order]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const oid = btn.getAttribute("data-history-modify-order");
          if (!oid || !userId) return;
          btn.disabled = true;
          try {
            const { error: reopenErr } = await supabase.rpc("rpc_reopen_order", {
              p_order_id: oid,
            });
            if (reopenErr) {
              alert(reopenErr.message || "No se pudo modificar el pedido.");
              return;
            }
            await loadClosedOrders(userId);
            if (typeof loadOrders === "function") await loadOrders(userId);
            await showDashboardMessageModal({
              title: "Pedido listo para modificar",
              bodyHtml:
                '<p class="dash-app-message-modal__text">Podés agregar o quitar productos desde Mi pedido.</p>',
              confirmLabel: "Entendido",
            });
          } catch (err) {
            alert(err?.message || "Error al reabrir el pedido.");
          } finally {
            btn.disabled = false;
          }
        });
      });
    }
  } catch (error) {
    console.warn("âš ï¸ Error cargando pedidos anteriores:", error.message);
    historyContainer.innerHTML = `
      <p style="text-align: center; color: #dc3545; padding: 40px;">Error cargando pedidos anteriores.</p>
    `;
  }
}

function showNoSession() {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (!dashboardContent) return;
    setupCartActions();
    const cartInfo = document.getElementById("cart-info");
    const cartFooter = document.getElementById("cart-footer");
    const ordersSection = document.getElementById("orders-section");
    const activeOrderChips = document.getElementById("active-order-chips");
    const activeOrderActions = document.getElementById("active-order-actions");
    const userName = document.getElementById("user-name");
    const userEmail = document.getElementById("user-email");
    const userAvatar = document.getElementById("user-avatar");

    if (userName) {
      userName.textContent = "Invitada";
    }
    const userNameSheet = document.getElementById("user-name-sheet");
    if (userNameSheet) {
      userNameSheet.textContent = "Invitada";
    }
    if (userEmail) {
      userEmail.textContent = "";
    }
    if (userAvatar) {
      userAvatar.src = GUEST_AVATAR_ICON;
      userAvatar.alt = "Perfil";
    }

    if (cartInfo) {
      let guestItems = [];
      try {
        const raw = localStorage.getItem("fyl_cart");
        const parsed = raw ? JSON.parse(raw) : [];
        guestItems = normalizeGuestCartStorageItems(
          Array.isArray(parsed) ? parsed : []
        );
        localStorage.setItem("fyl_cart", JSON.stringify(guestItems));
      } catch (_error) {
        guestItems = [];
      }

      const normalizedGuestItems = guestItems.filter(
        (item) => (Number(item?.cantidad) || 0) > 0
      );

      if (normalizedGuestItems.length === 0) {
        cartInfo.innerHTML = `
          <p class="empty-cart">
            Todavía no agregaste productos
            <br><span class="subtext">Explorá el catálogo y armá tu pedido</span>
          </p>
          <a href="../index.html" class="btn" style="margin:12px auto 0; display:block; width:fit-content;">Explorar catálogo</a>
        `;
      } else {
        const totalUnits = normalizedGuestItems.reduce((sum, item) => sum + (Number(item.cantidad) || 0), 0);
        const totalPrice = normalizedGuestItems.reduce((sum, item) => {
          const qty = Number(item.cantidad) || 0;
          const price = parseARSNumber(item.precio);
          return sum + qty * price;
        }, 0);

        const itemsHtml = normalizedGuestItems
          .map((item, idx) => {
            const lineTotal = (Number(item.cantidad) || 0) * parseARSNumber(item.precio);
            return `
              <div class="dash-bolsa-item">
                <div class="dash-bolsa-item__row1">
                  <img src="${item.imagen}" alt="${item.articulo}" class="dash-bolsa-item__thumb" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}';">
                  <div class="dash-bolsa-item__main">
                    <div class="dash-bolsa-item__head">
                      <div class="dash-bolsa-item__line1">
                        <span class="dash-bolsa-item__title">${item.articulo} · ${abbreviateColorLabel(item.color || "Color único")} · ${item.talle}</span>
                      </div>
                      <div class="dash-bolsa-item__right order-item-actions">
                        <span class="dash-bolsa-item__price item-row__price-total">$${lineTotal.toLocaleString("es-AR")}</span>
                        <div class="item-row__menu-wrap">
                          <button type="button" class="item-row__kebab" aria-label="Opciones" aria-haspopup="true" aria-expanded="false">⋯</button>
                          <div class="item-row__popover" role="menu" aria-hidden="true">
                            <button type="button" class="item-row__menuitem item-row__menuitem--danger" data-action="remove-bag-item" data-id="${idx}">Quitar de la bolsa</button>
                            <a href="${buildCatalogHrefFromVariantOrName(item.variant_id || item.variantInfo?.id, item.articulo)}" class="item-row__menuitem" data-action="view-product">Ver producto</a>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="dash-bolsa-item__line2">
                      <select class="cart-qty-select dash-bolsa-item__qty-select" data-id="${idx}">
                        ${[0,1,2,3,4].map((n) => `<option value="${n}" ${n === Number(item.cantidad || 0) ? "selected" : ""}>${n === 0 ? "0" : `${n} uni`}</option>`).join("")}
                        ${(Number(item.cantidad || 0) > 4) ? `<option value="${Number(item.cantidad)}" selected>${Number(item.cantidad)} uni</option>` : ""}
                      </select>
                      <span class="dash-bolsa-item__unit-price">· $${parseARSNumber(item.precio).toLocaleString("es-AR")} c/u</span>
                    </div>
                  </div>
                </div>
              </div>
            `;
          })
          .join("");

        cartInfo.innerHTML = `
          <p class="dash-bolsa-hint">Enviá el pedido para reservarlos.</p>
          <div class="cart-items-list dash-bolsa-list">
            ${itemsHtml}
          </div>
        `;
        const cartProductsCount = document.getElementById("cart-products-count");
        if (cartProductsCount) {
          cartProductsCount.textContent = `${totalUnits} ${totalUnits === 1 ? "producto" : "productos"} en el carrito`;
        }
        const cartTotalValue = document.getElementById("cart-total-value");
        if (cartTotalValue) {
          cartTotalValue.textContent = `$${totalPrice.toLocaleString("es-AR")}`;
        }
        const submitBtn = document.getElementById("submit-cart-btn");
        if (submitBtn) submitBtn.textContent = "Hacer pedido";
        if (cartFooter) {
          cartFooter.style.display = "block";
        }
        attachGuestCartHandlers();
        attachBolsaPopoverCloseOnOutsideClick();
      }
    }
    if (cartFooter && !cartInfo?.querySelector(".dash-bolsa-item")) {
      cartFooter.style.display = "none";
    }
    currentCartId = null;
    currentCartItems = [];

    if (activeOrderChips) {
      activeOrderChips.innerHTML = "";
    }
    if (activeOrderActions) {
      activeOrderActions.style.display = "none";
      activeOrderActions.innerHTML = "";
    }
    if (ordersSection) {
      ordersSection.innerHTML = `
        <div class="order-item" style="border:1px solid #e0e0e0; padding:16px; border-radius:8px; background:#fafafa;">
          <div class="section-title dash-title" style="margin-bottom:12px;">📦 Mi pedido</div>
          <div style="border:1px solid #f5c6cb; background:#f8d7da; padding:16px; border-radius:8px;">
            <div style="display:flex; align-items:center; gap:10px; color:#721c24;">
              <span style="font-size:18px;">🔒</span>
              <div>
                <strong>No hay sesión activa</strong>
                <p style="margin:5px 0 0 0; font-size:14px;">
                  <a href="./login.html?return=dashboard" style="color:#CD844D; text-decoration:underline;">Inicia sesión</a> para acceder a tu área personal.
                </p>
              </div>
            </div>
          </div>
        </div>
      `;
    }
}

function showError(message) {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (!dashboardContent) return;
    const messageDiv = document.createElement("div");
    messageDiv.style.cssText = `
      background: #fff3cd;
      border: 1px solid #ffeaa7;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 20px;
      color: #856404;
    `;
    messageDiv.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 20px;">⚠️</span>
        <div>
          <strong>Error</strong>
          <p style="margin: 5px 0 0 0; font-size: 14px;">${message}</p>
        </div>
      </div>
    `;
    safeInsertBefore(dashboardContent, messageDiv, dashboardContent.firstChild, "prepend");
  }

/** Primer nombre para el saludo corto del header: "Cuenta de [nombre]" */
function getFirstNameForGreeting(displayName) {
  const s = String(displayName || "").trim();
  if (!s) return "Usuario";
  return s.split(/\s+/)[0] || "Usuario";
}

async function loadData() {
  try {
    markDashboardPerf("load_data_start");
    setContentVisibility(false);

    await withAuth(
      async (user) => {
        currentUserId = user.id;
        markDashboardPerf("auth_ready_ms", { userId: user.id });
        const userName = document.getElementById("user-name");
        const userEmail = document.getElementById("user-email");
        const userAvatar = document.getElementById("user-avatar");

        const customerProfile = await fetchCustomerProfileRow();
        markDashboardPerf("profile_ready_ms");

        if (userName) {
          const displayName =
            customerProfile?.full_name ||
            user.user_metadata?.full_name ||
            user.email?.split("@")[0] ||
            "Usuario";
          const greeting = getFirstNameForGreeting(displayName);
          userName.textContent = greeting;
          const userNameSheet = document.getElementById("user-name-sheet");
          if (userNameSheet) {
            userNameSheet.textContent = greeting;
          }
        }
        if (userEmail) {
          userEmail.textContent = customerProfile?.email || user.email;
        }
        if (userAvatar) {
          const displayName =
            customerProfile?.full_name ||
            user.user_metadata?.full_name ||
            user.email?.split("@")[0] ||
            "Usuario";
          const avatarUrl =
            customerProfile?.avatar_url ||
            user.user_metadata?.avatar_url ||
            user.user_metadata?.picture;
          setUserAvatarWithFallback(userAvatar, displayName, avatarUrl);
          userAvatar.dataset.identitySet = "true";
        }

        setupCartActions();
        setupHistoryControls();
        setContentVisibility(true);
        markDashboardPerf("dashboard_shell_visible_ms");

        const cartPromise = Promise.resolve(loadCart(user.id))
          .then(() => {
            markDashboardPerf("cart_ready_ms");
          })
          .catch((error) => {
            console.warn("⚠️ Error cargando carrito inicial:", error?.message || error);
          });
        const ordersPromise = Promise.resolve(
          loadOrders(user.id, { forceMaintenance: true, source: "initial-load" })
        )
          .then(() => {
            markDashboardPerf("orders_ready_ms");
          })
          .catch((error) => {
            console.warn("⚠️ Error cargando pedidos iniciales:", error?.message || error);
          });
        const initialDataReadyPromise = Promise.allSettled([cartPromise, ordersPromise]);
        const visualBarrierPromise = Promise.race([
          initialDataReadyPromise,
          new Promise((resolve) => setTimeout(resolve, 3200)),
        ]);
        await visualBarrierPromise;
        hideLoader();
        markDashboardPerf("dashboard_interactive_ms");
        window.dispatchEvent(new CustomEvent("fyl-dashboard-boot-done"));
        maybeAutoScrollToBagFromStickyCart();
        await initialDataReadyPromise;
        markDashboardPerf("dashboard_data_ready_ms");
        await maybeShowDismantledTimeoutNoticeModal(user.id);

        // Deep-link: si viene ?view=history desde admin, abrir historial automáticamente.
        try {
          const url = new URL(window.location.href);
          if (url.searchParams.get("view") === "history") {
            setHistoryNotificationVisible(true);
            setTimeout(() => {
              try {
                openPreviousOrdersModal();
              } catch (_) {
                /* ignore */
              }
            }, 0);
          }
        } catch (_) {
          /* ignore */
        }

        if (!cartSyncedListenerRegistered) {
          window.addEventListener("cart:synced", () => {
            clearDashboardVariantInfoCaches();
            loadCart(user.id);
          });
          cartSyncedListenerRegistered = true;
        }

        flushDashboardPerfSummary("authenticated");
        // Realtime post-boot: no bloquear primer render útil del dashboard.
        setTimeout(() => {
          Promise.resolve(setupOrdersRealtimeSubscription(user.id)).catch((error) => {
            console.warn("⚠️ Error configurando realtime de pedidos:", error?.message || error);
          });
        }, 0);
        if (!fylDashboardViewOnce && fylAnalytics.isReady()) {
          fylDashboardViewOnce = true;
          fylAnalytics.setPageType("dashboard");
          fylAnalytics.event("dashboard_view", {});
        }
        if (typeof window.runDashboardOnboardingIfNeeded === "function") {
          window.runDashboardOnboardingIfNeeded();
        }
      },
      async () => {
        showNoSession();
        setContentVisibility(true);
        hideLoader();
        markDashboardPerf("dashboard_interactive_ms");
        flushDashboardPerfSummary("guest");
        window.dispatchEvent(new CustomEvent("fyl-dashboard-boot-done"));
      }
    );
  } catch (error) {
    console.warn("âš ï¸ Error cargando datos del dashboard:", error.message);
    showError("Error de conexión");
    setContentVisibility(true);
    hideLoader();
    markDashboardPerf("dashboard_interactive_ms");
    flushDashboardPerfSummary("error");
    window.dispatchEvent(new CustomEvent("fyl-dashboard-boot-done"));
  }
}

function initDashboard() {
  // Mantener el layout moderno definido en dashboard.html.
  // El template legacy de showContent() no debe sobrescribir el DOM.
  if (document.body) {
    document.body.classList.add("dashboard-loading");
  }
  setContentVisibility(false);
  setupAccountSheetControls();
  loadData();
}

// FunciÃ³n para configurar suscripciÃ³n en tiempo real para pedidos
async function setupOrdersRealtimeSubscription(userId) {
  if (!supabase || !userId) return;

  if (ordersRealtimeSetupPromise) {
    await ordersRealtimeSetupPromise;
    if (
      ordersRealtimeSubscription &&
      ordersRealtimeActiveUserId === userId &&
      currentUserId === userId
    ) {
      return;
    }
  }

  const setupPromise = (async () => {
    clearOrdersRealtimeRetryTimer();

    // Cancelar suscripciÃ³n anterior si existe.
    if (ordersRealtimeSubscription) {
      try {
        await supabase.removeChannel(ordersRealtimeSubscription);
      } catch (error) {
        console.warn("âš ï¸ Error eliminando suscripciÃ³n anterior:", error);
      } finally {
        ordersRealtimeSubscription = null;
        ordersRealtimeActiveUserId = null;
      }
    }

    // SuscripciÃ³n a cambios de orders del cliente.
    ordersRealtimeSubscription = supabase
      .channel(`orders-updates-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*", // INSERT, UPDATE, DELETE
          schema: "public",
          table: "orders",
        },
        async (payload) => {
          if (!currentUserId || currentUserId !== userId) return;
          const matchesNew = payload.new && payload.new.customer_id === userId;
          const matchesOld = payload.old && payload.old.customer_id === userId;
          if (!matchesNew && !matchesOld) return;

          if (matchesNew) rememberKnownOrderId(payload.new?.id);
          if (payload.eventType === "DELETE" && matchesOld) forgetKnownOrderId(payload.old?.id);

          fylDevLog("ðŸ”„ Cambio en pedidos detectado:", payload.eventType);
          scheduleOrdersRefresh({
            userId,
            includeClosedOrders: true,
            reason: `orders-${payload.eventType || "event"}`,
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*", // INSERT, UPDATE, DELETE
          schema: "public",
          table: "order_items",
        },
        async (payload) => {
          if (!currentUserId || currentUserId !== userId) return;

          const orderId = payload.new?.order_id || payload.old?.order_id;
          if (!orderId) return;

          let belongsToCurrentUser = knownOrderIdsByCurrentUser.has(orderId);
          if (!belongsToCurrentUser) {
            // Fallback conservador: solo consultar si no estÃ¡ en cachÃ©.
            const { data: order } = await supabase
              .from("orders")
              .select("id, customer_id")
              .eq("id", orderId)
              .maybeSingle();
            if (order?.customer_id === userId) {
              belongsToCurrentUser = true;
              rememberKnownOrderId(order.id);
            }
          }

          if (!belongsToCurrentUser) return;
          fylDevLog("ðŸ”„ Cambio en items de pedido detectado:", payload.eventType);
          scheduleOrdersRefresh({
            userId,
            includeClosedOrders: true,
            reason: `order-items-${payload.eventType || "event"}`,
          });
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          ordersRealtimeActiveUserId = userId;
          clearOrdersRealtimeRetryTimer();
          fylDevLog("âœ… SuscripciÃ³n en tiempo real de pedidos activa");
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(
            `âš ï¸ SuscripciÃ³n realtime con estado ${status}. Reintentando...`
          );
          scheduleOrdersRealtimeReconnect(userId, status);
        }
      });
  })();

  ordersRealtimeSetupPromise = setupPromise;
  try {
    await setupPromise;
  } finally {
    if (ordersRealtimeSetupPromise === setupPromise) {
      ordersRealtimeSetupPromise = null;
    }
  }
}

// FunciÃ³n para mostrar alternativas cuando un producto estÃ¡ marcado como faltante
async function mostrarAlternativasParaProductoFaltante({ articulo, color, talle, itemId }) {
  try {
    if (!window.buscarProductosAlternativos || !window.mostrarModalAlternativas) {
      alert(
        `Este producto no estÃ¡ disponible en el talle ${talle}. Por favor selecciona otro talle o producto.`
      );
      return;
    }

    // Intentar obtener los tags del producto original desde el catÃ¡logo
    let tags = [];
    try {
      const { data: productoData } = await supabase
        .from("catalog_public_view")
        .select("Filtro1, Filtro2, Filtro3")
        .eq("Articulo", articulo)
        .maybeSingle();

      if (productoData) {
        if (productoData.Filtro1) tags.push(productoData.Filtro1);
        if (productoData.Filtro2) tags.push(productoData.Filtro2);
        if (productoData.Filtro3) tags.push(productoData.Filtro3);
      }
    } catch (error) {
      console.warn("âš ï¸ No se pudieron obtener los tags del producto:", error);
    }

    const mensaje = `El producto "${articulo}" no estÃ¡ disponible en el talle ${talle} (faltante). Â¿QuerÃ©s ver alternativas similares en talle ${talle}?`;

    // Crear un modal inicial con dos opciones
    const confirmacion = await new Promise((resolve) => {
      const modalInicial = document.createElement("div");
      modalInicial.className = "alternativas-modal active";
      modalInicial.innerHTML = `
        <div class="alternativas-modal-content" style="max-width: 500px;">
          <div class="alternativas-modal-header">
            <h2>âš ï¸ Producto Faltante</h2>
            <button class="alternativas-modal-close" onclick="window.__verAlternativasFaltanteResolve(false)">Ã—</button>
          </div>
          <div class="alternativas-modal-body">
            <p class="alternativas-modal-message">${mensaje}</p>
          </div>
          <div class="alternativas-modal-footer" style="gap: 12px; display: flex; justify-content: flex-end;">
            <button class="alternativas-cerrar-btn" onclick="window.__verAlternativasFaltanteResolve(false)">Cerrar</button>
            <button class="alternativa-select-btn" style="margin: 0;" onclick="window.__verAlternativasFaltanteResolve(true)">Ver alternativas</button>
          </div>
        </div>
      `;
      
      const backdrop = document.createElement("div");
      backdrop.className = "alternativas-modal-backdrop";
      backdrop.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1999;";
      
      window.__verAlternativasFaltanteResolve = (result) => {
        modalInicial.remove();
        backdrop.remove();
        delete window.__verAlternativasFaltanteResolve;
        resolve(result);
      };
      
      backdrop.addEventListener("click", () => {
        window.__verAlternativasFaltanteResolve(false);
      });
      
      document.body.appendChild(backdrop);
      document.body.appendChild(modalInicial);
    });

    if (!confirmacion) return;

    // Buscar alternativas
    const productos = await window.buscarProductosAlternativos({
      articulo,
      talle,
      tags,
      color,
      limit: 6,
    });

    if (!productos || productos.length === 0) {
      alert(`No se encontraron productos alternativos disponibles en talle ${talle}.`);
      return;
    }

    // Mostrar modal con alternativas
    window.mostrarModalAlternativas({
      mensaje: `Productos alternativos disponibles en talle ${talle}:`,
      productos,
      onProductoSeleccionado: async (productoSeleccionado) => {
        // Agregar el producto seleccionado al carrito
        if (window.addToCart) {
          const productData = {
            articulo: productoSeleccionado.articulo,
            color: productoSeleccionado.color,
            talle: productoSeleccionado.talle,
            cantidad: 1,
            precio: productoSeleccionado.precio,
            imagen: productoSeleccionado.imagen,
            descripcion: productoSeleccionado.descripcion,
            variant_id: productoSeleccionado.variant_id,
          };
          
          const added = await window.addToCart(productData);
          if (added) {
            // Si tenemos el itemId faltante, cancelarlo automÃ¡ticamente
            if (itemId) {
              try {
                const { error: cancelError } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: itemId });
                if (cancelError) {
                  console.warn("âš ï¸ No se pudo cancelar el item faltante:", cancelError.message || cancelError);
                }
              } catch (e) {
                console.warn("âš ï¸ Error cancelando item faltante:", e?.message || e);
              }
            }
            
            alert(`âœ… ${productoSeleccionado.articulo} agregado al carrito`);
            // Recargar el carrito y pedidos para reflejar cambios
            if (currentUserId) {
              await loadCart(currentUserId);
              await loadOrders(currentUserId);
            }
          } else {
            alert(`No se pudo agregar ${productoSeleccionado.articulo} al carrito.`);
          }
        } else {
          alert("No se pudo agregar el producto al carrito. Por favor, recarga la pÃ¡gina.");
        }
      },
      onCerrar: () => {
        fylDevLog("Modal de alternativas cerrado");
      },
    });
  } catch (error) {
    console.error("âŒ Error mostrando alternativas para producto faltante:", error);
    alert(
      `No se pudieron cargar alternativas para el producto. Por favor intenta de nuevo.`
    );
  }
}

// Limpiar suscripciÃ³n cuando se cierra la pÃ¡gina
window.addEventListener("beforeunload", () => {
  if (ordersRefreshTimerId) {
    clearTimeout(ordersRefreshTimerId);
    ordersRefreshTimerId = null;
  }
  clearOrdersRealtimeRetryTimer();
  if (ordersRealtimeSubscription && supabase) {
    supabase.removeChannel(ordersRealtimeSubscription);
    ordersRealtimeSubscription = null;
    ordersRealtimeActiveUserId = null;
  }
});

if (document.readyState === "loading") {
document.addEventListener("DOMContentLoaded", initDashboard);
} else {
  initDashboard();
}

async function cancelEntireOrder(orderId) {
  if (getOrderUiState(orderId)?.isReadOnly) {
    showReadOnlyOrderBlockedMessage();
    return;
  }
  try {
    const confirmed = await showDashboardConfirmModal({
      title: "¿Seguro que querés cancelar todo el pedido?",
      bodyHtml: `<ul class="dash-confirm-bullets">
        <li>Los productos ya apartados notificarán al administrador y el pedido quedará como <strong>Cerrado</strong>.</li>
        <li>Los productos que aún no fueron apartados se cancelarán sin notificar y, si no había nada apartado, el pedido se eliminará.</li>
      </ul>`,
      confirmLabel: "Sí, cancelar",
      cancelLabel: "No",
    });
    if (!confirmed) return;

    // Obtener items del pedido
    const { data: items, error } = await supabase
      .from("order_items")
      .select("id, status")
      .eq("order_id", orderId);

    if (error) {
      alert("No se pudieron obtener los productos del pedido.");
      console.error("âŒ Error listando items:", error);
      return;
    }

    if (!items || items.length === 0) {
      // Si ya no tiene items, eliminar el pedido
      await supabase.from("orders").delete().eq("id", orderId);
      await loadOrders(currentUserId);
      return;
    }

    let hadPicked = false;

    // Cancelar cada item usando la misma lÃ³gica de cancelaciÃ³n
    for (const it of items) {
      // Reusar cancelOrderItem para cada Ã­tem
      // Pero sin confirmaciÃ³n individual
      try {
        if ((it.status || '').toLowerCase() === 'missing') {
          // Forzar eliminaciÃ³n directa (ramas de missing ya manejan total/update)
          await cancelOrderItem(it.id);
        } else {
          const { data: res, error: rpcErr } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: it.id });
          if (rpcErr) {
            console.warn("âš ï¸ No se pudo cancelar item:", it.id, rpcErr.message);
          } else if (res?.was_picked) {
            hadPicked = true;
          }
        }
      } catch (e) {
        console.warn("âš ï¸ Error cancelando item:", it.id, e?.message || e);
      }
    }

    // Si hubo algÃºn 'picked', dejar el pedido como 'closed' (visible para admin)
    if (hadPicked) {
      await supabase.from("orders").update({ status: "closed", updated_at: new Date().toISOString() }).eq("id", orderId);
      await loadOrders(currentUserId);
      return;
    }

    // Si no hubo 'picked', verificar si quedÃ³ vacÃ­o y eliminar pedido entero
    const { count } = await supabase
      .from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId);

    if ((Number(count) || 0) === 0) {
      await supabase.from("orders").delete().eq("id", orderId);
    } else {
      // AÃºn hay items cancelados, borrar tambiÃ©n los cancelados y eliminar pedido
      await supabase.from("order_items").delete().eq("order_id", orderId);
      await supabase.from("orders").delete().eq("id", orderId);
    }

    await loadOrders(currentUserId);
  } catch (e) {
    console.error("âŒ Error cancelando pedido completo:", e);
    alert("No se pudo cancelar el pedido.");
  }
}

