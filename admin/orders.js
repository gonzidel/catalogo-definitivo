// Importar dinámicamente para asegurar que se cargue después
let supabase = null;

import { createScreenScope } from "../scripts/net/screen-scope.js";
import { wrapSupabase, createAbortScope, FYL_ERROR_KIND, classifyError } from "../scripts/net/fyl-fetch.js";
import { getSessionUser, getAdminPermissions, can, preloadAuthState } from "./auth-state.js";

/**
 * Scope de pedidos: libera el spinner de "#orders-content" cuando la primera
 * tanda de pedidos ya está visible, sin esperar badges, realtime ni conteos.
 *
 * onFirstPaint: no-op (el spinner ya fue reemplazado por loadOrders antes de
 * llamar markFirstPaint). El valor está en el evento screen:first-paint para
 * telemetría y en la semántica uniforme entre pantallas.
 * onReady: emite screen:ready cuando realtime + badges quedaron configurados.
 */
const ordersScope = createScreenScope("admin-orders", {
  onFirstPaint({ reason }) {
    globalThis.markBootStage?.("admin-orders.ui_usable", { reason });
  },
  onReady({ reason }) {
    globalThis.markBootStage?.("admin-orders.fully_ready", { reason });
  },
});

/** AbortScope de la pantalla: cancela TODO el I/O al salir (beforeunload). */
const ordersAbortScope = createAbortScope();
window.addEventListener("beforeunload", () => ordersAbortScope.abort("unload"), { once: true });

/**
 * AbortScope de búsqueda: independiente del scope de pantalla.
 * Se recrea en cada llamada a searchOrdersInDatabase para cancelar la búsqueda
 * anterior. Así evitamos que resultados tardíos pisen el estado de una nueva
 * búsqueda sin necesidad de un scope global compartido.
 *
 * Nota: no se expone fuera de la función — la referencia vive en el closure
 * de cada invocación activa.
 */
let _activeSearchAbortScope = null;

function normalizeCustomerSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeCustomerSearch(value) {
  return normalizeCustomerSearchText(value)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

function customerMatchesFlexible(searchTerm, customer) {
  const normQuery = normalizeCustomerSearchText(searchTerm);
  const tokens = tokenizeCustomerSearch(normQuery);
  const fullName = normalizeCustomerSearchText(customer?.full_name || "");
  const dni = String(customer?.dni || "").toLowerCase();
  const email = String(customer?.email || "").toLowerCase();
  const customerNumber = String(customer?.customer_number || "").toLowerCase();
  const phoneDigits = String(customer?.phone || "").replace(/\D/g, "");
  const queryDigits = String(searchTerm || "").replace(/\D/g, "");

  if (fullName === normQuery) return true;
  if (fullName.startsWith(normQuery)) return true;
  if (tokens.length > 0 && tokens.every((t) => fullName.includes(t))) return true;
  if (customerNumber && customerNumber.includes(normQuery)) return true;
  if (dni && dni.includes(normQuery)) return true;
  if (email && email.includes(normQuery)) return true;
  if (queryDigits && phoneDigits.includes(queryDigits)) return true;
  return false;
}

/**
 * Contador de búsquedas activas: race condition guard.
 * Solo la invocación con el seq más alto puede mutar `orders` y llamar displayOrders.
 */
let _searchSeq = 0;
const _ordersUiActionInFlight = new Set();

function runOrdersTask(label, task) {
  return Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error(`[orders] ${label} failed:`, error);
      throw error;
    });
}

function generateOperationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const nowHex = Date.now().toString(16).padStart(12, "0");
  const randHex = Math.random().toString(16).slice(2).padEnd(20, "0").slice(0, 20);
  return `${nowHex.slice(0, 8)}-${nowHex.slice(8, 12)}-4${randHex.slice(0, 3)}-a${randHex.slice(3, 6)}-${randHex.slice(6, 18)}`;
}

async function callMarkOrderItemsPicked(sb, itemIds, source) {
  const operationId = generateOperationId();
  const { data, error } = await sb.rpc("rpc_mark_order_items_picked", {
    p_order_item_ids: itemIds,
    p_operation_id: operationId,
    p_request: { source: "admin/orders.js", action: source },
  });

  if (error) {
    const code = error.code ?? error.message ?? "";
    if (code.includes("conflict_in_progress")) {
      console.warn("⏳ rpc_mark_order_items_picked: operación en curso (conflict_in_progress). Reintentar en 2 s.");
    } else if (code.includes("operation_id_conflict")) {
      console.error("❌ rpc_mark_order_items_picked: operation_id reutilizado con payload distinto (bug).", error);
    } else {
      console.error("❌ rpc_mark_order_items_picked error:", error);
    }
    throw error;
  }

  if (data?.idempotent_replay) {
    console.log(`↩️  rpc_mark_order_items_picked replay (${source}): ${data.updated_count} actualizado(s), ${data.skipped_count} ya estaban en picked.`);
  } else {
    console.log(`✅ rpc_mark_order_items_picked (${source}): ${data?.updated_count ?? 0} actualizado(s), ${data?.skipped_count ?? 0} ya en picked.`);
  }

  return data;
}

// Permisos de pedidos — default permisivo durante boot (igual que stock.js).
// Se actualizan en applyOrdersPermissions(), llamada desde initOrders().
let canViewOrders = true;
let canEditOrders = true;
let canDeleteOrders = false;

/**
 * Carga y aplica permisos usando auth-state (Fase 3).
 *
 * Antes: 3 × checkPermission() = 3 × getUser() + isSuperAdmin() + hasta 3 RPCs.
 * Ahora: getAdminPermissions() = 1 getSession (local) + 1 bulk query → cache.
 *        can() es síncrono O(1) en los lookups siguientes.
 *
 * Se llama desde initOrders(), no en top-level, para no correr antes de que
 * Supabase esté disponible.
 */
async function applyOrdersPermissions() {
  try {
    await getAdminPermissions(); // carga bulk, una sola vez por sesión
    canViewOrders   = can("orders", "view");
    canEditOrders   = can("orders", "edit");
    canDeleteOrders = can("orders", "delete");

    if (canViewOrders === false) {
      // Solo redirigir cuando el servidor confirmó explícitamente sin permiso.
      alert("No tienes permiso para ver pedidos.");
      window.location.href = "./index.html";
    }
  } catch (permError) {
    console.warn("Error verificando permisos de orders; usando fallback permisivo:", permError);
    // Error de red transitorio: no degradar permisos. RLS protege el backend.
  }
}

// Función para obtener supabase, esperando a que esté disponible
async function getSupabase() {
  // Si ya está disponible, retornarlo
  if (supabase) {
    return supabase;
  }
  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }
  
  // Esperar hasta que window.supabase esté disponible (supabase-client.js lo asigna)
  let attempts = 0;
  const maxAttempts = 50; // 5 segundos máximo
  while (!window.supabase && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }
  
  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }
  
  // Si aún no está disponible, intentar importar
  try {
    const module = await import("../scripts/supabase-client.js");
    supabase = module.supabase || window.supabase;
    
    // Esperar un poco más
    if (!supabase) {
      await new Promise(resolve => setTimeout(resolve, 500));
      supabase = module.supabase || window.supabase;
    }
    
    if (supabase) {
      if (!window.supabase) {
        window.supabase = supabase;
      }
      return supabase;
    }
    
    console.error("❌ Supabase no disponible");
    return null;
  } catch (error) {
    console.error("❌ Error importando supabase-client:", error);
    return null;
  }
}

// Módulo orders.js cargado

// Importar función centralizada de normalización de tamaños
import { normalizeSize } from "../scripts/utils/size-normalizer.js";

const STATUS = {
  ACTIVE: "active",
  PICKED: "picked",
  CLOSED: "closed",
  SENT: "sent",
  PENDING: "pending",
  WAITING: "waiting",
  CANCELLED: "cancelled",
  STOCK_PENDING: "stock_pending",
  DEVOLUCION: "devolución",
  DEVOLUCION_ALT: "devolucion",
};

const WORKFLOW_STATUSES = ["active", "closed", "cancelled"];
const FINAL_STATUSES = ["sent", "devolución", "devolucion"];

const TAB_FILTER_MODE = {
  active: "client", // Activos se define por order_items (reserved/missing, no todos picked), no por orders.status; la BD no usa status='active'
  closed: "sql",
  cancelled: "client", // Cancelaciones incluye items cancelados + pedidos vencidos pendientes de desarme
  all: "sql",
  picked: "client",
  waiting: "client",
  stock_pending: "sql",
};

const ORDER_STATUS_LABELS = {
  active: "Activo",
  picked: "Apartado",
  closed: "Cerrado",
  sent: "Enviado",
  pending: "Pendiente",
  stock_pending: "Stock pendiente",
  waiting: "Espera",
};

const ORDER_STATUS_CLASSES = {
  active: "status-active",
  picked: "status-picked",
  closed: "status-closed",
  sent: "status-sent",
  pending: "status-pending",
  stock_pending: "status-stock-pending",
  cancelled: "status-cancelled",
  waiting: "status-waiting",
};

const ITEM_STATUS_INFO = {
  reserved: { text: "Reservado", className: "" },
  picked: { text: "Apartado", className: "picked" },
  missing: { text: "Falta", className: "missing" },
  cancelled: { text: "Cancelado", className: "cancelled" },
  waiting: { text: "Espera", className: "waiting" },
};

function isManualMissingOrderItem(item) {
  const status = String(item?.status || "").trim().toLowerCase();
  return status === "missing" && Boolean(item?.admin_confirmed_missing);
}

// Ítems nuevos (post-fix 179): picked pero con trazabilidad de confirmación manual.
function isPickedManualConfirmed(item) {
  const status = String(item?.status || "").trim().toLowerCase();
  return status === "picked" && Boolean(item?.admin_confirmed_missing);
}

/** Línea en waiting que sale del depósito venta-público (local). */
function isWaitingFromVentaPublico(item, warehouseInfoMap) {
  if (String(item?.status || "").trim().toLowerCase() !== "waiting") return false;
  if (warehouseInfoMap.get(item.id) === "Local") return true;
  const vId = warehousesCache.ventaPublico;
  const gId = warehousesCache.general;
  if (!vId) return false;
  const src = item.order_item_stock_sources;
  if (!Array.isArray(src) || src.length === 0) return false;
  let vq = 0;
  let gq = 0;
  for (const s of src) {
    const q = Number(s?.qty || 0) || 0;
    if (s?.warehouse_id === vId) vq += q;
    if (gId && s?.warehouse_id === gId) gq += q;
  }
  return vq > 0 && gq === 0;
}

function getOrderItemStatusDisplayInfo(item, warehouseInfoMap = new Map()) {
  const base = ITEM_STATUS_INFO[item.status] || ITEM_STATUS_INFO.reserved;
  if (isManualMissingOrderItem(item)) {
    return { ...base, text: "Falta (manual)" };
  }
  if (isPickedManualConfirmed(item)) {
    return { ...base, text: "Apartado (manual)" };
  }
  if (isWaitingFromVentaPublico(item, warehouseInfoMap)) {
    return { ...base, text: "Espera en local" };
  }
  return base;
}

// Función auxiliar para verificar si un pedido tiene todos los items apartados
// waiting se trata como picked para verificación de completitud
// Regla: sin order_items o array vacío => NO "todos apartados" (return false)
function hasAllItemsPicked(order) {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  const items = isOrders2Page()
    ? order.order_items.filter((item) => {
        const status = String(item?.status || "").trim().toLowerCase();
        return status !== "missing" || isManualMissingOrderItem(item);
      })
    : order.order_items;
  const totalItems = items.length;
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const pickedItems = items.filter(item => {
    const st = norm(item.status);
    // Los ítems confirmados manualmente (missing + admin_confirmed_missing) cuentan
    // como "efectivamente apartados" para la asignación de pestañas.
    return st === "picked" || st === "waiting" || isManualMissingOrderItem(item) || isPickedManualConfirmed(item);
  }).length;
  return pickedItems === totalItems && totalItems > 0;
}

// Función auxiliar para verificar si un pedido tiene al menos un item reservado
function hasReservedItems(order) {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  return order.order_items.some(item => norm(item.status) === "reserved");
}

// Función auxiliar para verificar si un pedido tiene items que necesitan atención
// (reserved o missing real — no los confirmados manualmente que ya son operativos)
function hasItemsNeedingAttention(order) {
  if (!order.order_items || order.order_items.length === 0) {
    return false;
  }
  // Los ítems missing confirmados manualmente (admin_confirmed_missing) NO son "faltantes
  // reales": el admin confirmó que los tiene físicamente, así que no generan atención.
  return order.order_items.some(item =>
    (item.status === 'reserved' || item.status === 'missing') &&
    !isManualMissingOrderItem(item) &&
    !isPickedManualConfirmed(item)
  );
}

// Función auxiliar para verificar si un pedido tiene items en espera
function hasWaitingItems(order) {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  return order.order_items.some(item => norm(item.status) === "waiting");
}

// Función auxiliar: pedido tiene SOLO ítems en espera (todos "waiting", sin reserved ni picked)
// Usado para que Activos y Espera sean excluyentes: "solo espera" va solo en pestaña Espera.
function hasOnlyWaitingItems(order) {
  if (!order.order_items || order.order_items.length === 0) return false;
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  return order.order_items.every(item => norm(item.status) === "waiting");
}

function hasOrderPassedCustomerEditWindow(order) {
  if (!order) return false;
  const nowMs = Date.now();
  const dismantleAtMs = order?.dismantle_at ? new Date(order.dismantle_at).getTime() : NaN;
  if (Number.isFinite(dismantleAtMs)) {
    return nowMs >= dismantleAtMs;
  }
  const createdAtMs = order.created_at ? new Date(order.created_at).getTime() : NaN;
  if (!Number.isFinite(createdAtMs)) return false;
  const daysElapsed = (nowMs - createdAtMs) / (1000 * 60 * 60 * 24);
  return daysElapsed >= 7;
}

function hasOperationalItems(order) {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) return false;
  const OPERATIONAL_ITEM_STATUSES = new Set(["reserved", "picked", "waiting", "missing"]);
  return order.order_items.some((item) => OPERATIONAL_ITEM_STATUSES.has(String(item?.status || "").trim().toLowerCase()));
}

function isExpiredPendingAdminDisassembly(order) {
  if (!order) return false;
  const status = String(order.status || "").trim().toLowerCase();
  if (status === "sent" || status === "cancelled" || status === "devolución" || status === "devolucion") {
    return false;
  }
  return hasOrderPassedCustomerEditWindow(order) && hasOperationalItems(order);
}

let currentFilter = "active";

async function getOrderCustomerId(orderId) {
  if (!orderId) return null;
  try {
    const local = Array.isArray(orders) ? orders.find((o) => String(o?.id) === String(orderId)) : null;
    const cid = local?.customer_id || local?.customers?.id || (Array.isArray(local?.customers) ? local.customers[0]?.id : null);
    if (cid) return cid;
  } catch (_) {
    /* ignore */
  }

  if (!supabase) supabase = await getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.from("orders").select("customer_id").eq("id", orderId).maybeSingle();
  if (error) return null;
  return data?.customer_id || null;
}

