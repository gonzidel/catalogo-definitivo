// Importar dinámicamente para asegurar que se cargue después
let supabase = null;

// Verificar permisos de pedidos
let canViewOrders = false;
let canEditOrders = false;
let canDeleteOrders = false;

async function checkOrdersPermissions() {
  try {
    const { checkPermission } = await import("./permissions-helper.js");
    canViewOrders = await checkPermission('orders', 'view');
    canEditOrders = await checkPermission('orders', 'edit');
    canDeleteOrders = await checkPermission('orders', 'delete');
    
    if (!canViewOrders) {
      alert("No tienes permiso para ver pedidos.");
      window.location.href = "./index.html";
      return;
    }
  } catch (error) {
    console.error("Error verificando permisos:", error);
    // Si hay error, permitir acceso (fallback)
    canViewOrders = true;
    canEditOrders = true;
  }
}

// Verificar permisos al cargar
checkOrdersPermissions();

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
  DEVOLUCION: "devolución",
  DEVOLUCION_ALT: "devolucion",
};

const WORKFLOW_STATUSES = ["active", "closed", "cancelled"];
const FINAL_STATUSES = ["sent", "devolución", "devolucion"];

const TAB_FILTER_MODE = {
  active: "client", // Activos se define por order_items (reserved/missing, no todos picked), no por orders.status; la BD no usa status='active'
  closed: "sql",
  cancelled: "items", // Pedidos con al menos un order_item cancelado (no orders.status)
  all: "sql",
  picked: "client",
  waiting: "client",
};

const ORDER_STATUS_LABELS = {
  active: "Activo",
  picked: "Apartado",
  closed: "Cerrado",
  sent: "Enviado",
  pending: "Pendiente",
  waiting: "Espera",
};