async function emitCustomerNotification({ customerId, orderId, type, message, payload, dedupeTypes }) {
  if (!customerId || !type || !message) return { ok: false };
  if (!supabase) supabase = await getSupabase();
  if (!supabase) return { ok: false };

  try {
    if (Array.isArray(dedupeTypes) && dedupeTypes.length) {
      await supabase
        .from("customer_notifications")
        .delete()
        .eq("customer_id", customerId)
        .eq("order_id", orderId)
        .in("type", dedupeTypes);
    }

    const insertPayload = {
      customer_id: customerId,
      order_id: orderId || null,
      type: String(type),
      message: String(message),
      payload: payload && typeof payload === "object" ? payload : {},
      read: false,
      read_at: null,
    };

    const { error } = await supabase.from("customer_notifications").insert(insertPayload);
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}
let orders = [];
let currentAdminUser = null;
let historyControlsInitialized = false;
let historyVisible = false;
let realtimeSubscription = null;
let currentSort = 'recent';
let currentSearch = '';
let searchDebounce = null;
// Variables de paginación e infinite scroll
let currentPage = 0;
let pageSize = 10;
let hasMoreOrders = true;
let isLoadingMore = false;
let allOrdersLoaded = false; // Para saber si ya se cargaron todos los pedidos
let badgeCountsLoaded = false; // Para saber si ya se cargaron los conteos totales de badges
/** IDs ordenados (más reciente primero) para Activos / Apartados / Espera: el filtro es por ítems, no por página SQL cruda. */
let clientTabFilteredIdsCache = null; // { filter: string, ids: string[] } | null
// Map para rastrear qué pedidos están en modo "ver completo" vs "solo reservados" en pestaña Activos
// orderId -> true (ver completo) | false/undefined (solo reservados)
let orderViewMode = new Map();
let orderWaitingViewMode = new Map(); // Para rastrear si se muestra solo items en espera o todos en la pestaña "Espera"
let orderClosedViewMode = new Map(); // Orders2: en Cerrados, renderizar items solo bajo demanda
// Cache de almacenes
let warehousesCache = { general: null, ventaPublico: null };

// Realtime delta: si true, solo insert/patch/remove por orderId; si false, comportamiento legacy (loadOrders en cada evento)
const REALTIME_DELTA_MODE = true;
const DEBUG_ORDERS = false;
const DEBUG_ACTIVE_FILTER = false; // true = logs por qué cada order se excluye en pestaña Activos
const ordersMap = new Map();
const pendingOrderIds = new Set();
let pendingTimer = null;
/** Evita que realtime inserte parches en el DOM mientras displayOrders reemplaza la lista por lotes (causa duplicados y refs obsoletas). */
let ordersUiFullReplaceInProgress = false;
let lastHiddenAt = 0;
let realtimeStatus = "UNKNOWN";
let lastVisibilityRefresh = 0;
let ordersLoadSeq = 0;
let ordersLastAppliedSeq = 0;

// Estado del modal de aceptar parcial (solo pedidos del cliente con varias unidades del mismo producto)
let partialAcceptState = null;

function isOrders2Page() {
  try {
    const p = (window.location && window.location.pathname) ? window.location.pathname.toLowerCase() : "";
    return (
      p.endsWith("/orders2.html") ||
      p.endsWith("orders2.html") ||
      p.endsWith("/orders.html") ||
      p.endsWith("orders.html")
    );
  } catch {
    return false;
  }
}

const ADMIN_CLIENT_SUMMARY_KEY = "admin_client_summary";
const ADMIN_ENABLE_24H_USES_KEY = "admin_enable_24h_uses";
const CUSTOMER_NOTIFICATION_ORDER_DISMANTLED_TIMEOUT = "ORDER_DISMANTLED_TIMEOUT";
const CUSTOMER_NOTIFICATION_ORDER_DEVOLUCION = "ORDER_MARKED_DEVOLUCION";
const customerIncidentPointsByCustomerId = new Map();
const transportNameById = new Map();
let transportNamesLoaded = false;

/** Fusiona claves en orders.notes (JSON). Si notes no es JSON objeto, devuelve null (no pisar). */
function applyOrderNotesPatch(rawNotes, patch) {
  let obj = {};
  if (rawNotes != null && String(rawNotes).trim() !== "") {
    try {
      const p = JSON.parse(String(rawNotes));
      if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
      obj = { ...p };
    } catch {
      return null;
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete obj[k];
    else obj[k] = v;
  }
  return JSON.stringify(obj);
}

function getAdminClientSummaryFromOrder(order) {
  if (!order?.notes) return "";
  try {
    const o = JSON.parse(order.notes);
    if (typeof o !== "object" || !o) return "";
    const s = o[ADMIN_CLIENT_SUMMARY_KEY];
    return typeof s === "string" && s.trim() ? s.trim() : "";
  } catch {
    return "";
  }
}

function getEnable24hUsesFromOrder(order) {
  if (!order?.notes) return 0;
  try {
    const o = JSON.parse(order.notes);
    if (typeof o !== "object" || !o) return 0;
    const n = Number(o[ADMIN_ENABLE_24H_USES_KEY] || 0);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  } catch {
    return 0;
  }
}

function parseOrderNotesObject(rawNotes) {
  if (!rawNotes) return {};
  try {
    const parsed = JSON.parse(String(rawNotes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore parse errors, fallback to empty object
  }
  return {};
}

function parseStockPendingReasonConflict(rawReason) {
  const reason = String(rawReason || "");
  if (!reason) return null;
  const variantMatch = reason.match(/variant=([0-9a-fA-F-]{36})/);
  const sizeMatch = reason.match(/size=([^,\s)]+)/i);
  const availableMatch = reason.match(/disponible=(\d+)/i);
  const requestedMatch = reason.match(/solicitado=(\d+)/i);
  if (!variantMatch) return null;
  return {
    variant_id: variantMatch[1],
    size: normalizeSize(sizeMatch?.[1] || ""),
    available: Number(availableMatch?.[1] || 0),
    requested: Number(requestedMatch?.[1] || 0),
  };
}

function describeStockPendingConflict(order, parsedConflict, fallbackReason = "") {
  if (!parsedConflict?.variant_id) return fallbackReason || "Conflicto de stock sin detalle.";
  const items = Array.isArray(order?.order_items) ? order.order_items : [];
  const targetItem = items.find((item) => {
    const sameVariant = String(item?.variant_id || "") === String(parsedConflict.variant_id);
    const sameSize = normalizeSize(item?.size || "") === parsedConflict.size;
    return sameVariant && sameSize;
  });
  if (!targetItem) return fallbackReason || "Conflicto de stock sin detalle.";
  const productLabel = [targetItem.product_name || "Producto", targetItem.color || "-", targetItem.size || "-"].join(" · ");
  return `${productLabel} | Disponible: ${parsedConflict.available} · Solicitado: ${parsedConflict.requested}`;
}

function clampIncidentPoints(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(3, Math.floor(n));
}

async function refreshCustomerIncidentPoints(orderList) {
  const customerIds = Array.from(
    new Set(
      (Array.isArray(orderList) ? orderList : [])
        .map((order) => String(order?.customer_id || order?.customers?.id || "").trim())
        .filter(Boolean)
    )
  );
  customerIncidentPointsByCustomerId.clear();
  if (customerIds.length === 0) return;

  if (!supabase) supabase = await getSupabase();
  if (!supabase) return;

  const baseMap = new Map();
  customerIds.forEach((id) => baseMap.set(id, { blue: 0, red: 0 }));

  const { data, error } = await supabase
    .from("customer_notifications")
    .select("customer_id, type")
    .in("customer_id", customerIds)
    .in("type", [
      CUSTOMER_NOTIFICATION_ORDER_DISMANTLED_TIMEOUT,
      CUSTOMER_NOTIFICATION_ORDER_DEVOLUCION,
    ]);

  if (error || !Array.isArray(data)) {
    for (const [id, counts] of baseMap.entries()) {
      customerIncidentPointsByCustomerId.set(id, counts);
    }
    return;
  }

  for (const row of data) {
    const id = String(row?.customer_id || "").trim();
    if (!id || !baseMap.has(id)) continue;
    const current = baseMap.get(id);
    const type = String(row?.type || "").trim();
    if (type === CUSTOMER_NOTIFICATION_ORDER_DISMANTLED_TIMEOUT) current.blue += 1;
    if (type === CUSTOMER_NOTIFICATION_ORDER_DEVOLUCION) current.red += 1;
  }

  for (const [id, counts] of baseMap.entries()) {
    customerIncidentPointsByCustomerId.set(id, {
      blue: clampIncidentPoints(counts.blue),
      red: clampIncidentPoints(counts.red),
    });
  }
}

function buildCustomerIncidentPointsHtml(customerId) {
  const key = String(customerId || "").trim();
  if (!key) return "";
  const counters = customerIncidentPointsByCustomerId.get(key) || { blue: 0, red: 0 };
  const blue = clampIncidentPoints(counters.blue);
  const red = clampIncidentPoints(counters.red);
  if (blue === 0 && red === 0) return "";

  const dot = (color, title) =>
    `<span title="${title}" style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${color};"></span>`;
  const blueDots = Array.from({ length: blue }, () => dot("#17a2ff", "Incidencia por desarme de pedido")).join("");
  const redDots = Array.from({ length: red }, () => dot("#dc3545", "Incidencia por devolución")).join("");
  return `
    <span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;vertical-align:middle;">
      ${blueDots}${redDots}
    </span>
  `;
}

async function loadTransportNames() {
  if (transportNamesLoaded) return;
  if (!supabase) supabase = await getSupabase();
  if (!supabase) return;

  try {
    const { data, error } = await supabase.from("transports").select("id, name");
    if (!error && Array.isArray(data)) {
      transportNameById.clear();
      data.forEach((t) => {
        const id = String(t?.id || "").trim();
        const name = String(t?.name || "").trim();
        if (id && name) transportNameById.set(id, name);
      });
    }
  } catch (_) {
    /* ignore */
  } finally {
    transportNamesLoaded = true;
  }
}

function normalizeTransportNameKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function getOrderTransportLabel(order, customer) {
  const orderTransportId = String(order?.transport_id || "").trim();
  const customerTransportId = String(customer?.transport_id || "").trim();
  const transportId = orderTransportId || customerTransportId;
  if (!transportId) return "Sin transporte asignado";
  return transportNameById.get(transportId) || "Transporte asignado";
}

function getTransportBadgeClassByLabel(label) {
  const key = normalizeTransportNameKey(label);
  if (key === "correo argentino") return "transport-badge--correo-argentino";
  if (key === "sede") return "transport-badge--sede";
  if (key === "credifin") return "transport-badge--credifin";
  if (key === "via cargo" || key === "via carlo") return "transport-badge--via-cargo";
  if (key === "mym") return "transport-badge--mym";
  if (key === "snaider") return "transport-badge--snaider";
  if (key === "retira local" || key === "retiro del local" || key === "retiro de local") {
    return "transport-badge--retira-local";
  }
  return "transport-badge--default";
}

/** Contribuciones por ítem (picked/waiting/missing/reserved) según BD o selección pendiente orders2. */
function collectContributionsForOrderItem(item, pendingEntry) {
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  if (norm(item?.status) === "cancelled") return [];

  const name = (item.product_name || "Producto").toString().trim() || "Producto";
  const color = (item.color || "-").toString().trim() || "-";
  const size = (item.size || "-").toString().trim() || "-";
  const qty = Number(item.quantity) || 0;
  const piece = (kind, q) => ({ kind, qty: q, name, color, size });

  if (pendingEntry?.kind === "split") {
    const s = pendingEntry.split || {};
    const nP = Number(s.nPicked) || 0;
    const nW = Number(s.nWaiting) || 0;
    const nM = Number(s.nMissing) || 0;
    const out = [];
    if (nP > 0) out.push(piece("picked", nP));
    if (nW > 0) out.push(piece("waiting", nW));
    if (nM > 0) out.push(piece("missing", nM));
    const rest = qty - nP - nW - nM;
    if (rest > 0) out.push(piece("reserved", rest));
    return out;
  }

  if (pendingEntry?.kind === "status") {
    const a = pendingEntry.action;
    if (a === "delete-item" || a === "remove-missing" || a === "cleanup-cancelled") return [];
    if (a === "picked") return [piece("picked", qty)];
    if (a === "waiting") return [piece("waiting", qty)];
    if (a === "missing") return [piece(isManualMissingOrderItem(item) ? "missing_manual" : "missing", qty)];
    if (a === "reserved") return [piece("reserved", qty)];
    return [];
  }

  const st = norm(item.status);
  if (st === "picked") return [piece("picked", qty)];
  if (st === "waiting") return [piece("waiting", qty)];
  if (st === "missing") return [piece(isManualMissingOrderItem(item) ? "missing_manual" : "missing", qty)];
  if (st === "reserved") return [piece("reserved", qty)];
  return [piece("reserved", qty)];
}

function buildAdminClientSummaryFromContributions(contributions) {
  if (!contributions.length) return "";

  const fmtMissingLine = (c) => {
    const q = c.qty;
    if (q === 1) {
      return `- 1 unidad del artículo ${c.name}, color ${c.color}, talle ${c.size}`;
    }
    return `- ${q} unidades del artículo ${c.name}, color ${c.color}, talle ${c.size}`;
  };

  const hasMissing = contributions.some((c) => c.kind === "missing" || c.kind === "missing_manual");
  const apartadosQty = contributions
    .filter((c) => c.kind === "picked" || c.kind === "waiting")
    .reduce((sum, c) => sum + c.qty, 0);

  const missingLines = contributions.filter((c) => c.kind === "missing").map(fmtMissingLine);
  const missingManualLines = contributions.filter((c) => c.kind === "missing_manual").map(fmtMissingLine);
  const stockBlock = [
    missingLines.length > 0 ? `❌ Sin stock:\n${missingLines.join("\n")}` : "",
    missingManualLines.length > 0 ? `⚠ Carga manual sin stock confirmado:\n${missingManualLines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Sin apartados efectivos y sin faltantes en el mensaje (p. ej. solo reserva interna): no inventar texto
  if (!hasMissing && apartadosQty === 0) {
    return "";
  }

  // Escenario 1 — todo apartado/en espera para el cliente, sin faltantes
  if (!hasMissing && apartadosQty > 0) {
    return `Tu pedido está listo 👍

✔ Todos los productos ya están reservados.

Ya reservamos estos productos para vos. Podés seguir agregando más si querés.`.trim();
  }

  // Escenario 2 — parte apartado + parte sin stock
  if (hasMissing && apartadosQty > 0) {
    return `Parte de tu pedido ya está confirmado 👍

✔ Se reservaron ${apartadosQty} unidades.

${stockBlock}

Si querés, podés reemplazar los faltantes o seguir agregando otros productos.`.trim();
  }

  // Escenario 3 — todo faltante, nada apartado
  if (hasMissing && apartadosQty === 0) {
    return `No pudimos confirmar stock de tu pedido ❌

${stockBlock}

Podés elegir otros modelos o seguir agregando productos a tu pedido.`.trim();
  }

  return "";
}

function buildAdminClientSummary(order) {
  const contribs = [];
  for (const item of order?.order_items || []) {
    contribs.push(...collectContributionsForOrderItem(item, null));
  }
  return buildAdminClientSummaryFromContributions(contribs);
}

/** Misma lógica que buildAdminClientSummary pero aplicando `orders2PendingByOrder` por ítem (vista previa antes de Aceptar). */
function buildAdminClientSummaryWithPending(order) {
  const pendingMap = orders2PendingByOrder.get(order.id);
  const contribs = [];
  for (const item of order?.order_items || []) {
    const entry = pendingMap?.get(item.id);
    contribs.push(...collectContributionsForOrderItem(item, entry));
  }
  return buildAdminClientSummaryFromContributions(contribs);
}

async function persistAdminClientSummaryForOrder(orderId) {
  if (!orderId || !canEditOrders) return;
  const client = await getSupabase();
  if (!client) return;
  const order = ordersMap.get(orderId);
  if (!order) return;

  const text = buildAdminClientSummary(order);
  if (!String(text).trim()) return;

  let nextNotes = applyOrderNotesPatch(order.notes, { [ADMIN_CLIENT_SUMMARY_KEY]: text });
  if (nextNotes === null) {
    const { data, error: selErr } = await client.from("orders").select("notes").eq("id", orderId).maybeSingle();
    if (selErr) return;
    nextNotes = applyOrderNotesPatch(data?.notes, { [ADMIN_CLIENT_SUMMARY_KEY]: text });
    if (nextNotes === null) {
      console.warn("notes del pedido no es JSON; no se guarda admin_client_summary.");
      return;
    }
  }

  const { error } = await client.from("orders").update({ notes: nextNotes }).eq("id", orderId);
  if (error) {
    console.warn("No se pudo guardar resumen para cliente:", error);
    return;
  }
  order.notes = nextNotes;
  await patchOrderCard(orderId, order);
}

async function clearOrderAdminClientSummary(orderId) {
  if (!orderId || !canEditOrders) return;
  const client = await getSupabase();
  if (!client) return;

  const { data, error: selErr } = await client.from("orders").select("notes").eq("id", orderId).maybeSingle();
  if (selErr) return;

  const nextNotes = applyOrderNotesPatch(data?.notes, { [ADMIN_CLIENT_SUMMARY_KEY]: null });
  if (nextNotes === null) return;
  if (String(data?.notes ?? "") === nextNotes) return;

  const { error } = await client.from("orders").update({ notes: nextNotes }).eq("id", orderId);
  if (error) console.warn("No se pudo limpiar resumen para cliente:", error);
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
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

// --- Orders2: selección de estados + Aceptar (por pedido) ---
const orders2PendingByOrder = new Map(); // orderId -> Map(itemId -> { kind, action?, split? })

function orders2PendingClassFor(kind, payload) {
  if (kind === "status") {
    if (payload === "picked") return "pending-picked";
    if (payload === "waiting") return "pending-waiting";
    if (payload === "missing") return "pending-missing";
    if (payload === "reserved") return "pending-reserved";
    if (payload === "delete-item") return "pending-missing";
    if (payload === "remove-missing") return "pending-missing";
    if (payload === "cleanup-cancelled") return "pending-missing";
  }
  if (kind === "split") {
    const { nPicked = 0, nWaiting = 0, nMissing = 0 } = payload || {};
    if (nWaiting > 0) return "pending-waiting";
    if (nPicked > 0) return "pending-picked";
    if (nMissing > 0) return "pending-missing";
    return "pending-reserved";
  }
  return "";
}

function orders2ClearPendingClasses(itemEl) {
  if (!itemEl) return;
  itemEl.classList.remove("pending-picked", "pending-waiting", "pending-missing", "pending-reserved");
}

function orders2ClearSplitPreview(itemEl) {
  if (!itemEl) return;
  itemEl.querySelectorAll(".orders2-split-preview").forEach((n) => n.remove());
}

function orders2RenderSplitPreview(itemEl, split) {
  if (!itemEl) return;
  orders2ClearSplitPreview(itemEl);

  const s = split || {};
  const parts = [
    { key: "picked", n: Number(s.nPicked || 0) || 0, cls: "pending-picked", label: "Apartado" },
    { key: "waiting", n: Number(s.nWaiting || 0) || 0, cls: "pending-waiting", label: "Espera" },
    { key: "missing", n: Number(s.nMissing || 0) || 0, cls: "pending-missing", label: "Faltante" },
  ].filter((p) => p.n > 0);

  if (parts.length <= 1) return;

  const wrap = document.createElement("div");
  wrap.className = "orders2-split-preview";
  wrap.innerHTML = parts
    .map(
      (p) =>
        `<div class="orders2-split-row ${p.cls}"><strong>${p.label}</strong> <span>x${p.n}</span></div>`
    )
    .join("");

  itemEl.appendChild(wrap);
}

function orders2ApplyPendingToItemEl(itemEl, kind, payload) {
  if (!itemEl) return;
  orders2ClearPendingClasses(itemEl);
  orders2ClearSplitPreview(itemEl);
  const cls = orders2PendingClassFor(kind, payload);
  if (cls) itemEl.classList.add(cls);
  if (kind === "split") orders2RenderSplitPreview(itemEl, payload);
}

function orders2GetOrderIdFromAnyEl(el) {
  const card = el?.closest?.(".order-card[data-order-id]");
  return card?.getAttribute("data-order-id") || "";
}

function orders2EnsureAcceptRow(orderId) {
  if (!orderId) return;
  const card = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
  if (!card) return;
  let row = card.querySelector(".order-accept-row");
  if (!row) {
    row = document.createElement("div");
    row.className = "order-accept-row";
    row.innerHTML = `
      <button type="button" class="btn orders2-accept-btn" data-accept-order="${orderId}">
        Aceptar
      </button>
    `;
    const totalEl = card.querySelector(".order-total");
    if (totalEl && totalEl.parentElement === card) {
      card.insertBefore(row, totalEl);
    } else {
      card.appendChild(row);
    }
  }
  orders2SyncAcceptRow(orderId);
}

function orders2SyncAcceptRow(orderId) {
  const card = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
  if (!card) {
    orders2SyncClientSummaryButtonVisibility(orderId);
    return;
  }
  const row = card.querySelector(".order-accept-row");
  if (row) {
    const pending = orders2PendingByOrder.get(orderId);
    const count = pending ? pending.size : 0;
    if (!count) {
      row.style.display = "none";
    } else {
      row.style.display = "block";
      const btn = row.querySelector("[data-accept-order]");
      if (btn) btn.textContent = `Aceptar (${count})`;
    }
  }
  orders2SyncClientSummaryButtonVisibility(orderId);
}

/** Muestra u oculta el botón 💬 según pendientes o resumen guardado (solo orders2, pedido cliente). */
function orders2SyncClientSummaryButtonVisibility(orderId) {
  if (!isOrders2Page() || !orderId) return;
  const order = ordersMap.get(orderId);
  if (!order) return;
  const isCustomerOrder = String(order?.source || "").trim().toLowerCase() === "customer";
  if (!isCustomerOrder) return;

  const card = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
  if (!card) return;
  const host = card.querySelector(".customer-info");
  if (!host) return;

  const pendingCount = orders2PendingByOrder.get(orderId)?.size ?? 0;
  const saved = getAdminClientSummaryFromOrder(order);
  const show = pendingCount > 0 || Boolean(saved);

  const details = host.querySelector(".customer-details");
  let row = host.querySelector(".orders2-client-message-row");
  if (!show) {
    row?.remove();
    return;
  }
  const btnHtml = `<div class="orders2-client-message-row">
                 <button type="button" class="orders2-client-message-btn" data-copy-client-summary="${order.id}" aria-label="Copiar mensaje para el cliente">
                   <span class="orders2-client-message-btn__icon" aria-hidden="true">💬</span>
                   <span class="orders2-client-message-btn__text">Copiar mensaje</span>
                 </button>
               </div>`;
  if (row) {
    row.outerHTML = btnHtml;
  } else if (details) {
    details.insertAdjacentHTML("afterend", btnHtml);
  }
}

function orders2SetPendingStatus(orderId, itemId, action) {
  if (!orderId || !itemId) return;
  if (!orders2PendingByOrder.has(orderId)) orders2PendingByOrder.set(orderId, new Map());
  orders2PendingByOrder.get(orderId).set(itemId, { kind: "status", action });
  orders2EnsureAcceptRow(orderId);
  orders2SyncAcceptRow(orderId);
  const itemEl = document.querySelector(`.order-card[data-order-id="${orderId}"] [data-item-id="${itemId}"]`)?.closest?.(".order-item");
  orders2ApplyPendingToItemEl(itemEl, "status", action);
}

function orders2SetPendingSplit(orderId, itemId, split) {
  if (!orderId || !itemId) return;
  if (!orders2PendingByOrder.has(orderId)) orders2PendingByOrder.set(orderId, new Map());
  orders2PendingByOrder.get(orderId).set(itemId, { kind: "split", split });
  orders2EnsureAcceptRow(orderId);
  orders2SyncAcceptRow(orderId);
  const itemEl = document.querySelector(`.order-card[data-order-id="${orderId}"] [data-item-id="${itemId}"]`)?.closest?.(".order-item");
  orders2ApplyPendingToItemEl(itemEl, "split", split);
}

async function orders2AcceptPending(orderId) {
  const pending = orders2PendingByOrder.get(orderId);
  if (!pending || pending.size === 0) return;
  const card = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
  const btn = card?.querySelector(`[data-accept-order="${orderId}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Aplicando...";
  }

  try {
    let pendingMissing = 0;
    let pendingPicked = 0;
    let pendingWaiting = 0;

    for (const [itemId, entry] of pending.entries()) {
      if (!entry) continue;
      if (entry.kind === "split") {
        const s = entry.split || {};
        pendingPicked += Number(s.nPicked || 0) || 0;
        pendingWaiting += Number(s.nWaiting || 0) || 0;
        pendingMissing += Number(s.nMissing || 0) || 0;
        await callRpcSplitOrderItemStatus(itemId, s.nPicked || 0, s.nWaiting || 0, s.nMissing || 0);
        continue;
      }
      const action = entry.action;
      if (action === "cleanup-cancelled") await cleanupCancelledItem(itemId);
      else if (action === "remove-missing") await removeMissingItem(itemId);
      else if (action === "delete-item") await deleteOrderItemImmediate(itemId);
      else if (action === "picked") await updateOrderItemStatus(itemId, "picked", { skipReload: true });
      else if (action === "waiting") await updateOrderItemStatus(itemId, "waiting", { skipReload: true });
      else if (action === "missing") await updateOrderItemStatus(itemId, "missing", { skipReload: true });
      else if (action === "reserved") await updateOrderItemStatus(itemId, "reserved", { skipReload: true });

      if (action === "picked") pendingPicked += 1;
      else if (action === "waiting") pendingWaiting += 1;
      else if (action === "missing") pendingMissing += 1;
    }

    // Notificación al cliente: solo cuando se acepta en pestaña "Activos" (orders2.html)
    if (isOrders2Page() && currentFilter === "active") {
      const customerId = await getOrderCustomerId(orderId);
      const actionUrl = "client/dashboard.html?view=history";
      const actionUrlDashboard = "client/dashboard.html";

      if (pendingMissing > 0) {
        await emitCustomerNotification({
          customerId,
          orderId,
          type: "ORDER_MISSING_ITEMS",
          message: `${pendingMissing} producto(s) no están disponibles. Por favor revisalos en tu pedido.`,
          payload: { missingCount: pendingMissing, action_url: actionUrl },
          dedupeTypes: ["ORDER_MISSING_ITEMS", "ORDER_ALL_RESERVED"],
        });
      } else if (pendingPicked > 0 || pendingWaiting > 0) {
        await emitCustomerNotification({
          customerId,
          orderId,
          type: "ORDER_ALL_RESERVED",
          message: "Todos los productos están reservados.",
          payload: { action_url: actionUrlDashboard },
          dedupeTypes: ["ORDER_MISSING_ITEMS", "ORDER_ALL_RESERVED"],
        });
      }
    }

    orders2PendingByOrder.delete(orderId);
    orders2SyncAcceptRow(orderId);

    if (orderId && typeof refreshOneOrder === "function") await refreshOneOrder(orderId);
    else if (typeof loadOrders === "function") await loadOrders();

    if (isOrders2Page() && currentFilter === "active" && orderId) {
      const ordAfter = ordersMap.get(orderId);
      const src = String(ordAfter?.source || "").trim().toLowerCase();
      if (ordAfter && src === "customer") await persistAdminClientSummaryForOrder(orderId);
    }
  } catch (e) {
    console.error("❌ Error aplicando pendientes:", e);
    alert(e?.message || "No se pudieron aplicar los cambios.");
  } finally {
    if (btn) {
      btn.disabled = false;
      orders2SyncAcceptRow(orderId);
    }
  }
}

function setupOrders2PendingAcceptSystem() {
  if (!isOrders2Page()) return;
  if (window.__orders2PendingAcceptSetup) return;
  window.__orders2PendingAcceptSetup = true;

  document.addEventListener("click", (e) => {
    const acceptBtn = e.target.closest?.("[data-accept-order]");
    if (!acceptBtn) return;
    const orderId = acceptBtn.getAttribute("data-accept-order");
    if (!orderId) return;
    e.preventDefault();
    orders2AcceptPending(orderId);
  });
}

function setupOrders2ClientSummaryCopy() {
  if (!isOrders2Page()) return;
  if (window.__orders2ClientSummaryCopySetup) return;
  window.__orders2ClientSummaryCopySetup = true;

  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-copy-client-summary]");
    if (!btn) return;
    const orderId = btn.getAttribute("data-copy-client-summary");
    if (!orderId) return;
    e.preventDefault();
    const lockKey = `copy-summary:${orderId}`;
    if (_ordersUiActionInFlight.has(lockKey)) return;
    _ordersUiActionInFlight.add(lockKey);
    btn.disabled = true;

    runOrdersTask("copy_client_summary", async () => {
      const order = ordersMap.get(orderId);
      if (!order) {
        alert("No se encontró el pedido.");
        return;
      }
      const live = buildAdminClientSummaryWithPending(order).trim();
      const text = live || getAdminClientSummaryFromOrder(order);
      if (!text) {
        alert("No hay datos para armar el mensaje. Marcá al menos un producto o aceptá los cambios primero.");
        return;
      }
      const ok = await copyTextToClipboard(text);
      if (ok) showToastNotification("Mensaje generado y copiado al portapapeles.", "success");
      else alert("No se pudo copiar. Copiá el texto manualmente desde el pedido.");
    }).catch(() => {
      alert("No se pudo copiar. Reintentá.");
    }).finally(() => {
      _ordersUiActionInFlight.delete(lockKey);
      btn.disabled = false;
    });
  });
}

function setupOrders2MissingItemsModalSystem() {
  if (!isOrders2Page()) return;
  if (window.__orders2MissingModalSetup) return;
  window.__orders2MissingModalSetup = true;

  function ensureModal() {
    if (document.getElementById("orders2-missing-modal")) return;
    const modal = document.createElement("div");
    modal.id = "orders2-missing-modal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-content orders2-missing-modal-content" style="max-width: 560px; text-align: left;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap: 10px; margin-bottom: 14px;">
          <h2 id="orders2-missing-modal-title" style="margin:0; font-size: 18px; color:#333;">Productos faltantes</h2>
          <button type="button" class="order-modal-close" data-close-missing-modal aria-label="Cerrar">&times;</button>
        </div>
        <div id="orders2-missing-modal-body"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("active");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") modal.classList.remove("active");
    });
  }

  function openModalForOrder(orderId) {
    ensureModal();
    const modal = document.getElementById("orders2-missing-modal");
    const title = document.getElementById("orders2-missing-modal-title");
    const body = document.getElementById("orders2-missing-modal-body");
    if (!modal || !title || !body) return;

    const order = orders.find((o) => String(o?.id) === String(orderId));
    const items = (order?.order_items || []).filter((i) => {
      const status = String(i?.status || "").trim().toLowerCase();
      return status === "missing" && !isManualMissingOrderItem(i);
    });

    title.textContent = `Productos faltantes (${items.length || 0})`;

    if (!items.length) {
      body.innerHTML = `<div style="padding: 10px; color:#666;">No hay productos faltantes en este pedido.</div>`;
      modal.classList.add("active");
      return;
    }

    body.innerHTML = `
      <div class="orders2-missing-list">
        ${items
          .map((it) => {
            const color = (it.color || "-").toString().trim() || "-";
            const size = (it.size || "-").toString().trim() || "-";
            const qty = Number(it.quantity || 0) || 0;
            const line = `${it.product_name} - ${color} - ${size} - x${qty}`;
            return `
              <div class="orders2-missing-row">
                <div class="orders2-missing-row__main">
                  <div class="orders2-missing-row__title">${line}</div>
                </div>
                <button type="button" class="btn orders2-missing-remove-btn" data-remove-missing-item="${it.id}" data-order-id="${orderId}">
                  Quitar
                </button>
              </div>
            `;
          })
          .join("")}
      </div>
    `;

    modal.classList.add("active");
  }

  document.addEventListener("click", async (e) => {
    const openBtn = e.target.closest?.("[data-open-missing-modal]");
    if (openBtn) {
      e.preventDefault();
      const orderId = openBtn.getAttribute("data-open-missing-modal");
      if (orderId) openModalForOrder(orderId);
      return;
    }
    const closeBtn = e.target.closest?.("[data-close-missing-modal]");
    if (closeBtn) {
      e.preventDefault();
      document.getElementById("orders2-missing-modal")?.classList.remove("active");
    }

    const removeBtn = e.target.closest?.("[data-remove-missing-item]");
    if (removeBtn) {
      e.preventDefault();
      const itemId = removeBtn.getAttribute("data-remove-missing-item");
      const orderId = removeBtn.getAttribute("data-order-id");
      if (!itemId) return;

      const confirmed = confirm("¿Quitar este producto faltante del pedido del cliente?");
      if (!confirmed) return;

      removeBtn.disabled = true;
      const prevText = removeBtn.textContent;
      removeBtn.textContent = "Quitando...";
      try {
        const res = await orders2RemoveMissingItemImmediate(itemId);
        if (!res.ok) {
          alert("No se pudo quitar el producto.");
          return;
        }

        // Refrescar UI
        if (res.orderId && typeof refreshOneOrder === "function") await refreshOneOrder(res.orderId);
        else if (typeof loadOrders === "function") await loadOrders();

        // Re-render modal contents (si sigue abierto)
        const modal = document.getElementById("orders2-missing-modal");
        if (modal && modal.classList.contains("active")) {
          openModalForOrder(orderId || res.orderId);
        }
      } catch (err) {
        console.error("❌ Error quitando faltante:", err);
        alert("No se pudo quitar el producto.");
      } finally {
        removeBtn.disabled = false;
        removeBtn.textContent = prevText || "Quitar";
      }
    }
  });
}

async function orders2RemoveMissingItemImmediate(itemId) {
  if (!itemId) return { ok: false, orderId: null, reason: "missing itemId" };
  if (!supabase) supabase = await getSupabase();
  if (!supabase) return { ok: false, orderId: null, reason: "no supabase" };

  const { data: itemRow, error: itemErr } = await supabase
    .from("order_items")
    .select("id, order_id, status")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr || !itemRow) return { ok: false, orderId: null, reason: "item not found" };

  const orderId = itemRow.order_id;
  const status = String(itemRow.status || "").toLowerCase();
  if (status !== "missing") return { ok: false, orderId, reason: "not missing" };

  const { data: rpcData, error: rpcErr } = await supabase.rpc("rpc_remove_order_item_restore_stock", {
    p_order_item_id: itemId,
  });
  if (rpcErr) return { ok: false, orderId, reason: rpcErr.message || "rpc failed" };
  if (!rpcData || rpcData.ok !== true) {
    return { ok: false, orderId, reason: "rpc invalid response" };
  }

  return { ok: true, orderId: rpcData.order_id || orderId, order_deleted: !!rpcData.order_deleted };
}

function setupOrders2ItemKebabMenu() {
  if (!isOrders2Page()) return;
  if (window.__orders2ItemKebabMenuSetup) return;
  window.__orders2ItemKebabMenuSetup = true;

  function closeAll(exceptRoot) {
    document.querySelectorAll(".item-more[data-open='1']").forEach((root) => {
      if (exceptRoot && root === exceptRoot) return;
      root.removeAttribute("data-open");
    });
  }

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest?.("[data-kebab-toggle]");
    if (toggle) {
      const root = toggle.closest(".item-more");
      if (!root) return;
      e.preventDefault();
      e.stopPropagation();
      const isOpen = root.getAttribute("data-open") === "1";
      closeAll(root);
      if (!isOpen) root.setAttribute("data-open", "1");
      return;
    }

    const menuAction = e.target.closest?.("[data-kebab-action]");
    if (menuAction) {
      const root = menuAction.closest(".item-actions");
      const action = menuAction.getAttribute("data-kebab-action");
      if (!root || !action) return;
      e.preventDefault();
      const realBtn = root.querySelector(`[data-item-action="${action}"]`);
      if (realBtn) realBtn.click();
      closeAll();
      return;
    }

    closeAll();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll();
  });
}

let softRefreshTimer = null;
let softRefreshOrderId = null;
const SOFT_REFRESH_DELAY_MS = 1500;

function scheduleSoftRefresh(orderId) {
  if (orderId) softRefreshOrderId = orderId;
  if (softRefreshTimer) return;
  softRefreshTimer = setTimeout(() => {
    softRefreshTimer = null;
    const id = softRefreshOrderId;
    softRefreshOrderId = null;
    runOrdersTask("schedule_soft_refresh", async () => {
      if (id && typeof refreshOneOrder === "function") {
        await refreshOneOrder(id);
      } else if (typeof loadOrders === "function") {
        await loadOrders(false);
      }
      if (typeof updateActiveOrdersBadge === "function") updateActiveOrdersBadge();
      if (typeof updatePickedOrdersBadge === "function") updatePickedOrdersBadge();
      if (typeof updateClosedOrdersBadge === "function") updateClosedOrdersBadge();
      if (typeof updateCancelledOrdersBadge === "function") updateCancelledOrdersBadge();
      if (typeof updateWaitingOrdersBadge === "function") updateWaitingOrdersBadge();
    }).catch(() => {});
  }, SOFT_REFRESH_DELAY_MS);
}

function getCustomerName(order) {
  const c = Array.isArray(order?.customers) ? order.customers[0] : order?.customers;
  const customerName = (c?.full_name || c?.name || '').toString().toLowerCase();
  return customerName || '';
}

function formatCustomerDisplayName(customer) {
  const full = (customer?.full_name || customer?.name || '').trim();
  if (!full) return 'Cliente sin nombre';
  const parts = full.split(/\s+/);
  if (parts.length === 1) return full;
  const last = parts.pop();
  const first = parts.join(' ');
  return `${last}, ${first}`;
}

function toWhatsAppPhoneDigits(rawPhone) {
  const s = String(rawPhone || "").trim();
  if (!s) return "";
  let digits = s.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  digits = digits.replace(/\D/g, "");
  // WhatsApp usa formato internacional sin "+".
  // Para AR, si viene con "00" internacional, normalizar a sin prefijo.
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits;
}

function buildWhatsAppHref(rawPhone) {
  const digits = toWhatsAppPhoneDigits(rawPhone);
  if (!digits) return "";
  return `https://wa.me/${digits}`;
}

function getCustomerPhone(order) {
  const c = Array.isArray(order?.customers) ? order.customers[0] : order?.customers;
  return (c?.phone || '').toString().toLowerCase();
}

function getCustomerDni(order) {
  const c = Array.isArray(order?.customers) ? order.customers[0] : order?.customers;
  return (c?.dni || '').toString().toLowerCase();
}

function getCustomerEmail(order) {
  const c = Array.isArray(order?.customers) ? order.customers[0] : order?.customers;
  return (c?.email || '').toString().toLowerCase();
}

function matchesSearch(order) {
  const q = (currentSearch || '').trim().toLowerCase();
  if (!q) return true;
  const name = getCustomerName(order) || '';
  const phone = getCustomerPhone(order) || '';
  const dni = getCustomerDni(order) || '';
  const email = getCustomerEmail(order) || '';
  const displayName = (() => {
    const full = name.trim();
    if (!full) return '';
    const parts = full.split(/\s+/);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      const first = parts.slice(0, -1).join(' ');
      return `${last}, ${first}`.toLowerCase();
    }
    return full;
  })();
  return (
    name.includes(q) ||
    displayName.includes(q) ||
    phone.includes(q) ||
    dni.includes(q) ||
    email.includes(q)
  );
}

function sortOrders(list) {
  const sorted = [...(list || [])];
  if (currentSort === 'oldest') {
    sorted.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  } else if (currentSort === 'name_az') {
    sorted.sort((a, b) => getCustomerName(a).localeCompare(getCustomerName(b), 'es'));
  } else if (currentSort === 'name_za') {
    sorted.sort((a, b) => getCustomerName(b).localeCompare(getCustomerName(a), 'es'));
  } else {
    // recent (default)
    sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }
  return sorted;
}

function setupSortControls() {
  const select = document.getElementById('sort-select');
  if (!select) return;
  select.value = currentSort;
  select.addEventListener('change', () => {
    currentSort = select.value || 'recent';
    displayOrders();
  });
}

function setupSearchControls() {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.value = currentSearch;
  input.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      runOrdersTask("search_input_refresh", async () => {
        const newSearch = input.value || '';
        currentSearch = newSearch;
        
        // Si hay búsqueda, buscar directamente en la base de datos
        if (newSearch.trim().length > 0) {
          showLoading();
          await searchOrdersInDatabase(newSearch.trim());
        } else {
          // Si no hay búsqueda, recargar pedidos normalmente con paginación
          currentPage = 0;
          orders = [];
          hasMoreOrders = true;
          allOrdersLoaded = false;
          await loadOrders(true);
        }
      }).catch((err) => {
        console.warn("[orders] search_input_refresh error:", err);
      });
    }, 250);
  });
}

async function initOrders() {
  try {
    // Obtener Supabase, esperando a que esté disponible
    supabase = await getSupabase();
    
    if (!supabase) {
      // Intentar una vez más después de un delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      supabase = window.supabase;
      
      if (!supabase) {
        console.error("❌ Supabase no disponible");
        alert("Error: Supabase no disponible. Por favor, recarga la página.");
        return;
      }
    }
    
    // Fase 3: preloadAuthState() carga usuario (getSession local) y permisos
    // (bulk, una sola query) en paralelo. Ambos quedan cacheados para toda la sesión.
    const { user } = await preloadAuthState();

    if (!user) {
      window.location.href = "index.html";
      return;
    }

    // verifyAdminAuth reutiliza el user de auth-state (no hace otro getUser).
    const isAdmin = await verifyAdminAuth(user);
    
    if (!isAdmin) {
      window.location.href = "index.html";
      return;
    }
    
    // Aplicar permisos de pedidos en background sin bloquear la carga de la UI.
    // getAdminPermissions() ya fue calentado por preloadAuthState() → O(1) desde cache.
    applyOrdersPermissions().catch(err =>
      console.warn("applyOrdersPermissions async:", err)
    );

    setupFilters();
    setupButtons();
    setupInfiniteScroll();
    
    // Mostrar loading inicial
    showLoading();
    
    // Cargar pedidos
    await loadOrders();

    // Primer paint: pedidos ya están en el DOM y el usuario puede operar.
    // Todo lo que sigue (realtime, badges, visibilitychange) es secundario.
    ordersScope.markFirstPaint("orders_loaded");

    setupRealtimeSubscription();

    if (typeof document !== "undefined") {
      const VISIBILITY_REFRESH_THROTTLE_MS = 30 * 1000;
      const HIDDEN_REFRESH_MS = 30 * 1000;
      const HIDDEN_FORCE_MS = 180 * 1000;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          lastHiddenAt = Date.now();
          return;
        }
        if (document.visibilityState !== "visible") return;
        if (typeof loadBadgeCountsInBackground === "function") loadBadgeCountsInBackground();
        const now = Date.now();
        const hiddenMs = lastHiddenAt ? now - lastHiddenAt : 0;
        if (REALTIME_DELTA_MODE) {
          if (now - lastVisibilityRefresh < VISIBILITY_REFRESH_THROTTLE_MS) return;
          const shouldFullRefresh =
            (realtimeStatus !== "SUBSCRIBED" && hiddenMs > HIDDEN_REFRESH_MS) ||
            (hiddenMs > HIDDEN_FORCE_MS && !pendingTimer && pendingOrderIds.size === 0);
          if (shouldFullRefresh && typeof loadOrders === "function") {
            lastVisibilityRefresh = now;
            loadOrders(true);
          }
        } else {
          if (now - lastVisibilityRefresh < VISIBILITY_REFRESH_THROTTLE_MS) return;
          lastVisibilityRefresh = now;
          if (typeof loadOrders === "function") loadOrders(true);
        }
      });
    }

    // Actualizar badges con datos de los pedidos cargados (rápido, pero puede ser inexacto)
    updateActiveOrdersBadge();
    updatePickedOrdersBadge();
    updateClosedOrdersBadge();
    updateCancelledOrdersBadge();
    updateWaitingOrdersBadge();
    
    // Cargar conteos exactos en background (no bloquea UI)
    // Esto actualizará los badges con números reales después de que el usuario vea los pedidos
    loadBadgeCountsInBackground();

    // Pantalla completamente lista: realtime configurado + badges actualizados.
    ordersScope.markReady("realtime_and_badges_ready");
  } catch (error) {
    console.error("❌ Error inicializando panel de pedidos:", error);
    ordersScope.markFirstPaint("init_error");
    // Usar classifyError (ya importado de fyl-fetch) en lugar de regex manual.
    const kind = classifyError(error);
    if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
      _showOrdersNetworkError("Error de conexión. Verificá tu red y recargá la página.");
    } else {
      window.location.href = "index.html";
    }
  }
}

async function verifyAdminAuth(existingUser = null) {
  try {
    if (!supabase) {
      supabase = await getSupabase();
    }
    if (!supabase) return false;

    // Reutilizar el user ya obtenido en initOrders para evitar segundo getUser().
    const user = existingUser ?? (await supabase.auth.getUser()).data?.user;
    if (!user) return false;

    const { data: adminRow, error: adminError } = await supabase
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error("❌ Error consultando tabla de admins:", adminError);
      return false;
    }

    if (!adminRow) {
      return false;
    }

    currentAdminUser = user;
    return true;
  } catch (error) {
    console.error("❌ Error en verifyAdminAuth:", error);
    return false;
  }
}

async function loadOrders(resetPagination = true) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en loadOrders");
    return;
  }

  const seq = ++ordersLoadSeq;
  const filterAtStart = currentFilter;
  const sortAtStart = currentSort;
  if (DEBUG_ORDERS) console.log("[orders] loadOrders start", { seq, filterAtStart, sortAtStart });

  // Si hay búsqueda activa, buscar directamente en la base de datos sin límite
  if (currentSearch && currentSearch.trim().length > 0) {
    await searchOrdersInDatabase(currentSearch.trim());
    return;
  }

  // Resetear paginación si se solicita (cambio de filtro, refresh, etc.)
  if (resetPagination) {
    currentPage = 0;
    orders = [];
    hasMoreOrders = true;
    allOrdersLoaded = false;
  }

  // Si ya se cargaron todos los pedidos, no hacer más consultas
  if (allOrdersLoaded) {
    if (seq !== ordersLoadSeq || filterAtStart !== currentFilter) {
      if (DEBUG_ORDERS) console.log("[orders] loadOrders dropped (allOrdersLoaded)", { seq, reason: "stale or filter changed" });
      return;
    }
    ordersLastAppliedSeq = seq;
    await displayOrders(!resetPagination);
    return;
  }

  // Construir query base: orders + order_items + customers (LEFT join; customers no tiene columna 'name', solo full_name)
  let query = supabase
    .from("orders")
    .select(
      `
        id,
        order_number,
        status,
        total_amount,
        created_at,
        expires_at,
        dismantle_at,
        transport_id,
        updated_at,
        sent_at,
        customer_id,
        notes,
        source,
        order_items (
          id,
          product_name,
          color,
          size,
          quantity,
          price_snapshot,
          status,
          imagen,
          variant_id,
          order_item_stock_sources ( qty, warehouse_id )
        ),
        customers:customer_id!left (
          id,
          customer_number,
          full_name,
          phone,
          city,
          province,
          dni,
          email,
          transport_id
        )
      `,
      { count: 'exact' }
    );

  const filterMode = TAB_FILTER_MODE[currentFilter];
  let data = null;
  let error = null;
  let totalCount = 0;

  if (filterMode === "items" && currentFilter === "cancelled") {
    // Cancelaciones: pedidos con al menos un ítem cancelado.
    const cancelledRes = await wrapSupabase(
      () => supabase
        .from("orders")
        .select("id, created_at, order_items!inner(status)")
        .eq("order_items.status", "cancelled")
        .order("created_at", { ascending: false }),
      { retries: 1, signal: ordersAbortScope.signal, label: "orders.load.cancelled_ids" }
    );
    if (cancelledRes.aborted) return;
    if (cancelledRes.error) {
      const kind = cancelledRes.kind;
      if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
        _showOrdersNetworkError("No se pudieron cargar los pedidos cancelados. Verificá tu conexión.");
        return;
      }
      error = cancelledRes.error;
      data = [];
    } else {
      const seen = new Set();
      const idsOrdered = (cancelledRes.data || []).map((r) => r.id).filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      totalCount = idsOrdered.length;
      const pageIds = idsOrdered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
      if (pageIds.length === 0) {
        data = [];
      } else {
        const cancelledPageRes = await wrapSupabase(
          () => supabase
            .from("orders")
            .select(`
              id, order_number, status, total_amount, created_at, expires_at, dismantle_at, transport_id, updated_at, sent_at, customer_id, notes, source,
              order_items ( id, product_name, color, size, quantity, price_snapshot, status, admin_confirmed_missing, imagen, variant_id, order_item_stock_sources ( qty, warehouse_id ) ),
              customers:customer_id!left ( id, customer_number, full_name, phone, city, province, dni, email, transport_id )
            `)
            .in("id", pageIds)
            .order("created_at", { ascending: false }),
          { retries: 1, signal: ordersAbortScope.signal, label: "orders.load.cancelled_page" }
        );
        if (cancelledPageRes.aborted) return;
        if (cancelledPageRes.error) {
          error = cancelledPageRes.error;
          data = [];
        } else {
          const orderById = new Map((cancelledPageRes.data || []).map((o) => [o.id, o]));
          data = pageIds.map((id) => orderById.get(id)).filter(Boolean);
        }
      }
    }
  } else {
    if (filterMode === "sql") {
      if (currentFilter === "all") {
        query = query.not("status", "in", '("sent","devolución","devolucion")');
      } else {
        query = query.eq("status", currentFilter);
      }

      query = query.order("created_at", { ascending: false }).range(currentPage * pageSize, (currentPage + 1) * pageSize - 1);
      const response = await wrapSupabase(() => query, {
        retries: 1,
        signal: ordersAbortScope.signal,
        label: `orders.load.sql.${currentFilter}`,
      });
      if (response.aborted) return;
      if (response.error) {
        const kind = response.kind;
        if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
          _showOrdersNetworkError("No se pudieron cargar los pedidos. Verificá tu conexión.");
          return;
        }
        // permission / unknown / auth: propagar el error para que el caller decida
        error = response.error;
      } else {
        data = response.data;
        // wrapSupabase reexpone `count` del header de Supabase cuando se usa { count: 'exact' }
        totalCount = response.count ?? response.data?.length ?? 0;
      }
    } else if (filterMode === "client") {
      // Activos / Apartados / Espera: el criterio es por estados de order_items. Paginar por IDs filtrados
      // (si pagináramos solo por fecha, los N más recientes podrían ser casi todos "Apartados" y la pestaña Activos quedaría casi vacía).
      let lightRows = null;
      let lightErr = null;

      if (resetPagination || !clientTabFilteredIdsCache || clientTabFilteredIdsCache.filter !== currentFilter) {
        let lightQuery = supabase
          .from("orders")
          .select("id, created_at, expires_at, dismantle_at, status, order_items(status)")
          .not("status", "in", '("sent","devolución","devolucion")');

        if (currentFilter === STATUS.ACTIVE || currentFilter === STATUS.PICKED || currentFilter === STATUS.WAITING) {
          lightQuery = lightQuery.neq("status", "stock_pending");
        }

        const lightRes = await wrapSupabase(
          () => lightQuery.order("created_at", { ascending: false }),
          { retries: 1, signal: ordersAbortScope.signal, label: `orders.load.light.${currentFilter}` }
        );
        if (lightRes.aborted) return;
        if (lightRes.error) {
          const kind = lightRes.kind;
          if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
            _showOrdersNetworkError("No se pudieron cargar los pedidos. Verificá tu conexión.");
            return;
          }
        }
        lightRows = lightRes.data;
        lightErr = lightRes.error;
      }

      if (seq !== ordersLoadSeq || filterAtStart !== currentFilter) {
        if (DEBUG_ORDERS) console.log("[orders] loadOrders dropped (client tab, pre-cache)", { seq, filterAtStart, currentFilter });
        return;
      }

      if (lightErr) {
        error = lightErr;
        data = [];
        totalCount = 0;
        clientTabFilteredIdsCache = null;
      } else if (resetPagination || !clientTabFilteredIdsCache || clientTabFilteredIdsCache.filter !== currentFilter) {
        const filtered = filterOrdersForTab(lightRows || [], currentFilter);
        clientTabFilteredIdsCache = {
          filter: currentFilter,
          ids: filtered.map((o) => o.id),
        };
        totalCount = filtered.length;
      } else {
        totalCount = clientTabFilteredIdsCache.ids.length;
      }

      if (!error) {
        const idList = (clientTabFilteredIdsCache && clientTabFilteredIdsCache.filter === currentFilter)
          ? clientTabFilteredIdsCache.ids
          : [];
        const pageIds = idList.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

        if (pageIds.length === 0) {
          data = [];
        } else {
          const fullSelect = `
            id,
            order_number,
            status,
            total_amount,
            created_at,
            expires_at,
            dismantle_at,
            transport_id,
            updated_at,
            sent_at,
            customer_id,
            notes,
            source,
            order_items (
              id,
              product_name,
              color,
              size,
              quantity,
              price_snapshot,
              status,
              admin_confirmed_missing,
              imagen,
              variant_id,
              order_item_stock_sources ( qty, warehouse_id )
            ),
            customers:customer_id!left (
              id,
              customer_number,
              full_name,
              phone,
              city,
              province,
              dni,
              email,
              transport_id
            )
          `;
          const fullRes = await wrapSupabase(
            () => supabase.from("orders").select(fullSelect).in("id", pageIds),
            { retries: 1, signal: ordersAbortScope.signal, label: `orders.load.full.${currentFilter}` }
          );
          if (fullRes.aborted) return;
          if (fullRes.error) {
            const kind = fullRes.kind;
            if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
              _showOrdersNetworkError("No se pudieron cargar los pedidos. Verificá tu conexión.");
              return;
            }
            error = fullRes.error;
            data = [];
          } else {
            const orderById = new Map((fullRes.data || []).map((o) => [o.id, o]));
            data = pageIds.map((id) => orderById.get(id)).filter(Boolean);
          }
        }
      }

      if (seq !== ordersLoadSeq || filterAtStart !== currentFilter) {
        if (DEBUG_ORDERS) console.log("[orders] loadOrders dropped (client tab, post-fetch)", { seq, filterAtStart, currentFilter });
        return;
      }
    }
  }

  // Verificar si hay más pedidos para cargar
  if (data && !error) {
    const loadedCount = (currentPage + 1) * pageSize;
    hasMoreOrders = loadedCount < totalCount;
    if (!hasMoreOrders) {
      allOrdersLoaded = true;
    }
  }

  // Normalizar customers: Supabase devuelve objeto o null con LEFT join; mantener compatibilidad con array/objeto/vacío
  if (data && !error && data.length > 0) {
    data = data.map((order) => {
      let customer = order.customers ?? null;
      if (customer && Array.isArray(customer)) {
        customer = customer[0] ?? null;
      }
      return { ...order, customers: customer };
    });
  }

  if (data && !error) {
    await refreshCustomerIncidentPoints(data);
  }

  if (error) {
    console.error("❌ Error cargando pedidos:", error);
    return;
  }

  if (seq !== ordersLoadSeq || filterAtStart !== currentFilter) {
    if (DEBUG_ORDERS) console.log("[orders] loadOrders dropped", { seq, filterAtStart, currentFilter, reason: "stale or filter changed" });
    return;
  }
  ordersLastAppliedSeq = seq;
  if (DEBUG_ORDERS) console.log("[orders] loadOrders apply", { seq, currentFilter });

  // Agregar nuevos pedidos a la lista (no reemplazar si estamos paginando)
  if (resetPagination) {
    orders = data || [];
  } else {
    orders = [...orders, ...(data || [])];
  }
  
  // Incrementar página para la próxima carga
  if (data && data.length > 0) {
    currentPage++;
  }
  
  // #region agent log - Comentado para evitar errores de conexión
  // Código de debugging removido para evitar errores de conexión
  // const sampleOrder = orders[0] || null;
  // const logData = {
  //   ordersCount: orders.length,
  //   sampleOrder: sampleOrder ? {
  //     id: sampleOrder.id,
  //     status: sampleOrder.status,
  //     itemsCount: sampleOrder.order_items?.length || 0,
  //     items: sampleOrder.order_items?.map(i => ({
  //       id: i.id,
  //       variant_id: i.variant_id,
  //       size: i.size,
  //       quantity: i.quantity,
  //       status: i.status
  //     })) || []
  //   } : null
  // };
  // fetch('http://127.0.0.1:7242/ingest/7a4b3bf8-ea8a-4f70-84cf-a37f8cbd48dc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orders.js:483',message:'loadOrders: Pedidos cargados',data:logData,timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
  // #endregion

  syncOrdersMapFromArray();
  if (DEBUG_ORDERS) {
    const statuses = [...new Set((orders || []).map((o) => o.status).filter(Boolean))];
    console.log("[debug] loadOrders rows", orders.length, "filter", currentFilter, "statuses", statuses);
  }
  // Si es reset, reemplazar todo; si no, agregar al final
  await displayOrders(!resetPagination);
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
}

/**
 * Busca pedidos en la base de datos por término libre.
 *
 * Fase 2:
 *  - Todas las queries envueltas con wrapSupabase (clasificación + retry).
 *  - Cada llamada crea su propio AbortScope y aborta el scope anterior,
 *    evitando que búsquedas previas muten el DOM de la búsqueda actual.
 *  - Guard numérico (_searchSeq) como segunda línea de defensa contra
 *    race conditions si dos invocaciones se solapan en tiempo.
 *  - Errores de red → banner no bloqueante, sin redirect, sin "sin resultados".
 *  - Auth / permission → solo actuar si el servidor lo confirmó.
 */
async function searchOrdersInDatabase(searchTerm) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en searchOrdersInDatabase");
    return;
  }

  // — Abort de la búsqueda anterior y creación del scope propio —
  if (_activeSearchAbortScope) _activeSearchAbortScope.abort("new_search");
  const myScope = createAbortScope();
  _activeSearchAbortScope = myScope;
  const signal = myScope.signal;

  // — Guard numérico: solo el seq más reciente puede mutar el DOM —
  const mySeq = ++_searchSeq;

  /** Retorna true si esta invocación ya fue superada o abortada. */
  function isStale() {
    return mySeq !== _searchSeq || signal.aborted;
  }

  /** Muestra un banner de error de red dentro del contenedor de búsqueda. */
  function showSearchNetworkError(msg) {
    if (isStale()) return;
    const container = document.getElementById("orders-content");
    if (!container) return;
    container.innerHTML = `
      <div class="loading" style="flex-direction:column;gap:10px;">
        <p style="color:#c00;font-size:14px;margin:0;">${msg}</p>
        <button onclick="location.reload()" style="padding:8px 16px;border:1px solid #c00;border-radius:6px;background:#fff;color:#c00;cursor:pointer;font-size:13px;">Recargar</button>
      </div>`;
  }

  try {
    const safeSearchTerm = String(searchTerm || "").trim();
    const escapedSearchTerm = safeSearchTerm.replace(/[%_]/g, "");

    // ── Query 1: clientes por nombre/DNI/teléfono/email/número cliente ───────
    const custRes = await wrapSupabase(
      () => supabase
        .from("customers")
        .select("id, full_name, dni, phone, email, customer_number")
        .or(`full_name.ilike.%${escapedSearchTerm}%,dni.ilike.%${escapedSearchTerm}%,phone.ilike.%${escapedSearchTerm}%,email.ilike.%${escapedSearchTerm}%,customer_number.ilike.%${escapedSearchTerm}%`)
        .limit(800),
      { retries: 1, signal, label: "orders.search.customers" }
    );
    if (isStale()) return;
    if (custRes.aborted) return;
    if (custRes.error) {
      const kind = custRes.kind;
      if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
        showSearchNetworkError("Error de conexión. Verificá tu red e intentá de nuevo.");
        return;
      }
      // permission/unknown: continuar sin IDs de clientes (búsqueda parcial)
      console.warn("[orders.search] customers query error:", custRes.error, "kind:", kind);
    }
    const customerIds = (custRes.data || [])
      .filter((c) => customerMatchesFlexible(safeSearchTerm, c))
      .map((c) => c.id);

    // ── Query 2: items por nombre de producto o color ─────────────────────────
    const itemsRes = await wrapSupabase(
      () => supabase
        .from("order_items")
        .select("order_id")
        .or(`product_name.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%`)
        .limit(1000),
      { retries: 1, signal, label: "orders.search.items" }
    );
    if (isStale()) return;
    if (itemsRes.aborted) return;
    if (itemsRes.error) {
      const kind = itemsRes.kind;
      if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
        showSearchNetworkError("Error de conexión. Verificá tu red e intentá de nuevo.");
        return;
      }
      console.warn("[orders.search] order_items query error:", itemsRes.error, "kind:", kind);
    }
    const orderIdsFromItems = itemsRes.data
      ? [...new Set(itemsRes.data.map(i => i.order_id))]
      : [];

    // ── Combinar IDs hasta aquí ───────────────────────────────────────────────
    const allOrderIds = new Set(orderIdsFromItems);

    // ── Query 3 (condicional): pedidos por customer_id ────────────────────────
    if (customerIds.length > 0) {
      const byCustomerRes = await wrapSupabase(
        () => supabase
          .from("orders")
          .select("id")
          .in("customer_id", customerIds)
          .limit(1000),
        { retries: 1, signal, label: "orders.search.by_customer" }
      );
      if (isStale()) return;
      if (byCustomerRes.aborted) return;
      if (!byCustomerRes.error && byCustomerRes.data) {
        byCustomerRes.data.forEach(o => allOrderIds.add(o.id));
      } else if (byCustomerRes.error) {
        const kind = byCustomerRes.kind;
        if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
          showSearchNetworkError("Error de conexión. Verificá tu red e intentá de nuevo.");
          return;
        }
        console.warn("[orders.search] by_customer error:", byCustomerRes.error, "kind:", kind);
      }
    }

    // ── Query 4: pedidos por order_number ─────────────────────────────────────
    const byNumberRes = await wrapSupabase(
      () => supabase
        .from("orders")
        .select("id")
        .ilike("order_number", `%${searchTerm}%`)
        .limit(1000),
      { retries: 1, signal, label: "orders.search.by_number" }
    );
    if (isStale()) return;
    if (byNumberRes.aborted) return;
    if (!byNumberRes.error && byNumberRes.data) {
      byNumberRes.data.forEach(o => allOrderIds.add(o.id));
    } else if (byNumberRes.error) {
      const kind = byNumberRes.kind;
      if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
        showSearchNetworkError("Error de conexión. Verificá tu red e intentá de nuevo.");
        return;
      }
      console.warn("[orders.search] by_number error:", byNumberRes.error, "kind:", kind);
    }

    if (isStale()) return;

    // ── Sin resultados: limpiar lista ─────────────────────────────────────────
    if (allOrderIds.size === 0) {
      orders = [];
      await displayOrders();
      updateActiveOrdersBadge();
      updatePickedOrdersBadge();
      updateClosedOrdersBadge();
      return;
    }

    // ── Query 5: datos completos de los pedidos encontrados ───────────────────
    const orderIdsArray = Array.from(allOrderIds);
    const fullOrdersRes = await wrapSupabase(
      () => supabase
        .from("orders")
        .select(`
          id, order_number, status, total_amount, created_at, expires_at,
          dismantle_at, transport_id, updated_at, sent_at, customer_id, notes, source,
          order_items (
            id, product_name, color, size, quantity, price_snapshot,
            status, imagen, variant_id,
            order_item_stock_sources ( qty, warehouse_id )
          )
        `)
        .in("id", orderIdsArray)
        .order("created_at", { ascending: false }),
      { retries: 1, signal, label: "orders.search.full_data" }
    );
    if (isStale()) return;
    if (fullOrdersRes.aborted) return;
    if (fullOrdersRes.error) {
      const kind = fullOrdersRes.kind;
      if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
        showSearchNetworkError("Error de conexión al cargar los pedidos. Verificá tu red.");
        return;
      }
      console.error("❌ Error buscando pedidos completos:", fullOrdersRes.error, "kind:", kind);
      orders = [];
      await displayOrders();
      return;
    }

    let data = fullOrdersRes.data || [];

    // ── Query 6 (condicional): datos completos de customers ───────────────────
    if (data.length > 0) {
      const allCustomerIds = [...new Set(data.map(o => o.customer_id).filter(Boolean))];
      if (allCustomerIds.length > 0) {
        const custFullRes = await wrapSupabase(
          () => supabase
            .from("customers")
            .select("id, customer_number, full_name, phone, city, province, dni, email, transport_id")
            .in("id", allCustomerIds),
          { retries: 1, signal, label: "orders.search.customers_full" }
        );
        if (isStale()) return;
        if (custFullRes.aborted) return;
        if (!custFullRes.error && custFullRes.data) {
          const custMap = new Map(custFullRes.data.map(c => [c.id, c]));
          data = data.map(o => ({ ...o, customers: custMap.get(o.customer_id) || {} }));
        }
        // Error en customers full: continuar sin datos de cliente (degraded, no romper)
      }
    }

    if (isStale()) return;

    // ── Aplicar resultados al estado del módulo ───────────────────────────────
    await refreshCustomerIncidentPoints(data);
    if (isStale()) return;

    orders = data;
    currentPage = 0;
    hasMoreOrders = false;
    allOrdersLoaded = true;

    await displayOrders();
    updateActiveOrdersBadge();
    updatePickedOrdersBadge();
    updateClosedOrdersBadge();

  } catch (err) {
    if (isStale()) return; // error de una búsqueda ya superada — ignorar
    const kind = classifyError(err);
    if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
      showSearchNetworkError("Error de conexión durante la búsqueda. Verificá tu red.");
      return;
    }
    if (kind === FYL_ERROR_KIND.AUTH) {
      window.location.href = "index.html";
      return;
    }
    console.error("❌ Error inesperado en searchOrdersInDatabase:", err, "kind:", kind);
    orders = [];
    await displayOrders();
  }
}

// NOTA: Las funciones loadMoreOrders() y handleScroll() fueron eliminadas.
// La funcionalidad de infinite scroll ahora está en setupInfiniteScroll() (línea ~2450)
// que tiene mejor manejo de debounce y estado.

// Función para actualizar el badge de pedidos activos
// Los conteos solo los actualiza loadBadgeCountsInBackground() con datos reales de BD.
// Esta función es no-op para evitar pisar con conteos del array `orders` (parcial/filtrado).
function updateActiveOrdersBadge() {
  return;
}

// Función para actualizar el badge de pedidos apartados
// Los conteos solo los actualiza loadBadgeCountsInBackground() con datos reales de BD.
function updatePickedOrdersBadge() {
  return;
}

// Función para actualizar el badge de pedidos cerrados
// Los conteos solo los actualiza loadBadgeCountsInBackground() con datos reales de BD.
function updateClosedOrdersBadge() {
  return;
}

// Función para actualizar el badge de cancelaciones
// Los conteos solo los actualiza loadBadgeCountsInBackground() con datos reales de BD.
function updateCancelledOrdersBadge() {
  return;
}

// Función para actualizar el badge de pedidos en espera
// Los conteos solo los actualiza loadBadgeCountsInBackground() con datos reales de BD.
function updateWaitingOrdersBadge() {
  return;
}

// Función para actualizar el badge de stock pendiente
// Los conteos solo los actualiza loadBadgeCountsInBackground() con datos reales de BD.
function updateStockPendingOrdersBadge() {
  return;
}

// Exponer funciones de actualización de badges globalmente (después de que estén definidas)
window.updateActiveOrdersBadge = updateActiveOrdersBadge;
window.updatePickedOrdersBadge = updatePickedOrdersBadge;
window.updateClosedOrdersBadge = updateClosedOrdersBadge;
window.updateCancelledOrdersBadge = updateCancelledOrdersBadge;
window.updateWaitingOrdersBadge = updateWaitingOrdersBadge;
window.updateStockPendingOrdersBadge = updateStockPendingOrdersBadge;
window.loadOrders = loadOrders;
window.refreshOneOrder = refreshOneOrder;