const ORDER_STATUS_CLASSES = {
  active: "status-active",
  picked: "status-picked",
  closed: "status-closed",
  sent: "status-sent",
  pending: "status-pending",
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

// Función auxiliar para verificar si un pedido tiene todos los items apartados
// waiting se trata como picked para verificación de completitud
// Regla: sin order_items o array vacío => NO "todos apartados" (return false)
function hasAllItemsPicked(order) {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  const items = order.order_items;
  const totalItems = items.length;
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const pickedItems = items.filter(item => {
    const st = norm(item.status);
    return st === "picked" || st === "waiting";
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
// (reserved o missing - no completamente apartados)
function hasItemsNeedingAttention(order) {
  if (!order.order_items || order.order_items.length === 0) {
    return false;
  }
  // Un pedido necesita atención si tiene items "reserved" o "missing"
  // Es decir, si NO todos los items están "picked" o "waiting"
  const hasNeedingAttention = order.order_items.some(item => 
    item.status === 'reserved' || item.status === 'missing'
  );
  
  // Log para depuración
  if (!hasNeedingAttention && order.order_items.length > 0) {
    const statuses = order.order_items.map(item => item.status);
    console.log(`🔍 Pedido ${order.order_number || order.id} - Status de items:`, statuses);
  }
  
  return hasNeedingAttention;
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

let currentFilter = "active";
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
// Map para rastrear qué pedidos están en modo "ver completo" vs "solo reservados" en pestaña Activos
// orderId -> true (ver completo) | false/undefined (solo reservados)
let orderViewMode = new Map();
let orderWaitingViewMode = new Map(); // Para rastrear si se muestra solo items en espera o todos en la pestaña "Espera"
// Cache de almacenes
let warehousesCache = { general: null, ventaPublico: null };

// Realtime delta: si true, solo insert/patch/remove por orderId; si false, comportamiento legacy (loadOrders en cada evento)
const REALTIME_DELTA_MODE = true;
const PICKING_NO_FULL_REFRESH = true; // En Modo Picking (Activos/Espera) evitar loadOrders(true) para no parpadear
const PICKING_MODE_ENABLED = true;
const PICKING_MODE_STORAGE_KEY = "ordersPickingMode";
const DEBUG_ORDERS = false;
const DEBUG_ACTIVE_FILTER = false; // true = logs por qué cada order se excluye en pestaña Activos
const ordersMap = new Map();
const pendingOrderIds = new Set();
let pendingTimer = null;
let lastHiddenAt = 0;
let realtimeStatus = "UNKNOWN";
let lastVisibilityRefresh = 0;
let ordersLoadSeq = 0;
let ordersLastAppliedSeq = 0;

// Estado del modal de aceptar parcial (solo pedidos del cliente con varias unidades del mismo producto)
let partialAcceptState = null;

function getPickingMode() {
  if (new URLSearchParams(location.search).has("noPicking")) return false;
  return PICKING_MODE_ENABLED && localStorage.getItem(PICKING_MODE_STORAGE_KEY) === "true";
}

function setPickingMode(on) {
  if (!PICKING_MODE_ENABLED) return;
  localStorage.setItem(PICKING_MODE_STORAGE_KEY, on ? "true" : "false");
  updatePickingModeVisibility();
}

function updatePickingModeVisibility() {
  const isPicking = getPickingMode();
  const isPickingTab = currentFilter === "active" || currentFilter === "waiting";

  document.body.classList.toggle("picking-mode", isPicking);
  document.body.classList.toggle("picking-mode-on-active-or-waiting", isPicking && isPickingTab);

  const btn = document.getElementById("picking-mode-toggle");
  if (btn) {
    btn.classList.toggle("active", isPicking);
    btn.textContent = isPicking ? "✅ Picking ON" : "📋 Modo Picking";
  }
}

function injectPickingModeCSS() {
  if (!PICKING_MODE_ENABLED || document.getElementById("picking-mode-css")) return;
  const style = document.createElement("style");
  style.id = "picking-mode-css";
  style.textContent = `/* ===== Picking Mode: desktop efficiency ===== */
body.picking-mode.picking-mode-on-active-or-waiting .orders-container {
  max-width: 1500px;
  margin: 0 auto;
  padding-left: 12px;
  padding-right: 12px;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .orders-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  align-items: start;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .order-card {
  height: fit-content;
  min-width: 0;
}
@media (max-width: 1099px) {
  body.picking-mode.picking-mode-on-active-or-waiting #orders-content .orders-list { grid-template-columns: 1fr; }
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .order-item {
  display: grid;
  grid-template-columns: 48px 1fr 150px;
  align-items: center;
  column-gap: 12px;
  padding: 6px 10px;
  margin: 4px 0;
  border-radius: 10px;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .order-item.order-item-processing {
  opacity: 0.7;
  pointer-events: none;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-thumb {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-main {
  min-width: 0;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.25;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-details {
  font-size: 12px;
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-status,
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-price,
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-main > div[style*="background"],
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-main > div[style*="display: flex"] {
  display: none !important;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  align-items: center;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-action-btn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  font-size: 18px;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-action-btn.picking-more {
  width: 32px;
  height: 32px;
  opacity: 0.85;
}
@media (max-width: 768px) {
  body.picking-mode.picking-mode-on-active-or-waiting #orders-content .order-item {
    grid-template-columns: 44px 1fr;
    grid-template-rows: auto auto;
    align-items: start;
  }
  body.picking-mode.picking-mode-on-active-or-waiting #orders-content .order-item .item-actions { grid-column: 1 / -1; justify-content: flex-end; }
  body.picking-mode.picking-mode-on-active-or-waiting #orders-content .order-item .item-thumb,
  body.picking-mode.picking-mode-on-active-or-waiting #orders-content .order-item .picking-thumb-placeholder { width: 44px; height: 44px; }
}
/* Picking: EXTRA especial badge */
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-thumb.extra-badge {
  width: 48px; height: 48px; border-radius: 8px; background: #e8e8e8; color: #555; display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; line-height: 1.2; text-align: center; border: 1px solid #ccc;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-thumb.extra-badge span { font-size: 8px; font-weight: 600; color: #777; }
/* Picking: botón lupa (zoom) */
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-thumb-btn {
  width: 48px; height: 48px; border-radius: 8px; background: #eee; border: 1px solid #ccc; cursor: pointer; font-size: 20px; padding: 0;
  display: flex; align-items: center; justify-content: center; transition: background .15s, border-color .15s;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-thumb-btn:hover { background: #e0e0e0; border-color: #999; }
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .item-thumb-btn:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
/* Picking: placeholder sin imagen (sin lupa) */
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .picking-thumb-placeholder {
  width: 48px; height: 48px; border-radius: 8px; background: #eee; display: flex; align-items: center; justify-content: center; font-size: 20px;
}
body.picking-mode.picking-mode-on-active-or-waiting #orders-content .order-item .picking-thumb-placeholder { width: 44px; height: 44px; font-size: 18px; }
.picking-show-image-btn {
  width: 100%; height: 100%; border: none; background: transparent; cursor: pointer; font-size: 20px; padding: 0; border-radius: 8px;
}
.picking-image-overlay {
  display: none; position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,.75); align-items: center; justify-content: center; padding: 20px;
}
.picking-image-overlay.active { display: flex; }
.picking-image-container { position: relative; max-width: 90vw; max-height: 90vh; }
.picking-image-close {
  position: absolute; top: -36px; right: 0; width: 32px; height: 32px; border: none; background: #fff; border-radius: 50%; cursor: pointer; font-size: 24px; line-height: 1; color: #333;
}
.picking-image-img { max-width: 100%; max-height: 85vh; display: block; border-radius: 8px; background: #111; }
}`;
  document.head.appendChild(style);
}

function applyPickingItemActionsMenu() {
  if (!getPickingMode() || (currentFilter !== "active" && currentFilter !== "waiting")) return;
  const scope = document.querySelector("#orders-content");
  if (!scope) return;
  scope.querySelectorAll(".order-item").forEach((orderItem) => {
    const actions = orderItem.querySelector(".item-actions");
    if (!actions) return;
    if (actions.querySelector(".picking-more")) return;

    const secondary = ["reserved", "delete-item"];
    actions.querySelectorAll("[data-item-action]").forEach((btn) => {
      if (secondary.includes(btn.dataset.itemAction)) btn.style.display = "none";
    });

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "item-action-btn neutral picking-more";
    moreBtn.textContent = "⋯";
    moreBtn.title = "Más acciones";

    const popover = document.createElement("div");
    popover.className = "picking-more-popover";
    popover.style.cssText = "display:none;position:absolute;right:0;top:100%;margin-top:4px;z-index:100;background:white;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);padding:4px 0;min-width:140px;";

    const optRestore = document.createElement("button");
    optRestore.type = "button";
    optRestore.className = "picking-more-opt";
    optRestore.textContent = "Restaurar ↺";
    optRestore.style.cssText = "display:block;width:100%;padding:8px 12px;border:none;background:none;text-align:left;cursor:pointer;font-size:13px;";
    const optDelete = document.createElement("button");
    optDelete.type = "button";
    optDelete.className = "picking-more-opt";
    optDelete.textContent = "Eliminar 🗑️";
    optDelete.style.cssText = "display:block;width:100%;padding:8px 12px;border:none;background:none;text-align:left;cursor:pointer;font-size:13px;";

    function closePopover() {
      popover.style.display = "none";
      document.removeEventListener("click", closeOnOutside);
    }
    function closeOnOutside(e) {
      if (!actions.contains(e.target)) closePopover();
    }

    optRestore.addEventListener("click", () => {
      const reservedBtn = actions.querySelector('[data-item-action="reserved"]');
      if (reservedBtn) reservedBtn.click();
      closePopover();
    });
    optDelete.addEventListener("click", () => {
      const delBtn = actions.querySelector('[data-item-action="delete-item"]');
      if (delBtn) delBtn.click();
      closePopover();
    });

    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (popover.style.display === "block") {
        closePopover();
      } else {
        popover.style.display = "block";
        setTimeout(() => document.addEventListener("click", closeOnOutside), 0);
      }
    });

    popover.appendChild(optRestore);
    popover.appendChild(optDelete);
    actions.style.position = "relative";
    actions.appendChild(moreBtn);
    actions.appendChild(popover);
  });
}

let softRefreshTimer = null;
let softRefreshOrderId = null;
const SOFT_REFRESH_DELAY_MS = 1500;

function scheduleSoftRefresh(orderId) {
  if (orderId) softRefreshOrderId = orderId;
  if (softRefreshTimer) return;
  softRefreshTimer = setTimeout(async () => {
    softRefreshTimer = null;
    const id = softRefreshOrderId;
    softRefreshOrderId = null;
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
  }, SOFT_REFRESH_DELAY_MS);
}

function applyPickingOptimisticItemRemoval(btn, action) {
  if (!btn || !getPickingMode() || (currentFilter !== "active" && currentFilter !== "waiting")) return;
  const itemEl = btn.closest(".order-item");
  const card = btn.closest(".order-card[data-order-id]");
  if (!itemEl || !card) return;
  const orderId = card.getAttribute("data-order-id");
  const itemsContainer = card.querySelector(".order-items");
  const headerRow = itemsContainer && itemsContainer.previousElementSibling;
  if (headerRow) {
    const textDiv = Array.from(headerRow.children).find((el) => el.textContent && el.textContent.includes("Productos separados"));
    if (textDiv) {
      const m = textDiv.textContent.match(/Productos separados:\s*(\d+)\/(\d+)/);
      if (m) {
        let picked = parseInt(m[1], 10);
        let total = parseInt(m[2], 10);
        if (action === "picked") {
          picked = Math.min(picked + 1, total);
        } else {
          total = Math.max(0, total - 1);
        }
        textDiv.textContent = `Productos separados: ${picked}/${total}`;
      }
    }
  }
  itemEl.remove();
  const remaining = card.querySelectorAll(".order-item");
  if (remaining.length === 0) card.remove();
  scheduleSoftRefresh(orderId);
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
    searchDebounce = setTimeout(async () => {
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
    
    // Verificar autenticación primero
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) {
      // Usuario no autenticado: redirigir a index.html para login
      window.location.href = "index.html";
      return;
    }
    
    // Usuario autenticado, verificar si es admin
    const isAdmin = await verifyAdminAuth();
    
    if (!isAdmin) {
      // Usuario autenticado pero no es admin: redirigir
      window.location.href = "index.html";
      return;
    }
    
    // Usuario es admin, continuar con la carga
    setupFilters();
    setupButtons();
    updatePickingModeVisibility();
    setupInfiniteScroll();
    
    // Mostrar loading inicial
    showLoading();
    
    // Cargar pedidos
    await loadOrders();
    
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
        if (PICKING_NO_FULL_REFRESH && getPickingMode() && (currentFilter === "active" || currentFilter === "waiting")) return;
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
  } catch (error) {
    console.error("❌ Error inicializando panel de pedidos:", error);
    window.location.href = "index.html";
  }
}

async function verifyAdminAuth() {
  try {
    // Asegurar que supabase esté disponible
    if (!supabase) {
      supabase = await getSupabase();
    }
    
    if (!supabase) {
      return false;
    }

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user) {
      return false;
    }

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
          variant_id
        ),
        customers:customer_id!left (
          id,
          customer_number,
          full_name,
          phone,
          city,
          province,
          dni,
          email
        )
      `,
      { count: 'exact' }
    );

  const filterMode = TAB_FILTER_MODE[currentFilter];
  let data = null;
  let error = null;
  let totalCount = 0;

  if (filterMode === "items" && currentFilter === "cancelled") {
    // Cancelaciones: pedidos con al menos un ítem cancelado (order_items.status = 'cancelled'), no orders.status
    const { data: cancelledRows, error: errIds } = await supabase
      .from("orders")
      .select("id, created_at, order_items!inner(status)")
      .eq("order_items.status", "cancelled")
      .order("created_at", { ascending: false });
    if (errIds) {
      error = errIds;
      data = [];
    } else {
      const seen = new Set();
      const idsOrdered = (cancelledRows || []).map((r) => r.id).filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      totalCount = idsOrdered.length;
      const pageIds = idsOrdered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
      if (pageIds.length === 0) {
        data = [];
      } else {
        const { data: pageOrders, error: errPage } = await supabase
          .from("orders")
          .select(`
            id, order_number, status, total_amount, created_at, updated_at, sent_at, customer_id, notes, source,
            order_items ( id, product_name, color, size, quantity, price_snapshot, status, imagen, variant_id ),
            customers:customer_id!left ( id, customer_number, full_name, phone, city, province, dni, email )
          `)
          .in("id", pageIds)
          .order("created_at", { ascending: false });
        if (errPage) {
          error = errPage;
          data = [];
        } else {
          const orderById = new Map((pageOrders || []).map((o) => [o.id, o]));
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
    } else if (filterMode === "client") {
      query = query.not("status", "in", '("sent","devolución","devolucion")');
    }

    query = query.order("created_at", { ascending: false }).range(currentPage * pageSize, (currentPage + 1) * pageSize - 1);
    const response = await query;
    data = response.data;
    error = response.error;
    totalCount = response.count || 0;
  }

  // Log temporal: respuesta de Supabase (antes del guard)
  console.log("[orders AUDIT] Supabase response", {
    currentFilter,
    filterMode,
    dataLength: data ? data.length : 0,
    totalCount,
    firstStatuses: (data && data.length) ? data.slice(0, 3).map((o) => o.status) : [],
  });

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

  if (error) {
    console.error("❌ Error cargando pedidos:", error);
    return;
  }

  if (seq !== ordersLoadSeq || filterAtStart !== currentFilter) {
    console.log("[orders AUDIT] guard DROPPED response", { seq, ordersLoadSeq, filterAtStart, currentFilter });
    if (DEBUG_ORDERS) console.log("[orders] loadOrders dropped", { seq, filterAtStart, currentFilter, reason: "stale or filter changed" });
    return;
  }
  ordersLastAppliedSeq = seq;
  if (DEBUG_ORDERS) console.log("[orders] loadOrders apply", { seq, currentFilter });

  // Log temporal: justo antes de asignar orders
  const ordersBefore = (data || []).length;
  console.log("[orders AUDIT] before assign orders", { currentFilter, dataLength: ordersBefore, resetPagination });

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
  // Log temporal: justo antes de displayOrders
  console.log("[orders AUDIT] before displayOrders", { currentFilter, ordersLength: (orders || []).length, orderStatuses: (orders || []).map((o) => o.status) });
  // Si es reset, reemplazar todo; si no, agregar al final
  await displayOrders(!resetPagination);
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
}

// Función para buscar pedidos directamente en la base de datos (sin límite)
async function searchOrdersInDatabase(searchTerm) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en searchOrdersInDatabase");
    return;
  }

  try {
    // Buscar clientes que coincidan con el término de búsqueda
    const { data: customersData, error: customersError } = await supabase
      .from("customers")
      .select("id")
      .or(`full_name.ilike.%${searchTerm}%,dni.ilike.%${searchTerm}%,phone.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%`);

    if (customersError) {
      console.error("❌ Error buscando clientes:", customersError);
    }

    const customerIds = customersData?.map(c => c.id) || [];

    // Buscar pedidos que tengan productos que coincidan con el término de búsqueda
    const { data: ordersWithProducts, error: ordersError } = await supabase
      .from("order_items")
      .select("order_id")
      .or(`product_name.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%`)
      .limit(1000); // Límite razonable para evitar consultas muy grandes

    const orderIdsFromProducts = ordersWithProducts ? [...new Set(ordersWithProducts.map(item => item.order_id))] : [];

    // Combinar todos los IDs de pedidos encontrados
    const allOrderIds = new Set();
    
    // Agregar IDs de pedidos encontrados por productos
    orderIdsFromProducts.forEach(id => allOrderIds.add(id));
    
    // Buscar pedidos por cliente y agregar sus IDs
    if (customerIds.length > 0) {
      const { data: ordersByCustomer, error: ordersByCustomerError } = await supabase
        .from("orders")
        .select("id")
        .in("customer_id", customerIds)
        .limit(1000);
      
      if (!ordersByCustomerError && ordersByCustomer) {
        ordersByCustomer.forEach(order => allOrderIds.add(order.id));
      }
    }
    
    // Buscar pedidos por order_number y agregar sus IDs
    const { data: ordersByNumber, error: ordersByNumberError } = await supabase
      .from("orders")
      .select("id")
      .ilike("order_number", `%${searchTerm}%`)
      .limit(1000);
    
    if (!ordersByNumberError && ordersByNumber) {
      ordersByNumber.forEach(order => allOrderIds.add(order.id));
    }
    
    // Si no se encontraron pedidos, retornar vacío
    if (allOrderIds.size === 0) {
      orders = [];
      await displayOrders();
      updateActiveOrdersBadge();
      updatePickedOrdersBadge();
      updateClosedOrdersBadge();
      return;
    }
    
    // Buscar todos los pedidos encontrados con sus datos completos
    const orderIdsArray = Array.from(allOrderIds);
    const query = supabase
      .from("orders")
      .select(
        `
          id,
          order_number,
          status,
          total_amount,
          created_at,
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
            variant_id
          )
        `
      )
      .in("id", orderIdsArray)
      .order("created_at", { ascending: false });

    const response = await query;
    let data = response.data;
    let error = response.error;

    // Si hay datos, obtener información completa de customers
    if (data && !error && data.length > 0) {
      const allCustomerIds = [...new Set(data.map(order => order.customer_id).filter(Boolean))];
      
      if (allCustomerIds.length > 0) {
        const { data: customersFullData, error: customersFullError } = await supabase
          .from("customers")
          .select("id, customer_number, full_name, phone, city, province, dni, email")
          .in("id", allCustomerIds);
        
        if (!customersFullError && customersFullData) {
          const customersMap = new Map();
          customersFullData.forEach(c => {
            customersMap.set(c.id, c);
          });
          
          data = data.map(order => {
            const customer = customersMap.get(order.customer_id) || {};
            return {
              ...order,
              customers: customer
            };
          });
        }
      }
    }

    if (error) {
      console.error("❌ Error buscando pedidos:", error);
      orders = [];
    } else {
      orders = data || [];
      // Resetear paginación cuando hay búsqueda
      currentPage = 0;
      hasMoreOrders = false;
      allOrdersLoaded = true;
    }

    await displayOrders();
    updateActiveOrdersBadge();
    updatePickedOrdersBadge();
    updateClosedOrdersBadge();
  } catch (error) {
    console.error("❌ Error en searchOrdersInDatabase:", error);
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

// Exponer funciones de actualización de badges globalmente (después de que estén definidas)
window.updateActiveOrdersBadge = updateActiveOrdersBadge;
window.updatePickedOrdersBadge = updatePickedOrdersBadge;
window.updateClosedOrdersBadge = updateClosedOrdersBadge;
window.updateCancelledOrdersBadge = updateCancelledOrdersBadge;
window.updateWaitingOrdersBadge = updateWaitingOrdersBadge;

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
    const { data: ordersForCounting } = await supabase
      .from("orders")
      .select("id, status, order_items(status)")
      .not("status", "in", "(closed,sent,devolución)");
    
    if (ordersForCounting) {
      // Contar activos: solo pedidos con al menos un ítem reservado o missing (misma lógica que pestaña Activos)
      const realActiveCount = ordersForCounting.filter(order => {
        if (!order.order_items || order.order_items.length === 0) return false;
        if (hasAllItemsPicked(order) && !hasWaitingItems(order)) return false;
        return hasReservedItems(order) || hasItemsNeedingAttention(order);
      }).length;
      
      // Contar apartados
      const realPickedCount = ordersForCounting.filter(order => {
        if (!order.order_items || order.order_items.length === 0) return false;
        const hasWaiting = order.order_items.some(i => i.status === 'waiting');
        if (hasWaiting) return false;
        const hasReserved = order.order_items.some(i => i.status === 'reserved');
        if (hasReserved) return false;
        const allPicked = order.order_items.every(i => i.status === 'picked' || i.status === 'waiting');
        return allPicked;
      }).length;
      
      // Contar en espera: pedidos con al menos un ítem en waiting
      const realWaitingCount = ordersForCounting.filter(order => {
        if (!order.order_items || order.order_items.length === 0) return false;
        return hasWaitingItems(order);
      }).length;
      
      // Actualizar badges con conteos reales
      updateBadgeWithCount('active-orders-badge', realActiveCount);
      updateBadgeWithCount('picked-orders-badge', realPickedCount);
      updateBadgeWithCount('waiting-orders-badge', realWaitingCount);
      
      console.log(`✅ Badges actualizados: Activos=${realActiveCount}, Apartados=${realPickedCount}, Espera=${realWaitingCount}`);
    }
    
    // Contar cerrados (consulta simple y rápida)
    const { count: closedCount } = await supabase
      .from("orders")
      .select("*", { count: 'exact', head: true })
      .eq("status", "closed");
    
    updateBadgeWithCount('closed-orders-badge', closedCount || 0);
    
    // Contar cancelados (pedidos con items cancelados)
    const { data: allOrders } = await supabase
      .from("orders")
      .select("id, order_items!inner(status)")
      .eq("order_items.status", "cancelled");
    
    const cancelledCount = allOrders ? new Set(allOrders.map(o => o.id)).size : 0;
    updateBadgeWithCount('cancelled-orders-badge', cancelledCount);
    
    // Marcar que los conteos totales ya se cargaron
    badgeCountsLoaded = true;
    
    console.log(`✅ Conteos exactos cargados: Cerrados=${closedCount}, Cancelados=${cancelledCount}`);
    
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
  pendingTimer = setTimeout(async () => {
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
  }, 250);
}

async function refreshOneOrder(orderId) {
  const t0 = performance.now();
  const full = await fetchOrderById(orderId);
  const t1 = performance.now();
  if (!full) return;

  const belongs = orderBelongsToCurrentTab(full);
  upsertOrder(full);
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
      id, order_number, status, total_amount, created_at, updated_at, sent_at, customer_id, notes, source,
      order_items (
        id, product_name, color, size, quantity, price_snapshot, status, imagen, variant_id
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
      .select("id, customer_number, full_name, name, email, phone, dni, city, province")
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
          if (PICKING_NO_FULL_REFRESH && getPickingMode() && (currentFilter === "active" || currentFilter === "waiting") && orderId && typeof refreshOneOrder === "function") {
            await refreshOneOrder(orderId);
          } else if (typeof loadOrders === "function") {
            await loadOrders();
          }
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
          if (PICKING_NO_FULL_REFRESH && getPickingMode() && (currentFilter === "active" || currentFilter === "waiting") && orderId && typeof refreshOneOrder === "function") {
            await refreshOneOrder(orderId);
          } else if (typeof loadOrders === "function") {
            await loadOrders();
          }
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

  // Log temporal: entrada a displayOrders
  console.log("[orders AUDIT] displayOrders entry", { currentFilter, ordersLength: (orders || []).length, append });

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
  console.log("[orders AUDIT] after filterOrders", { currentFilter, ordersLength: orders.length, filteredByTabLength: filteredByTab.length });

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
    // IMPORTANTE: Limpiar contenedor antes de renderizar
    container.innerHTML = '';
    
    // Crear contenedor de lista inmediatamente
    const ordersList = document.createElement('div');
    ordersList.className = 'orders-list';
    container.appendChild(ordersList);
    
    // Renderizar pedidos de forma progresiva (no bloquear esperando todos)
    // Esto permite que el usuario vea los pedidos tan pronto como estén listos
    // Renderizar en batches para mejor performance
    const batchSize = 5;
    for (let i = 0; i < sorted.length; i += batchSize) {
      const batch = sorted.slice(i, i + batchSize);
      const batchPromises = batch.map(async (order) => {
        try {
          const cardHtml = await renderOrderCard(order);
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
        // Attach handlers después de cada batch para que los botones funcionen inmediatamente
        attachOrderEventHandlers();
      }
    }
    
    // Ocultar loading después de renderizar todos los pedidos
    hideLoading();
  }
  
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  updateWaitingOrdersBadge();
  setupSortControls();
  setupSearchControls();
  applyPickingItemActionsMenu();
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
      .eq('active', true)
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
    
    // Si no se encontró stock por talle o no hay tamaño, consultar variant_warehouse_stock como fallback
    if (generalQty === 0 && ventaQty === 0) {
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
  // Determinar el estado del pedido basado en los items
  let displayStatus = order.status;
  let statusLabel = ORDER_STATUS_LABELS[displayStatus] || displayStatus || "Desconocido";
  let statusClass = ORDER_STATUS_CLASSES[displayStatus] || "status-active";
  
  // Si el pedido no está cerrado ni enviado, verificar el estado basado en los items
  if (order.status !== "closed" && order.status !== "sent") {
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
  
  // Normalizar customer (objeto o array; nunca null para evitar fallos en render)
  const customer = Array.isArray(order?.customers) ? (order.customers[0] ?? {}) : (order?.customers && typeof order.customers === 'object' ? order.customers : {});

  const customerEmail = (customer?.email || '').trim() || '—';
  const customerPhone = (customer?.phone || '').trim() || '—';
  const customerDni = (customer?.dni || '').trim() || '';
  const customerNumber = (customer?.customer_number || '').trim() || '';
  const customerCity = (customer?.city || '').trim() || '';
  const customerProvince = (customer?.province || '').trim() || '';
  
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
  
  const total =
    typeof order.total_amount === "number"
      ? order.total_amount
      : (order.order_items || []).reduce(
          (sum, item) => sum + (item.quantity || 0) * normalizeOrderPrice(item.price_snapshot || 0),
          0
        );

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
  const allItems = order.order_items || [];
  const cancelledItems = allItems.filter(item => item.status === 'cancelled');
  
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
      // En Activos solo se muestran productos en estado Reservado (y Falta); no "espera"
      activeItems = allItems.filter(item =>
        item.status === 'reserved' || item.status === 'missing'
      );
    }
  } else {
    // En otros filtros, mostrar todos excepto cancelados
    activeItems = allItems.filter(item => item.status !== 'cancelled');
  }
  
  // Mostrar advertencia si hay items cancelados (solo si no estamos en filtro de espera)
  const cancelledWarning = (currentFilter !== 'waiting' && cancelledItems.length > 0) ? `
    <div class="cancelled-warning">
      <span>⚠️</span>
      <span>${cancelledItems.length} producto(s) cancelado(s) por el cliente ${formatCustomerDisplayName(customer)}${customerNumber ? ` (Nº ${customerNumber})` : ''}</span>
    </div>
  ` : '';
  
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
  
  // Obtener información de depósitos para items reservados
  const warehouseInfoMap = new Map();
  if (activeItems.some(item => item.status === 'reserved')) {
    await Promise.all(activeItems
      .filter(item => item.status === 'reserved')
      .map(async (item) => {
        const warehouse = await getItemWarehouse(item);
        if (warehouse) {
          warehouseInfoMap.set(item.id, warehouse);
        }
      })
    );
  }
  
  // Renderizar items: primero cancelados, luego activos, luego valores extra
  // En pestaña Activos modo "solo reservados", no mostrar valores extra
  const showExtraValues = currentFilter !== 'waiting' && 
                         (currentFilter !== 'active' || orderViewMode.get(order.id) === true);
  
  let itemsHtml;
  if (currentFilter === 'cancelled') {
    // En Cancelaciones: solo productos cancelados visibles por defecto; el resto en bloque colapsable
    const restHtml = activeItems.map((item) => renderOrderItem(item, customer, offersData, warehouseInfoMap)).join("") +
      (showExtraValues ? extraValuesHtml : "");
    itemsHtml = cancelledWarning +
      cancelledItems.map((item) => renderOrderItem(item, customer, offersData, warehouseInfoMap)).join("") +
      (restHtml ? `<div class="order-items-rest" style="display:none;">${restHtml}</div>` : "");
  } else {
    itemsHtml = cancelledWarning +
      (currentFilter !== 'waiting' ? cancelledItems.map((item) => renderOrderItem(item, customer, offersData, warehouseInfoMap)).join("") : "") +
      activeItems.map((item) => renderOrderItem(item, customer, offersData, warehouseInfoMap)).join("") +
      (showExtraValues ? extraValuesHtml : "");
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
  
  if (order.status === "closed") {
    // Para pedidos cerrados, mostrar botón "TERMINADO" y "Editar"
    actionButtons = `
      <button class="btn" style="background: #17a2b8; color: white;" data-edit-order="${order.id}">✏️ Editar Pedido</button>
      <button class="btn" style="background: #28a745; color: white;" data-mark-sent="${order.id}">TERMINADO</button>
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
  } else if (currentFilter === 'cancelled') {
    // En Cancelaciones: solo se ven los productos cancelados; el resto se muestra al pulsar "Ver productos"
    itemsDisplay = 'block';
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
  
  return `
    <div class="order-card" data-order-id="${order.id}">
      <div class="order-header">
        <div class="order-id" style="display: flex; align-items: center; gap: 8px;">
          Pedido #${orderDisplayNumber}${createdLabel}${sentLabel}
          ${(displayStatus === 'active' || displayStatus === 'picked' || displayStatus === 'waiting') ? `
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
      <div class="customer-info">
        <div class="customer-name" style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            ${customerNumber ? `<span style="color: #CD844D; font-weight: 600; margin-right: 8px;">#${customerNumber}</span>` : ""}
            ${formatCustomerDisplayName(customer)}
          </div>
          ${displayStatus === "picked" ? `
            <button class="btn" style="background: #17a2b8; color: white; padding: 6px 12px; font-size: 13px;" data-view-summary="${order.id}">
              📄 Ver Detalle
            </button>
          ` : ''}
        </div>
        <div class="customer-details">
          ${customerDni ? `<span>🆔 DNI: ${customerDni}</span>` : ""}
          <span>📞 ${customerPhone}</span>
          <span>📧 ${customerEmail}</span>
          ${(customerCity || customerProvince) ? `<span>📍 ${[customerCity, customerProvince].filter(Boolean).join(" - ")}</span>` : ""}
        </div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin:8px 0 4px 0;">
        <button class="btn btn-outline" data-toggle-items="${order.id}">${toggleLabel}</button>
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
  const itemsHtml = allItems.map(item => {
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
        ${imageHtml}
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
  const info = ITEM_STATUS_INFO[item.status] || ITEM_STATUS_INFO.reserved;
  
  // Obtener información del depósito si el item está reservado
  const warehouse = item.status === 'reserved' ? warehouseInfoMap.get(item.id) : null;
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
  const isMissing = item.status === 'missing';
  const isWaiting = item.status === 'waiting';

  const pickingModeThumb = getPickingMode() && (currentFilter === "active" || currentFilter === "waiting");
  let imageHtml;
  if (pickingModeThumb) {
    if (isExtraSpecialItem(item)) {
      imageHtml = '<div class="item-thumb extra-badge">EXTRA<br><span>especial</span></div>';
    } else if (item.imagen && String(item.imagen).trim()) {
      const imgEsc = (item.imagen || "").replace(/"/g, "&quot;");
      imageHtml = `<button type="button" class="item-thumb item-thumb-btn" data-action="zoom" data-img="${imgEsc}" aria-label="Ver imagen en grande">🔍</button>`;
    } else {
      imageHtml = '<div class="item-thumb picking-thumb-placeholder"><span aria-hidden="true">🖼️</span></div>';
    }
  } else {
    imageHtml = item.imagen
      ? `<img src="${item.imagen}" alt="${item.product_name}" class="item-thumb" onerror="this.remove()" />`
      : "";
  }

  // Mostrar leyenda de oferta o promoción
  let offerPromoBadge = '';
  if (promoText) {
    offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #ff9800; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">${promoText}</div>`;
  } else if (offerInfo) {
    offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #e74c3c; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">🔥 Oferta</div>`;
  }

  // Si está cancelado, mostrar información del cliente que lo canceló
  const cancelledInfo = isCancelled ? `
    <div style="margin-top: 8px; padding: 8px; background: #fff3e0; border-radius: 6px; font-size: 12px; color: #e65100;">
      <strong>Cancelado por:</strong> ${customer.full_name || 'Cliente sin nombre'}${customer.customer_number ? ` (Nº ${customer.customer_number})` : ''}${customer.phone ? ` • Tel: ${customer.phone}` : ''}${customer.email ? ` • Email: ${customer.email}` : ''}
    </div>
  ` : '';

  // Si está cancelado, mostrar botón para aceptar y limpiar la cancelación
  // Si está faltante, mostrar botón para eliminar del pedido
  // Si está en espera, mostrar botón para confirmar (cambiar a picked)
  const actionButtons = isCancelled ? `
    <div class="item-actions">
      <button class="item-action-btn success" title="Aceptar cancelación y eliminar del pedido" data-item-id="${
        item.id
      }" data-item-action="cleanup-cancelled">✓</button>
    </div>
  ` : isMissing ? `
    <div class="item-actions">
      <button class="item-action-btn danger" title="Eliminar producto faltante del pedido" data-item-id="${
        item.id
      }" data-item-action="remove-missing">🗑️</button>
      <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${
        item.id
      }" data-item-action="reserved">↺</button>
    </div>
  ` : (isWaiting || item.status === 'reserved' || item.status === 'picked') ? `
    <div class="item-actions">
      <button class="item-action-btn success" title="Producto apartado" data-item-id="${
        item.id
      }" data-item-action="picked">✓</button>
      <button class="item-action-btn" title="Producto en espera" data-item-id="${
        item.id
      }" data-item-action="waiting" style="background: #ff9800; color: white;">⏳</button>
      <button class="item-action-btn danger" title="Producto faltante" data-item-id="${
        item.id
      }" data-item-action="missing">✕</button>
      <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${
        item.id
      }" data-item-action="reserved">↺</button>
      <button class="item-action-btn danger" title="Eliminar del pedido" data-item-id="${
        item.id
      }" data-item-action="delete-item">🗑️</button>
    </div>
  ` : `
    <div class="item-actions">
      <button class="item-action-btn success" title="Producto apartado" data-item-id="${
        item.id
      }" data-item-action="picked">✓</button>
      <button class="item-action-btn" title="Producto en espera" data-item-id="${
        item.id
      }" data-item-action="waiting" style="background: #ff9800; color: white;">⏳</button>
      <button class="item-action-btn danger" title="Producto faltante" data-item-id="${
        item.id
      }" data-item-action="missing">✕</button>
      <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${
        item.id
      }" data-item-action="reserved">↺</button>
      <button class="item-action-btn danger" title="Eliminar del pedido" data-item-id="${
        item.id
      }" data-item-action="delete-item">🗑️</button>
    </div>
  `;

  // Detectar si es móvil
  const isMobile = window.innerWidth <= 768;
  
  if (isMobile) {
    // Layout móvil: imagen a la izquierda, información a la derecha
    return `
      <div class="order-item ${isCancelled ? 'cancelled-item' : ''}">
        <div style="display: flex; gap: 10px; align-items: flex-start;">
          ${imageHtml}
          <div class="item-main" style="flex: 1; min-width: 0;">
            <div class="item-name" style="font-size: 15px; font-weight: 600; margin-bottom: 6px; line-height: 1.3;">${item.product_name}</div>
            <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px;">
              <div style="font-size: 19px; font-weight: 700; color: #333;">
                <span style="color: #666; font-size: 13px; font-weight: 500;">Color:</span> <strong style="font-size: 19px; font-weight: 700;">${item.color || "-"}</strong>
              </div>
              <div style="font-size: 19px; font-weight: 700; color: #333;">
                <span style="color: #666; font-size: 13px; font-weight: 500;">Talle:</span> <strong style="font-size: 19px; font-weight: 700;">${item.size || "-"}</strong>
              </div>
              <div style="font-size: 16px; font-weight: 700; color: #333; margin-top: 2px;">
                Cantidad: <strong style="font-size: 16px; font-weight: 700;">${item.quantity || 0}</strong>
              </div>
            </div>
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
          <div class="item-name">${item.product_name}</div>
          <div class="item-details">
            Color: <strong style="font-size: 15px; font-weight: 700;">${item.color || "-"}</strong> • Talle: <strong style="font-size: 15px; font-weight: 700;">${item.size || "-"}</strong> • Cantidad: <strong style="font-size: 15px; font-weight: 700;">${item.quantity || 0}</strong>
          </div>
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
      return hasWaitingItems(order);
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
      if (statusNorm === STATUS.CLOSED || statusNorm === STATUS.SENT || statusNorm === STATUS.DEVOLUCION || statusNorm === STATUS.DEVOLUCION_ALT) excludedBy = "order.status=" + (order.status ?? "null");
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
    return list.filter((order) => order.status === STATUS.CLOSED);
  }

  if (currentFilter === STATUS.CANCELLED) {
    // Mostrar pedidos que tienen al menos un item cancelado
    return list.filter((order) => {
      const hasCancelledItems = (order.order_items || []).some(item => item.status === 'cancelled');
      return hasCancelledItems;
    });
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
      updatePickingModeVisibility();
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

  // Modo Picking: inyectar CSS y botón (solo si está habilitado y no existe ya)
  if (PICKING_MODE_ENABLED) {
    injectPickingModeCSS();
    const headerBtnWrap = document.querySelector(".orders-header div");
    if (headerBtnWrap && !document.getElementById("picking-mode-toggle")) {
      headerBtnWrap.insertAdjacentHTML("beforeend", '<button type="button" id="picking-mode-toggle" class="btn" style="margin-left:8px;">📋 Modo Picking</button>');
      document.getElementById("picking-mode-toggle").addEventListener("click", () => setPickingMode(!getPickingMode()));
    }
  }

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

function setupPickingImageModal() {
  if (document.getElementById("image-zoom-modal")) return;
  const overlay = document.createElement("div");
  overlay.id = "image-zoom-modal";
  overlay.className = "picking-image-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Imagen del producto");
  overlay.innerHTML = '<div class="picking-image-container"><button type="button" class="picking-image-close" aria-label="Cerrar">×</button><img alt="Producto" class="picking-image-img" /></div>';
  document.body.appendChild(overlay);
  const img = overlay.querySelector(".picking-image-img");
  const close = () => {
    overlay.classList.remove("active");
    img.removeAttribute("src");
  };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".picking-image-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.classList.contains("active")) close(); });
  window.showPickingImageModal = function (src) {
    if (!src) return;
    img.src = src;
    overlay.classList.add("active");
  };
  document.body.addEventListener("click", (e) => {
    const zoomBtn = e.target.closest("[data-action=\"zoom\"]");
    const legacyBtn = e.target.closest(".picking-show-image-btn");
    const btn = zoomBtn || legacyBtn;
    if (!btn) return;
    e.preventDefault();
    const src = btn.getAttribute("data-img") || btn.getAttribute("data-img-src");
    if (src && typeof window.showPickingImageModal === "function") window.showPickingImageModal(src);
  });
}

function attachOrderEventHandlers() {
  if (!window._pickingImageModalSetup) {
    setupPickingImageModal();
    window._pickingImageModalSetup = true;
  }
  if (!window._partialAcceptModalSetup) {
    setupPartialAcceptModal();
    window._partialAcceptModalSetup = true;
  }
  document.querySelectorAll("[data-item-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.dataset.itemId;
      const status = btn.dataset.itemAction;
      const itemEl = btn.closest(".order-item");
      const isPicking = PICKING_NO_FULL_REFRESH && getPickingMode() && (currentFilter === "active" || currentFilter === "waiting");
      if (isPicking && itemEl) {
        itemEl.classList.add("order-item-processing");
        itemEl.querySelectorAll(".item-action-btn").forEach((b) => { b.disabled = true; });
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
            if (isPicking && itemEl) {
              itemEl.classList.remove("order-item-processing");
              itemEl.querySelectorAll(".item-action-btn").forEach((b) => { b.disabled = false; });
            }
            return;
          }
          await updateOrderItemStatus(itemId, status);
        } else {
          await updateOrderItemStatus(itemId, status);
        }
        if (getPickingMode() && (currentFilter === "active" || currentFilter === "waiting")) {
          applyPickingOptimisticItemRemoval(btn, status);
        }
      } catch (e) {
        if (e && e.message) console.error("Item action error:", e.message);
        if (isPicking && itemEl) {
          itemEl.classList.remove("order-item-processing");
          itemEl.querySelectorAll(".item-action-btn").forEach((b) => { b.disabled = false; });
        }
      }
    });
  });

  // Toggle de productos por pedido
  document.querySelectorAll('[data-toggle-items]').forEach((btn) => {
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

  if (typeof applyPickingItemActionsMenu === "function") {
    applyPickingItemActionsMenu();
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
  const itemPrice = normalizeOrderPrice(itemData.price_snapshot || 0);
  const itemQuantity = Number(itemData.quantity || 0);
  const itemTotal = itemPrice * itemQuantity;
  
  // Eliminar el item de la base de datos
  const { error: deleteError } = await supabase
    .from("order_items")
    .delete()
    .eq("id", itemId);
  
  if (deleteError) {
    console.error("❌ Error eliminando item faltante:", deleteError);
    alert("No se pudo eliminar el producto faltante.");
    return;
  }
  
  // Actualizar el total del pedido restando el precio del item eliminado
  if (orderId && itemTotal > 0) {
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .select("total_amount")
      .eq("id", orderId)
      .maybeSingle();
    
    if (!orderError && orderData) {
      const currentTotal = Number(orderData.total_amount || 0);
      const newTotal = Math.max(0, currentTotal - itemTotal);
      
      const { error: updateError } = await supabase
        .from("orders")
        .update({ 
          total_amount: newTotal,
          updated_at: new Date().toISOString()
        })
        .eq("id", orderId);
      
      if (updateError) {
        console.warn("⚠️ No se pudo actualizar el total del pedido:", updateError);
      }
    }
  }
  
  console.log("✅ Item faltante eliminado correctamente");
  
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (getPickingMode() && (currentFilter === "active" || currentFilter === "waiting")) return;

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
  
  // Obtener información completa del item (variant_id y size para devolver stock)
  const { data: fullItemData, error: fullItemError } = await supabase
    .from("order_items")
    .select("id, order_id, quantity, price_snapshot, variant_id, size")
    .eq("id", itemId)
    .maybeSingle();
  
  if (fullItemError || !fullItemData) {
    console.error("❌ Error obteniendo información completa del item:", fullItemError);
    alert("No se pudo obtener la información del producto.");
    return;
  }
  
  const orderId = fullItemData.order_id;
  const itemPrice = Number(fullItemData.price_snapshot || 0);
  const itemQuantity = Number(fullItemData.quantity || 0);
  const itemTotal = itemPrice * itemQuantity;
  
  // Devolver cantidad al stock general (el producto estaba apartado, se había descontado)
  const variantId = fullItemData.variant_id;
  const itemSize = fullItemData.size || null;
  if (variantId && itemSize) {
    try {
      await loadWarehouses();
      if (warehousesCache.general) {
        const normalizedItemSize = normalizeSize(itemSize);
        if (normalizedItemSize) {
          const { data: sizeStockData, error: sizeStockError } = await supabase
            .from("variant_size_warehouse_stock")
            .select("size, stock_qty")
            .eq("variant_id", variantId)
            .eq("warehouse_id", warehousesCache.general);
          let matchingStock = null;
          if (!sizeStockError && sizeStockData && sizeStockData.length > 0) {
            matchingStock = sizeStockData.find((sws) => {
              const swsNormalizedSize = normalizeSize(sws.size || "");
              return swsNormalizedSize === normalizedItemSize;
            });
          }
          const currentQty = matchingStock ? (matchingStock.stock_qty || 0) : 0;
          const newQty = currentQty + itemQuantity;
          const { error: updateSizeError } = await supabase
            .from("variant_size_warehouse_stock")
            .upsert({
              variant_id: variantId,
              size: normalizedItemSize,
              warehouse_id: warehousesCache.general,
              stock_qty: newQty
            }, { onConflict: "variant_id,size,warehouse_id" });
          if (updateSizeError) {
            console.warn("⚠️ Error devolviendo stock al general en cleanup cancelado:", updateSizeError);
          } else {
            console.log("✅ Stock devuelto al general:", variantId, normalizedItemSize, "+", itemQuantity);
          }
        }
      }
    } catch (e) {
      console.warn("⚠️ Error al devolver stock en cleanup cancelado:", e);
    }
  }
  
  // Eliminar el item de la base de datos
  const { error: deleteError } = await supabase
    .from("order_items")
    .delete()
    .eq("id", itemId);
  
  if (deleteError) {
    console.error("❌ Error eliminando item cancelado:", deleteError);
    alert("No se pudo eliminar el producto cancelado.");
    return;
  }
  
  // Actualizar el total del pedido restando el precio del item eliminado
  if (orderId && itemTotal > 0) {
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .select("total_amount")
      .eq("id", orderId)
      .maybeSingle();
    
    if (!orderError && orderData) {
      const currentTotal = Number(orderData.total_amount || 0);
      const newTotal = Math.max(0, currentTotal - itemTotal);
      
      const { error: updateError } = await supabase
        .from("orders")
        .update({ 
          total_amount: newTotal,
          updated_at: new Date().toISOString()
        })
        .eq("id", orderId);
      
      if (updateError) {
        console.warn("⚠️ No se pudo actualizar el total del pedido:", updateError);
      }
    }
  }
  
  console.log("✅ Item cancelado eliminado correctamente");
  
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (getPickingMode() && (currentFilter === "active" || currentFilter === "waiting")) return;

  await loadOrders();
  if (historyVisible) await loadClosedOrders();
  alert("✅ Producto cancelado eliminado correctamente. La cantidad se devolvió al stock general y el pedido fue actualizado.");
}

async function updateOrderItemStatus(itemId, status) {
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
  if (getPickingMode() && (currentFilter === "active" || currentFilter === "waiting")) return;

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
      updateOrderItemStatus(s.item.id, "picked");
      closePartialAcceptModal();
      loadOrders();
      if (historyVisible) loadClosedOrders();
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
      await callRpcSplitOrderItemStatus(s.item.id, nPicked, nWaiting, nMissing);
      closePartialAcceptModal();
      loadOrders();
      if (historyVisible) loadClosedOrders();
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
    
    // OPTIMIZACIÓN: Actualización masiva en una sola operación
    const itemIds = orderItems.map(item => item.id);
    const { error: updateError } = await supabase
      .from("order_items")
      .update({
        status: "picked",
        checked_by: currentAdminUser.id,
        checked_at: new Date().toISOString()
      })
      .in("id", itemIds);
    
    if (updateError) {
      console.error("❌ Error apartando productos:", updateError);
      alert(`Error: No se pudieron apartar los productos. ${updateError.message}`);
      return;
    }
    
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
    const { error: updateError } = await supabase
      .from("order_items")
      .update({
        status: "picked",
        checked_by: currentAdminUser.id,
        checked_at: new Date().toISOString()
      })
      .in("id", itemIds);

    if (updateError) {
      console.error("❌ Error apartando productos en espera:", updateError);
      alert(`Error: No se pudieron apartar los productos. ${updateError.message}`);
      return;
    }

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
    const { error: updateError } = await supabase
      .from("order_items")
      .update({
        status: "picked",
        checked_by: currentAdminUser.id,
        checked_at: new Date().toISOString()
      })
      .in("id", itemIds);

    if (updateError) {
      console.error("❌ Error apartando productos:", updateError);
      alert(`Error: No se pudieron apartar los productos. ${updateError.message}`);
      return;
    }

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
  paymentMethods.forEach((method) => {
    const option = document.createElement("option");
    option.value = method.name;
    option.textContent = method.name;
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

  await loadOrders();
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

  console.log("✅ Pedido marcado como terminado correctamente");

  await loadOrders();
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

  showToastNotification(
    `Pedido enviado al local correctamente. Número de pedido local: ${data.order_number || 'N/A'}`,
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
          variant_id
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
      .select("id, customer_number, full_name, phone, city, province, dni, email")
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

// Precios en "miles abreviados" (ej. 18 = $18.000): normalizar para cálculo y visual
function normalizeOrderPrice(p) {
  const n = Number(p) || 0;
  if (n > 0 && n < 1000) return n * 1000;
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

  // Obtener datos del item
  const { data: item, error: itemErr } = await supabase
    .from("order_items")
    .select("id, order_id, status, quantity, price_snapshot, variant_id, size")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr || !item) {
    alert("No se encontró el producto.");
    return;
  }

  const qty = Number(item.quantity || 0) || 0;
  const price = Number(item.price_snapshot || 0) || 0;
  const itemTotal = qty * price;

  // Ajuste de stock básico: si estaba 'picked' devolver al stock físico; si 'reserved', liberar reserva
  // Si estaba 'waiting', liberar reserva si existe (ya que los items en espera pueden tener stock reservado)
  if (item.variant_id) {
    try {
      const itemStatus = (item.status || '').toLowerCase();
      const itemSize = item.size || null;
      
      // Cargar almacenes si no están en cache
      await loadWarehouses();
      
      if (itemStatus === 'picked') {
        // Si el item tiene un talle específico, devolver stock a variant_size_warehouse_stock
        if (itemSize && warehousesCache.general && warehousesCache.ventaPublico) {
          const warehouseIds = [warehousesCache.general, warehousesCache.ventaPublico].filter(Boolean);
          
          // IMPORTANTE: Normalizar el tamaño antes de consultar
          const normalizedItemSize = normalizeSize(itemSize);
          if (!normalizedItemSize) return; // Saltar si el tamaño está vacío después de normalizar
          
          for (const warehouseId of warehouseIds) {
            // Obtener stock actual del talle en el almacén
            // IMPORTANTE: Cargar todos los registros y normalizar después para evitar problemas de comparación
            const { data: sizeStockData, error: sizeStockError } = await supabase
              .from("variant_size_warehouse_stock")
              .select("size, stock_qty")
              .eq("variant_id", item.variant_id)
              .eq("warehouse_id", warehouseId);
            
            // Filtrar por tamaño normalizado después de obtener los datos
            let matchingStock = null;
            if (!sizeStockError && sizeStockData && sizeStockData.length > 0) {
              matchingStock = sizeStockData.find(sws => {
                const swsNormalizedSize = normalizeSize(sws.size || "");
                return swsNormalizedSize === normalizedItemSize;
              });
            }
            
            if (matchingStock) {
              const currentQty = matchingStock.stock_qty || 0;
              const newQty = currentQty + qty;
              
              // Actualizar stock por talle usando el tamaño normalizado
              const { error: updateSizeError } = await supabase
                .from("variant_size_warehouse_stock")
                .upsert({
                  variant_id: item.variant_id,
                  size: normalizedItemSize, // Usar tamaño normalizado
                  warehouse_id: warehouseId,
                  stock_qty: newQty
                }, {
                  onConflict: 'variant_id,size,warehouse_id'
                });
              
              if (updateSizeError) {
                console.warn(`⚠️ Error devolviendo stock por talle para variant ${item.variant_id}, size ${normalizedItemSize}, warehouse ${warehouseId}:`, updateSizeError);
              }
            } else if (!sizeStockError) {
              // Si no existe el registro, crearlo usando el tamaño normalizado
              const { error: insertSizeError } = await supabase
                .from("variant_size_warehouse_stock")
                .insert({
                  variant_id: item.variant_id,
                  size: normalizedItemSize, // Usar tamaño normalizado
                  warehouse_id: warehouseId,
                  stock_qty: qty
                });
              
              if (insertSizeError) {
                console.warn(`⚠️ Error creando stock por talle para variant ${item.variant_id}, size ${normalizedItemSize}, warehouse ${warehouseId}:`, insertSizeError);
              }
            }
          }
        }
        // NOTA: Ya no actualizamos product_variants.stock_qty (código legacy eliminado)
      } else if (itemStatus === 'reserved' || itemStatus === 'waiting') {
        // Para 'reserved' y 'waiting', devolver el stock a variant_size_warehouse_stock
        // porque cuando se crea un pedido con status 'reserved', el stock se descuenta de variant_size_warehouse_stock
        if (itemSize && warehousesCache.general) {
          // IMPORTANTE: Normalizar el tamaño antes de consultar
          const normalizedItemSize = normalizeSize(itemSize);
          if (normalizedItemSize) {
            console.log(`🔄 Devolviendo stock para item 'reserved': variant ${item.variant_id}, size ${normalizedItemSize}, cantidad ${qty}`);
            
            // Obtener stock actual del talle en el almacén general
            const { data: sizeStockData, error: sizeStockError } = await supabase
              .from("variant_size_warehouse_stock")
              .select("size, stock_qty")
              .eq("variant_id", item.variant_id)
              .eq("warehouse_id", warehousesCache.general);
            
            // Filtrar por tamaño normalizado después de obtener los datos
            let matchingStock = null;
            if (!sizeStockError && sizeStockData && sizeStockData.length > 0) {
              matchingStock = sizeStockData.find(sws => {
                const swsNormalizedSize = normalizeSize(sws.size || "");
                return swsNormalizedSize === normalizedItemSize;
              });
            }
            
            let currentQty = 0;
            if (matchingStock) {
              currentQty = matchingStock.stock_qty || 0;
            } else {
              // Si no existe en variant_size_warehouse_stock, verificar variant_sizes como fallback
              const { data: variantSizeData } = await supabase
                .from("variant_sizes")
                .select("stock_qty")
                .eq("variant_id", item.variant_id)
                .eq("size", normalizedItemSize)
                .maybeSingle();
              
              if (variantSizeData) {
                currentQty = variantSizeData.stock_qty || 0;
                console.log(`🔵 Usando fallback desde variant_sizes: ${currentQty} unidades`);
              }
            }
            
            const newQty = currentQty + qty;
            console.log(`📦 Stock actual: ${currentQty}, Cantidad a devolver: ${qty}, Nuevo stock: ${newQty}`);
            
            // Actualizar o insertar el stock en variant_size_warehouse_stock
            const { error: updateSizeError } = await supabase
              .from("variant_size_warehouse_stock")
              .upsert({
                variant_id: item.variant_id,
                size: normalizedItemSize,
                warehouse_id: warehousesCache.general,
                stock_qty: newQty
              }, {
                onConflict: 'variant_id,size,warehouse_id'
              });
            
            if (updateSizeError) {
              console.warn(`⚠️ Error devolviendo stock por talle para variant ${item.variant_id}, size ${normalizedItemSize}:`, updateSizeError);
            } else {
              console.log(`✅ Stock devuelto correctamente: ${qty} unidades agregadas al almacén 'general' para variant ${item.variant_id}, talle ${normalizedItemSize}`);
              
              // Si se usó fallback (no había stock en variant_size_warehouse_stock), también actualizar variant_sizes
              if (!matchingStock) {
                const { data: variantSizeData } = await supabase
                  .from("variant_sizes")
                  .select("stock_qty")
                  .eq("variant_id", item.variant_id)
                  .eq("size", normalizedItemSize)
                  .maybeSingle();
                
                if (variantSizeData) {
                  const variantSizeCurrentQty = variantSizeData.stock_qty || 0;
                  const variantSizeNewQty = variantSizeCurrentQty + qty;
                  
                  const { error: variantSizeUpdateError } = await supabase
                    .from("variant_sizes")
                    .upsert({
                      variant_id: item.variant_id,
                      size: normalizedItemSize,
                      stock_qty: variantSizeNewQty
                    }, {
                      onConflict: 'variant_id,size'
                    });
                  
                  if (variantSizeUpdateError) {
                    console.warn(`⚠️ Error actualizando variant_sizes:`, variantSizeUpdateError);
                  } else {
                    console.log(`✅ variant_sizes actualizado: ${variantSizeCurrentQty} → ${variantSizeNewQty}`);
                  }
                }
              }
            }
          }
        }
        
        // También liberar la reserva en product_variants (por compatibilidad)
        const { data: varRow } = await supabase
          .from("product_variants")
          .select("reserved_qty")
          .eq("id", item.variant_id)
          .maybeSingle();
        if (varRow) {
          await supabase
            .from("product_variants")
            .update({ reserved_qty: Math.max(0, Number(varRow.reserved_qty || 0) - qty) })
            .eq("id", item.variant_id);
        }
      }
    } catch (e) {
      console.warn("⚠️ No se pudo ajustar stock del ítem eliminado:", e?.message || e);
    }
  }

  // Eliminar el item
  const { error: delErr } = await supabase.from("order_items").delete().eq("id", itemId);
  if (delErr) {
    alert("No se pudo eliminar el producto.");
    return;
  }

  // Actualizar total del pedido
  if (item.order_id && itemTotal > 0) {
    const { data: orderRow } = await supabase
      .from("orders")
      .select("total_amount")
      .eq("id", item.order_id)
      .maybeSingle();
    if (orderRow) {
      const newTotal = Math.max(0, Number(orderRow.total_amount || 0) - itemTotal);
      await supabase
        .from("orders")
        .update({ total_amount: newTotal, updated_at: new Date().toISOString() })
        .eq("id", item.order_id);
    }
  }

  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (getPickingMode() && (currentFilter === "active" || currentFilter === "waiting")) return;

  await loadOrders();
  if (historyVisible) await loadClosedOrders();
  alert("✅ Producto eliminado del pedido.");
}

// Función para cancelar un pedido completo
async function cancelOrder(orderId) {
  if (!canDeleteOrders) {
    alert("No tienes permiso para cancelar pedidos.");
    return;
  }
  
  if (!orderId) return;
  
  const confirmed = confirm("¿Cancelar este pedido? Si tiene productos reservados, el stock volverá al almacén general.");
  if (!confirmed) return;

  if (!supabase) supabase = await getSupabase();
  if (!supabase) {
    alert("No se pudo conectar con la base de datos.");
    return;
  }

  // Obtener el pedido completo con sus items
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select(`
      id,
      order_number,
      status,
      order_items (
        id,
        variant_id,
        size,
        quantity,
        status
      )
    `)
    .eq("id", orderId)
    .maybeSingle();
  
  if (orderErr || !order) {
    alert("No se encontró el pedido.");
    return;
  }

  // Verificar que el pedido pueda cancelarse (solo active, picked o waiting)
  if (order.status === 'closed' || order.status === 'sent') {
    alert("No se puede cancelar un pedido cerrado o enviado.");
    return;
  }

  // Cargar almacenes si no están en cache
  await loadWarehouses();
  
  if (!warehousesCache.general) {
    console.error("❌ No se pudo cargar el almacén 'general'");
    alert("Error: No se pudo encontrar el almacén 'general'. El pedido no se canceló.");
    return;
  }

  // Si el pedido tiene items, devolver el stock de los items que no llegaron a enviarse
  if (order.order_items && order.order_items.length > 0) {
    const itemsToReturnStock = order.order_items.filter(item => 
      item.status === 'reserved' || item.status === 'waiting' || item.status === 'picked'
    );
    
    console.log(`🔄 Cancelando pedido ${order.order_number || orderId}: ${itemsToReturnStock.length} items a devolver stock`);
    
    for (const item of itemsToReturnStock) {
      const qty = Number(item.quantity || 0) || 0;
      const itemSize = item.size || null;
      
      if (!item.variant_id || !itemSize || qty === 0) {
        console.warn(`⚠️ Item ${item.id} sin variant_id, size o cantidad válida, saltando...`);
        continue;
      }
      
      // Normalizar el tamaño
      const normalizedItemSize = normalizeSize(itemSize);
      if (!normalizedItemSize) {
        console.warn(`⚠️ Item ${item.id} sin tamaño normalizado válido, saltando...`);
        continue;
      }
      
      console.log(`🔄 Devolviendo stock para item '${item.status}': variant ${item.variant_id}, size ${normalizedItemSize}, cantidad ${qty}`);
      
      // Obtener stock actual del talle en el almacén general
      const { data: sizeStockData, error: sizeStockError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("size, stock_qty")
        .eq("variant_id", item.variant_id)
        .eq("warehouse_id", warehousesCache.general);
      
      // Filtrar por tamaño normalizado después de obtener los datos
      let matchingStock = null;
      if (!sizeStockError && sizeStockData && sizeStockData.length > 0) {
        matchingStock = sizeStockData.find(sws => {
          const swsNormalizedSize = normalizeSize(sws.size || "");
          return swsNormalizedSize === normalizedItemSize;
        });
      }
      
      let currentQty = 0;
      if (matchingStock) {
        currentQty = matchingStock.stock_qty || 0;
      } else {
        // Si no existe en variant_size_warehouse_stock, verificar variant_sizes como fallback
        const { data: variantSizeData } = await supabase
          .from("variant_sizes")
          .select("stock_qty")
          .eq("variant_id", item.variant_id)
          .eq("size", normalizedItemSize)
          .maybeSingle();
        
        if (variantSizeData) {
          currentQty = variantSizeData.stock_qty || 0;
          console.log(`🔵 Usando fallback desde variant_sizes: ${currentQty} unidades`);
        }
      }
      
      const newQty = currentQty + qty;
      console.log(`📦 Stock actual: ${currentQty}, Cantidad a devolver: ${qty}, Nuevo stock: ${newQty}`);
      
      // Actualizar o insertar el stock en variant_size_warehouse_stock
      const { error: updateSizeError } = await supabase
        .from("variant_size_warehouse_stock")
        .upsert({
          variant_id: item.variant_id,
          size: normalizedItemSize,
          warehouse_id: warehousesCache.general,
          stock_qty: newQty
        }, {
          onConflict: 'variant_id,size,warehouse_id'
        });
      
      if (updateSizeError) {
        console.warn(`⚠️ Error devolviendo stock por talle para variant ${item.variant_id}, size ${normalizedItemSize}:`, updateSizeError);
      } else {
        console.log(`✅ Stock devuelto correctamente: ${qty} unidades agregadas al almacén 'general' para variant ${item.variant_id}, talle ${normalizedItemSize}`);
        
        // Si se usó fallback (no había stock en variant_size_warehouse_stock), también actualizar variant_sizes
        if (!matchingStock) {
          const { data: variantSizeData } = await supabase
            .from("variant_sizes")
            .select("stock_qty")
            .eq("variant_id", item.variant_id)
            .eq("size", normalizedItemSize)
            .maybeSingle();
          
          if (variantSizeData) {
            const variantSizeCurrentQty = variantSizeData.stock_qty || 0;
            const variantSizeNewQty = variantSizeCurrentQty + qty;
            
            const { error: variantSizeUpdateError } = await supabase
              .from("variant_sizes")
              .upsert({
                variant_id: item.variant_id,
                size: normalizedItemSize,
                stock_qty: variantSizeNewQty
              }, {
                onConflict: 'variant_id,size'
              });
            
            if (variantSizeUpdateError) {
              console.warn(`⚠️ Error actualizando variant_sizes:`, variantSizeUpdateError);
            } else {
              console.log(`✅ variant_sizes actualizado: ${variantSizeCurrentQty} → ${variantSizeNewQty}`);
            }
          }
        }
      }
      
      // También liberar la reserva en product_variants (por compatibilidad)
      const { data: varRow } = await supabase
        .from("product_variants")
        .select("reserved_qty")
        .eq("id", item.variant_id)
        .maybeSingle();
      
      if (varRow && varRow.reserved_qty > 0) {
        const newReservedQty = Math.max(0, (varRow.reserved_qty || 0) - qty);
        await supabase
          .from("product_variants")
          .update({ reserved_qty: newReservedQty })
          .eq("id", item.variant_id);
      }
    }
  }

  // Eliminar el pedido (los items se eliminarán automáticamente por on delete cascade si existe)
  // Primero eliminar los items manualmente para asegurar que se eliminen correctamente
  if (order.order_items && order.order_items.length > 0) {
    const itemIds = order.order_items.map(item => item.id);
    const { error: deleteItemsError } = await supabase
      .from("order_items")
      .delete()
      .in("id", itemIds);
    
    if (deleteItemsError) {
      console.error("❌ Error eliminando items del pedido:", deleteItemsError);
      alert("Error al eliminar los items del pedido. El pedido no se canceló completamente.");
      return;
    }
  }
  
  // Eliminar el pedido
  const { error: deleteOrderError } = await supabase
    .from("orders")
    .delete()
    .eq("id", orderId);
  
  if (deleteOrderError) {
    console.error("❌ Error eliminando el pedido:", deleteOrderError);
    alert("Error al eliminar el pedido.");
    return;
  }
  
  console.log(`✅ Pedido ${order.order_number || orderId} cancelado correctamente`);
  
  // Actualizar UI
  const orderCard = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
  if (orderCard) {
    orderCard.remove();
  }
  
  // Actualizar badges
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateWaitingOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  
  // Mostrar notificación
  showToastNotification("✅ Pedido cancelado correctamente. El stock ha sido devuelto al almacén general.", "success");
}