// Función auxiliar para actualizar un badge con conteo
function updateBadgeWithCount(badgeId, count) {
  const badge = document.getElementById(badgeId);
  if (badge) {
    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

// Función para cargar conteos exactos de badges en background
// Esta función se ejecuta en paralelo sin bloquear la carga inicial de pedidos
async function loadBadgeCountsInBackground() {
  if (!supabase) return;
  
  try {
    console.log("🔄 Cargando conteos exactos de badges en background...");
    
    // Consulta optimizada: solo traer IDs y status de items (no datos completos)
    // Esto es mucho más rápido que traer todos los datos del pedido
    // Misma base que loadOrders (pestañas client): incluye closed para que orders2 pueda contar cerrados con ítems reservados en Activos.
    const { data: ordersForCounting } = await supabase
      .from("orders")
      .select("id, status, created_at, dismantle_at, order_items(status)")
      .not("status", "in", '("sent","devolución","devolucion")');
    
    if (ordersForCounting) {
      const list = ordersForCounting;
      const listForOperationalTabs = list.filter((order) => order.status !== "stock_pending");
      const realActiveCount = filterOrdersForTab(listForOperationalTabs, STATUS.ACTIVE).length;
      const realPickedCount = filterOrdersForTab(listForOperationalTabs, STATUS.PICKED).length;
      const realWaitingCount = filterOrdersForTab(listForOperationalTabs, STATUS.WAITING).length;
      const realCancelledCount = filterOrdersForTab(list, STATUS.CANCELLED).length;
      
      // Actualizar badges con conteos reales
      updateBadgeWithCount('active-orders-badge', realActiveCount);
      updateBadgeWithCount('picked-orders-badge', realPickedCount);
      updateBadgeWithCount('waiting-orders-badge', realWaitingCount);
      updateBadgeWithCount('cancelled-orders-badge', realCancelledCount);
      
      console.log(`✅ Badges actualizados: Activos=${realActiveCount}, Apartados=${realPickedCount}, Espera=${realWaitingCount}, Cancelados=${realCancelledCount}`);
    }
    
    // Contar cerrados (consulta simple y rápida)
    const { count: closedCount } = await supabase
      .from("orders")
      .select("*", { count: 'exact', head: true })
      .eq("status", "closed");
    const { count: stockPendingCount } = await supabase
      .from("orders")
      .select("*", { count: 'exact', head: true })
      .eq("status", "stock_pending");
    
    updateBadgeWithCount('closed-orders-badge', closedCount || 0);
    updateBadgeWithCount('stock-pending-orders-badge', stockPendingCount || 0);
    
    // Marcar que los conteos totales ya se cargaron
    badgeCountsLoaded = true;
    
    const cancelledBadgeValue = document.getElementById('cancelled-orders-badge')?.textContent || "0";
    const stockPendingBadgeValue = document.getElementById('stock-pending-orders-badge')?.textContent || "0";
    console.log(`✅ Conteos exactos cargados: Cerrados=${closedCount}, Cancelados=${cancelledBadgeValue}, StockPendiente=${stockPendingBadgeValue}`);
    
  } catch (error) {
    console.error("❌ Error cargando conteos de badges en background:", error);
    // Si falla, los badges siguen mostrando el conteo de los pedidos cargados
    // No es crítico, solo significa que los números pueden no ser exactos
  }
}

// ===== REALTIME DELTA ENGINE (NO refetch global) =====

function syncOrdersMapFromArray() {
  ordersMap.clear();
  for (const o of orders || []) {
    if (o?.id) ordersMap.set(o.id, o);
  }
}

function upsertOrder(order) {
  if (!order?.id) return;
  ordersMap.set(order.id, order);
  const idx = (orders || []).findIndex((o) => o.id === order.id);
  if (idx >= 0) {
    orders[idx] = order;
  } else {
    orders.push(order);
  }
}

function removeOrder(orderId) {
  ordersMap.delete(orderId);
  const idx = (orders || []).findIndex((o) => o.id === orderId);
  if (idx >= 0) orders.splice(idx, 1);
}

function removeOrderCard(orderId) {
  const card = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
  if (card) card.remove();
}

function dedupeOrderCardsInList() {
  const list = document.querySelector("#orders-content .orders-list");
  if (!list) return;
  const seen = new Set();
  list.querySelectorAll(".order-card[data-order-id]").forEach((card) => {
    const id = card.getAttribute("data-order-id");
    if (!id) return;
    if (seen.has(id)) {
      card.remove();
      return;
    }
    seen.add(id);
  });
}

async function patchOrderCard(orderId, order) {
  const list = document.querySelector("#orders-content .orders-list");
  if (!list) return;
  const card = list.querySelector(`.order-card[data-order-id="${orderId}"]`);
  if (!card) return;
  const html = await renderOrderCard(order);
  if (!html) return;
  card.outerHTML = html;
  attachOrderEventHandlers();
}

async function insertOrderCardInList(order) {
  if (ordersUiFullReplaceInProgress) return;
  if (document.querySelector(`.order-card[data-order-id="${order.id}"]`)) return;
  const list = document.querySelector("#orders-content .orders-list");
  if (!list) return;
  const html = await renderOrderCard(order);
  if (!html) return;
  list.insertAdjacentHTML("afterbegin", html);
  attachOrderEventHandlers();
}

function orderBelongsToCurrentTab(order) {
  const filtered = typeof filterOrders === "function" ? filterOrders([order]) : [order];
  if (!filtered || filtered.length === 0) return false;
  if (typeof matchesSearch === "function") {
    return matchesSearch(order);
  }
  return true;
}

function updateAllBadges() {
  if (typeof updateActiveOrdersBadge === "function") updateActiveOrdersBadge();
  if (typeof updatePickedOrdersBadge === "function") updatePickedOrdersBadge();
  if (typeof updateClosedOrdersBadge === "function") updateClosedOrdersBadge();
  if (typeof updateCancelledOrdersBadge === "function") updateCancelledOrdersBadge();
  if (typeof updateWaitingOrdersBadge === "function") updateWaitingOrdersBadge();
  if (typeof updateStockPendingOrdersBadge === "function") updateStockPendingOrdersBadge();
}

function scheduleRealtimeDelta(payload) {
  const table = payload.table;
  const orderId =
    table === "orders"
      ? (payload.new?.id ?? payload.old?.id)
      : (payload.new?.order_id ?? payload.old?.order_id);
  if (!orderId) return;

  if (table === "orders" && payload.eventType === "DELETE") {
    removeOrder(orderId);
    removeOrderCard(orderId);
    updateAllBadges();
    return;
  }

  pendingOrderIds.add(orderId);
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    runOrdersTask("realtime_batch_refresh", async () => {
      const ids = Array.from(pendingOrderIds);
      pendingOrderIds.clear();
      pendingTimer = null;
      const t0 = performance.now();
      for (const id of ids) {
        await refreshOneOrder(id);
      }
      updateAllBadges();
      const t1 = performance.now();
      if (DEBUG_ORDERS) console.log("[perf] realtime batch", ids.length, "orders in", (t1 - t0).toFixed(0), "ms");
    }).catch((err) => {
      pendingTimer = null;
      console.warn("[orders] realtime_batch_refresh error:", err);
    });
  }, 250);
}

async function refreshOneOrder(orderId) {
  const t0 = performance.now();
  const full = await fetchOrderById(orderId);
  const t1 = performance.now();
  if (!full) return;

  const belongs = orderBelongsToCurrentTab(full);
  upsertOrder(full);
  if (ordersUiFullReplaceInProgress) {
    const t2 = performance.now();
    if (DEBUG_ORDERS) console.log("[perf] refreshOneOrder", orderId, "skipped DOM (full list replace)", (t2 - t1).toFixed(0) + "ms");
    return;
  }
  const card = document.querySelector(`.order-card[data-order-id="${orderId}"]`);

  if (belongs) {
    if (card) {
      await patchOrderCard(orderId, full);
    } else {
      await insertOrderCardInList(full);
    }
  } else {
    removeOrder(orderId);
    removeOrderCard(orderId);
  }

  const t2 = performance.now();
  if (DEBUG_ORDERS) console.log("[perf] refreshOneOrder", orderId, "fetch", (t1 - t0).toFixed(0) + "ms", "dom", (t2 - t1).toFixed(0) + "ms");
}

async function fetchOrderById(orderId) {
  if (!supabase) return null;
  const { data: order, error: err1 } = await supabase
    .from("orders")
    .select(`
      id, order_number, status, total_amount, created_at, expires_at, dismantle_at, transport_id, updated_at, sent_at, customer_id, notes, source,
      order_items (
        id, product_name, color, size, quantity, price_snapshot, status, imagen, variant_id,
        order_item_stock_sources ( qty, warehouse_id )
      )
    `)
    .eq("id", orderId)
    .single();

  if (err1 || !order) {
    console.warn("fetchOrderById: error orders", err1);
    return null;
  }

  if (order.customer_id) {
    const { data: cust, error: err2 } = await supabase
      .from("customers")
      .select("id, customer_number, full_name, name, email, phone, dni, city, province, transport_id")
      .eq("id", order.customer_id)
      .single();
    if (!err2 && cust) {
      order.customers = cust;
    } else {
      order.customers = null;
    }
  }
  return order;
}

// Función para configurar suscripción en tiempo real
function setupRealtimeSubscription() {
  if (!supabase) return;

  if (realtimeSubscription) {
    supabase.removeChannel(realtimeSubscription);
  }

  if (REALTIME_DELTA_MODE) {
    realtimeSubscription = supabase
      .channel("orders-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders" },
        (payload) => {
          console.log("🔄 Cambio en pedidos detectado:", payload.eventType, payload);
          scheduleRealtimeDelta(payload);
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "order_items" },
        (payload) => {
          console.log("🔄 INSERT en items:", payload);
          scheduleRealtimeDelta(payload);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "order_items" },
        (payload) => {
          console.log("🔄 UPDATE en items:", payload);
          scheduleRealtimeDelta(payload);
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "order_items" },
        (payload) => {
          console.log("🔄 DELETE en items:", payload);
          scheduleRealtimeDelta(payload);
        }
      )
      .subscribe((status) => {
        realtimeStatus = status;
        if (status === "SUBSCRIBED") {
          console.log("✅ Suscripción en tiempo real activa");
        } else if (status === "CHANNEL_ERROR") {
          console.error("❌ Error en suscripción en tiempo real");
        }
      });
  } else {
    realtimeSubscription = supabase
      .channel("orders-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders" },
        async (payload) => {
          console.log("🔄 Cambio en pedidos detectado:", payload.eventType);
          const orderId = payload.new?.id ?? payload.old?.id;
          if (orderId && typeof refreshOneOrder === "function") await refreshOneOrder(orderId);
          else if (typeof loadOrders === "function") await loadOrders();
          updateActiveOrdersBadge();
          updatePickedOrdersBadge();
          updateClosedOrdersBadge();
          updateCancelledOrdersBadge();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "order_items" },
        async (payload) => {
          console.log("🔄 Cambio en items de pedidos detectado:", payload.eventType);
          const orderId = payload.new?.order_id ?? payload.old?.order_id;
          if (orderId && typeof refreshOneOrder === "function") await refreshOneOrder(orderId);
          else if (typeof loadOrders === "function") await loadOrders();
          updateActiveOrdersBadge();
          updatePickedOrdersBadge();
          updateClosedOrdersBadge();
          updateCancelledOrdersBadge();
        }
      )
      .subscribe((status) => {
        realtimeStatus = status;
        if (status === "SUBSCRIBED") {
          console.log("✅ Suscripción en tiempo real activa");
        } else if (status === "CHANNEL_ERROR") {
          console.error("❌ Error en suscripción en tiempo real");
        }
      });
  }
}

async function displayOrders(append = false) {
  const container = document.getElementById("orders-content");
  if (!container) return;

  // CRÍTICO: Validar que el filtro actual coincide con los datos
  // Si orders está vacío o no hay datos, mostrar mensaje apropiado
  if (!orders || orders.length === 0) {
    if (!append) {
      container.innerHTML = `
        <div class="empty-orders">
          <h2>No hay pedidos</h2>
          <p>No se encontraron pedidos con el filtro seleccionado.</p>
        </div>
      `;
      // Ocultar loading si existe
      hideLoading();
    }
    return;
  }

  // Filtrar por pestaña actual
  const filteredByTab = filterOrders(orders);

  // Aplicar búsqueda si existe
  let filtered = filteredByTab;
  if (currentSearch && currentSearch.trim().length > 0) {
    filtered = filteredByTab;
  } else if (currentFilter === 'picked' || currentFilter === 'closed') {
    filtered = filteredByTab.filter(matchesSearch);
  }

  const sorted = sortOrders(filtered);
  if (DEBUG_ORDERS) console.log("[debug] displayOrders filteredByTab", filteredByTab.length, "filtered", filtered.length, "sorted", sorted.length);

  // Si después de filtrar no hay resultados
  if (!sorted.length) {
    if (!append) {
      container.innerHTML = `
        <div class="empty-orders">
          <h2>No hay pedidos</h2>
          <p>No se encontraron pedidos con el filtro seleccionado.</p>
        </div>
      `;
      // Ocultar loading si existe
      hideLoading();
    }
    return;
  }

  // Limpiar el estado de visualización solo si no es append
  if (!append && currentFilter !== 'active') {
    orderViewMode.clear();
  }
  
  // Si es append, agregar al final; si no, reemplazar todo
  if (append) {
    // Obtener solo los nuevos pedidos (los que no están ya renderizados)
    const existingOrdersList = container.querySelector('.orders-list');
    if (existingOrdersList) {
      // Obtener IDs de pedidos ya renderizados
      const existingOrderIds = new Set(
        Array.from(existingOrdersList.querySelectorAll('[data-order-id]'))
          .map(el => el.getAttribute('data-order-id'))
      );
      
      // Filtrar solo los nuevos pedidos
      const newOrders = sorted.filter(order => !existingOrderIds.has(order.id));
      
      if (newOrders.length > 0) {
        // Renderizar solo los nuevos pedidos
        const cardsPromises = newOrders.map(async (order) => await renderOrderCard(order));
        const cardsHtml = (await Promise.all(cardsPromises)).join("");
        
        // Agregar al final de la lista existente
        existingOrdersList.insertAdjacentHTML('beforeend', cardsHtml);
        
        // Re-attach event handlers solo para los nuevos elementos
        attachOrderEventHandlers();
      }
    }
  } else {
    ordersUiFullReplaceInProgress = true;
    try {
      // IMPORTANTE: Limpiar contenedor antes de renderizar
      container.innerHTML = '';
      
      // Crear contenedor de lista inmediatamente
      const ordersList = document.createElement('div');
      ordersList.className = 'orders-list';
      container.appendChild(ordersList);
      
      // Renderizar pedidos de forma progresiva (no bloquear esperando todos)
      // Usar siempre la copia en ordersMap si existe: durante los awaits el realtime puede
      // sustituir el objeto en `orders` y las refs del array `sorted` quedarían obsoletas.
      const batchSize = 5;
      for (let i = 0; i < sorted.length; i += batchSize) {
        const batch = sorted.slice(i, i + batchSize);
        const batchPromises = batch.map(async (order) => {
          try {
            const fresh = ordersMap.get(order.id) || order;
            const cardHtml = await renderOrderCard(fresh);
            return cardHtml || '';
          } catch (error) {
            console.error(`❌ Error renderizando pedido ${order.id}:`, error);
            return '';
          }
        });
        
        const batchHtml = (await Promise.all(batchPromises)).join('');
        if (DEBUG_ORDERS) console.log("[debug] displayOrders batch", i / batchSize + 1, "batchSize", batch.length, "batchHtml.length", batchHtml.length);
        if (batchHtml) {
          ordersList.insertAdjacentHTML('beforeend', batchHtml);
          attachOrderEventHandlers();
        }
      }
      
      dedupeOrderCardsInList();
      hideLoading();
    } finally {
      ordersUiFullReplaceInProgress = false;
    }
  }
  
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  updateWaitingOrdersBadge();
  setupSortControls();
  setupSearchControls();
}

// Función para obtener variant_id basado en product_name, color y size
async function findVariantId(productName, color, size) {
  if (!supabase || !productName || !color || !size) return null;
  
  try {
    // Buscar producto por nombre (incluir todos los estados)
    const { data: productData, error: productError } = await supabase
      .from('products')
      .select('id')
      .eq('name', productName)
      .in('status', ['active', 'pending_stock', 'draft'])
      .limit(1)
      .maybeSingle();
    
    if (productError || !productData) return null;
    
    // Buscar variante por producto, color y tamaño
    const { data: variantData, error: variantError } = await supabase
      .from('product_variants')
      .select('id')
      .eq('product_id', productData.id)
      .eq('color', color)
      .eq('size', size)
      .limit(1)
      .maybeSingle();
    
    return variantError ? null : variantData?.id || null;
  } catch (error) {
    console.error('Error buscando variant_id:', error);
    return null;
  }
}

// Función para obtener ofertas y promociones activas para los items de un pedido
async function getOffersAndPromotionsForOrder(order) {
  if (!supabase || !order.order_items || order.order_items.length === 0) {
    return { offers: [], promotions: [], totalDiscount: 0, itemOffers: new Map(), itemPromos: new Map() };
  }
  
  const items = order.order_items.filter(item => item.status !== 'cancelled');
  const variantIds = [];
  const itemVariantMap = new Map(); // Mapea variant_id -> items[]
  const itemToVariantMap = new Map(); // Mapea item.id -> variant_id
  
  // Obtener variant_ids de los items
  for (const item of items) {
    let variantId = item.variant_id;
    
    // Si no tiene variant_id, intentar buscarlo
    if (!variantId && item.product_name && item.color && item.size) {
      variantId = await findVariantId(item.product_name, item.color, item.size);
    }
    
    if (variantId) {
      variantIds.push(variantId);
      if (!itemVariantMap.has(variantId)) {
        itemVariantMap.set(variantId, []);
      }
      itemVariantMap.get(variantId).push(item);
      itemToVariantMap.set(item.id, variantId);
    }
  }
  
  if (variantIds.length === 0) {
    return { offers: [], promotions: [], totalDiscount: 0, itemOffers: new Map(), itemPromos: new Map() };
  }
  
  // Obtener promociones activas
  const { data: promotionsData, error: promotionsError } = await supabase
    .rpc('get_active_promotions_for_variants', {
      p_variant_ids: variantIds
    });
  
  const promotions = promotionsError ? [] : (promotionsData || []);
  
  // Obtener ofertas activas (por color)
  const variantOffersMap = new Map();
  const itemOffersMap = new Map(); // item.id -> { offerPrice, originalPrice, promoText }
  const itemPromosMap = new Map(); // item.id -> promoText
  
  // Primero procesar promociones (tienen prioridad)
  // Primero calcular si se cumple la condición mínima antes de asignar etiquetas
  const validPromotions = new Map(); // promo -> { promoText, itemsInPromo[], totalQuantity }
  
  for (const promo of promotions) {
    const variantIdsInPromo = promo.variant_ids || [];
    const itemsInPromo = [];
    
    // Recolectar todos los items que están en esta promoción
    for (const variantId of variantIdsInPromo) {
      const variantItems = itemVariantMap.get(variantId) || [];
      itemsInPromo.push(...variantItems);
    }
    
    if (itemsInPromo.length === 0) continue;
    
    // Calcular cantidad total para verificar si se cumple la condición mínima
    let totalQuantity = 0;
    for (const item of itemsInPromo) {
      totalQuantity += item.quantity || 0;
    }
    
    // Las promociones tipo 2x requieren mínimo 2 unidades para aplicarse
    const groups = Math.floor(totalQuantity / 2);
    if (groups > 0) {
      const promoText = promo.promo_type === '2x1' 
        ? '2x1' 
        : promo.promo_type === '2xMonto' && promo.fixed_amount
        ? `2x$${promo.fixed_amount}`
        : null;
      
      if (promoText) {
        validPromotions.set(promo, { promoText, itemsInPromo, totalQuantity });
        // Solo asignar etiqueta si se cumple la condición
        for (const item of itemsInPromo) {
          itemPromosMap.set(item.id, promoText);
        }
      }
    }
  }
  
  // Luego procesar ofertas (solo para items que no están en promociones)
  for (const item of items) {
    // Si ya tiene promoción, saltar oferta
    if (itemPromosMap.has(item.id)) continue;
    
    if (!item.product_name || !item.color) continue;
    
    // Buscar producto por nombre (incluir todos los estados para aplicar ofertas)
    const { data: productData } = await supabase
      .from('products')
      .select('id')
      .eq('name', item.product_name)
      .in('status', ['active', 'pending_stock', 'draft'])
      .limit(1)
      .maybeSingle();
    
    if (!productData) continue;
    
    // Buscar oferta activa para este producto y color
    const today = new Date().toISOString().split('T')[0];
    const { data: offerData } = await supabase
      .from('color_price_offers')
      .select('*')
      .eq('product_id', productData.id)
      .eq('color', item.color)
      .eq('status', 'active')
      .lte('start_date', today)
      .gte('end_date', today)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (offerData) {
      const originalPrice = item.price_snapshot || 0;
      const offerPrice = offerData.offer_price;
      itemOffersMap.set(item.id, {
        offerPrice: offerPrice,
        originalPrice: originalPrice,
        promoText: '🔥 Oferta'
      });
    }
  }
  
  // Calcular descuentos totales
  let totalDiscount = 0;
  const appliedPromotions = new Map(); // promo_type -> { count, discount, fixed_amount }
  
  // Calcular descuentos de promociones (solo las que cumplen la condición mínima)
  for (const [promo, promoData] of validPromotions.entries()) {
    const itemsInPromo = promoData.itemsInPromo;
    const totalQuantity = promoData.totalQuantity;
    
    // Calcular precio total
    let totalPrice = 0;
    for (const item of itemsInPromo) {
      const qty = item.quantity || 0;
      const price = item.price_snapshot || 0;
      totalPrice += qty * price;
    }
    
    // Ya verificamos que groups > 0 antes de agregar a validPromotions
    const groups = Math.floor(totalQuantity / 2);
    let discount = 0;
    
    if (promo.promo_type === '2x1') {
      // En 2x1, se cobra solo la mitad (redondeando hacia arriba)
      // Descuento = precio de la mitad de los items
      const averagePrice = totalPrice / totalQuantity;
      discount = groups * averagePrice;
    } else if (promo.promo_type === '2xMonto' && promo.fixed_amount) {
      // En 2xMonto, se cobra el monto fijo por cada grupo de 2
      const promoPrice = groups * promo.fixed_amount;
      discount = totalPrice - promoPrice;
    }
    
    totalDiscount += discount;
    
    const promoKey = promo.promo_type === '2x1' ? '2x1' : `2x$${promo.fixed_amount}`;
    if (!appliedPromotions.has(promoKey)) {
      appliedPromotions.set(promoKey, { count: 0, discount: 0 });
    }
    const promoInfo = appliedPromotions.get(promoKey);
    promoInfo.count += totalQuantity;
    promoInfo.discount += discount;
  }
  
  // Calcular descuentos de ofertas
  for (const [itemId, offerInfo] of itemOffersMap.entries()) {
    const item = items.find(i => i.id === itemId);
    if (item) {
      const discount = (offerInfo.originalPrice - offerInfo.offerPrice) * (item.quantity || 0);
      totalDiscount += discount;
    }
  }
  
  return {
    offers: Array.from(itemOffersMap.values()),
    promotions: Array.from(appliedPromotions.entries()).map(([type, info]) => ({ type, ...info })),
    totalDiscount: totalDiscount,
    itemOffers: itemOffersMap,
    itemPromos: itemPromosMap
  };
}

// Función para cargar almacenes si no están en cache
async function loadWarehouses() {
  if (warehousesCache.general && warehousesCache.ventaPublico) {
    return warehousesCache;
  }
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    return warehousesCache;
  }
  
  try {
    const { data, error } = await supabase
      .from("warehouses")
      .select("id, code, name")
      .in("code", ["general", "venta-publico"]);
    
    if (!error && data) {
      data.forEach(w => {
        if (w.code === "general") warehousesCache.general = w.id;
        if (w.code === "venta-publico") warehousesCache.ventaPublico = w.id;
      });
    }
  } catch (error) {
    console.error("❌ Error cargando almacenes:", error);
  }
  
  return warehousesCache;
}

function orderItemSplitGroupKey(item) {
  const vid = item.variant_id ?? "";
  const sz = normalizeSize(item.size || "") || "";
  const col = String(item.color ?? "").trim().toLowerCase();
  return `${vid}|${sz}|${col}`;
}

function splitGroupSortKey(item, generalId, ventaId) {
  const src = item.order_item_stock_sources;
  if (Array.isArray(src) && src.length === 1) {
    const wid = src[0].warehouse_id;
    if (wid === generalId) return 0;
    if (wid === ventaId) return 1;
  }
  const st = String(item.status || "").trim().toLowerCase();
  if (st === "reserved") return 0;
  if (st === "waiting") return 1;
  return 2;
}

function sortSplitGroupItems(items) {
  const g = warehousesCache.general;
  const v = warehousesCache.ventaPublico;
  if (!g || !v) return [...items];
  return [...items].sort((a, b) => splitGroupSortKey(a, g, v) - splitGroupSortKey(b, g, v));
}

/** Agrupa líneas del mismo producto/talle/color para mostrar una sola tarjeta (stock general + local). */
function groupOrderItemsForDisplayFlat(items) {
  const buckets = new Map();
  const keyOrder = [];
  for (const it of items || []) {
    const k = orderItemSplitGroupKey(it);
    if (!buckets.has(k)) {
      buckets.set(k, []);
      keyOrder.push(k);
    }
    buckets.get(k).push(it);
  }
  const out = [];
  for (const k of keyOrder) {
    const arr = sortSplitGroupItems(buckets.get(k));
    if (arr.length >= 2) out.push({ type: "group", items: arr });
    else out.push({ type: "single", item: arr[0] });
  }
  return out;
}

function fillWarehouseMapFromItemSources(items, map) {
  const g = warehousesCache.general;
  const v = warehousesCache.ventaPublico;
  if (!g || !v) return;
  for (const item of items || []) {
    const src = item.order_item_stock_sources;
    if (!Array.isArray(src) || src.length === 0) continue;
    if (src.length === 1) {
      const wid = src[0].warehouse_id;
      if (wid === g) map.set(item.id, "General");
      else if (wid === v) map.set(item.id, "Local");
    } else {
      map.set(item.id, "Mixto");
    }
  }
}

// Función para obtener el depósito de un item reservado
async function getItemWarehouse(item) {
  // Solo para items en estado reservado con variant_id
  if (item.status !== 'reserved' || !item.variant_id) {
    return null;
  }
  
  // Cargar almacenes si no están en cache
  await loadWarehouses();
  
  if (!warehousesCache.general || !warehousesCache.ventaPublico) {
    return null;
  }
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    return null;
  }
  
  try {
    // IMPORTANTE: Si el item tiene un tamaño, consultar variant_size_warehouse_stock
    // en lugar de variant_warehouse_stock para obtener el stock correcto
    const itemSize = item.size || null;
    const normalizedSize = itemSize ? normalizeSize(itemSize) : null;
    
    let generalQty = 0;
    let ventaQty = 0;
    
    if (normalizedSize) {
      // Consultar stock por talle específico desde variant_size_warehouse_stock
      // IMPORTANTE: Cargar todos los registros y normalizar después para evitar problemas de comparación
      const { data: sizeStockData, error: sizeStockError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("size, warehouse_id, stock_qty")
        .eq("variant_id", item.variant_id)
        .in("warehouse_id", [warehousesCache.general, warehousesCache.ventaPublico]);
      
      if (!sizeStockError && sizeStockData && sizeStockData.length > 0) {
        // Filtrar por tamaño normalizado después de obtener los datos
        sizeStockData.forEach(sws => {
          const swsNormalizedSize = normalizeSize(sws.size || "");
          if (swsNormalizedSize !== normalizedSize) return; // Saltar si no coincide después de normalizar
          
          if (sws.warehouse_id === warehousesCache.general) {
            generalQty = sws.stock_qty || 0;
          } else if (sws.warehouse_id === warehousesCache.ventaPublico) {
            ventaQty = sws.stock_qty || 0;
          }
        });
      }
    }
    
    // Solo sin talle: consultar variant_warehouse_stock por compatibilidad legacy.
    // Si hay talle, no mezclar con tabla derivada de variante.
    if (!normalizedSize && generalQty === 0 && ventaQty === 0) {
      const { data: stockData, error } = await supabase
        .from("variant_warehouse_stock")
        .select("warehouse_id, stock_qty")
        .eq("variant_id", item.variant_id)
        .in("warehouse_id", [warehousesCache.general, warehousesCache.ventaPublico]);
      
      if (!error && stockData) {
        const generalStock = stockData.find(s => s.warehouse_id === warehousesCache.general);
        const ventaStock = stockData.find(s => s.warehouse_id === warehousesCache.ventaPublico);
        
        generalQty = generalStock?.stock_qty || 0;
        ventaQty = ventaStock?.stock_qty || 0;
      }
    }
    
    const itemQty = item.quantity || 1;
    
    // Lógica: primero se descuenta del general, luego del local
    // Si hay suficiente stock en general, está en General
    if (generalQty >= itemQty) {
      return "General";
    }
    // Si hay stock en general pero no suficiente, y hay stock en venta para completar
    if (generalQty > 0 && (generalQty + ventaQty) >= itemQty) {
      // Se usó de ambos, pero priorizamos mostrar General ya que se descuenta primero de ahí
      return "General";
    }
    // Si no hay stock en general o no es suficiente y solo hay en venta, está en Local
    if (ventaQty >= itemQty) {
      return "Local";
    }
    // Si hay stock combinado suficiente pero no individual, determinar según prioridad
    if ((generalQty + ventaQty) >= itemQty) {
      // Si hay algo en general, priorizar General (se descuenta primero de ahí)
      return generalQty > 0 ? "General" : "Local";
    }
    
    return null;
  } catch (error) {
    console.error("❌ Error obteniendo depósito del item:", error);
    return null;
  }
}

async function renderOrderCard(order) {
  const isExpiredPendingDisassemblyOrder = isExpiredPendingAdminDisassembly(order);
  // Determinar el estado del pedido basado en los items
  let displayStatus = order.status;
  let statusLabel = ORDER_STATUS_LABELS[displayStatus] || displayStatus || "Desconocido";
  let statusClass = ORDER_STATUS_CLASSES[displayStatus] || "status-active";
  
  // Si el pedido no está cerrado ni enviado, verificar el estado basado en los items
  if (order.status !== "closed" && order.status !== "sent" && order.status !== "stock_pending") {
    // Si tiene items en espera y estamos en el filtro de espera, mostrar como "Espera"
    // Mostrar como "Espera" si tiene al menos un item en espera (sin importar otros estados)
    if (currentFilter === 'waiting' && hasWaitingItems(order)) {
      displayStatus = "waiting";
      statusLabel = "Espera";
      statusClass = "status-waiting";
    } else if (hasAllItemsPicked(order) && !hasWaitingItems(order)) {
      // Todos los items están apartados (pero NO waiting, porque esos van a Espera)
      displayStatus = "picked";
      statusLabel = "Apartado";
      statusClass = "status-picked";
    } else {
      // Si no todos están apartados, mostrar como "Activo"
      // Esto incluye pedidos con items "reserved", "missing", o mezclados
      // (pero NO waiting, porque esos van a Espera)
      displayStatus = "active";
      statusLabel = "Activo";
      statusClass = "status-active";
    }
  } else if (order.status === "sent") {
    // Si el pedido está enviado, mostrar como "Enviado"
    displayStatus = "sent";
    statusLabel = "Enviado";
    statusClass = "status-sent";
  }

  // En Cancelaciones, el estado intermedio se presenta como cancelado para evitar ambigüedad visual.
  if (currentFilter === STATUS.CANCELLED && isExpiredPendingDisassemblyOrder) {
    displayStatus = STATUS.CANCELLED;
    statusLabel = "Cancelado por vencimiento";
    statusClass = ORDER_STATUS_CLASSES.cancelled;
  }
  
  // Normalizar customer (objeto o array; nunca null para evitar fallos en render)
  const customer = Array.isArray(order?.customers) ? (order.customers[0] ?? {}) : (order?.customers && typeof order.customers === 'object' ? order.customers : {});
  const isCustomerOrder = String(order?.source || "").trim().toLowerCase() === "customer";

  const customerPhone = (customer?.phone || '').trim() || '—';
  const customerPhoneDigits = buildWhatsAppHref(customerPhone) ? toWhatsAppPhoneDigits(customerPhone) : "";
  const customerPhoneHref = buildWhatsAppHref(customerPhone);
  const customerNumber = (customer?.customer_number || '').trim() || '';
  const customerCity = (customer?.city || '').trim() || '';
  const customerProvince = (customer?.province || '').trim() || '';
  const customerIncidentPointsHtml = buildCustomerIncidentPointsHtml(customer?.id || order?.customer_id || "");
  await loadTransportNames();
  const transportLabelRaw = getOrderTransportLabel(order, customer);
  const transportLabel = transportLabelRaw && transportLabelRaw !== "Transporte asignado"
    ? transportLabelRaw
    : "Sin transporte";
  const transportBadgeClass = getTransportBadgeClassByLabel(transportLabel);
  const transportBadgeText = transportLabel.toUpperCase();
  const showDetailButton = displayStatus === "picked";
  const showTransportUnderDetail = showDetailButton && isCustomerOrder;
  const detailTransportLabel = showTransportUnderDetail ? getOrderTransportLabel(order, customer) : "";
  const detailActionHtml = showDetailButton ? `
    <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
      <button class="btn" style="background: #17a2b8; color: white; padding: 6px 12px; font-size: 13px;" data-view-summary="${order.id}">
        📄 Ver Detalle
      </button>
      ${showTransportUnderDetail ? `
        <div style="font-size:12px; color:#4b5563; text-align:right; max-width:210px;">
          🚚 ${detailTransportLabel}
        </div>
      ` : ""}
    </div>
  ` : "";
  const orderNotesObj = parseOrderNotesObject(order?.notes);
  const stockPendingReasonRaw = String(orderNotesObj?.stock_pending_reason || "").trim();
  const stockPendingConflict = parseStockPendingReasonConflict(stockPendingReasonRaw);
  const stockPendingReasonUi = describeStockPendingConflict(order, stockPendingConflict, stockPendingReasonRaw);
  const stockPendingBannerHtml = order.status === STATUS.STOCK_PENDING
    ? `<div style="background:#fdecea; border:1px solid #f5c2c7; color:#7f1d1d; border-radius:8px; padding:10px; margin-bottom:10px; font-size:13px;">
         <strong>Stock pendiente:</strong> ${stockPendingReasonUi || "Resolver conflicto de stock para continuar."}
       </div>`
    : "";
  
  // Obtener ofertas y promociones (con timeout para no bloquear el renderizado)
  // Si tarda más de 2 segundos, usar datos vacíos para mostrar el pedido rápidamente
  let offersData = { offers: [], promotions: [], totalDiscount: 0, itemOffers: new Map(), itemPromos: new Map() };
  try {
    const offersPromise = getOffersAndPromotionsForOrder(order);
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 2000));
    const result = await Promise.race([offersPromise, timeoutPromise]);
    if (result) {
      offersData = result;
    }
  } catch (error) {
    console.warn(`⚠️ Error obteniendo ofertas para pedido ${order.id}:`, error);
    // Continuar sin ofertas para mostrar el pedido rápidamente
  }
  
  const itemsSubtotal = (order.order_items || []).reduce(
    (sum, item) => sum + (item.quantity || 0) * normalizeOrderPrice(item.price_snapshot || 0),
    0
  );

  // total_amount a veces viene en "miles abreviados" (ej. 5.4 => $5.400). Si es numérico pero < 1000
  // y los ítems suman miles, normalizar para evitar mostrar "$5,4".
  const rawTotalAmount = typeof order.total_amount === "number" ? order.total_amount : null;
  const total =
    rawTotalAmount != null
      ? ((rawTotalAmount > 0 && rawTotalAmount < 1000 && itemsSubtotal >= 1000)
          ? normalizeOrderPrice(rawTotalAmount)
          : rawTotalAmount)
      : itemsSubtotal;

  // Fecha de creación y días transcurridos
  const createdAt = order.created_at ? new Date(order.created_at) : null;
  let createdLabel = "";
  if (createdAt && !isNaN(createdAt.getTime())) {
    const now = new Date();
    const diffMs = now - createdAt;
    const diffDays = Math.max(0, Math.floor(diffMs / 86400000));
    const daysColor = diffDays >= 7 ? "#dc3545" : "#6c757d";
    const daysText = `${diffDays} día${diffDays === 1 ? '' : 's'}`;
    const createdText = createdAt.toLocaleDateString('es-AR');
    createdLabel = `<div style="font-size:12px; color:#666; margin-top:2px;">
                      Creado: ${createdText}
                      <span style="margin-left:8px; font-weight:700; color:${daysColor};">${daysText}</span>
                    </div>`;
  }

  // Fecha de envío (sent_at) - mostrar si el pedido está enviado o cerrado y tiene sent_at
  let sentLabel = "";
  if ((order.status === "sent" || order.status === "closed") && order.sent_at) {
    const sentAt = new Date(order.sent_at);
    if (!isNaN(sentAt.getTime())) {
      const sentText = sentAt.toLocaleDateString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Argentina/Buenos_Aires',
      });
      sentLabel = `<div style="font-size:12px; color:#28a745; margin-top:2px; font-weight:600;">
                    Enviado: ${sentText}
                  </div>`;
    }
  } else if (order.status === "sent" && !order.sent_at && order.updated_at) {
    // Fallback: usar updated_at si sent_at no existe (pedidos antiguos)
    const updatedAt = new Date(order.updated_at);
    if (!isNaN(updatedAt.getTime())) {
      const updatedText = updatedAt.toLocaleDateString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Argentina/Buenos_Aires',
      });
      sentLabel = `<div style="font-size:12px; color:#28a745; margin-top:2px; font-weight:600;">
                    Enviado: ${updatedText}
                  </div>`;
    }
  }
  
  // Separar items cancelados de los demás para mostrarlos primero con advertencia
  const rawItems = Array.isArray(order.order_items) ? order.order_items : [];
  const forcedCancelledView = currentFilter === STATUS.CANCELLED && isExpiredPendingDisassemblyOrder;
  const allItems =
    forcedCancelledView
      ? rawItems.map((item) => {
          const status = String(item?.status || "").toLowerCase().trim();
          if (status === "cancelled") return item;
          return {
            ...item,
            __forcedCancelled: true,
            __originalStatus: item?.status || "",
            status: "cancelled",
          };
        })
      : rawItems;
  const cancelledItems = forcedCancelledView
    ? allItems
    : allItems.filter(item => item.status === 'cancelled');
  const missingItemsAll = allItems.filter((i) => String(i?.status || "").trim().toLowerCase() === "missing");
  
  // Determinar qué items mostrar según el filtro y el modo de visualización
  let activeItems;
  if (currentFilter === 'waiting') {
    // En filtro de espera, verificar si está en modo "ver completo"
    const isFullView = orderWaitingViewMode.get(order.id) === true;
    if (isFullView) {
      // Modo completo: mostrar todos excepto cancelados
      activeItems = allItems.filter(item => item.status !== 'cancelled');
    } else {
      // Modo por defecto: solo mostrar items en espera
      activeItems = allItems.filter(item => item.status === 'waiting');
    }
  } else if (currentFilter === 'active') {
    // En pestaña Activos, verificar si está en modo "ver completo"
    const isFullView = orderViewMode.get(order.id) === true;
    if (isFullView) {
      // Modo completo: mostrar todos excepto cancelados
      activeItems = allItems.filter(item => item.status !== 'cancelled');
    } else {
      // Reservado + líneas en espera del mismo pedido (checkout mixto general + local)
      const orderHasReserved = allItems.some((i) => i.status === "reserved");
      activeItems = allItems.filter((item) => {
        if (item.status === "reserved") return true;
        if (item.status === "waiting" && orderHasReserved) return true;
        if (item.status === "missing" && isManualMissingOrderItem(item)) return true;
        return false;
      });
    }
  } else if (forcedCancelledView) {
    activeItems = [];
  } else {
    // En otros filtros, mostrar todos excepto cancelados
    activeItems = allItems.filter(item => item.status !== 'cancelled');
  }

  // Orders2: ocultar solo missing real; missing manual sí se muestra como ficha en la card.
  if (isOrders2Page()) {
    activeItems = (activeItems || []).filter((item) => {
      const status = String(item?.status || "").trim().toLowerCase();
      return status !== "missing" || isManualMissingOrderItem(item);
    });
  }
  
  // Mostrar advertencia si hay items cancelados (solo si no estamos en filtro de espera)
  const cancelledWarning = (currentFilter !== 'waiting' && cancelledItems.length > 0) ? `
    <div class="cancelled-warning">
      <span>⚠️</span>
      <span>${
        forcedCancelledView
          ? `${cancelledItems.length} producto(s) marcados como cancelados por vencimiento del pedido.`
          : `${cancelledItems.length} producto(s) cancelado(s) por el cliente ${formatCustomerDisplayName(customer)}${customerNumber ? ` (Nº ${customerNumber})` : ''}`
      }</span>
    </div>
  ` : '';

  const missingItemsReal = missingItemsAll.filter((item) => !isManualMissingOrderItem(item));
  const missingBannerHtml = (isOrders2Page() && missingItemsReal.length > 0)
    ? `<button type="button" class="orders2-missing-banner" data-open-missing-modal="${order.id}" aria-label="Ver productos faltantes">
         ⚠️ Faltantes: ${missingItemsReal.length}
       </button>`
    : "";
  
  // Parsear valores extra desde notes
  let extraValuesHtml = '';
  if (order.notes) {
    try {
      const extraValues = JSON.parse(order.notes);
      const shippingAmount = parseFloat(extraValues.shipping) || 0;
      const discountAmount = parseFloat(extraValues.discount) || 0;
      const extrasAmount = parseFloat(extraValues.extras_amount) || 0;
      const extrasPercentage = parseFloat(extraValues.extras_percentage) || 0;
      
      // Calcular subtotal de productos para el porcentaje de extras (normalizar miles abreviados)
      const productsSubtotal = allItems.reduce((sum, item) => {
        return sum + (normalizeOrderPrice(item.price_snapshot || 0) * (item.quantity || 0));
      }, 0);
      
      if (shippingAmount > 0) {
        extraValuesHtml += `
          <div class="order-item" style="background: #e3f2fd; border-left: 4px solid #2196f3; padding: 12px; margin: 8px 0; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 15px;">🚚 Envío</strong>
                <div style="font-size: 14px; color: #2196f3; margin-top: 4px; font-weight: 600;">
                  $${shippingAmount.toLocaleString('es-AR')}
                </div>
              </div>
            </div>
          </div>
        `;
      }
      
      if (discountAmount > 0) {
        extraValuesHtml += `
          <div class="order-item" style="background: #ffebee; border-left: 4px solid #f44336; padding: 12px; margin: 8px 0; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 15px;">💸 Descuento</strong>
                <div style="font-size: 14px; color: #f44336; margin-top: 4px; font-weight: 600;">
                  -$${discountAmount.toLocaleString('es-AR')}
                </div>
              </div>
            </div>
          </div>
        `;
      }
      
      if (extrasAmount > 0) {
        extraValuesHtml += `
          <div class="order-item" style="background: #f3e5f5; border-left: 4px solid #9c27b0; padding: 12px; margin: 8px 0; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 15px;">➕ Extras</strong>
                <div style="font-size: 14px; color: #9c27b0; margin-top: 4px; font-weight: 600;">
                  $${extrasAmount.toLocaleString('es-AR')}
                </div>
              </div>
            </div>
          </div>
        `;
      }
      
      if (extrasPercentage > 0) {
        const extrasFromPercentage = productsSubtotal * extrasPercentage / 100;
        extraValuesHtml += `
          <div class="order-item" style="background: #f3e5f5; border-left: 4px solid #9c27b0; padding: 12px; margin: 8px 0; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 15px;">➕ Extras (${extrasPercentage}%)</strong>
                <div style="font-size: 14px; color: #9c27b0; margin-top: 4px; font-weight: 600;">
                  $${extrasFromPercentage.toLocaleString('es-AR')}
                </div>
              </div>
            </div>
          </div>
        `;
      }
    } catch (e) {
      console.warn('Error parseando valores extra del pedido:', e);
    }
  }
  
  const warehouseInfoMap = new Map();
  await loadWarehouses();
  const itemsForWarehouse = activeItems.filter(
    (item) => item.status === "reserved" || item.status === "waiting"
  );
  fillWarehouseMapFromItemSources(itemsForWarehouse, warehouseInfoMap);
  await Promise.all(
    activeItems
      .filter((item) => item.status === "reserved" && !warehouseInfoMap.has(item.id))
      .map(async (item) => {
        const warehouse = await getItemWarehouse(item);
        if (warehouse) warehouseInfoMap.set(item.id, warehouse);
      })
  );
  
  // Renderizar items: primero cancelados, luego activos, luego valores extra
  // En pestaña Activos modo "solo reservados", no mostrar valores extra
  const showExtraValues = currentFilter !== 'waiting' && 
                         (currentFilter !== 'active' || orderViewMode.get(order.id) === true);
  
  let itemsHtml;
  if (currentFilter === 'cancelled') {
    // En Cancelaciones: solo productos cancelados visibles por defecto; el resto en bloque colapsable
    const restHtml = renderOrderItemsChunk(activeItems, customer, offersData, warehouseInfoMap) +
      (showExtraValues ? extraValuesHtml : "");
    itemsHtml = cancelledWarning +
      renderOrderItemsChunk(cancelledItems, customer, offersData, warehouseInfoMap) +
      (restHtml ? `<div class="order-items-rest" style="display:none;">${restHtml}</div>` : "");
  } else {
    const shouldRenderItemsNow =
      !(isOrders2Page() && currentFilter === "closed" && orderClosedViewMode.get(order.id) !== true);
    itemsHtml = cancelledWarning +
      (shouldRenderItemsNow && currentFilter !== 'waiting' ? renderOrderItemsChunk(cancelledItems, customer, offersData, warehouseInfoMap) : "") +
      (shouldRenderItemsNow ? renderOrderItemsChunk(activeItems, customer, offersData, warehouseInfoMap) : "") +
      (shouldRenderItemsNow && showExtraValues ? extraValuesHtml : "");
  }
  
  // Agregar resumen de ofertas y promociones si hay descuentos
  let offersSummaryHtml = '';
  if (offersData.totalDiscount > 0) {
    let summaryText = '';
    let summaryCount = 0;
    
    // Contar promociones aplicadas
    if (offersData.promotions.length > 0) {
      for (const promo of offersData.promotions) {
        summaryCount += promo.count || 0;
        summaryText += `${promo.count || 0} items en ${promo.type}`;
      }
    }
    
    // Contar ofertas aplicadas
    if (offersData.offers.length > 0) {
      const offerCount = offersData.offers.reduce((sum, o) => {
        const item = activeItems.find(i => offersData.itemOffers.has(i.id));
        return sum + (item?.quantity || 0);
      }, 0);
      if (offerCount > 0) {
        if (summaryText) summaryText += ' + ';
        summaryText += `${offerCount} items en oferta`;
      }
    }
    
    offersSummaryHtml = `
      <div class="order-item" style="background: #fff3e0; border-left: 4px solid #ff9800; padding: 12px; margin: 8px 0; border-radius: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 15px;">🔥 Ofertas y Promociones</strong>
            <div style="font-size: 13px; color: #666; margin-top: 4px;">
              ${summaryText || 'Descuentos aplicados'}
            </div>
            <div style="font-size: 14px; color: #ff9800; margin-top: 4px; font-weight: 600;">
              Descuento: -$${offersData.totalDiscount.toLocaleString('es-AR')}
            </div>
          </div>
        </div>
      </div>
    `;
  }
  
  const finalItemsHtml = itemsHtml + offersSummaryHtml;

  // Contar productos apartados (sumando cantidades)
  const readyCount = (order.order_items || [])
    .filter((item) => item.status === "picked")
    .reduce((sum, item) => sum + (item.quantity || 0), 0);

  // Contar total de productos (sumando cantidades)
  const totalItems = (order.order_items || [])
    .reduce((sum, item) => sum + (item.quantity || 0), 0);

  // Contar items reservados
  const reservedItems = (order.order_items || []).filter(item => item.status === 'reserved');
  const hasReservedItems = reservedItems.length > 0;

  // Mostrar botones según el estado del pedido
  let actionButtons = "";
  let sendToLocalButton = "";
  
  if (isExpiredPendingDisassemblyOrder) {
    actionButtons = "";
  } else if (order.status === "closed") {
    // Para pedidos cerrados, mostrar botón "TERMINADO" y "Editar"
    actionButtons = `
      <button class="btn" style="background: #17a2b8; color: white;" data-edit-order="${order.id}">✏️ Editar Pedido</button>
      <button class="btn" style="background: #28a745; color: white;" data-mark-sent="${order.id}">TERMINADO</button>
    `;
  } else if (order.status === STATUS.STOCK_PENDING) {
    actionButtons = `
      <button class="btn" style="background: #b42318; color: white;" data-resolve-stock-pending="${order.id}">Resolver conflicto</button>
      <button class="btn" style="background: #dc3545; color: white;" data-cancel-order="${order.id}">Cancelar pedido</button>
    `;
  } else if (order.status !== "sent") {
    // Botón "Editar Pedido" siempre visible
    actionButtons = `
      <button class="btn" style="background: #17a2b8; color: white;" data-edit-order="${order.id}">✏️ Editar Pedido</button>
    `;
    
    // Si el pedido está en estado "activo": botón reservados (lógica original) y/o enviar todos como apartados (pedidos del usuario)
    if (displayStatus === "active") {
      if (hasReservedItems) {
        actionButtons += `
          <button class="btn" style="background: #28a745; color: white;" data-pick-all-reserved="${order.id}">✓ Apartar Todos los Reservados</button>
        `;
      }
      if (hasWaitingItems(order)) {
        actionButtons += `
          <button class="btn" style="background: #28a745; color: white;" data-pick-all-waiting="${order.id}">✓ Enviar todos los productos como apartados</button>
        `;
      }
    }
    
    // Si el pedido está en estado "apartado" (picked), mostrar "Cerrar pedido" y "Enviar al Local"
    if (displayStatus === "picked") {
      actionButtons += `
        <button class="btn btn-success" data-close-order="${order.id}">Cerrar pedido</button>
      `;
      
      // Separar botón "Enviar al Local" para colocarlo a la derecha
      if (hasAllItemsPicked(order) && !hasWaitingItems(order)) {
        sendToLocalButton = `
          <button class="btn" style="background: #CD844D; color: white;" data-send-to-local="${order.id}">🏪 Enviar al Local</button>
        `;
      }
    }
  }

  // En Cancelaciones, ofrecer desarme completo reutilizando el flujo existente de cancelación total.
  if (currentFilter === "cancelled") {
    if (isExpiredPendingDisassemblyOrder) {
      const enable24hUses = getEnable24hUsesFromOrder(order);
      const enableBtnColor = enable24hUses <= 0 ? "#17a2b8" : (enable24hUses === 1 ? "#f39c12" : "#dc3545");
      actionButtons += `
        <button class="btn" style="background: ${enableBtnColor}; color: white;" data-enable-order="${order.id}">
          ⏱️ Habilitar 24hs
        </button>
      `;
    }
    actionButtons += `
      <button class="btn" style="background: #dc3545; color: white;" data-dismantle-order="${order.id}">
        🧩 Desarmar pedido
      </button>
    `;
  }

  // Obtener número de pedido o usar ID como fallback
  const orderDisplayNumber = order.order_number || order.id.substring(0, 8);
  
  // Determinar el estado de visualización y el texto del botón
  let shouldStartCollapsed = false;
  let toggleLabel = 'Ocultar productos';
  let itemsDisplay = 'block';
  
  if (currentFilter === 'active') {
    // En pestaña Activos, el botón alterna entre "ver completo" y "solo reservados"
    const isFullView = orderViewMode.get(order.id) === true;
    if (isFullView) {
      toggleLabel = 'Ver solo reservados';
      itemsDisplay = 'block';
    } else {
      toggleLabel = 'Ver pedido completo';
      itemsDisplay = 'block';
    }
  } else if (currentFilter === 'waiting') {
    // En pestaña Espera, mostrar expandido por defecto (solo items en espera)
    // El botón alterna entre "ver pedido completo" y "ver solo en espera"
    const isFullView = orderWaitingViewMode.get(order.id) === true;
    if (isFullView) {
      toggleLabel = 'Ver solo en espera';
      itemsDisplay = 'block';
    } else {
      toggleLabel = 'Ver pedido completo';
      itemsDisplay = 'block'; // Mostrar expandido por defecto
    }
  } else if (currentFilter === 'picked') {
    // En Apartados, colapsar por defecto
    shouldStartCollapsed = true;
    itemsDisplay = 'none';
    toggleLabel = 'Ver productos';
  } else if (currentFilter === 'closed') {
    // Orders2: en Cerrados, no renderizar productos hasta pedirlo
    if (isOrders2Page()) {
      const isFullView = orderClosedViewMode.get(order.id) === true;
      shouldStartCollapsed = !isFullView;
      itemsDisplay = isFullView ? 'block' : 'none';
      toggleLabel = isFullView ? 'Ocultar productos' : 'Ver pedido';
    } else {
      itemsDisplay = 'block';
      toggleLabel = 'Ocultar productos';
    }
  } else if (currentFilter === 'cancelled') {
    // En Cancelaciones: solo se ven los productos cancelados; el resto se muestra al pulsar "Ver productos"
    if (forcedCancelledView) {
      shouldStartCollapsed = true;
      itemsDisplay = 'none';
    } else {
      itemsDisplay = 'block';
    }
    toggleLabel = 'Ver productos';
  } else {
    // En otros filtros, mostrar expandido
    itemsDisplay = 'block';
    toggleLabel = 'Ocultar productos';
  }
  
  // Si estamos en filtro de espera y no hay items en espera, no mostrar la tarjeta
  if (currentFilter === 'waiting' && activeItems.length === 0) {
    return '';
  }
  
  const orderCardExtraClass = (isOrders2Page() && isCustomerOrder) ? " order-card--customer" : "";
  const pendingSummaryCount = orders2PendingByOrder.get(order.id)?.size ?? 0;
  const showClientSummaryBtn =
    isOrders2Page() &&
    isCustomerOrder &&
    (pendingSummaryCount > 0 || Boolean(getAdminClientSummaryFromOrder(order)));

  return `
    <div class="order-card${orderCardExtraClass}" data-order-id="${order.id}">
      <div class="order-header">
        <div class="order-id" style="display: flex; align-items: center; gap: 8px;">
          Pedido #${orderDisplayNumber}${createdLabel}${sentLabel}
          ${(displayStatus === 'active' || displayStatus === 'picked' || displayStatus === 'waiting' || displayStatus === STATUS.STOCK_PENDING) ? `
            <button class="btn-cancel-order" 
                    data-cancel-order="${order.id}" 
                    title="Cancelar pedido"
                    style="background: #dc3545; color: white; padding: 4px 8px; font-size: 12px; border-radius: 6px; border: none; cursor: pointer; white-space: nowrap;">
              🗑️ Cancelar
            </button>
          ` : ''}
        </div>
        <div class="order-status ${statusClass}">${statusLabel}</div>
      </div>
      ${stockPendingBannerHtml}
      <div class="customer-info">
        <div class="customer-name" style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            ${customerNumber ? `<span style="color: #CD844D; font-weight: 600; margin-right: 8px;">#${customerNumber}</span>` : ""}
            <span>${formatCustomerDisplayName(customer)}</span>${customerIncidentPointsHtml}
          </div>
          ${detailActionHtml}
        </div>
        <div class="customer-details">
          ${
            (customerPhoneHref && customerPhoneDigits.length >= 8)
              ? `<a href="${customerPhoneHref}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline; text-underline-offset: 3px; font-weight: 600;">📞 ${customerPhone}</a>`
              : `<span>📞 ${customerPhone}</span>`
          }
          ${(customerCity || customerProvince) ? `<span>📍 ${[customerCity, customerProvince].filter(Boolean).join(" - ")}</span>` : ""}
          <span class="transport-badge ${transportBadgeClass}">${transportBadgeText}</span>
        </div>
        ${
          showClientSummaryBtn
            ? `<div class="orders2-client-message-row">
                 <button type="button" class="orders2-client-message-btn" data-copy-client-summary="${order.id}" aria-label="Copiar mensaje para el cliente">
                   <span class="orders2-client-message-btn__icon" aria-hidden="true">💬</span>
                   <span class="orders2-client-message-btn__text">Copiar mensaje</span>
                 </button>
               </div>`
            : ""
        }
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin:8px 0 4px 0; gap: 10px; flex-wrap: wrap;">
        <div style="display:flex; align-items:center; gap:10px; flex-wrap: wrap;">
          <button class="btn btn-outline" data-toggle-items="${order.id}">${toggleLabel}</button>
          ${missingBannerHtml}
        </div>
        <div style="font-size:14px; color:#555; font-weight:600;">Productos separados: ${readyCount}/${totalItems}</div>
      </div>
      <div class="order-items" id="order-items-${order.id}" style="display:${itemsDisplay};" data-order-id="${order.id}">
        ${finalItemsHtml}
      </div>
      <div class="order-total">
        <span>Total</span>
        <span>${formatCurrency(total)}</span>
      </div>
      <div class="order-actions" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          ${actionButtons}
        </div>
        ${sendToLocalButton ? `<div>${sendToLocalButton}</div>` : ''}
      </div>
    </div>
  `;
}

function generateOrderSummary(order) {
  // Obtener información del cliente
  let customer = {};
  if (Array.isArray(order.customers)) {
    customer = order.customers[0] || {};
  } else if (order.customers && typeof order.customers === 'object') {
    customer = order.customers;
  }
  
  // Obtener todos los items (excluir cancelados)
  const allItems = (order.order_items || []).filter(item => item.status !== 'cancelled');
  
  // Parsear valores extra desde notes
  let shippingAmount = 0;
  let discountAmount = 0;
  let extrasAmount = 0;
  let extrasPercentage = 0;
  
  if (order.notes) {
    try {
      const extraValues = JSON.parse(order.notes);
      shippingAmount = parseFloat(extraValues.shipping) || 0;
      discountAmount = parseFloat(extraValues.discount) || 0;
      extrasAmount = parseFloat(extraValues.extras_amount) || 0;
      extrasPercentage = parseFloat(extraValues.extras_percentage) || 0;
    } catch (e) {
      console.warn('Error parseando valores extra:', e);
    }
  }
  
  // Calcular subtotal de productos (normalizar miles abreviados)
  const productsSubtotal = allItems.reduce((sum, item) => {
    return sum + (normalizeOrderPrice(item.price_snapshot || 0) * (item.quantity || 0));
  }, 0);
  
  // Calcular cantidad total de productos
  const totalQuantity = allItems.reduce((sum, item) => {
    return sum + (item.quantity || 0);
  }, 0);
  
  // Calcular extras porcentuales
  const extrasFromPercentage = productsSubtotal * extrasPercentage / 100;
  
  // Calcular total
  const total = productsSubtotal + shippingAmount - discountAmount + extrasAmount + extrasFromPercentage;
  
  // Generar HTML de items
  const itemsHtml = allItems.map((item, idx) => {
    const unitPrice = normalizeOrderPrice(item.price_snapshot || 0);
    const itemTotal = unitPrice * (item.quantity || 0);
    // Usar el nombre del producto en lugar del código QR
    const productName = item.product_name || 'Producto sin nombre';
    const color = (item.color || '-').toLowerCase();
    const size = item.size || '-';
    const quantity = item.quantity || 0;
    
    const imageHtml = item.imagen 
      ? `<img src="${item.imagen}" alt="${productName}" class="order-summary-item-image" onerror="this.style.display='none'">`
      : '<div class="order-summary-item-image" style="background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #999; font-size: 10px;">Sin img</div>';
    
    return `
      <div class="order-summary-item">
        <div class="order-summary-item-media">
          <div class="order-summary-item-index">${idx + 1}</div>
          ${imageHtml}
        </div>
        <div class="order-summary-item-details-horizontal">
          <span class="order-summary-item-name">${productName}</span>
          <span class="order-summary-item-color">${color}</span>
          <span class="order-summary-item-size">${size}</span>
          <span class="order-summary-item-quantity">${quantity}</span>
          <span class="order-summary-item-unit-price">${formatCurrency(unitPrice)}</span>
          <span class="order-summary-item-total">${formatCurrency(itemTotal)}</span>
        </div>
      </div>
    `;
  }).join('');
  
  // Generar HTML de extras
  let extrasHtml = '';
  if (shippingAmount > 0 || discountAmount > 0 || extrasAmount > 0 || extrasPercentage > 0) {
    extrasHtml += '<div class="order-summary-section">';
    if (shippingAmount > 0) {
      extrasHtml += `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span>🚚 Envío:</span>
          <strong>${formatCurrency(shippingAmount)}</strong>
        </div>
      `;
    }
    if (discountAmount > 0) {
      extrasHtml += `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span>💸 Descuento:</span>
          <strong style="color: #dc3545;">-${formatCurrency(discountAmount)}</strong>
        </div>
      `;
    }
    if (extrasAmount > 0) {
      extrasHtml += `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span>➕ Extras:</span>
          <strong>${formatCurrency(extrasAmount)}</strong>
        </div>
      `;
    }
    if (extrasPercentage > 0) {
      extrasHtml += `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span>➕ Extras (${extrasPercentage}%):</span>
          <strong>${formatCurrency(extrasFromPercentage)}</strong>
        </div>
      `;
    }
    extrasHtml += '</div>';
  }
  
  return `
    <div style="margin-bottom: 16px;">
      <div style="font-size: 14px; color: #666; margin-bottom: 4px;">Pedido #${order.order_number || order.id.substring(0, 8)}</div>
      <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">${formatCustomerDisplayName(customer)}</div>
      ${customer.phone ? `<div style="font-size: 14px; color: #666;">📞 ${customer.phone}</div>` : ''}
    </div>
    <div class="order-summary-section">
      <h3 style="margin: 0 0 12px 0; font-size: 18px; color: #333;">Productos</h3>
      ${itemsHtml}
    </div>
    ${extrasHtml}
    <div class="order-summary-total">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 14px; color: #666;">Total de productos: <strong>${totalQuantity}</strong></span>
        <span>Total: ${formatCurrency(total)}</span>
      </div>
    </div>
  `;
}

function showOrderSummaryModal(order) {
  const modal = document.getElementById('order-summary-modal');
  const content = document.getElementById('order-summary-content');
  
  if (!modal || !content) {
    console.error('Modal de resumen no encontrado');
    return;
  }
  
  content.innerHTML = generateOrderSummary(order);
  modal.classList.add('active');
}

function renderOrderItemActionButtonsHtml(item) {
  if (item?.__forcedCancelled) {
    return `<div class="item-actions"></div>`;
  }
  const isCancelled = item.status === "cancelled";
  const isMissing = item.status === "missing";
  const isWaiting = item.status === "waiting";
  const useKebabMenu = isOrders2Page();
  if (isCancelled) {
    return `
    <div class="item-actions">
      <button class="item-action-btn success" title="Aceptar cancelación y eliminar del pedido" data-item-id="${
        item.id
      }" data-item-action="cleanup-cancelled">✓</button>
    </div>
  `;
  }
  if (isMissing) {
    return `
    <div class="item-actions">
      <button class="item-action-btn danger" title="Eliminar producto faltante del pedido" data-item-id="${
        item.id
      }" data-item-action="remove-missing">🗑️</button>
      <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${
        item.id
      }" data-item-action="reserved">↺</button>
    </div>
  `;
  }
  if (isWaiting || item.status === "reserved" || item.status === "picked") {
    return `
    <div class="item-actions">
      <button class="item-action-btn success" title="Producto apartado" data-item-id="${
        item.id
      }" data-item-action="picked">✓</button>
      <button class="item-action-btn danger" title="Producto faltante" data-item-id="${
        item.id
      }" data-item-action="missing">✕</button>
      ${
        useKebabMenu
          ? `
        <div class="item-more">
          <button type="button" class="item-action-btn neutral item-kebab-toggle" title="Más acciones" aria-label="Más acciones" data-kebab-toggle="1">⋮</button>
          <div class="item-kebab-menu" role="menu">
            <button type="button" class="item-kebab-item" role="menuitem" data-kebab-action="waiting">⏳ Producto en espera</button>
            <button type="button" class="item-kebab-item" role="menuitem" data-kebab-action="reserved">↺ Restaurar estado</button>
            <button type="button" class="item-kebab-item danger" role="menuitem" data-kebab-action="delete-item">🗑️ Eliminar</button>
          </div>
        </div>
        <button class="item-action-btn" title="Producto en espera" data-item-id="${item.id}" data-item-action="waiting" style="display:none;background:#ff9800;color:white;">⏳</button>
        <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${item.id}" data-item-action="reserved" style="display:none;">↺</button>
        <button class="item-action-btn danger" title="Eliminar del pedido" data-item-id="${item.id}" data-item-action="delete-item" style="display:none;">🗑️</button>
          `
          : `
        <button class="item-action-btn" title="Producto en espera" data-item-id="${item.id}" data-item-action="waiting" style="background: #ff9800; color: white;">⏳</button>
        <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${item.id}" data-item-action="reserved">↺</button>
        <button class="item-action-btn danger" title="Eliminar del pedido" data-item-id="${item.id}" data-item-action="delete-item">🗑️</button>
          `
      }
    </div>
  `;
  }
  return `
    <div class="item-actions">
      <button class="item-action-btn success" title="Producto apartado" data-item-id="${
        item.id
      }" data-item-action="picked">✓</button>
      <button class="item-action-btn danger" title="Producto faltante" data-item-id="${
        item.id
      }" data-item-action="missing">✕</button>
      ${
        useKebabMenu
          ? `
        <div class="item-more">
          <button type="button" class="item-action-btn neutral item-kebab-toggle" title="Más acciones" aria-label="Más acciones" data-kebab-toggle="1">⋮</button>
          <div class="item-kebab-menu" role="menu">
            <button type="button" class="item-kebab-item" role="menuitem" data-kebab-action="waiting">⏳ Producto en espera</button>
            <button type="button" class="item-kebab-item" role="menuitem" data-kebab-action="reserved">↺ Restaurar estado</button>
            <button type="button" class="item-kebab-item danger" role="menuitem" data-kebab-action="delete-item">🗑️ Eliminar</button>
          </div>
        </div>
        <button class="item-action-btn" title="Producto en espera" data-item-id="${item.id}" data-item-action="waiting" style="display:none;background:#ff9800;color:white;">⏳</button>
        <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${item.id}" data-item-action="reserved" style="display:none;">↺</button>
        <button class="item-action-btn danger" title="Eliminar del pedido" data-item-id="${item.id}" data-item-action="delete-item" style="display:none;">🗑️</button>
          `
          : `
        <button class="item-action-btn" title="Producto en espera" data-item-id="${item.id}" data-item-action="waiting" style="background: #ff9800; color: white;">⏳</button>
        <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${item.id}" data-item-action="reserved">↺</button>
        <button class="item-action-btn danger" title="Eliminar del pedido" data-item-id="${item.id}" data-item-action="delete-item">🗑️</button>
          `
      }
    </div>
  `;
}

/** Tarjeta única para varias líneas order_items del mismo producto/talle/color (general + local). */
function renderOrderItemGroup(items, customer = {}, offersData = { itemOffers: new Map(), itemPromos: new Map() }, warehouseInfoMap = new Map()) {
  const base = items[0];
  const displayColor = (base.color || "-").toString().trim() || "-";
  const displaySize = (base.size || "-").toString().trim() || "-";
  const titleBase = `${base.product_name} - ${displayColor} - ${displaySize}`;
  const imageHtml = base.imagen
    ? `<img src="${base.imagen}" alt="${base.product_name}" class="item-thumb" onerror="this.remove()" />`
    : "";

  let offerPromoBadge = "";
  for (const it of items) {
    const promoText = offersData.itemPromos?.get(it.id);
    const offerInfo = offersData.itemOffers?.get(it.id);
    if (promoText) {
      offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #ff9800; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">${promoText}</div>`;
      break;
    }
    if (offerInfo) {
      offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #e74c3c; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">🔥 Oferta</div>`;
      break;
    }
  }

  let totalSubtotal = 0;
  let totalOriginal = 0;
  const sublinesHtml = items
    .map((item) => {
      const info = getOrderItemStatusDisplayInfo(item, warehouseInfoMap);
      const warehouse = warehouseInfoMap.get(item.id);
      const warehouseLabel = warehouse === "Local" ? "en local" : warehouse;
      const qty = Number(item.quantity || 0) || 0;
      let displayPrice = normalizeOrderPrice(item.price_snapshot || 0);
      let originalPrice = null;
      const promoText = offersData.itemPromos?.get(item.id);
      const offerInfo = offersData.itemOffers?.get(item.id);
      if (promoText) {
        originalPrice = displayPrice;
      } else if (offerInfo) {
        originalPrice = offerInfo.originalPrice;
        displayPrice = offerInfo.offerPrice;
      }
      const lineSubtotal = qty * displayPrice;
      totalSubtotal += lineSubtotal;
      if (originalPrice != null) totalOriginal += originalPrice * qty;
      return `
      <div class="order-item-split-row" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(0,0,0,0.08);">
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 6px;">
          <strong style="font-size: 14px;">x${qty}</strong>
          <span class="item-status ${info.className}">${info.text}</span>
          ${warehouseLabel ? `<span style="background: #e3f2fd; color: #1565c0; padding: 3px 6px; border-radius: 10px; font-size: 10px; font-weight: 600;">📍 ${warehouseLabel}</span>` : ""}
          <span style="margin-left: auto; font-weight: 700; font-size: 14px;">${formatCurrency(lineSubtotal)}</span>
        </div>
        ${renderOrderItemActionButtonsHtml(item)}
      </div>`;
    })
    .join("");

  const isMobile = window.innerWidth <= 768;
  const anyCancelled = items.some((i) => i.status === "cancelled");
  const anyForcedCancelled = items.some((i) => i?.__forcedCancelled);
  const cancelledInfo = anyCancelled
    ? (anyForcedCancelled
      ? ""
      : `
    <div style="margin-top: 8px; padding: 8px; background: #fff3e0; border-radius: 6px; font-size: 12px; color: #e65100;">
      <strong>Cancelado por:</strong> ${customer.full_name || "Cliente sin nombre"}${customer.customer_number ? ` (Nº ${customer.customer_number})` : ""}${customer.phone ? ` • Tel: ${customer.phone}` : ""}${customer.email ? ` • Email: ${customer.email}` : ""}
    </div>
  `)
    : "";

  if (isMobile) {
    return `
      <div class="order-item ${anyCancelled ? "cancelled-item" : ""}">
        <div style="display: flex; gap: 10px; align-items: flex-start;">
          ${imageHtml}
          <div class="item-main" style="flex: 1; min-width: 0;">
            <div class="item-name" style="font-size: 15px; font-weight: 700; margin-bottom: 6px; line-height: 1.3;">${titleBase}</div>
            ${offerPromoBadge}
            ${sublinesHtml}
            <div class="item-price" style="margin-top: 10px; font-size: 16px; font-weight: 700;">
              ${totalOriginal > 0 ? `<span style="text-decoration: line-through; color: #888; font-size: 0.85em; margin-right: 6px;">${formatCurrency(totalOriginal)}</span>` : ""}
              ${formatCurrency(totalSubtotal)}
            </div>
            ${cancelledInfo}
          </div>
        </div>
      </div>`;
  }
  return `
      <div class="order-item ${anyCancelled ? "cancelled-item" : ""}">
        ${imageHtml}
        <div class="item-main">
          <div class="item-name">${titleBase}</div>
          ${offerPromoBadge}
          ${sublinesHtml}
          <div class="item-price" style="margin-top: 10px;">
            ${totalOriginal > 0 ? `<span style="text-decoration: line-through; color: #888; font-size: 0.9em; margin-right: 8px;">${formatCurrency(totalOriginal)}</span>` : ""}
            ${formatCurrency(totalSubtotal)}
          </div>
          ${cancelledInfo}
        </div>
      </div>`;
}

function renderOrderItemsChunk(items, customer, offersData, warehouseInfoMap) {
  return groupOrderItemsForDisplayFlat(items)
    .map((g) =>
      g.type === "single"
        ? renderOrderItem(g.item, customer, offersData, warehouseInfoMap)
        : renderOrderItemGroup(g.items, customer, offersData, warehouseInfoMap)
    )
    .join("");
}

function isExtraSpecialItem(item) {
  if (!item) return false;
  const empty = (v) => {
    if (v == null) return true;
    const s = String(v).trim();
    return s === "" || s === "-" || s === "—" || s.toLowerCase() === "undefined";
  };
  const noVariant = item.variant_id == null || item.variant_id === "";
  const noImage = empty(item.imagen) && empty(item.image_url);
  const noColor = empty(item.color);
  const noSize = empty(item.size);
  return !!(noVariant && noImage && noColor && noSize);
}

function renderOrderItem(item, customer = {}, offersData = { itemOffers: new Map(), itemPromos: new Map() }, warehouseInfoMap = new Map()) {
  const info = getOrderItemStatusDisplayInfo(item, warehouseInfoMap);

  const warehouse =
    item.status === "reserved" || item.status === "waiting" ? warehouseInfoMap.get(item.id) : null;
  const warehouseLabel = warehouse === "Local" ? "en local" : warehouse;
  
  // Verificar si tiene promoción (prioridad sobre oferta)
  const promoText = offersData.itemPromos?.get(item.id);
  const offerInfo = offersData.itemOffers?.get(item.id);
  
  // Calcular precio y subtotal (normalizar miles abreviados: 18 → 18000)
  let displayPrice = normalizeOrderPrice(item.price_snapshot || 0);
  let originalPrice = null;
  
  if (promoText) {
    originalPrice = displayPrice;
  } else if (offerInfo) {
    originalPrice = offerInfo.originalPrice;
    displayPrice = offerInfo.offerPrice;
  }
  
  const subtotal = (item.quantity || 0) * displayPrice;
  const isCancelled = item.status === 'cancelled';

  const displayColor = (item.color || "-").toString().trim() || "-";
  const displaySize = (item.size || "-").toString().trim() || "-";
  const displayQty = Number(item.quantity || 0) || 0;
  const compactLine = `${item.product_name} - ${displayColor} - ${displaySize} - x${displayQty}`;

  const imageHtml = item.imagen
    ? `<img src="${item.imagen}" alt="${item.product_name}" class="item-thumb" onerror="this.remove()" />`
    : "";

  // Mostrar leyenda de oferta o promoción
  let offerPromoBadge = '';
  if (promoText) {
    offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #ff9800; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">${promoText}</div>`;
  } else if (offerInfo) {
    offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #e74c3c; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">🔥 Oferta</div>`;
  }

  // Si está cancelado, mostrar información contextual.
  const cancelledInfo = isCancelled
    ? item?.__forcedCancelled
      ? ""
      : `
    <div style="margin-top: 8px; padding: 8px; background: #fff3e0; border-radius: 6px; font-size: 12px; color: #e65100;">
      <strong>Cancelado por:</strong> ${customer.full_name || 'Cliente sin nombre'}${customer.customer_number ? ` (Nº ${customer.customer_number})` : ''}${customer.phone ? ` • Tel: ${customer.phone}` : ''}${customer.email ? ` • Email: ${customer.email}` : ''}
    </div>
  `
    : '';

  const actionButtons = renderOrderItemActionButtonsHtml(item);

  // Detectar si es móvil
  const isMobile = window.innerWidth <= 768;
  
  if (isMobile) {
    // Layout móvil: imagen a la izquierda, información a la derecha
    return `
      <div class="order-item ${isCancelled ? 'cancelled-item' : ''}">
        <div style="display: flex; gap: 10px; align-items: flex-start;">
          ${imageHtml}
          <div class="item-main" style="flex: 1; min-width: 0;">
            <div class="item-name" style="font-size: 15px; font-weight: 700; margin-bottom: 6px; line-height: 1.3;">${compactLine}</div>
            ${offerPromoBadge}
            <div style="display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
              <span class="item-status ${info.className}">${info.text}</span>
              ${warehouseLabel ? `<span style="background: #e3f2fd; color: #1565c0; padding: 3px 6px; border-radius: 10px; font-size: 10px; font-weight: 600;">📍 ${warehouseLabel}</span>` : ''}
            </div>
            <div class="item-price" style="margin-top: 6px; font-size: 16px; font-weight: 700;">
              ${originalPrice ? `<span style="text-decoration: line-through; color: #888; font-size: 0.85em; margin-right: 6px;">${formatCurrency(originalPrice * (item.quantity || 0))}</span>` : ''}
              ${formatCurrency(subtotal)}
            </div>
            ${cancelledInfo}
          </div>
        </div>
        ${actionButtons}
      </div>
    `;
  } else {
    // Layout desktop: mantener estructura original
    return `
      <div class="order-item ${isCancelled ? 'cancelled-item' : ''}">
        ${imageHtml}
        <div class="item-main">
          <div class="item-name">${compactLine}</div>
          ${offerPromoBadge}
          <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap;">
            <span class="item-status ${info.className}">${info.text}</span>
            ${warehouseLabel ? `<span style="background: #e3f2fd; color: #1565c0; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;">📍 ${warehouseLabel}</span>` : ''}
          </div>
          <div class="item-price">
            ${originalPrice ? `<span style="text-decoration: line-through; color: #888; font-size: 0.9em; margin-right: 8px;">${formatCurrency(originalPrice * (item.quantity || 0))}</span>` : ''}
            ${formatCurrency(subtotal)}
          </div>
          ${cancelledInfo}
        </div>
        ${actionButtons}
      </div>
    `;
  }
}

/** Aplica la misma lógica que filterOrders pero para una pestaña concreta (sin mutar currentFilter de forma visible al resto del módulo). */
function filterOrdersForTab(list, tab) {
  const saved = currentFilter;
  currentFilter = tab;
  try {
    return filterOrders(list);
  } finally {
    currentFilter = saved;
  }
}

function filterOrders(list) {
  if (currentFilter === "all") {
    const excluded = new Set(FINAL_STATUSES.map((s) => s.toLowerCase()));
    return list.filter((o) => !excluded.has((o.status || "").toLowerCase()));
  }

  // Activos = solo pedidos con al menos un ítem en Reservado (o Falta). En Activos el único estado de producto que se muestra es Reservado.
  // Espera = pedidos con ítems en waiting (estado interno; con checkout en 'reserved' ya no deberían crearse nuevos).

  if (currentFilter === "waiting") {
    return list.filter((order) => {
      if (order.status === STATUS.CLOSED || order.status === STATUS.SENT || order.status === STATUS.DEVOLUCION) return false;
      if (!hasWaitingItems(order)) return false;
      // Prioridad Activos: pedidos mixtos (p. ej. reservado + espera) solo en Activos, no duplicar en Espera
      if (filterOrdersForTab([order], STATUS.ACTIVE).length === 1) return false;
      return true;
    });
  }

  if (currentFilter === STATUS.ACTIVE) {
    // Solo pedidos que tienen al menos un ítem en reservado o missing (no solo waiting)
    const normStatus = (s) => String(s ?? "").trim().toLowerCase();
    let debugLogCount = 0;
    const MAX_DEBUG_LOGS = 10;
    return list.filter((order) => {
      let excludedBy = null;
      const statusNorm = normStatus(order.status);
      // orders2: si el pedido quedó CLOSED pero todavía tiene items RESERVED, debe priorizarse en Activos
      const orders2AllowClosedWithReserved =
        isOrders2Page() && statusNorm === STATUS.CLOSED && hasReservedItems(order);

      if (!orders2AllowClosedWithReserved && (statusNorm === STATUS.CLOSED || statusNorm === STATUS.SENT || statusNorm === STATUS.DEVOLUCION || statusNorm === STATUS.DEVOLUCION_ALT)) {
        excludedBy = "order.status=" + (order.status ?? "null");
      }
      else if (isExpiredPendingAdminDisassembly(order)) excludedBy = "pedido vencido pendiente de desarme (va en Cancelaciones)";
      else if (statusNorm === STATUS.ACTIVE) {
        if (!hasOperationalItems(order)) excludedBy = "active sin ítems operacionales";
        else if (hasOnlyWaitingItems(order)) excludedBy = "active con solo waiting (va en Espera)";
        else if (hasAllItemsPicked(order) && !hasWaitingItems(order)) excludedBy = "active con items apartados (va en Apartados)";
        else return true;
      }
      else if (!hasReservedItems(order) && !hasItemsNeedingAttention(order)) excludedBy = "sin ítems reservados ni missing";
      else if (hasAllItemsPicked(order) && !hasWaitingItems(order)) excludedBy = "hasAllItemsPicked=true (sin espera)";
      if (DEBUG_ACTIVE_FILTER && debugLogCount < MAX_DEBUG_LOGS) {
        const items = order.order_items;
        const hasItems = items != null;
        const itemsType = typeof items;
        const itemsLen = hasItems && Array.isArray(items) ? items.length : (hasItems ? "not-array" : 0);
        const itemStatuses = (Array.isArray(items) ? items : []).map((i) => i?.status);
        console.log("[DEBUG_ACTIVE_FILTER] order", {
          orderId: order.id,
          orderStatus: order.status,
          order_itemsExists: hasItems,
          order_itemsType: itemsType,
          order_itemsLength: itemsLen,
          itemStatuses,
          hasWaitingItems: hasWaitingItems(order),
          hasOnlyWaitingItems: hasOnlyWaitingItems(order),
          hasAllItemsPicked: hasAllItemsPicked(order),
          excludedBy: excludedBy || "INCLUDED",
        });
        debugLogCount++;
      }
      if (excludedBy) return false;
      return true;
    });
  }
  
  if (currentFilter === STATUS.PICKED) {
    // Apartados: todos los items "picked" (sin items en espera)
    return list.filter((order) => {
      if (order.status === STATUS.CLOSED || order.status === STATUS.SENT || order.status === STATUS.DEVOLUCION) return false;
      if (hasWaitingItems(order)) return false;
      if (!hasAllItemsPicked(order)) return false;
      if (hasReservedItems(order)) return false;
      return true;
    });
  }
  
  if (currentFilter === STATUS.CLOSED) {
    // Mostrar pedidos cerrados (excluir los que ya están enviados/terminados)
    return list.filter((order) => {
      if (order.status !== STATUS.CLOSED) return false;

      // orders2: si aún quedan items RESERVED, NO debe verse en Cerrados (prioridad Activos)
      if (isOrders2Page()) {
        if (hasReservedItems(order)) return false;
        // Solo mostrar cuando esté completamente procesado (sin reserved; picked/waiting o resuelto)
        if (hasItemsNeedingAttention(order)) return false;
        if (hasWaitingItems(order)) return false;
        if (!hasAllItemsPicked(order)) return false;
      }

      return true;
    });
  }

  if (currentFilter === STATUS.CANCELLED) {
    // Mostrar pedidos con al menos un item cancelado
    // + pedidos vencidos pendientes de desarme (bloqueados para cliente).
    return list.filter((order) => {
      const hasCancelledItems = (order.order_items || []).some(item => item.status === 'cancelled');
      return hasCancelledItems || isExpiredPendingAdminDisassembly(order);
    });
  }

  if (currentFilter === STATUS.STOCK_PENDING) {
    return list.filter((order) => String(order?.status || "").trim().toLowerCase() === STATUS.STOCK_PENDING);
  }
  
  // Fallback: filtrar por status
  return list.filter((order) => order.status === currentFilter);
}

function disableAllTabs() {
  const filterButtons = document.querySelectorAll(".filter-btn");
  filterButtons.forEach((btn) => {
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";
  });
}

function enableAllTabs() {
  const filterButtons = document.querySelectorAll(".filter-btn");
  filterButtons.forEach((btn) => {
    btn.disabled = false;
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
  });
}

function showLoading() {
  const container = document.getElementById("orders-content");
  if (!container) return;
  
  // Limpiar completamente el contenedor primero
  container.innerHTML = '';
  
  // Luego mostrar el loading
  container.innerHTML = `
    <div class="loading">
      <div class="loading-spinner"></div>
      <p>Cargando pedidos...</p>
    </div>
  `;
}

function hideLoading() {
  const container = document.getElementById("orders-content");
  if (!container) return;
  const loading = container.querySelector(".loading");
  if (loading) {
    loading.classList.add("hidden");
  }
}

/**
 * Muestra un banner de error de red no bloqueante dentro de #orders-content.
 * No cierra el modal ni redirige. El usuario puede recargar manualmente.
 * Solo se muestra si el contenedor sigue en estado de "loading" (primer render);
 * si ya hay pedidos visibles, el error se ignora para no pisar la UI usable.
 */
function _showOrdersNetworkError(msg) {
  const container = document.getElementById("orders-content");
  if (!container) return;
  // Si ya hay tarjetas de pedidos en pantalla, no interrumpir con el banner.
  if (container.querySelector(".order-card, [data-order-id]")) return;
  container.innerHTML = `
    <div class="loading" style="flex-direction:column;gap:10px;">
      <p style="color:#c00;font-size:14px;margin:0;">${msg}</p>
      <button onclick="location.reload()" style="padding:8px 16px;border:1px solid #c00;border-radius:6px;background:#fff;color:#c00;cursor:pointer;font-size:13px;">Recargar</button>
    </div>`;
}

function showOrderActionLoading(orderId) {
  const orderCard = document.querySelector(`[data-order-id="${orderId}"]`);
  if (!orderCard) return;
  
  // Crear overlay de carga
  const overlay = document.createElement('div');
  overlay.className = 'order-loading-overlay';
  overlay.innerHTML = `
    <div class="order-loading-spinner"></div>
    <p>Actualizando...</p>
  `;
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(255, 255, 255, 0.9);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;
  
  orderCard.style.position = 'relative';
  orderCard.appendChild(overlay);
}

function hideOrderActionLoading(orderId) {
  const orderCard = document.querySelector(`[data-order-id="${orderId}"]`);
  if (!orderCard) return;
  
  const overlay = orderCard.querySelector('.order-loading-overlay');
  if (overlay) {
    overlay.remove();
  }
}

function setupInfiniteScroll() {
  let scrollTimeout = null;
  
  window.addEventListener('scroll', () => {
    // Debounce para evitar demasiadas llamadas
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
    }
    
    scrollTimeout = setTimeout(async () => {
      // No cargar más si:
      // - Ya se están cargando pedidos
      // - Ya se cargaron todos los pedidos
      // - Hay una búsqueda activa (no usar paginación en búsqueda)
      // - Se está cambiando de pestaña (las pestañas están deshabilitadas)
      if (isLoadingMore || allOrdersLoaded || (currentSearch && currentSearch.trim().length > 0)) {
        return;
      }
      
      // Verificar si el usuario está cerca del final de la página (200px antes del final)
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const windowHeight = window.innerHeight;
      const documentHeight = document.documentElement.scrollHeight;
      
      // Si está a menos de 200px del final, cargar más pedidos
      if (scrollTop + windowHeight >= documentHeight - 200) {
        if (hasMoreOrders && !isLoadingMore) {
          isLoadingMore = true;
          
          // Mostrar indicador de carga al final de la lista
          showLoadingMoreIndicator();
          
          try {
            // Cargar siguiente página (sin reset)
            await loadOrders(false);
          } catch (error) {
            console.error("❌ Error cargando más pedidos:", error);
          } finally {
            isLoadingMore = false;
            hideLoadingMoreIndicator();
          }
        }
      }
    }, 100); // Debounce de 100ms
  });
}

function showLoadingMoreIndicator() {
  const container = document.getElementById("orders-content");
  if (!container) return;
  
  // Buscar si ya existe un indicador
  let indicator = container.querySelector('.loading-more-indicator');
  
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'loading-more-indicator';
    indicator.innerHTML = `
      <div class="loading-spinner-small"></div>
      <p>Cargando más pedidos...</p>
    `;
    indicator.style.cssText = `
      text-align: center;
      padding: 20px;
      color: #666;
    `;
    
    const ordersList = container.querySelector('.orders-list');
    if (ordersList) {
      ordersList.appendChild(indicator);
    } else {
      container.appendChild(indicator);
    }
  }
}

function hideLoadingMoreIndicator() {
  const container = document.getElementById("orders-content");
  if (!container) return;
  
  const indicator = container.querySelector('.loading-more-indicator');
  if (indicator) {
    indicator.remove();
  }
}

function setupFilters() {
  const filterButtons = document.querySelectorAll(".filter-btn");
  filterButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      // Prevenir clics múltiples
      if (btn.disabled) return;
      
      // Deshabilitar todas las pestañas inmediatamente
      disableAllTabs();
      
      // Actualizar estado visual
      filterButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      
      // Actualizar filtro
      currentFilter = btn.dataset.status;
      if (DEBUG_ORDERS) {
        const label = btn.textContent?.trim().replace(/\s*\d+\s*$/, "") || currentFilter;
        console.log("[debug] clicked tab", label, "currentFilter", currentFilter);
      }
      orderViewMode.clear();
      
      // Resetear búsqueda y paginación
      currentSearch = '';
      const searchInput = document.getElementById('search-input');
      if (searchInput) {
        searchInput.value = '';
      }
      currentPage = 0;
      orders = [];
      hasMoreOrders = true;
      allOrdersLoaded = false;
      isLoadingMore = false; // Resetear flag de carga
      badgeCountsLoaded = false; // Resetear flag de conteos totales para que se vuelvan a cargar
      
      // Limpiar contenedor INMEDIATAMENTE
      const container = document.getElementById("orders-content");
      if (container) {
        container.innerHTML = '';  // Limpiar primero
      }
      
      // Ocultar indicador de "cargando más" si existe
      hideLoadingMoreIndicator();
      
      // Mostrar indicador de carga
      showLoading();
      
      // Cargar conteos totales de badges INMEDIATAMENTE (en paralelo, no bloquea)
      loadBadgeCountsInBackground();
      
      // Esperar delay para propagación de BD
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Cargar pedidos desde el inicio
      await loadOrders(true);
      
      // Rehabilitar pestañas
      enableAllTabs();
    });
  });
}

function setupButtons() {
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Actualizando...";
      // Resetear paginación y búsqueda
      currentPage = 0;
      orders = [];
      hasMoreOrders = true;
      allOrdersLoaded = false;
      currentSearch = '';
      const searchInput = document.getElementById('search-input');
      if (searchInput) {
        searchInput.value = '';
      }
      await loadOrders(true);
      updateActiveOrdersBadge();
      updatePickedOrdersBadge();
      updateClosedOrdersBadge();
      updateCancelledOrdersBadge();
      if (historyVisible) {
        await loadClosedOrders();
      }
      refreshBtn.textContent = "Actualizar";
      refreshBtn.disabled = false;
    });
  }

  // Event listener para botones de cancelar pedido (delegación de eventos)
  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cancel-order]')) {
      const button = e.target.closest('[data-cancel-order]');
      const orderId = button.getAttribute('data-cancel-order');
      if (orderId) {
        await cancelOrder(orderId);
      }
    }
  });

  // Event listeners para el modal de método de pago
  setupPaymentMethodModal();
}

// Función para configurar los event listeners del modal de método de pago
function setupPaymentMethodModal() {
  const modal = document.getElementById("payment-method-modal");
  const closeBtn = document.getElementById("close-payment-modal");
  const cancelBtn = document.getElementById("cancel-payment-btn");
  const confirmBtn = document.getElementById("confirm-payment-btn");
  const createNewCheckbox = document.getElementById("create-new-payment-method");
  const newMethodContainer = document.getElementById("new-payment-method-container");
  const select = document.getElementById("payment-method-select");

  if (!modal) return;

  // Cerrar modal al hacer clic en X o Cancelar
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      hidePaymentMethodModal();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      hidePaymentMethodModal();
    });
  }

  // Cerrar modal al hacer clic fuera del contenido
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      hidePaymentMethodModal();
    }
  });

  // Toggle para crear nuevo método de pago
  if (createNewCheckbox) {
    createNewCheckbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        newMethodContainer.style.display = "block";
        select.disabled = true;
        select.value = "";
      } else {
        newMethodContainer.style.display = "none";
        select.disabled = false;
        const newMethodInput = document.getElementById("new-payment-method-input");
        if (newMethodInput) {
          newMethodInput.value = "";
        }
      }
    });
  }

  // Confirmar método de pago
  if (confirmBtn) {
    confirmBtn.addEventListener("click", async () => {
      await confirmCloseOrderWithPayment();
    });
  }

  // Permitir Enter en el input de nuevo método
  const newMethodInput = document.getElementById("new-payment-method-input");
  if (newMethodInput) {
    newMethodInput.addEventListener("keypress", async (e) => {
      if (e.key === "Enter") {
        await confirmCloseOrderWithPayment();
      }
    });
  }
}

function setupHistoryControls() {
  if (historyControlsInitialized) return;

  const toggleBtn = document.getElementById("toggle-history-btn");
  const historyContainer = document.getElementById("orders-history");
  if (!toggleBtn || !historyContainer) return;

  historyControlsInitialized = true;

  toggleBtn.addEventListener("click", async () => {
    historyVisible = !historyVisible;
    if (historyVisible) {
      toggleBtn.textContent = "Ocultar pedidos anteriores";
      historyContainer.style.display = "block";
      historyContainer.innerHTML = `
        <p style="margin:0; font-size:14px; color:#666;">Cargando pedidos anteriores...</p>
      `;
      await loadClosedOrders();
    } else {
      toggleBtn.textContent = "Ver pedidos anteriores";
      historyContainer.style.display = "none";
    }
  });
}

function attachOrderEventHandlers() {
  if (!window._partialAcceptModalSetup) {
    setupPartialAcceptModal();
    window._partialAcceptModalSetup = true;
  }
  document.querySelectorAll("[data-item-action]").forEach((btn) => {
    if (btn.dataset.orders2Bound === "1") return;
    btn.dataset.orders2Bound = "1";
    btn.addEventListener("click", async () => {
      const itemId = btn.dataset.itemId;
      const status = btn.dataset.itemAction;
      if (isOrders2Page()) {
        const orderId = orders2GetOrderIdFromAnyEl(btn);
        if (status === "picked") {
          const order = orders.find((o) => o.order_items?.some((i) => i.id === itemId));
          const item = order?.order_items?.find((i) => i.id === itemId);
          if (order?.source === "customer" && item?.quantity > 1 && item?.status === "reserved") {
            openPartialAcceptModal(order, item);
            return;
          }
        }
        orders2SetPendingStatus(orderId, itemId, status);
        return;
      }
      try {
        if (status === "cleanup-cancelled") {
          await cleanupCancelledItem(itemId);
        } else if (status === "remove-missing") {
          await removeMissingItem(itemId);
        } else if (status === "delete-item") {
          await deleteOrderItemImmediate(itemId);
        } else if (status === "picked") {
          // Flujo aceptar parcial: solo para pedidos creados por el cliente con varias unidades del mismo producto
          const order = orders.find((o) => o.order_items?.some((i) => i.id === itemId));
          const item = order?.order_items?.find((i) => i.id === itemId);
          if (order?.source === "customer" && item?.quantity > 1 && item?.status === "reserved") {
            openPartialAcceptModal(order, item);
            return;
          }
          await updateOrderItemStatus(itemId, status);
        } else {
          await updateOrderItemStatus(itemId, status);
        }
      } catch (e) {
        if (e && e.message) console.error("Item action error:", e.message);
      }
    });
  });

  // Toggle de productos por pedido
  document.querySelectorAll('[data-toggle-items]').forEach((btn) => {
    if (btn.dataset.toggleBound === "1") return;
    btn.dataset.toggleBound = "1";
    btn.addEventListener('click', () => {
      const orderId = btn.getAttribute('data-toggle-items');
      const itemsEl = document.getElementById(`order-items-${orderId}`);
      if (!itemsEl) return;
      
      if (currentFilter === 'active') {
        // En pestaña Activos, alternar entre modo completo y solo reservados
        const isFullView = orderViewMode.get(orderId) === true;
        const newMode = !isFullView;
        orderViewMode.set(orderId, newMode);
        
        // Recargar el pedido para actualizar la vista
        const order = orders.find(o => o.id === orderId);
        if (order) {
          // Re-renderizar solo este pedido
          renderOrderCard(order).then(async (html) => {
            if (html) {
              const orderCard = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
              if (orderCard) {
                orderCard.outerHTML = html;
                // Re-attach event handlers para este pedido
                attachOrderEventHandlers();
              }
            }
          });
        }
      } else if (currentFilter === 'waiting') {
        // En pestaña Espera, alternar entre modo completo y solo items en espera
        const isFullView = orderWaitingViewMode.get(orderId) === true;
        const newMode = !isFullView;
        orderWaitingViewMode.set(orderId, newMode);
        
        // Recargar el pedido para actualizar la vista
        const order = orders.find(o => o.id === orderId);
        if (order) {
          // Re-renderizar solo este pedido
          renderOrderCard(order).then(async (html) => {
            if (html) {
              const orderCard = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
              if (orderCard) {
                orderCard.outerHTML = html;
                // Re-attach event handlers para este pedido
                attachOrderEventHandlers();
              }
            }
          });
        }
      } else if (currentFilter === 'closed' && isOrders2Page()) {
        const isFullView = orderClosedViewMode.get(orderId) === true;
        const newMode = !isFullView;
        orderClosedViewMode.set(orderId, newMode);

        const order = orders.find(o => o.id === orderId);
        if (order) {
          renderOrderCard(order).then(async (html) => {
            if (html) {
              const orderCard = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
              if (orderCard) {
                orderCard.outerHTML = html;
                attachOrderEventHandlers();
              }
            }
          });
        }
      } else {
        // En Cancelaciones hay .order-items-rest (solo ese bloque se muestra/oculta); en otras pestañas se oculta todo
        const restEl = itemsEl.querySelector('.order-items-rest');
        if (restEl) {
          const isHidden = restEl.style.display === 'none';
          restEl.style.display = isHidden ? 'block' : 'none';
          btn.textContent = isHidden ? 'Ocultar productos' : 'Ver productos';
        } else {
          const isHidden = itemsEl.style.display === 'none';
          itemsEl.style.display = isHidden ? 'block' : 'none';
          btn.textContent = isHidden ? 'Ocultar productos' : 'Ver productos';
        }
      }
    });
  });

  document.querySelectorAll("[data-close-order]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.closeOrder;
      await closeOrder(orderId);
    });
  });

  document.querySelectorAll("[data-pick-all-reserved]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.pickAllReserved;
      await pickAllReservedItems(orderId);
    });
  });

  document.querySelectorAll("[data-pick-all-waiting]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.pickAllWaiting;
      await pickAllWaitingItems(orderId);
    });
  });

  document.querySelectorAll("[data-mark-sent]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.markSent;
      await markOrderAsSent(orderId);
    });
  });

  document.querySelectorAll("[data-edit-order]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.editOrder;
      
      // Esperar a que order-creator.js esté cargado
      let attempts = 0;
      while (!window.openEditOrderModal && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      
      if (window.openEditOrderModal) {
        window.openEditOrderModal(orderId);
      } else {
        alert("Error: No se pudo cargar el módulo de edición. Por favor, recarga la página.");
        console.error("❌ window.openEditOrderModal no está disponible después de esperar");
      }
    });
  });

  document.querySelectorAll("[data-send-to-local]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.sendToLocal;
      await sendOrderToLocal(orderId);
    });
  });

  document.querySelectorAll("[data-resolve-stock-pending]").forEach((btn) => {
    if (btn.dataset.resolveStockPendingBound === "1") return;
    btn.dataset.resolveStockPendingBound = "1";
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.resolveStockPending;
      await resolveStockPendingOrder(orderId);
    });
  });

  document.querySelectorAll("[data-enable-order]").forEach((btn) => {
    if (btn.dataset.enableBound === "1") return;
    btn.dataset.enableBound = "1";
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.enableOrder;
      if (!orderId || btn.disabled || btn.dataset.processing === "1") return;

      const confirmed = confirm(
        "¿Deseas habilitar este pedido por 24 horas? El cliente podrá volver a operarlo temporalmente."
      );
      if (!confirmed) return;

      if (!supabase) {
        supabase = await getSupabase();
      }
      if (!supabase) {
        alert("No se pudo habilitar el pedido. Recargá la página e intentá de nuevo.");
        return;
      }

      const originalText = btn.textContent;
      btn.disabled = true;
      btn.dataset.processing = "1";
      btn.textContent = "Habilitando...";
      try {
        const { data: currentOrderNotesRow, error: notesError } = await supabase
          .from("orders")
          .select("notes")
          .eq("id", orderId)
          .maybeSingle();
        if (notesError) {
          alert(notesError.message || "No se pudo leer el estado de habilitaciones del pedido.");
          return;
        }

        const currentUses = getEnable24hUsesFromOrder({ notes: currentOrderNotesRow?.notes || "" });
        const nextNotes = applyOrderNotesPatch(currentOrderNotesRow?.notes || "", {
          [ADMIN_ENABLE_24H_USES_KEY]: currentUses + 1,
        });
        if (nextNotes === null) {
          alert("No se pudo registrar la habilitación porque notes del pedido no es JSON válido.");
          return;
        }

        const newDismantleAtIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const { error } = await supabase
          .from("orders")
          .update({
            dismantle_at: newDismantleAtIso,
            notes: nextNotes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", orderId);

        if (error) {
          alert(error.message || "No se pudo habilitar el pedido por 24 horas.");
          return;
        }

        await loadOrders(true);
        updateActiveOrdersBadge();
        updatePickedOrdersBadge();
        updateClosedOrdersBadge();
        updateCancelledOrdersBadge();
        if (historyVisible) await loadClosedOrders();
        if (typeof loadBadgeCountsInBackground === "function") loadBadgeCountsInBackground();

        alert("✅ Pedido habilitado por 24 horas.");
      } finally {
        btn.dataset.processing = "0";
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  document.querySelectorAll("[data-dismantle-order]").forEach((btn) => {
    if (btn.dataset.dismantleBound === "1") return;
    btn.dataset.dismantleBound = "1";
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.dismantleOrder;
      if (!orderId || btn.disabled || btn.dataset.processing === "1") return;

      const originalText = btn.textContent;
      btn.disabled = true;
      btn.dataset.processing = "1";
      btn.textContent = "Desarmando...";
      try {
        await cancelOrder(orderId);
      } finally {
        btn.dataset.processing = "0";
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  // Event listener para botón "Ver Detalle"
  document.querySelectorAll("[data-view-summary]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const orderId = btn.dataset.viewSummary;
      const order = orders.find(o => o.id === orderId);
      if (order) {
        showOrderSummaryModal(order);
      }
    });
  });

  // Event listener para cerrar modal de resumen
  const closeSummaryBtn = document.getElementById('close-summary-modal');
  if (closeSummaryBtn) {
    closeSummaryBtn.addEventListener("click", () => {
      const modal = document.getElementById('order-summary-modal');
      if (modal) {
        modal.classList.remove('active');
      }
    });
  }

  // Cerrar modal al hacer clic fuera del contenido
  const summaryModal = document.getElementById('order-summary-modal');
  if (summaryModal) {
    summaryModal.addEventListener("click", (e) => {
      if (e.target === summaryModal) {
        summaryModal.classList.remove('active');
      }
    });
  }

  setupHistoryControls();
}

// Función para eliminar un item faltante del pedido
async function removeMissingItem(itemId) {
  if (!itemId) return;
  
  const confirmRemove = confirm(
    "¿Está seguro que desea eliminar este producto faltante del pedido? El producto se eliminará permanentemente del pedido del cliente y el total se actualizará."
  );
  
  if (!confirmRemove) return;
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en removeMissingItem");
    alert("No se pudo eliminar el producto faltante. Por favor, recarga la página.");
    return;
  }
  
  if (!currentAdminUser) {
    console.error("❌ Usuario admin no disponible");
    return;
  }
  
  console.log(`🗑️ Eliminando item faltante ${itemId}`);
  
  // Obtener información del item para verificar que está marcado como missing
  const { data: itemData, error: itemError } = await supabase
    .from("order_items")
    .select("id, order_id, status, quantity, price_snapshot, variant_id")
    .eq("id", itemId)
    .maybeSingle();
  
  if (itemError || !itemData) {
    console.error("❌ Error obteniendo item:", itemError);
    alert("No se pudo encontrar el producto a eliminar.");
    return;
  }
  
  // Verificar que el item está marcado como faltante
  if (itemData.status !== "missing") {
    alert("Este producto no está marcado como faltante.");
    return;
  }
  
  const orderId = itemData.order_id;

  const { error: rpcError } = await supabase.rpc("rpc_remove_order_item_restore_stock", {
    p_order_item_id: itemId,
  });

  if (rpcError) {
    console.error("❌ Error eliminando item faltante (RPC):", rpcError);
    alert(rpcError.message || "No se pudo eliminar el producto faltante.");
    return;
  }

  console.log("✅ Item faltante eliminado correctamente", orderId ? `(pedido ${orderId})` : "");
  
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  await loadOrders();
  if (historyVisible) await loadClosedOrders();
  alert("✅ Producto faltante eliminado correctamente del pedido. El total ha sido actualizado.");
}

// Función para limpiar/eliminar un item cancelado del pedido
async function cleanupCancelledItem(itemId) {
  if (!canDeleteOrders) {
    alert("No tienes permiso para eliminar items de pedidos.");
    return;
  }
  
  if (!itemId) return;
  
  const confirmCleanup = confirm(
    "¿Está seguro que desea eliminar este producto cancelado del pedido? El producto se eliminará permanentemente y el pedido volverá a aparecer en las otras secciones si no tiene más cancelaciones."
  );
  
  if (!confirmCleanup) return;
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en cleanupCancelledItem");
    alert("No se pudo limpiar el producto cancelado. Por favor, recarga la página.");
    return;
  }
  
  if (!currentAdminUser) {
    console.error("❌ Usuario admin no disponible");
    return;
  }
  
  console.log(`🧹 Limpiando item cancelado ${itemId}`);
  
  // Primero, obtener información del item para obtener el order_id
  const { data: itemData, error: itemError } = await supabase
    .from("order_items")
    .select("id, order_id, status")
    .eq("id", itemId)
    .maybeSingle();
  
  if (itemError || !itemData) {
    console.error("❌ Error obteniendo item:", itemError);
    alert("No se pudo encontrar el producto a eliminar.");
    return;
  }
  
  // Verificar que el item está cancelado
  if (itemData.status !== "cancelled") {
    alert("Este producto no está cancelado.");
    return;
  }

  const { error: rpcError } = await supabase.rpc("rpc_remove_order_item_restore_stock", {
    p_order_item_id: itemId,
  });

  if (rpcError) {
    console.error("❌ Error limpiando item cancelado (RPC):", rpcError);
    alert(rpcError.message || "No se pudo eliminar el producto cancelado.");
    return;
  }

  console.log("✅ Item cancelado eliminado correctamente");
  
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  await loadOrders();
  if (historyVisible) await loadClosedOrders();
  alert("✅ Producto cancelado eliminado correctamente. Stock y total se actualizaron vía el flujo del servidor.");
}

function findOrderIdByItemId(itemId) {
  if (!itemId) return null;
  const id = String(itemId);
  for (const o of orders || []) {
    const items = o?.order_items || [];
    if (items.some((it) => String(it?.id) === id)) return o.id || null;
  }
  return null;
}

async function updateOrderItemStatus(itemId, status, opts = {}) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!itemId) return;
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en updateOrderItemStatus");
    return;
  }
  
  if (!currentAdminUser) {
    console.error("❌ Usuario admin no disponible");
    return;
  }
  
  console.log(`🔄 Actualizando item ${itemId} a status: ${status}`);
  
  // Usar la nueva función RPC que verifica si todos los items están apartados
  const { data, error } = await supabase.rpc("rpc_update_order_item_status", {
    p_item_id: itemId,
    p_status: status,
    p_checked_by: currentAdminUser.id,
  });

  if (error) {
    console.error("❌ Error actualizando ítem:", error);
    alert(error.message || "No se pudo actualizar el estado del producto.");
    return;
  }

  console.log("✅ Item actualizado correctamente. Respuesta:", data);
  
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  updateWaitingOrdersBadge();
  if (opts?.skipReload) return;

  if (isOrders2Page()) {
    const orderId = findOrderIdByItemId(itemId);
    if (orderId && typeof refreshOneOrder === "function") {
      await refreshOneOrder(orderId);
      return;
    }
  }

  await loadOrders();
  if (data && data.all_items_picked) console.log("✅ Todos los items del pedido están apartados");
  else console.log("ℹ️ El pedido aún tiene items que necesitan atención");
  if (historyVisible) await loadClosedOrders();
}

// --- Flujo aceptar parcial (pedidos creados por cliente desde dashboard, varias unidades del mismo producto) ---
function getPartialAcceptModalEl() {
  return document.getElementById("partial-accept-modal");
}

function openPartialAcceptModal(order, item) {
  if (!order || !item || item.quantity < 2) return;
  partialAcceptState = {
    order,
    item,
    step: 1,
    availableCount: null,
    waitingSet: new Set(),
  };
  const modal = getPartialAcceptModalEl();
  if (modal) {
    modal.classList.add("active");
    renderPartialAcceptStep();
  }
}

function closePartialAcceptModal() {
  partialAcceptState = null;
  const modal = getPartialAcceptModalEl();
  if (modal) modal.classList.remove("active");
}

function renderPartialAcceptStep() {
  const s = partialAcceptState;
  if (!s) return;
  const body = document.getElementById("partial-accept-body");
  const footer = document.getElementById("partial-accept-footer");
  const titleEl = document.getElementById("partial-accept-title");
  if (!body || !footer) return;

  const qty = s.item.quantity;
  const name = [s.item.product_name, s.item.color, s.item.size].filter(Boolean).join(" · ") || "Producto";

  if (s.step === 1) {
    titleEl.textContent = "Disponibilidad";
    body.innerHTML = `
      <p style="margin: 0 0 16px; color: #444;">¿Están disponibles las <strong>${qty}</strong> unidades de este producto?</p>
    `;
    footer.innerHTML = `
      <button type="button" class="btn" id="partial-accept-yes-all" style="background: #28a745; color: white;">Sí, todas</button>
      <button type="button" class="btn btn-secondary" id="partial-accept-no-less">No, hay menos</button>
    `;
    footer.querySelector("#partial-accept-yes-all").addEventListener("click", () => {
      if (isOrders2Page()) {
        orders2SetPendingStatus(s.order.id, s.item.id, "picked");
      } else {
        updateOrderItemStatus(s.item.id, "picked");
      }
      closePartialAcceptModal();
      if (!isOrders2Page()) {
        loadOrders();
        if (historyVisible) loadClosedOrders();
      }
    });
    footer.querySelector("#partial-accept-no-less").addEventListener("click", () => {
      partialAcceptState.step = 2;
      renderPartialAcceptStep();
    });
    return;
  }

  if (s.step === 2) {
    titleEl.textContent = "¿Cuántas hay disponibles?";
    const buttons = [];
    for (let i = 0; i <= qty; i++) {
      buttons.push(`<button type="button" class="btn partial-accept-qty-btn" data-qty="${i}" style="min-width: 44px;">${i}</button>`);
    }
    body.innerHTML = `
      <p style="margin: 0 0 12px; color: #444;">Unidades disponibles (0 = ninguna):</p>
      <div style="display: flex; flex-wrap: wrap; gap: 8px;">${buttons.join("")}</div>
    `;
    footer.innerHTML = "";
    body.querySelectorAll(".partial-accept-qty-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = parseInt(btn.dataset.qty, 10);
        partialAcceptState.availableCount = k;
        partialAcceptState.step = 3;
        partialAcceptState.waitingSet = new Set();
        renderPartialAcceptStep();
      });
    });
    return;
  }

  if (s.step === 3) {
    const k = partialAcceptState.availableCount;
    const nMissing = qty - k;
    titleEl.textContent = "Apartado y espera";
    const chips = [];
    for (let i = 1; i <= k; i++) {
      chips.push(`<button type="button" class="partial-accept-chip" data-index="${i}" style="padding: 8px 12px; border-radius: 8px; border: 1px solid #ddd; background: #f8f9fa; cursor: pointer; font-weight: 600;">${i}</button>`);
    }
    body.innerHTML = `
      <p style="margin: 0 0 8px; color: #444;">De las <strong>${k}</strong> disponibles, marcar en espera las que correspondan (click en el número):</p>
      <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;">${chips.join("")}</div>
      <p id="partial-accept-summary" style="margin: 0; font-size: 13px; color: #666;"></p>
    `;
    footer.innerHTML = `
      <button type="button" class="btn btn-secondary" id="partial-accept-cancel-step3">Cancelar</button>
      <button type="button" class="btn" id="partial-accept-apply" style="background: #28a745; color: white;">Aplicar</button>
    `;

    const updateSummary = () => {
      const nWaiting = partialAcceptState.waitingSet.size;
      const nPicked = k - nWaiting;
      const el = document.getElementById("partial-accept-summary");
      if (el) {
        el.textContent = `Apartados: ${nPicked} · En espera: ${nWaiting} · Sin stock: ${nMissing}`;
      }
    };

    body.querySelectorAll(".partial-accept-chip").forEach((chipBtn) => {
      chipBtn.addEventListener("click", () => {
        const idx = parseInt(chipBtn.dataset.index, 10);
        if (partialAcceptState.waitingSet.has(idx)) {
          partialAcceptState.waitingSet.delete(idx);
          chipBtn.style.background = "#f8f9fa";
          chipBtn.style.borderColor = "#ddd";
        } else {
          partialAcceptState.waitingSet.add(idx);
          chipBtn.style.background = "rgba(255, 152, 0, 0.2)";
          chipBtn.style.borderColor = "#ff9800";
        }
        updateSummary();
      });
    });

    footer.querySelector("#partial-accept-cancel-step3").addEventListener("click", closePartialAcceptModal);
    footer.querySelector("#partial-accept-apply").addEventListener("click", async () => {
      const nWaiting = partialAcceptState.waitingSet.size;
      const nPicked = k - nWaiting;
      if (isOrders2Page()) {
        orders2SetPendingSplit(s.order.id, s.item.id, { nPicked, nWaiting, nMissing });
      } else {
        await callRpcSplitOrderItemStatus(s.item.id, nPicked, nWaiting, nMissing);
      }
      closePartialAcceptModal();
      if (!isOrders2Page()) {
        loadOrders();
        if (historyVisible) loadClosedOrders();
      }
    });
    updateSummary();
  }
}

async function callRpcSplitOrderItemStatus(itemId, nPicked, nWaiting, nMissing) {
  if (!supabase) supabase = await getSupabase();
  if (!supabase || !currentAdminUser) {
    alert("No se pudo completar la operación.");
    return;
  }
  const { data, error } = await supabase.rpc("rpc_split_order_item_status", {
    p_item_id: itemId,
    p_n_picked: nPicked,
    p_n_waiting: nWaiting,
    p_n_missing: nMissing,
    p_checked_by: currentAdminUser.id,
  });
  if (error) {
    console.error("❌ Error rpc_split_order_item_status:", error);
    alert(error.message || "No se pudo actualizar el pedido.");
    return;
  }
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateWaitingOrdersBadge();
  if (data && data.all_items_picked) console.log("✅ Todos los items del pedido están apartados");
}

function setupPartialAcceptModal() {
  const modal = getPartialAcceptModalEl();
  if (!modal) return;
  document.getElementById("partial-accept-close")?.addEventListener("click", closePartialAcceptModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closePartialAcceptModal();
  });
}

// Función para apartar todos los productos reservados de un pedido
async function pickAllReservedItems(orderId) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!orderId) return;
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en pickAllReservedItems");
    alert("No se pudo apartar los productos. Por favor, recarga la página.");
    return;
  }
  
  if (!currentAdminUser) {
    console.error("❌ Usuario admin no disponible");
    return;
  }
  
  // Obtener referencia al botón para control de estado
  const button = document.querySelector(`[data-pick-all-reserved="${orderId}"]`);
  const originalButtonText = button?.textContent;
  const originalButtonBg = button?.style.background;
  
  try {
    // Obtener todos los items reservados del pedido
    const { data: orderItems, error: itemsError } = await supabase
      .from("order_items")
      .select("id, status")
      .eq("order_id", orderId)
      .eq("status", "reserved");
    
    if (itemsError) {
      console.error("❌ Error obteniendo items reservados:", itemsError);
      alert("No se pudieron obtener los productos reservados.");
      return;
    }
    
    if (!orderItems || orderItems.length === 0) {
      alert("No hay productos reservados para apartar.");
      return;
    }
    
    const confirmPick = confirm(
      `¿Está seguro que desea apartar todos los productos reservados? Se apartarán ${orderItems.length} producto(s).`
    );
    
    if (!confirmPick) return;
    
    // Mostrar overlay de carga sobre la tarjeta del pedido
    showOrderActionLoading(orderId);
    
    // Deshabilitar botón y mostrar indicador de carga
    if (button) {
      button.disabled = true;
      button.style.cursor = "not-allowed";
      button.style.background = "#6c757d";
      button.innerHTML = "⏳ Apartando...";
    }
    
    console.log(`🔄 Apartando ${orderItems.length} productos reservados del pedido ${orderId}`);

    const itemIds = orderItems.map(item => item.id);
    await callMarkOrderItemsPicked(supabase, itemIds, "pick_reserved");

    console.log(`✅ ${orderItems.length} productos apartados correctamente`);
    
    // Delay para asegurar propagación de cambios en BD (evita mezcla entre pestañas)
    // Esto previene que consultas posteriores obtengan datos en cache obsoletos
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Invalidar cache local para forzar datos frescos
    orders = [];
    allOrdersLoaded = false;
    
    // Recargar pedidos con datos frescos (true = reset paginación y forzar recarga)
    await loadOrders(true);
    updateActiveOrdersBadge();
    updatePickedOrdersBadge();
    updateClosedOrdersBadge();
    updateCancelledOrdersBadge();
    updateWaitingOrdersBadge();
    
    // Cargar conteos exactos en background después de operación masiva
    loadBadgeCountsInBackground();
    
    if (historyVisible) {
      await loadClosedOrders();
    }
    
    showToastNotification(
      `✅ ${orderItems.length} producto(s) apartado(s) correctamente.`,
      "success"
    );
    
  } catch (error) {
    console.error("❌ Error en pickAllReservedItems:", error);
    alert(`Error inesperado: ${error.message}`);
  } finally {
    // Ocultar overlay de carga
    hideOrderActionLoading(orderId);
    
    // Restaurar botón siempre, incluso si hay error
    if (button) {
      button.disabled = false;
      button.style.cursor = "pointer";
      button.style.background = originalButtonBg || "#28a745";
      button.textContent = originalButtonText || "✓ Apartar Todos los Reservados";
    }
  }
}

// Función para marcar todos los productos en espera como apartados
async function pickAllWaitingItems(orderId) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  if (!orderId) return;

  if (!supabase) supabase = await getSupabase();
  if (!supabase) {
    console.error("❌ Supabase no disponible en pickAllWaitingItems");
    alert("No se pudo apartar los productos. Por favor, recarga la página.");
    return;
  }
  if (!currentAdminUser) {
    console.error("❌ Usuario admin no disponible");
    return;
  }

  const button = document.querySelector(`[data-pick-all-waiting="${orderId}"]`);
  const originalButtonText = button?.textContent;
  const originalButtonBg = button?.style.background;

  try {
    const { data: orderItems, error: itemsError } = await supabase
      .from("order_items")
      .select("id, status")
      .eq("order_id", orderId)
      .eq("status", "waiting");

    if (itemsError) {
      console.error("❌ Error obteniendo items en espera:", itemsError);
      alert("No se pudieron obtener los productos en espera.");
      return;
    }
    if (!orderItems || orderItems.length === 0) {
      alert("No hay productos en espera para apartar.");
      return;
    }

    const confirmPick = confirm(
      `¿Marcar todos los productos como apartados? Se apartarán ${orderItems.length} producto(s).`
    );
    if (!confirmPick) return;

    showOrderActionLoading(orderId);
    if (button) {
      button.disabled = true;
      button.style.cursor = "not-allowed";
      button.style.background = "#6c757d";
      button.innerHTML = "⏳ Apartando...";
    }

    const itemIds = orderItems.map(item => item.id);
    await callMarkOrderItemsPicked(supabase, itemIds, "pick_waiting");

    await new Promise(resolve => setTimeout(resolve, 150));
    orders = [];
    allOrdersLoaded = false;
    await loadOrders(true);
    updateActiveOrdersBadge();
    updatePickedOrdersBadge();
    updateWaitingOrdersBadge();
    loadBadgeCountsInBackground();
    if (historyVisible) await loadClosedOrders();

    showToastNotification(
      `✅ ${orderItems.length} producto(s) apartado(s) correctamente.`,
      "success"
    );
  } catch (error) {
    console.error("❌ Error en pickAllWaitingItems:", error);
    alert(`Error inesperado: ${error.message}`);
  } finally {
    hideOrderActionLoading(orderId);
    if (button) {
      button.disabled = false;
      button.style.cursor = "pointer";
      button.style.background = originalButtonBg || "#28a745";
      button.textContent = originalButtonText || "✓ Enviar todos los productos como apartados";
    }
  }
}

// Función unificada: apartar todos los productos (reservados y en espera) del pedido
async function pickAllItems(orderId) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  if (!orderId) return;

  if (!supabase) supabase = await getSupabase();
  if (!supabase) {
    console.error("❌ Supabase no disponible en pickAllItems");
    alert("No se pudo apartar los productos. Por favor, recarga la página.");
    return;
  }
  if (!currentAdminUser) {
    console.error("❌ Usuario admin no disponible");
    return;
  }

  const button = document.querySelector(`[data-pick-all="${orderId}"]`);
  const originalButtonText = button?.textContent;
  const originalButtonBg = button?.style.background;

  try {
    const { data: orderItems, error: itemsError } = await supabase
      .from("order_items")
      .select("id, status")
      .eq("order_id", orderId)
      .in("status", ["waiting", "reserved"]);

    if (itemsError) {
      console.error("❌ Error obteniendo items:", itemsError);
      alert("No se pudieron obtener los productos.");
      return;
    }
    if (!orderItems || orderItems.length === 0) {
      alert("No hay productos para apartar (reservados o en espera).");
      return;
    }

    const confirmPick = confirm(
      `¿Apartar todos los productos? Se apartarán ${orderItems.length} producto(s).`
    );
    if (!confirmPick) return;

    showOrderActionLoading(orderId);
    if (button) {
      button.disabled = true;
      button.style.cursor = "not-allowed";
      button.style.background = "#6c757d";
      button.innerHTML = "⏳ Apartando...";
    }

    const itemIds = orderItems.map(item => item.id);
    await callMarkOrderItemsPicked(supabase, itemIds, "pick_all");

    await new Promise(resolve => setTimeout(resolve, 150));
    orders = [];
    allOrdersLoaded = false;
    await loadOrders(true);
    updateActiveOrdersBadge();
    updatePickedOrdersBadge();
    updateWaitingOrdersBadge();
    loadBadgeCountsInBackground();
    if (historyVisible) await loadClosedOrders();

    showToastNotification(
      `✅ ${orderItems.length} producto(s) apartado(s) correctamente.`,
      "success"
    );
  } catch (error) {
    console.error("❌ Error en pickAllItems:", error);
    alert(`Error inesperado: ${error.message}`);
  } finally {
    hideOrderActionLoading(orderId);
    if (button) {
      button.disabled = false;
      button.style.cursor = "pointer";
      button.style.background = originalButtonBg || "#28a745";
      button.textContent = originalButtonText || "✓ Apartar todos los productos";
    }
  }
}

// Variable para almacenar el orderId pendiente de cerrar
let pendingCloseOrderId = null;

// Función para cargar métodos de pago desde la base de datos
async function loadPaymentMethods() {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en loadPaymentMethods");
    return [];
  }

  try {
    const { data, error } = await supabase
      .from("payment_methods")
      .select("id, name")
      .order("name", { ascending: true });

    if (error) {
      console.error("❌ Error cargando métodos de pago:", error);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error("❌ Error al cargar métodos de pago:", err);
    return [];
  }
}

// Función para crear un nuevo método de pago
async function createPaymentMethod(name) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en createPaymentMethod");
    return null;
  }

  if (!name || name.trim() === "") {
    return null;
  }

  try {
    const { data, error } = await supabase
      .from("payment_methods")
      .insert({ name: name.trim() })
      .select()
      .single();

    if (error) {
      console.error("❌ Error creando método de pago:", error);
      return null;
    }

    return data;
  } catch (err) {
    console.error("❌ Error al crear método de pago:", err);
    return null;
  }
}

// Función para mostrar el modal de método de pago
async function showPaymentMethodModal(orderId) {
  pendingCloseOrderId = orderId;

  const modal = document.getElementById("payment-method-modal");
  const select = document.getElementById("payment-method-select");
  const createNewCheckbox = document.getElementById("create-new-payment-method");
  const newMethodContainer = document.getElementById("new-payment-method-container");
  const newMethodInput = document.getElementById("new-payment-method-input");
  const errorDiv = document.getElementById("payment-method-error");

  // Limpiar estado anterior
  select.innerHTML = '<option value="">-- Seleccione un método --</option>';
  createNewCheckbox.checked = false;
  newMethodContainer.style.display = "none";
  newMethodInput.value = "";
  errorDiv.style.display = "none";
  errorDiv.textContent = "";

  // Cargar métodos de pago
  const paymentMethods = await loadPaymentMethods();
  const seen = new Set();
  paymentMethods.forEach((method) => {
    const name = (method?.name || "").toString().trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });

  // Mostrar modal
  modal.style.display = "flex";
  modal.classList.add("active");
}

// Función para cerrar el modal de método de pago
function hidePaymentMethodModal() {
  const modal = document.getElementById("payment-method-modal");
  modal.style.display = "none";
  modal.classList.remove("active");
  pendingCloseOrderId = null;
}

// Función para confirmar el cierre del pedido con método de pago
async function confirmCloseOrderWithPayment() {
  const select = document.getElementById("payment-method-select");
  const createNewCheckbox = document.getElementById("create-new-payment-method");
  const newMethodInput = document.getElementById("new-payment-method-input");
  const errorDiv = document.getElementById("payment-method-error");

  errorDiv.style.display = "none";
  errorDiv.textContent = "";

  let paymentMethod = null;

  if (createNewCheckbox.checked) {
    // Crear nuevo método de pago
    const newMethodName = newMethodInput.value.trim();
    if (!newMethodName) {
      errorDiv.textContent = "Por favor, ingrese un nombre para el nuevo método de pago.";
      errorDiv.style.display = "block";
      return;
    }

    const newMethod = await createPaymentMethod(newMethodName);
    if (!newMethod) {
      errorDiv.textContent = "No se pudo crear el nuevo método de pago. Intente nuevamente.";
      errorDiv.style.display = "block";
      return;
    }

    paymentMethod = newMethod.name;
  } else {
    // Usar método existente
    paymentMethod = select.value;
    if (!paymentMethod) {
      errorDiv.textContent = "Por favor, seleccione un método de pago.";
      errorDiv.style.display = "block";
      return;
    }
  }

  // Guardar el orderId antes de cerrar el modal (que limpia pendingCloseOrderId)
  const orderIdToClose = pendingCloseOrderId;
  
  // Cerrar el modal
  hidePaymentMethodModal();

  // Proceder con el cierre del pedido
  if (orderIdToClose) {
    await closeOrderWithPayment(orderIdToClose, paymentMethod);
  } else {
    console.error("❌ No se encontró el ID del pedido para cerrar");
    alert("Error: No se pudo identificar el pedido a cerrar. Por favor, intente nuevamente.");
  }
}

// Función para cerrar el pedido con el método de pago seleccionado
async function closeOrderWithPayment(orderId, paymentMethod) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!orderId) return;
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en closeOrderWithPayment");
    alert("No se pudo cerrar el pedido. Por favor, recarga la página.");
    return;
  }

  // #region agent log - Comentado para evitar errores de conexión
  // fetch('http://127.0.0.1:7242/ingest/7a4b3bf8-ea8a-4f70-84cf-a37f8cbd48dc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orders.js:2510',message:'closeOrderWithPayment ENTRY',data:{orderId,paymentMethod},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
  // #endregion

  const { error } = await supabase.rpc("rpc_close_order", {
    p_order_id: orderId,
    p_payment_method: paymentMethod,
  });

  // #region agent log - Comentado para evitar errores de conexión
  // fetch('http://127.0.0.1:7242/ingest/7a4b3bf8-ea8a-4f70-84cf-a37f8cbd48dc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orders.js:2531',message:'rpc_close_order RESULT',data:{orderId,error:error?.message,errorCode:error?.code,errorDetails:error?.details},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
  // #endregion

  if (error) {
    console.error("❌ Error cerrando pedido:", error);
    alert("No se pudo cerrar el pedido.");
    return;
  }

  if (isOrders2Page() && typeof refreshOneOrder === "function") {
    await refreshOneOrder(orderId);
  } else {
    await loadOrders();
  }
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (historyVisible) {
    await loadClosedOrders();
  }
}

async function closeOrder(orderId) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!orderId) return;
  
  // Mostrar modal de método de pago en lugar de confirm
  await showPaymentMethodModal(orderId);
}

async function markOrderAsSent(orderId) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!orderId) return;
  const confirmSend = confirm(
    "¿Está seguro que desea marcar este pedido como TERMINADO? El pedido se moverá a Pedidos Enviados."
  );
  if (!confirmSend) return;

  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en markOrderAsSent");
    alert("No se pudo marcar el pedido como terminado. Por favor, recarga la página.");
    return;
  }

  console.log("🔄 Marcando pedido como terminado:", orderId);

  // #region agent log - Comentado para evitar errores de conexión
  // fetch('http://127.0.0.1:7242/ingest/7a4b3bf8-ea8a-4f70-84cf-a37f8cbd48dc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orders.js:2583',message:'Llamando rpc_mark_order_as_sent',data:{orderId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
  // #endregion

  const { error } = await supabase.rpc("rpc_mark_order_as_sent", {
    p_order_id: orderId,
  });

  // #region agent log - Comentado para evitar errores de conexión
  // fetch('http://127.0.0.1:7242/ingest/7a4b3bf8-ea8a-4f70-84cf-a37f8cbd48dc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'orders.js:2587',message:'rpc_mark_order_as_sent RESULT',data:{orderId,error:error?.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
  // #endregion

  if (error) {
    console.error("❌ Error marcando pedido como terminado:", error);
    alert(error.message || "No se pudo marcar el pedido como terminado.");
    return;
  }

  await clearOrderAdminClientSummary(orderId);

  // Limpiar notificaciones previas del pedido y emitir "empaquetado" (campana cliente)
  try {
    const customerId = await getOrderCustomerId(orderId);
    if (customerId) {
      await supabase.from("customer_notifications").delete().eq("customer_id", customerId).eq("order_id", orderId);
      await emitCustomerNotification({
        customerId,
        orderId,
        type: "ORDER_PACKAGED_TODAY",
        message: "Tu pedido ya fue empaquetado y se enviará hoy al transporte.",
        payload: { action_url: "client/dashboard.html?view=history" },
        dedupeTypes: ["ORDER_PACKAGED_TODAY"],
      });
    }
  } catch (e) {
    console.warn("⚠️ No se pudo emitir notificación al cliente:", e);
  }

  console.log("✅ Pedido marcado como terminado correctamente");

  if (isOrders2Page() && typeof refreshOneOrder === "function") {
    await refreshOneOrder(orderId);
  } else {
    await loadOrders();
  }
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (historyVisible) {
    await loadClosedOrders();
  }

  showToastNotification("Pedido marcado como terminado. Se ha movido a Pedidos Enviados.", "success");
}

// Función para enviar pedido al local
async function sendOrderToLocal(orderId) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!orderId) return;
  
  const confirmSend = confirm(
    "¿Está seguro que desea enviar este pedido al local? El cliente será copiado a los clientes del local y el pedido estará disponible en Venta al Público."
  );
  if (!confirmSend) return;

  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en sendOrderToLocal");
    alert("No se pudo enviar el pedido al local. Por favor, recarga la página.");
    return;
  }

  console.log("🔄 Enviando pedido al local:", orderId);

  // Llamar a la función RPC que copia cliente y crea pedido local
  const { data, error } = await supabase.rpc("rpc_send_order_to_local", {
    p_order_id: orderId,
  });

  if (error) {
    console.error("❌ Error enviando pedido al local:", error);
    alert(error.message || "No se pudo enviar el pedido al local.");
    return;
  }

  console.log("✅ Pedido enviado al local correctamente:", data);

  const already = data && data.already_exists === true;
  showToastNotification(
    already
      ? `Este pedido ya estaba en el local (n.º ${data.order_number || "N/A"}).`
      : `Pedido enviado al local correctamente. Número de pedido local: ${data.order_number || "N/A"}`,
    "success"
  );

  // Recargar pedidos para actualizar la vista
  await loadOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (historyVisible) {
    await loadClosedOrders();
  }
}

// Función para mostrar notificación toast
function showToastNotification(message, type = "success") {
  // Eliminar notificación anterior si existe
  const existingToast = document.querySelector(".toast-notification");
  if (existingToast) {
    existingToast.remove();
  }

  // Crear elemento de notificación
  const toast = document.createElement("div");
  toast.className = `toast-notification ${type}`;
  
  const icon = type === "success" ? "✅" : "❌";
  
  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-message">${message}</span>
  `;

  // Agregar al body
  document.body.appendChild(toast);

  // Remover después de 3 segundos con animación
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
      }
    }, 300);
  }, 3000);
}

async function loadClosedOrders() {
  const historyContainer = document.getElementById("orders-history");
  if (!historyContainer) return;
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en loadClosedOrders");
    return;
  }

  // Consulta sin join para pedidos cerrados (misma estrategia que loadOrders)
  const response = await supabase
    .from("orders")
    .select(
      `
        id,
        order_number,
        status,
        total_amount,
        created_at,
        transport_id,
        updated_at,
        customer_id,
        order_items (
          id,
          product_name,
          color,
          size,
          quantity,
          price_snapshot,
          status,
          imagen,
          variant_id,
          order_item_stock_sources ( qty, warehouse_id )
        )
      `
    )
    .eq("status", "closed")
    .order("updated_at", { ascending: false });
  
  let { data, error } = response;
  
  // Si hay datos, obtener información de customers por separado
  if (data && !error && data.length > 0) {
    const customerIds = [...new Set(data.map(order => order.customer_id).filter(Boolean))];
    
    console.log("🔍 Pedidos cerrados encontrados:", data.length);
    console.log("🔍 Customer IDs únicos (cerrados):", customerIds.length, customerIds);
    
    // Obtener información de customers (ahora incluye email y customer_number)
    const { data: customersData, error: customersError } = await supabase
      .from("customers")
      .select("id, customer_number, full_name, phone, city, province, dni, email, transport_id")
      .in("id", customerIds);
    
    if (customersError) {
      console.error("❌ Error obteniendo datos de customers (cerrados):", customersError);
    } else {
      console.log("✅ Customers obtenidos (cerrados):", customersData?.length || 0);
    }
    
    // Los emails ahora vienen directamente en customersData
    // Combinar datos de customers con orders
    const customersMap = new Map();
    if (customersData) {
      customersData.forEach(c => {
        customersMap.set(c.id, c);
      });
    }
    
    // Verificar qué customer_ids no tienen datos
    const missingCustomers = customerIds.filter(id => !customersMap.has(id));
    if (missingCustomers.length > 0) {
      console.warn("⚠️ Customer IDs sin datos en customers (cerrados):", missingCustomers);
    }
    
    // Mapear orders con customers (el email ya viene en customer)
    data = data.map(order => {
      const customer = customersMap.get(order.customer_id) || {};
      
      if (!customer.id && order.customer_id) {
        console.warn(`⚠️ Pedido cerrado ${order.id} tiene customer_id ${order.customer_id} pero no se encontró en customers`);
      }
      
      return {
        ...order,
        customers: customer
      };
    });
  }

  if (error) {
    console.error("❌ Error cargando pedidos anteriores:", error);
    historyContainer.innerHTML = `
      <div class="empty-orders">
        <p>No se pudo cargar el historial.</p>
      </div>
    `;
    return;
  }

  if (!data || data.length === 0) {
    historyContainer.innerHTML = `
      <p style="margin:0; font-size:14px; color:#666;">Todavía no tienes pedidos anteriores.</p>
    `;
    return;
  }

  historyContainer.innerHTML = `<div class="orders-list">${data
    .map((order) => renderOrderCard(order))
    .join("")}</div>`;

  document.querySelectorAll("[data-close-order]").forEach((btn) => {
    btn.remove();
  });
}

function formatCurrency(value) {
  const amount = Number(value) || 0;
  return `$${amount.toLocaleString("es-AR")}`;
}

// Legacy solo con decimales (ej. 16.5 → 16500). Enteros < 1000 son pesos reales; no multiplicar.
function normalizeOrderPrice(p) {
  const n = Number(p) || 0;
  if (n > 0 && n < 1000 && n % 1 !== 0) return n * 1000;
  return n;
}

// Suprimir errores de extensiones del navegador que aparecen periódicamente
// Estos errores no afectan la funcionalidad de la aplicación
(function() {
  const originalError = console.error;
  const originalWarn = console.warn;
  
  // Interceptar console.error para filtrar errores de extensiones
  console.error = function(...args) {
    const message = args.join(' ');
    // Filtrar errores conocidos de extensiones del navegador
    if (message.includes('runtime.lastError') || 
        message.includes('message port closed') ||
        message.includes('Extension context invalidated') ||
        message.includes('The message port closed before a response was received')) {
      // No mostrar estos errores en la consola
      return;
    }
    // Mostrar otros errores normalmente
    originalError.apply(console, args);
  };
  
  // Interceptar console.warn también por si acaso
  console.warn = function(...args) {
    const message = args.join(' ');
    if (message.includes('runtime.lastError') || 
        message.includes('message port closed') ||
        message.includes('Extension context invalidated')) {
      return;
    }
    originalWarn.apply(console, args);
  };
  
  // También capturar errores no manejados relacionados con extensiones
  window.addEventListener('error', (event) => {
    const message = event.message || '';
    if (message.includes('runtime.lastError') || 
        message.includes('message port closed') ||
        message.includes('Extension context invalidated')) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
  }, true);
})();

// Función para inicializar cuando el DOM y Supabase estén listos
async function initWhenReady() {
  // Esperar a que el DOM esté listo
  if (document.readyState === "loading") {
    await new Promise(resolve => {
      document.addEventListener("DOMContentLoaded", resolve);
    });
  }
  
  setupOrders2ItemKebabMenu();
  setupOrders2PendingAcceptSystem();
  setupOrders2ClientSummaryCopy();
  setupOrders2MissingItemsModalSystem();
  
  // Esperar a que Supabase esté disponible
  supabase = await getSupabase();
  
  if (!supabase) {
    console.error("❌ No se pudo obtener Supabase");
    alert("Error: No se pudo conectar con Supabase. Por favor, recarga la página.");
    return;
  }
  
  await initOrders();
}

// Limpiar suscripción cuando se cierra la página
window.addEventListener("beforeunload", () => {
  if (realtimeSubscription && supabase) {
    supabase.removeChannel(realtimeSubscription);
  }
});

// Inicializar cuando esté listo
initWhenReady();

async function deleteOrderItemImmediate(itemId) {
  if (!canDeleteOrders) {
    alert("No tienes permiso para eliminar items de pedidos.");
    return;
  }
  
  if (!itemId) return;
  const confirmed = confirm("¿Eliminar este producto del pedido? Se ajustará el total y (si corresponde) el stock.");
  if (!confirmed) return;

  if (!supabase) supabase = await getSupabase();
  if (!supabase) {
    alert("No se pudo conectar con la base de datos.");
    return;
  }

  const { data: rpcData, error: rpcErr } = await supabase.rpc("rpc_remove_order_item_restore_stock", {
    p_order_item_id: itemId,
  });
  if (rpcErr) {
    console.error("❌ rpc_remove_order_item_restore_stock:", rpcErr);
    alert(rpcErr.message || "No se pudo eliminar el producto.");
    return;
  }
  if (!rpcData || rpcData.ok !== true) {
    alert("No se pudo eliminar el producto.");
    return;
  }

  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  await loadOrders();
  if (historyVisible) await loadClosedOrders();
  alert("✅ Producto eliminado del pedido.");
}

async function resolveStockPendingOrder(orderId) {
  if (!canDeleteOrders) {
    alert("No tienes permiso para resolver pedidos en stock pendiente.");
    return;
  }
  if (!orderId) return;
  if (!supabase) supabase = await getSupabase();
  if (!supabase) {
    alert("No se pudo conectar con la base de datos.");
    return;
  }

  const { data: orderRow, error: orderError } = await supabase
    .from("orders")
    .select("id, status, notes, order_items(id, variant_id, size, product_name, color, status)")
    .eq("id", orderId)
    .maybeSingle();

  if (orderError || !orderRow) {
    alert("No se pudo cargar el pedido en stock pendiente.");
    return;
  }
  if (String(orderRow.status || "").trim().toLowerCase() !== STATUS.STOCK_PENDING) {
    alert("Este pedido ya no está en stock pendiente.");
    if (typeof loadOrders === "function") await loadOrders(true);
    return;
  }

  const notesObj = parseOrderNotesObject(orderRow.notes);
  const reasonRaw = String(notesObj.stock_pending_reason || "").trim();
  const parsed = parseStockPendingReasonConflict(reasonRaw);
  if (!parsed?.variant_id) {
    alert("No se pudo identificar automáticamente el producto en conflicto. Cancelá el pedido manualmente.");
    return;
  }

  const targetItem = (orderRow.order_items || []).find((item) => {
    const sameVariant = String(item?.variant_id || "") === String(parsed.variant_id);
    const sameSize = normalizeSize(item?.size || "") === parsed.size;
    const itemStatus = String(item?.status || "").trim().toLowerCase();
    return sameVariant && sameSize && itemStatus !== "cancelled";
  });
  if (!targetItem?.id) {
    alert("No se encontró el ítem conflictivo para resolver esta orden.");
    return;
  }

  const itemLabel = [targetItem.product_name || "Producto", targetItem.color || "-", targetItem.size || "-"].join(" · ");
  const confirmed = confirm(
    `Se eliminará el ítem conflictivo:\n${itemLabel}\n\nDisponible: ${parsed.available} · Solicitado: ${parsed.requested}\n\n¿Continuar?`
  );
  if (!confirmed) return;

  const { data: removeData, error: removeError } = await supabase.rpc("rpc_remove_order_item_restore_stock", {
    p_order_item_id: targetItem.id,
  });
  if (removeError) {
    console.error("❌ resolveStockPendingOrder: error removiendo ítem conflictivo:", removeError);
    alert(removeError.message || "No se pudo eliminar el ítem conflictivo.");
    return;
  }
  if (removeData && removeData.ok === false) {
    alert("No se pudo resolver el conflicto de stock.");
    return;
  }

  const nextNotes = { ...notesObj };
  delete nextNotes.stock_pending_reason;
  delete nextNotes.stock_pending_at;
  delete nextNotes.stock_pending_source;
  const nextNotesRaw = JSON.stringify(nextNotes);

  const { error: updateError } = await supabase
    .from("orders")
    .update({
      status: "active",
      notes: nextNotesRaw === "{}" ? null : nextNotesRaw,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  if (updateError) {
    console.error("❌ resolveStockPendingOrder: error actualizando estado:", updateError);
    alert(updateError.message || "El ítem se eliminó, pero no se pudo actualizar el estado del pedido.");
    return;
  }

  await loadOrders(true);
  if (historyVisible) await loadClosedOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateWaitingOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (typeof loadBadgeCountsInBackground === "function") loadBadgeCountsInBackground();
  showToastNotification("Conflicto resuelto. El pedido volvió a Activos.", "success");
}

const cancelOrderInFlight = new Set();

// Función para cancelar un pedido completo
async function cancelOrder(orderId) {
  if (!canDeleteOrders) {
    alert("No tienes permiso para cancelar pedidos.");
    return;
  }
  
  if (!orderId) return;
  if (cancelOrderInFlight.has(orderId)) return;
  
  const confirmed = confirm("¿Cancelar este pedido? Si tiene productos reservados, el stock volverá al almacén general.");
  if (!confirmed) return;

  if (!supabase) supabase = await getSupabase();
  if (!supabase) {
    alert("No se pudo conectar con la base de datos.");
    return;
  }

  cancelOrderInFlight.add(orderId);
  try {
    // Consulta previa "best effort" solo para enriquecer UI / notificación.
    // No bloquea el flujo: si no existe o falla, seguimos con la RPC.
    let prefetchedOrder = null;
    try {
      const { data: orderData } = await supabase
        .from("orders")
        .select("id, order_number, status, customer_id, created_at, dismantle_at")
        .eq("id", orderId)
        .maybeSingle();
      prefetchedOrder = orderData || null;
    } catch (prefetchErr) {
      console.warn("⚠️ No se pudo pre-cargar la orden (se continúa con la RPC):", prefetchErr);
    }

    const shouldNotifyDismantledByTimeout =
      prefetchedOrder ? isExpiredPendingAdminDisassembly(prefetchedOrder) : false;

    const { data: cancelData, error: cancelError } = await supabase.rpc("rpc_cancel_order_full", {
      p_order_id: orderId
    });

    if (cancelError) {
      console.error("❌ Error en rpc_cancel_order_full:", cancelError);
      alert(cancelError.message || "No se pudo cancelar el pedido.");
      return;
    }

    if (!cancelData || cancelData.ok !== true) {
      alert("No se pudo cancelar el pedido.");
      return;
    }

    const wasIdempotentNoop = cancelData.idempotent_noop === true;

    // Notificación de desarme: solo si teníamos datos y correspondía por timeout.
    // Si el pedido ya no existía (noop), no podemos saberlo: se omite silenciosamente.
    if (!wasIdempotentNoop && shouldNotifyDismantledByTimeout && prefetchedOrder?.customer_id) {
      const notifyResult = await emitCustomerNotification({
        customerId: prefetchedOrder.customer_id,
        orderId: null,
        type: CUSTOMER_NOTIFICATION_ORDER_DISMANTLED_TIMEOUT,
        message:
          "Tu pedido llegó al tiempo límite y nuestro equipo lo desarmó para liberar stock. Si querés, podés armar uno nuevo cuando quieras.",
        payload: {
          action_url: "/index.html",
          order_number: prefetchedOrder.order_number || null,
        },
      });
      if (!notifyResult?.ok) {
        console.warn("⚠️ No se pudo guardar notificación de desarme para cliente:", notifyResult?.error || notifyResult);
      }
    }

    const displayOrderNumber = prefetchedOrder?.order_number || cancelData.order_number || orderId;
    if (wasIdempotentNoop) {
      console.log(`ℹ️ Pedido ${displayOrderNumber} ya estaba cancelado (idempotent_noop).`);
    } else {
      console.log(`✅ Pedido ${displayOrderNumber} cancelado correctamente vía RPC`);
    }

    await loadOrders(true);
    if (historyVisible) await loadClosedOrders();
    updateActiveOrdersBadge();
    updatePickedOrdersBadge();
    updateWaitingOrdersBadge();
    updateClosedOrdersBadge();
    updateCancelledOrdersBadge();

    const successMsg = wasIdempotentNoop
      ? "✅ El pedido ya estaba cancelado. Vista actualizada."
      : "✅ Pedido cancelado correctamente. Stock restaurado de forma segura.";
    showToastNotification(successMsg, "success");
  } finally {
    cancelOrderInFlight.delete(orderId);
  }
}
