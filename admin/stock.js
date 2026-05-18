// admin/stock.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { can, preloadAuthState } from "./auth-state.js";
import { normalizeSize, compareCatalogSizes } from "../scripts/utils/size-normalizer.js?v=m260420";
import { printProductLabelsZebra } from "./qz-printing.js";
import { wrapSupabase, createAbortScope, FYL_ERROR_KIND, classifyError } from "../scripts/net/fyl-fetch.js";

// Verificar permisos de stock
// Default permisivo durante boot para que el buscador funcione si la verificación
// se retrasa en móviles. Luego se ajusta cuando termina applyStockPermissions().
// auth-state: 1× preloadAuthState = sesión (local) + 1 carga bulk de permisos; can() es O(1).
let canViewStock = true;
let canEditStock = true;
let canDeleteStock = false;

async function applyStockPermissions() {
  try {
    await preloadAuthState();
    canViewStock   = can("stock", "view");
    canEditStock   = can("stock", "edit");
    canDeleteStock = can("stock", "delete");

    // Sin permiso de vista confirmado: redirect (igual que orders).
    if (canViewStock === false) {
      alert("No tienes permiso para ver el stock.");
      window.location.href = "./index.html";
      return;
    }
  } catch (permError) {
    console.warn("Error verificando permisos de stock; usando fallback permisivo:", permError);
    // RLS y backend protegen; no redirigir por fallo transitorio.
  }

  // Ocultar/mostrar elementos según permisos
  if (!canEditStock) {
    // Ocultar botones de guardar y editar
    const saveAllBtn = document.getElementById("save-all");
    const discardAllBtn = document.getElementById("discard-all");
    if (saveAllBtn) saveAllBtn.style.display = "none";
    if (discardAllBtn) discardAllBtn.style.display = "none";
    
    // Hacer inputs de solo lectura (esto se aplicará después del render)
    // La función applyPermissions se llamará después de cada render
  }
}

// Aplicar permisos a los inputs después del render
function applyPermissions() {
  if (!canEditStock) {
    // Aplicar a tabla (si existe)
    document.querySelectorAll("#tbl input[type='number'][data-field='stock_general']").forEach(input => {
      input.disabled = true;
      input.style.backgroundColor = "#f5f5f5";
    });
    document.querySelectorAll("#tbl input[type='number'][data-field='stock_venta_publico']").forEach(input => {
      input.disabled = true;
      input.style.backgroundColor = "#f5f5f5";
    });
    document.querySelectorAll("#tbl input[type='number'][data-field='price']").forEach(input => {
      input.disabled = true;
      input.style.backgroundColor = "#f5f5f5";
    });
    document.querySelectorAll("#tbl input[type='checkbox']").forEach(input => {
      input.disabled = true;
    });
    document.querySelectorAll("#tbl button[data-save]").forEach(btn => {
      btn.disabled = true;
    });
    
    // Aplicar a tarjetas
    document.querySelectorAll(".sizes-table input[type='number']").forEach(input => {
      input.disabled = true;
      input.style.backgroundColor = "#f5f5f5";
    });
    document.querySelectorAll(".sizes-table input[type='checkbox']").forEach(input => {
      input.disabled = true;
    });
    document.querySelectorAll(".sizes-table button[data-save]").forEach(btn => {
      btn.disabled = true;
    });
  }
}

// NOTA: no usamos top-level await aquí para evitar que una red lenta en móvil
// bloquee el registro de event listeners (buscador). La verificación se ejecuta
// dentro de bootstrapStockUi() más abajo, y hasta entonces canEditStock=true
// (permisivo) permite usar el buscador; aplyPermissions() luego ajusta la UI.

const tbody = document.querySelector("#tbl tbody");
const productsContainer = document.getElementById("products-container");
const noResults = document.getElementById("no-results");
const tbl = document.getElementById("tbl");

// Ocultar tabla por defecto, mostrar contenedor de productos
if (tbl) tbl.style.display = "none";
if (productsContainer) productsContainer.style.display = "grid";

if (!tbody && !productsContainer) {
  console.error("No se encontró el elemento #tbl tbody o #products-container en el DOM");
  document.body.innerHTML = "<div style='padding:20px;color:red;'>Error: No se encontró el contenedor de stock. Por favor, recarga la página.</div>";
  throw new Error("Elemento #tbl tbody o #products-container no encontrado");
}
const q = document.getElementById("q");
const reloadBtn = document.getElementById("reload");
const msg = document.getElementById("msg");
const fCategory = document.getElementById("f-category");
const fColor = document.getElementById("f-color");
const fSize = document.getElementById("f-size");
const fActive = document.getElementById("f-active");
const fSupplier = document.getElementById("f-supplier");
const fLow = document.getElementById("f-low");
const SUPPLIER_FILTER_NONE = "__none__";
const SUPPLIER_LOAD_LIMIT = 200;
const saveAllBtn = document.getElementById("save-all");
const discardAllBtn = document.getElementById("discard-all");
const pendingCount = document.getElementById("pending-count");
const lowAlertBtn = document.getElementById("low-alert");
const lowAlertCount = document.getElementById("low-alert-count");
const overlay = document.getElementById("overlay");
const closeOverlay = document.getElementById("close-overlay");
const lowListTbody = document.getElementById("low-list");
const lowSummary = document.getElementById("low-summary");
const oldBtn = document.getElementById("old-products");
const overlayOld = document.getElementById("overlay-old");
const closeOverlayOld = document.getElementById("close-overlay-old");
const oldListTbody = document.getElementById("old-list");
const oldSummary = document.getElementById("old-summary");
const oldCheckAll = document.getElementById("old-check-all");
const archiveSelectedBtn = document.getElementById("archive-selected");
const incompleteAlert = document.getElementById("incomplete-alert");
const incompleteCount = document.getElementById("incomplete-count");
const productNamesDatalist = document.getElementById("product-names");
const stockLoadingOverlay = document.getElementById("stock-loading-overlay");
const stockBuildVersionEl = document.getElementById("stock-build-version");
const mobileWizardOverlay = document.getElementById("mobile-stock-wizard-overlay");
const mobileWizardClose = document.getElementById("mobile-stock-close");
const mobileWizardSubtitle = document.getElementById("mobile-stock-wizard-subtitle");
const mobileWizardProductName = document.getElementById("mobile-stock-product-name");
const mobileStepWarehouse = document.getElementById("mobile-stock-step-warehouse");
const mobileStepMode = document.getElementById("mobile-stock-step-mode");
const mobileStepSize = document.getElementById("mobile-stock-step-size");
const mobileStepSummary = document.getElementById("mobile-stock-step-summary");
const mobileWarehouseButtons = Array.from(document.querySelectorAll("[data-mobile-warehouse]"));
const mobileModeButtons = Array.from(document.querySelectorAll("[data-mobile-mode]"));
const mobileModeTag = document.getElementById("mobile-stock-mode-tag");
const mobileModeTagSummary = document.getElementById("mobile-stock-mode-tag-summary");
const mobileStepCount = document.getElementById("mobile-stock-step-count");
const mobileSizeJump = document.getElementById("mobile-stock-size-jump");
const mobileSizeValue = document.getElementById("mobile-stock-size-value");
const mobileSizeMeta = document.getElementById("mobile-stock-size-meta");
const mobileQtyInput = document.getElementById("mobile-stock-qty-input");
const mobileMinusBtn = document.getElementById("mobile-stock-minus");
const mobilePlusBtn = document.getElementById("mobile-stock-plus");
const mobileBackBtn = document.getElementById("mobile-stock-back");
const mobileNextBtn = document.getElementById("mobile-stock-next");
const mobileSummaryList = document.getElementById("mobile-stock-summary-list");
const mobileSummaryBackBtn = document.getElementById("mobile-stock-summary-back");
const mobileSaveBtn = document.getElementById("mobile-stock-save");
const mobileLectorToggle = document.getElementById("mobile-stock-lector-toggle");
const mobileLectorCheckbox = document.getElementById("mobile-stock-lector-checkbox");
const mobileLectorPanel = document.getElementById("mobile-stock-lector-panel");
const mobileLectorInput = document.getElementById("mobile-stock-lector-input");
const mobileLectorReset = document.getElementById("mobile-stock-lector-reset");
const mobileLectorStatus = document.getElementById("mobile-stock-lector-status");
const mobileLectorGrid = document.getElementById("mobile-stock-lector-grid");
const mobileStockSizeBox = document.getElementById("mobile-stock-size-box");
const mobileStockQtyControls = document.getElementById("mobile-stock-qty-controls");
const mobileStockTotalCounter = document.getElementById("mobile-stock-total-counter");
const mobileStockTotalCounterValue = document.getElementById("mobile-stock-total-counter-value");

let allData = [];
const productMainImageUrls = new Map();
const STOCK_CLOUDINARY_CLOUD = "dnuedzuzm";
const pendingChanges = new Map(); // id -> { stock_general, stock_venta_publico, price, active }
const MIN_SEARCH_CHARS = 2;
let currentProductIds = [];
let dataLoaded = false;
let loadInProgress = false;
let renderTimeout = null;
let searchTimeout = null;
let activeSearchRequest = 0;
let isStockUiReady = true;
let stockLoadingWatchdog = null;
let mobileKeyboardViewportListenersBound = false;
const STOCK_BUILD_VERSION = "build-m270426";
const MOBILE_STOCK_BREAKPOINT = 767;
const AUTH_SLOW_NOTICE_MS = 8000;
const SEARCH_LOAD_TIMEOUT_MS = 15000;
const _stockUiActionInFlight = new Set();

function runStockTask(label, task) {
  return Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error(`[stock] ${label} failed:`, error);
      throw error;
    });
}

/**
 * AbortScope por búsqueda: se recrea en cada `runSearchByTerm`.
 * Abortar la anterior cancela sus requests en vuelo sin afectar la nueva.
 * La referencia vive en módulo; el scope anterior es GC-able.
 * Al hacer unload, se aborta la búsqueda activa para liberar recursos.
 */
let _stockSearchAbortScope = null;
window.addEventListener("beforeunload", () => {
  if (_stockSearchAbortScope) _stockSearchAbortScope.abort("unload");
}, { once: true });
const mobileWizardState = {
  open: false,
  productId: null,
  variantId: null,
  scope: "variant",
  rows: [],
  selectedField: null,
  mode: null,
  currentIndex: 0,
  values: new Map(),
  lectorActive: false,
};

let mobileLectorInputTimeout = null;
let mobileLectorLastFlashTimeout = null;
let mobileLectorScanQueue = [];
let mobileLectorIsProcessingQueue = false;
const MOBILE_LECTOR_MIN_DIGITS = 6;
const mobileLectorRowMap = new Map();
const mobileLectorSizeMap = new Map();
const mobileLectorVariantSizeMap = new Map();
const mobileLectorQrMap = new Map();
const mobileLectorCellMap = new Map();

function isCompleteMobileLectorCode(raw) {
  const code = String(raw ?? "").trim();
  return /^\d+$/.test(code) && code.length >= MOBILE_LECTOR_MIN_DIGITS;
}

function shouldAutoFocusMobileLectorInput() {
  const isCoarsePointer = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
  return !isCoarsePointer;
}

if (stockBuildVersionEl) {
  stockBuildVersionEl.textContent = STOCK_BUILD_VERSION;
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

async function requireAuthWithTimeout() {
  const defaultMessage = stockLoadHintMessage();
  const slowMessage = "Conexión lenta: validando sesión en segundo plano.";
  let slowNoticeTimer = setTimeout(() => {
    if (msg) msg.textContent = slowMessage;
  }, AUTH_SLOW_NOTICE_MS);

  try {
    // Validación real de auth (sin Promise.race para la notificación visual).
    await requireAuth();
  } catch (authError) {
    console.warn("Auth fallida. Continuando con fallback:", authError);
  } finally {
    if (slowNoticeTimer) {
      clearTimeout(slowNoticeTimer);
      slowNoticeTimer = null;
    }
    if (msg && msg.textContent === slowMessage) {
      msg.textContent = defaultMessage;
    }
  }
}

// Cargar nombres de productos para autocompletado
async function loadProductNames() {
  if (!productNamesDatalist) return;
  // Evitar precarga masiva de nombres: el stock ahora se consulta bajo demanda.
  productNamesDatalist.innerHTML = "";
}

// Cargar contador de productos incompletos (pending_stock con stock 0)
async function loadIncompleteCount() {
  if (!incompleteAlert || !incompleteCount) {
    console.warn("Elementos de alerta incompleta no encontrados");
    return;
  }
  
  // Obtener productos con status pending_stock
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id")
    .eq("status", "pending_stock");
  
  if (productsError) {
    console.error("Error cargando productos pending_stock:", productsError);
    return;
  }
  
  if (!products || products.length === 0) {
    incompleteCount.textContent = "0";
    incompleteAlert.style.display = "none";
    return;
  }
  
  // Obtener IDs de almacenes
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  if (warehousesError) {
    console.error("Error cargando almacenes:", warehousesError);
    return;
  }
  
  const warehouseMap = new Map();
  warehouses.forEach(w => warehouseMap.set(w.code, w.id));
  const generalWarehouseId = warehouseMap.get("general");
  const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  
  if (!generalWarehouseId || !ventaPublicoWarehouseId) {
    console.error("No se encontraron los almacenes necesarios");
    return;
  }
  
  // Obtener todas las variantes de estos productos
  const productIds = products.map(p => p.id);
  const { data: variants, error: variantsError } = await supabase
    .from("product_variants")
    .select("id, product_id")
    .in("product_id", productIds);
  
  if (variantsError) {
    console.error("Error cargando variantes:", variantsError);
    return;
  }
  
  if (!variants || variants.length === 0) {
    // Si no hay variantes, todos los productos tienen stock 0
    incompleteCount.textContent = String(products.length);
    incompleteAlert.style.display = products.length > 0 ? "block" : "none";
    return;
  }
  
  // Obtener stocks de todas las variantes
  // Dividir en lotes para evitar error 400 con arrays grandes
  const variantIds = variants.map(v => v.id);
  const batchSize = 100;
  const totalBatches = Math.ceil(variantIds.length / batchSize);
  let allStocks = [];
  
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startIndex = batchIndex * batchSize;
    const endIndex = Math.min(startIndex + batchSize, variantIds.length);
    const batchVariantIds = variantIds.slice(startIndex, endIndex);
    
    if (batchVariantIds.length === 0) continue;
    
    const { data: stocks, error: stocksError } = await supabase
      .from("variant_warehouse_stock")
      .select("variant_id, warehouse_id, stock_qty")
      .in("variant_id", batchVariantIds)
      .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
    
    if (stocksError) {
      console.error(`Error cargando stocks (lote ${batchIndex + 1}/${totalBatches}):`, stocksError);
      return;
    }
    
    if (stocks && stocks.length > 0) {
      allStocks.push(...stocks);
    }
  }
  
  // Crear mapa de stocks por variante y almacén
  const stockMap = new Map();
  allStocks.forEach(s => {
    const key = `${s.variant_id}_${s.warehouse_id}`;
    stockMap.set(key, s.stock_qty || 0);
  });
  
  // Calcular stock total por producto
  const productStockMap = new Map();
  variants.forEach(v => {
    const stockGeneralKey = `${v.id}_${generalWarehouseId}`;
    const stockVentaPublicoKey = `${v.id}_${ventaPublicoWarehouseId}`;
    const stockGeneral = stockMap.get(stockGeneralKey) || 0;
    const stockVentaPublico = stockMap.get(stockVentaPublicoKey) || 0;
    const stockTotal = stockGeneral + stockVentaPublico;
    
    const currentTotal = productStockMap.get(v.product_id) || 0;
    productStockMap.set(v.product_id, currentTotal + stockTotal);
  });
  
  // Contar productos con stock total = 0
  let count = 0;
  productIds.forEach(productId => {
    const totalStock = productStockMap.get(productId) || 0;
    if (totalStock === 0) {
      count++;
    }
  });
  
  incompleteCount.textContent = String(count);
  
  if (count > 0) {
    incompleteAlert.style.display = "block";
  } else {
    incompleteAlert.style.display = "none";
  }
}

function setPendingCount() {
  pendingCount.textContent = String(pendingChanges.size);
  saveAllBtn.disabled = pendingChanges.size === 0;
  discardAllBtn.disabled = pendingChanges.size === 0;
}

function computeLowStockGroups(threshold = 12) {
  // Agrupar por producto+color y sumar stock_total, considerando cambios pendientes si existen
  const map = new Map(); // key -> { productId, name, category, color, total, variants }
  for (const r of allData) {
    const key = `${r.products?.id ?? "?"}__${r.color ?? ""}`;
    const uniqueKey = r.rowId || `${r.id}_${r.size || 'null'}`;
    const change = pendingChanges.get(uniqueKey);
    // Calcular stock total considerando cambios pendientes
    let stock_total;
    if (change) {
      const stock_general = change.stock_general !== undefined ? change.stock_general : r.stock_general;
      const stock_venta_publico = change.stock_venta_publico !== undefined ? change.stock_venta_publico : r.stock_venta_publico;
      stock_total = (stock_general || 0) + (stock_venta_publico || 0);
    } else {
      stock_total = r.stock_total || 0;
    }
    const qty = Number(stock_total);
    const entry =
      map.get(key) ||
      {
        productId: r.products?.id,
        name: r.products?.name,
        category: r.products?.category,
        color: r.color,
        total: 0,
        variants: [],
      };
    entry.total += qty;
    entry.variants.push({ id: r.id, size: r.size, qty });
    map.set(key, entry);
  }
  return Array.from(map.values()).filter((g) => g.total < threshold);
}

function updateLowAlertBadge() {
  const groups = computeLowStockGroups();
  lowAlertCount.textContent = String(groups.length);
  lowAlertBtn.disabled = groups.length === 0;
}

// Función normalizeSize importada desde scripts/utils/size-normalizer.js (centralizada)

/**
 * Busca productos por nombre.
 * Fase 2: acepta `signal` para abort, usa `wrapSupabase` para clasificar errores.
 * Conserva el retry con término sanitizado (manejo específico de caracteres
 * especiales de teclados móviles que disparan 400 en PostgREST).
 * Lanza un error con `kind` si el fallo es de red/servidor, para que
 * `runSearchByTerm` lo maneje como banner en lugar de mostrar "sin resultados".
 */
async function searchProductsByName(term, { signal } = {}) {
  const normalizedTerm = String(term || "").trim();
  if (normalizedTerm.length < MIN_SEARCH_CHARS) return [];

  const runNameSearch = async (queryTerm) =>
    wrapSupabase(
      () => supabase
        .from("products")
        .select("id, name")
        .neq("status", "archived")
        .ilike("name", `%${queryTerm}%`)
        .order("name", { ascending: true })
        .limit(60),
      { signal, label: "stock.search.products" }
    );

  let res = await runNameSearch(normalizedTerm);
  if (res.aborted) return [];

  // Retry con término sanitizado: teclados móviles pueden insertar smart quotes
  // o símbolos Unicode que PostgREST rechaza con 400. Sólo aplicar si el error
  // no es de red (un error de red no mejora con un término distinto).
  if (res.error) {
    const kind = res.kind;
    if (kind !== FYL_ERROR_KIND.NETWORK && kind !== FYL_ERROR_KIND.SERVER) {
      const sanitizedTerm = normalizedTerm
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}\s\-_.]/gu, "")
        .trim();
      if (sanitizedTerm.length >= MIN_SEARCH_CHARS && sanitizedTerm !== normalizedTerm) {
        const retry = await runNameSearch(sanitizedTerm);
        if (retry.aborted) return [];
        res = retry;
      }
    }
  }

  if (res.error) {
    const kind = res.kind;
    if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
      // Lanzar para que runSearchByTerm muestre banner de red, no "sin resultados".
      throw Object.assign(new Error(res.error.message || "network"), { kind });
    }
    console.error("Error buscando productos por nombre:", res.error, "kind:", kind);
    msg.textContent = "Error en búsqueda. Intenta con menos caracteres especiales.";
    return [];
  }

  return (res.data || []).map((p) => p.id).filter(Boolean);
}

async function searchProductsBySupplier(supplierValue, { signal } = {}) {
  if (!supplierValue) return [];

  let query = supabase
    .from("products")
    .select("id, name")
    .neq("status", "archived")
    .order("name", { ascending: true })
    .limit(SUPPLIER_LOAD_LIMIT);

  if (supplierValue === SUPPLIER_FILTER_NONE) {
    query = query.is("supplier_id", null);
  } else {
    query = query.eq("supplier_id", supplierValue);
  }

  const res = await wrapSupabase(() => query, { signal, label: "stock.search.supplier" });
  if (res.aborted) return [];

  if (res.error) {
    const kind = res.kind;
    if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
      throw Object.assign(new Error(res.error.message || "network"), { kind });
    }
    console.error("Error buscando productos por proveedor:", res.error, "kind:", kind);
    msg.textContent = "Error al filtrar por proveedor.";
    return [];
  }

  return (res.data || []).map((p) => p.id).filter(Boolean);
}

async function resolveProductIdsForStockLoad({ signal } = {}) {
  const term = String(q?.value || "").trim();
  const supplier = fSupplier?.value || "";
  const hasTerm = term.length >= MIN_SEARCH_CHARS;
  const hasSupplier = Boolean(supplier);

  if (!hasTerm && !hasSupplier) {
    return { productIds: [], hasCriteria: false };
  }

  let idsByTerm = null;
  let idsBySupplier = null;

  if (hasTerm) idsByTerm = await searchProductsByName(term, { signal });
  if (hasSupplier) idsBySupplier = await searchProductsBySupplier(supplier, { signal });

  if (hasTerm && hasSupplier) {
    const supplierSet = new Set(idsBySupplier);
    return { productIds: idsByTerm.filter((id) => supplierSet.has(id)), hasCriteria: true };
  }
  if (hasTerm) return { productIds: idsByTerm, hasCriteria: true };
  return { productIds: idsBySupplier, hasCriteria: true };
}

function stockLoadHintMessage() {
  return `Escribe al menos ${MIN_SEARCH_CHARS} letras o elegí un proveedor para ver productos.`;
}

function fillSupplierSelectOptions(select, suppliers) {
  if (!select) return;
  const current = select.value;
  const base =
    select.id === "f-supplier"
      ? `<option value="">Proveedor: todos</option><option value="${SUPPLIER_FILTER_NONE}">Sin proveedor</option>`
      : `<option value="">Sin proveedor</option>`;
  select.innerHTML =
    base +
    suppliers
      .map((s) => `<option value="${s.id}">${String(s.name || s.code || s.id)}</option>`)
      .join("");
  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}

async function loadSuppliersForFilter() {
  try {
    const { data, error } = await supabase.from("suppliers").select("id, name, code").order("name");
    if (error) {
      console.warn("No se pudieron cargar proveedores para stock:", error.message);
      return;
    }
    const suppliers = Array.isArray(data) ? data : [];
    fillSupplierSelectOptions(fSupplier, suppliers);
    fillSupplierSelectOptions(document.getElementById("supplier-select"), suppliers);
  } catch (e) {
    console.warn("Error cargando proveedores para stock:", e);
  }
}

function isBadRequestError(error) {
  const message = String(error?.message || "").toLowerCase();
  const status = String(error?.status || "");
  return status === "400" || message.includes("bad request");
}

async function fetchVariantWarehouseStocksAdaptive(variantIds, warehouseIds) {
  const pendingBatches = [variantIds.filter(Boolean)];
  const collected = [];

  while (pendingBatches.length > 0) {
    const batch = pendingBatches.shift();
    if (!batch || batch.length === 0) continue;

    const { data, error } = await supabase
      .from("variant_warehouse_stock")
      .select("variant_id, warehouse_id, stock_qty")
      .in("variant_id", batch)
      .in("warehouse_id", warehouseIds);

    if (!error) {
      if (data && data.length > 0) collected.push(...data);
      continue;
    }

    // Algunos navegadores móviles fallan con querystrings largas.
    // Reintentamos dividiendo en lotes más chicos automáticamente.
    if (isBadRequestError(error) && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      pendingBatches.unshift(batch.slice(mid));
      pendingBatches.unshift(batch.slice(0, mid));
      continue;
    }

    return { data: null, error };
  }

  return { data: collected, error: null };
}

async function load(productIds = [], { signal } = {}) {
  const ids = Array.isArray(productIds) ? productIds.filter(Boolean) : [];
  if (ids.length === 0) {
    allData = [];
    pendingChanges.clear();
    setPendingCount();
    render();
    msg.textContent = stockLoadHintMessage();
    return true;
  }

  if (signal?.aborted) return false;

  msg.textContent = "Cargando...";
  tbody.innerHTML = "";
  allData = []; // Limpiar al inicio para que, si hay return anticipado, no queden datos viejos
  pendingChanges.clear();
  setPendingCount();

  // ── Query crítica 1: variantes de los productos buscados ─────────────────
  const variantsRes = await wrapSupabase(
    () => supabase
      .from("product_variants")
      .select("id, product_id, sku, color, price, active, products(id, name, category, status, created_at, handle, supplier_id)")
      .in("product_id", ids)
      .order("sku", { ascending: true }),
    { retries: 1, signal, label: "stock.load.variants" }
  );
  if (signal?.aborted || variantsRes.aborted) return false;
  if (variantsRes.error) {
    const kind = variantsRes.kind;
    if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
      // Propagar para que runSearchByTerm muestre banner de red.
      throw Object.assign(new Error(variantsRes.error.message || "network"), { kind });
    }
    msg.textContent = variantsRes.error.message;
    console.error("Error cargando variantes:", variantsRes.error, "kind:", kind);
    return false;
  }
  const variants = variantsRes.data;
  
  console.log(`📦 Total variantes cargadas: ${(variants || []).length}`);
  
  // Filtrar productos: mostrar todos excepto archivados
  const validVariants = (variants || []).filter((r) => {
    const status = r.products?.status;
    const isValid = status && status !== "archived";
    if (!isValid && r.products) {
      console.log(`⚠️ Variante excluida - Producto status: ${status} (archivado)`, r.products.name);
    }
    return isValid;
  });
  
  console.log(`✅ Variantes válidas (excluyendo archivados): ${validVariants.length}`);
  if (validVariants.length === 0) {
    allData = [];
    productMainImageUrls.clear();
    render();
    msg.textContent = "No se encontraron variantes para los productos buscados.";
    updateLowAlertBadge();
    await loadIncompleteCount();
    return true;
  }
  
  // ── Query crítica 2: IDs de almacenes ────────────────────────────────────
  const warehousesRes = await wrapSupabase(
    () => supabase
      .from("warehouses")
      .select("id, code")
      .in("code", ["general", "venta-publico"]),
    { retries: 1, signal, label: "stock.load.warehouses" }
  );
  if (signal?.aborted || warehousesRes.aborted) return false;
  if (warehousesRes.error) {
    const kind = warehousesRes.kind;
    if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
      throw Object.assign(new Error(warehousesRes.error.message || "network"), { kind });
    }
    msg.textContent = `Error cargando almacenes: ${warehousesRes.error.message}`;
    console.error("Error cargando almacenes:", warehousesRes.error, "kind:", kind);
    return false;
  }
  const warehouses = warehousesRes.data;

  const warehouseMap = new Map();
  warehouses.forEach(w => warehouseMap.set(w.code, w.id));
  const generalWarehouseId = warehouseMap.get("general");
  const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  
  if (!generalWarehouseId || !ventaPublicoWarehouseId) {
    msg.textContent = "Error: No se encontraron los almacenes necesarios";
    console.error("Almacenes no encontrados:", { generalWarehouseId, ventaPublicoWarehouseId });
    return false;
  }
  
  // Obtener talles desde variant_sizes con paginación (para manejar más de 1000 registros)
  const variantIds = validVariants.map(v => v.id);
  // Log reducido: no mostrar el array completo de variantIds (muy verboso)
  console.log(`🔧 Buscando talles para ${variantIds.length} variantes`);
  
  let allSizesData = [];
  const batchSize = isMobileStockViewport() ? 25 : 100; // En mobile usar lotes más chicos para evitar 400 por URL larga
  const totalBatches = Math.ceil(variantIds.length / batchSize);
  
  // Procesar en lotes para evitar error 400 con arrays grandes
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    if (signal?.aborted) return false; // búsqueda cancelada: salir del loop
    const startIndex = batchIndex * batchSize;
    const endIndex = Math.min(startIndex + batchSize, variantIds.length);
    const batchVariantIds = variantIds.slice(startIndex, endIndex);
    
    if (batchVariantIds.length === 0) continue;
    
    let offset = 0;
    const pageSize = isMobileStockViewport() ? 400 : 1000;
    let hasMore = true;
    
    while (hasMore) {
      const { data: sizesData, error: sizesError } = await supabase
        .from("variant_sizes")
        .select("variant_id, size, stock_qty, sku, qr_code")
        .in("variant_id", batchVariantIds)
        .order("size")
        .range(offset, offset + pageSize - 1);
      
      if (sizesError) {
        console.error(`❌ Error cargando talles (lote ${batchIndex + 1}/${totalBatches}):`, sizesError);
        msg.textContent = `Error cargando talles: ${sizesError.message}`;
        break;
      }
      
      if (sizesData && sizesData.length > 0) {
        allSizesData.push(...sizesData);
        offset += pageSize;
        hasMore = sizesData.length === pageSize; // Si hay menos de pageSize, no hay más
      } else {
        hasMore = false;
      }
    }
  }
  
  const sizesData = allSizesData;
  if (sizesData.length > 0) {
    console.log(`✅ Total talles cargados: ${sizesData.length} (en ${totalBatches} lote${totalBatches > 1 ? 's' : ''})`);
  }
  
  // Agrupar talles por variant_id
  // IMPORTANTE: Incluir TODOS los talles desde variant_sizes, incluso con stock 0
  const sizesByVariant = new Map();
  if (sizesData && sizesData.length > 0) {
    sizesData.forEach(sizeRow => {
      if (!sizeRow.variant_id) {
        console.warn("⚠️ Talle sin variant_id:", sizeRow);
        return;
      }
      if (!sizesByVariant.has(sizeRow.variant_id)) {
        sizesByVariant.set(sizeRow.variant_id, []);
      }
      // Normalizar el tamaño usando la función definida al inicio de load()
      // IMPORTANTE: Incluir talles incluso si stock_qty es 0
      const sizeValue = normalizeSize(sizeRow.size);
      if (sizeValue) {
        sizesByVariant.get(sizeRow.variant_id).push({
          size: sizeValue,
          stock_qty: sizeRow.stock_qty || 0, // Incluir incluso si es 0
          sku: sizeRow.sku || null,
          qr_code: sizeRow.qr_code || null,
        });
      }
    });
  } else {
    console.warn("⚠️ No se encontraron talles en variant_sizes para las variantes");
  }
  
  // Log reducido: solo mostrar resumen
  if (sizesData && sizesData.length > 0) {
    console.log(`📏 ${sizesData.length} talles cargados para ${sizesByVariant.size} variantes`);
  }
  
  // Obtener stocks por almacén (stock total por variante desde variant_warehouse_stock)
  const { data: stocks, error: stocksError } = await fetchVariantWarehouseStocksAdaptive(
    variantIds,
    [generalWarehouseId, ventaPublicoWarehouseId]
  );

  if (stocksError) {
    console.warn("⚠️ Error cargando stocks agregados. Continuando con fallback por talle:", stocksError);
    msg.textContent = "Carga parcial: usando stock por talle.";
  }
  
  // Crear mapa de stocks por variante y almacén
  const stockMap = new Map();
  (stocks || []).forEach(s => {
    const key = `${s.variant_id}_${s.warehouse_id}`;
    stockMap.set(key, s.stock_qty || 0);
  });
  
  // Obtener TODOS los stocks por talle y warehouse con paginación (para manejar más de 1000 registros)
  // Dividir en lotes para evitar error 400 con arrays grandes
  let allSizeWarehouseStocks = [];
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    if (signal?.aborted) return false; // búsqueda cancelada: salir del loop
    const startIndex = batchIndex * batchSize;
    const endIndex = Math.min(startIndex + batchSize, variantIds.length);
    const batchVariantIds = variantIds.slice(startIndex, endIndex);
    
    if (batchVariantIds.length === 0) continue;
    
    let stockOffset = 0;
    const stockPageSize = isMobileStockViewport() ? 400 : 1000;
    let hasMoreStocks = true;
    
    while (hasMoreStocks) {
      const { data: sizeWarehouseStocks, error: allSizeWarehouseError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("variant_id, size, warehouse_id, stock_qty")
        .in("variant_id", batchVariantIds)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId])
        .range(stockOffset, stockOffset + stockPageSize - 1);
      
      if (allSizeWarehouseError) {
        console.warn(`⚠️ Error cargando stock por talle y warehouse (lote ${batchIndex + 1}/${totalBatches}):`, allSizeWarehouseError);
        break;
      }
      
      if (sizeWarehouseStocks && sizeWarehouseStocks.length > 0) {
        allSizeWarehouseStocks.push(...sizeWarehouseStocks);
        stockOffset += stockPageSize;
        hasMoreStocks = sizeWarehouseStocks.length === stockPageSize;
      } else {
        hasMoreStocks = false;
      }
    }
  }
  
  if (allSizeWarehouseStocks.length > 0) {
    console.log(`✅ Total stocks por talle/warehouse cargados: ${allSizeWarehouseStocks.length} (en ${totalBatches} lote${totalBatches > 1 ? 's' : ''})`);
  }
  
  // Crear mapa global de stock por variante, talle y warehouse
  // key: `${variant_id}_${size}_${warehouse_id}` -> stock_qty
  // IMPORTANTE: Usar la misma función normalizeSize definida al inicio para asegurar consistencia
  const globalSizeWarehouseMap = new Map();
  if (allSizeWarehouseStocks && allSizeWarehouseStocks.length > 0) {
    allSizeWarehouseStocks.forEach(sws => {
      const sizeNormalized = normalizeSize(sws.size);
      if (sizeNormalized) {
        const key = `${sws.variant_id}_${sizeNormalized}_${sws.warehouse_id}`;
        globalSizeWarehouseMap.set(key, sws.stock_qty || 0);
      }
    });
  }
  
  // Crear filas: una por cada talle de cada variante
  // IMPORTANTE: Incluir TODOS los talles desde variant_sizes, incluso si tienen stock 0
  allData = [];
  for (const v of validVariants) {
    const sizes = sizesByVariant.get(v.id) || [];
    
    if (sizes && sizes.length > 0) {
      // Crear una fila por cada talle (TODOS, incluso con stock 0)
      sizes.forEach(sizeData => {
        // Normalizar el size usando la función definida al inicio de load()
        // IMPORTANTE: Usar la misma normalización que se usó para crear el mapa global
        const sizeNormalized = normalizeSize(sizeData.size);
        
        // Si el size está vacío después de normalizar, saltar este registro
        if (!sizeNormalized) {
          console.warn(`⚠️ Variante ${v.id} (${v.color}): Saltando talle con size vacío:`, sizeData);
          return;
        }
        
        // Obtener stock por warehouse desde el mapa global usando la misma normalización
        const generalKey = `${v.id}_${sizeNormalized}_${generalWarehouseId}`;
        const ventaPublicoKey = `${v.id}_${sizeNormalized}_${ventaPublicoWarehouseId}`;
        let stock_general = globalSizeWarehouseMap.get(generalKey) || 0;
        let stock_venta_publico = globalSizeWarehouseMap.get(ventaPublicoKey) || 0;
        
        // Plan 2: no usar variant_sizes como fuente operativa por talle.
        const isFallbackFromVariantSizes = false;
        // Si stock_general === 0 && stock_venta_publico === 0 && stock_qty === 0,
        // mantener stock en 0 pero INCLUIR el talle igual (esto es correcto)
        
        const stock_total = stock_general + stock_venta_publico;
        
        const rowData = {
          ...v,
          size: sizeNormalized, // Talle normalizado desde variant_sizes
          sku: sizeData.sku || v.sku, // SKU completo con talle si existe
          qr_code: sizeData.qr_code || null, // QR code del talle si existe
          stock_general, // Stock del talle en warehouse general (puede ser 0)
          stock_venta_publico, // Stock del talle en warehouse venta público (puede ser 0)
          stock_total, // Stock total (puede ser 0)
          fallbackFromVariantSizes: isFallbackFromVariantSizes,
          rowId: `${v.id}_${sizeNormalized}` // ID único para esta combinación variante+talle
        };
        
        allData.push(rowData);
      });
    } else {
      console.log(`⚠️ Variante ${v.id} (${v.color}): Sin talles en variant_sizes`);
      // Si no tiene talles, agregar la variante sin size (modo legacy)
      const stockGeneralKey = `${v.id}_${generalWarehouseId}`;
      const stockVentaPublicoKey = `${v.id}_${ventaPublicoWarehouseId}`;
      const stock_general = stockMap.get(stockGeneralKey) || 0;
      const stock_venta_publico = stockMap.get(stockVentaPublicoKey) || 0;
      const stock_total = stock_general + stock_venta_publico;
      
      allData.push({
        ...v,
        size: null, // Sin talle
        stock_general,
        stock_venta_publico,
        stock_total
      });
    }
  }
  
  // Log resumido
  console.log(`📊 ${allData.length} filas creadas (${validVariants.length} variantes)`);

  await loadProductMainImages(validVariants, { signal });
  
  populateFilters(allData);
  render();
  if (allData.length > 0) {
    msg.textContent = `${allData.length} variantes cargadas.`;
  } else {
    msg.textContent = `Usa el buscador o filtros para ver productos.`;
  }
  updateLowAlertBadge();
  loadIncompleteCount().catch((err) => {
    console.warn("No se pudo cargar contador de incompletos:", err);
  });
  return true;
}

function stockImageThumbUrl(img) {
  if (!img) return "";
  if (img.public_id?.trim()) {
    return `https://res.cloudinary.com/${STOCK_CLOUDINARY_CLOUD}/image/upload/f_auto,q_auto,c_scale,w_200/${img.public_id.trim()}`;
  }
  const url = img.secure_url || img.url || "";
  if (!url) return "";
  if (url.includes("res.cloudinary.com") && url.includes("/image/upload/")) {
    if (url.includes("/upload/f_") || url.includes("/upload/v")) {
      if (!url.includes("w_200") && !url.includes("w_")) {
        return url.replace("/upload/", "/upload/f_auto,q_auto,c_scale,w_200/");
      }
      return url.replace(/w_\d+/, "w_200");
    }
    return url.replace("/upload/", "/upload/f_auto,q_auto,c_scale,w_200/");
  }
  return url;
}

async function loadProductMainImages(validVariants, { signal } = {}) {
  productMainImageUrls.clear();
  const variantIds = validVariants.map((v) => v.id).filter(Boolean);
  if (variantIds.length === 0) return;

  const variantToProduct = new Map();
  validVariants.forEach((v) => {
    if (v.id && v.product_id) variantToProduct.set(v.id, v.product_id);
  });

  const allImages = [];
  const batchSize = 100;
  for (let i = 0; i < variantIds.length; i += batchSize) {
    if (signal?.aborted) return;
    const batch = variantIds.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from("variant_images")
      .select("variant_id, url, secure_url, public_id, position, is_main")
      .in("variant_id", batch)
      .order("position", { ascending: true });
    if (error) {
      console.warn("Error cargando imágenes de stock:", error.message);
      continue;
    }
    if (data?.length) allImages.push(...data);
  }

  const byProduct = new Map();
  allImages.forEach((img) => {
    const productId = variantToProduct.get(img.variant_id);
    if (!productId) return;
    if (!byProduct.has(productId)) byProduct.set(productId, []);
    byProduct.get(productId).push(img);
  });

  byProduct.forEach((images, productId) => {
    const sorted = [...images].sort((a, b) => {
      const aMain = a.is_main ? 0 : 1;
      const bMain = b.is_main ? 0 : 1;
      if (aMain !== bMain) return aMain - bMain;
      return (a.position || 999) - (b.position || 999);
    });
    const thumb = stockImageThumbUrl(sorted[0]);
    if (thumb) productMainImageUrls.set(String(productId), thumb);
  });
}

function closeStockImagePreview() {
  const popover = document.getElementById("stock-image-preview-popover");
  if (!popover) return;
  popover.classList.remove("show");
  popover.setAttribute("aria-hidden", "true");
  popover.removeAttribute("data-product-id");
  document.removeEventListener("click", onStockImagePreviewOutsideClick, true);
  document.removeEventListener("keydown", onStockImagePreviewEsc, true);
}

function onStockImagePreviewOutsideClick(e) {
  const popover = document.getElementById("stock-image-preview-popover");
  if (!popover) return;
  if (popover.contains(e.target)) return;
  if (e.target.closest?.(".stock-image-preview-btn")) return;
  closeStockImagePreview();
}

function onStockImagePreviewEsc(e) {
  if (e.key === "Escape") closeStockImagePreview();
}

function populateFilters(rows) {
  // Rellenar selects con opciones únicas
  const setFrom = (arr, getter) =>
    Array.from(new Set(arr.map(getter).filter(Boolean))).sort((a, b) =>
      String(a).localeCompare(String(b), "es")
    );
  const categories = setFrom(rows, (r) => r.products?.category);
  const colors = setFrom(rows, (r) => r.color);
  const sizes = setFrom(rows, (r) => r.size);

  function fillSelect(select, values) {
    const current = select.value;
    const base = select.querySelector("option[value='']")?.outerHTML || "<option value=''></option>";
    select.innerHTML = base + values.map((v) => `<option value="${String(v)}">${String(v)}</option>`).join("");
    // Restaurar selección si existe
    if ([...select.options].some((o) => o.value === current)) {
      select.value = current;
    }
  }
  fillSelect(fCategory, categories);
  fillSelect(fColor, colors);
  fillSelect(fSize, sizes);
}

function applyFilters(rows) {
  const term = (q.value || "").toLowerCase().trim();
  const cat = fCategory?.value || "";
  const color = fColor?.value || "";
  const size = fSize?.value || "";
  const active = fActive?.value;
  const supplier = fSupplier?.value || "";
  const onlyLow = fLow?.checked;
  const hasTerm = term.length >= MIN_SEARCH_CHARS;
  const hasLoadCriteria = hasTerm || Boolean(supplier);
  const hasSecondaryFilter = cat || color || size || active || onlyLow;

  if (!hasLoadCriteria && !hasSecondaryFilter) {
    return [];
  }

  // IMPORTANTE: Incluir TODOS los talles, incluso con stock 0
  // El filtro solo debe excluir filas que no coincidan con los criterios de búsqueda,
  // NO debe excluir filas por tener stock 0 (excepto cuando se activa el filtro "Solo bajo stock")
  return rows.filter((r) => {
    // Filtro por término de búsqueda (solo nombre de producto)
    if (hasTerm) {
      const productName = r.products?.name;
      if (!productName || !String(productName).toLowerCase().includes(term)) {
        return false;
      }
    }
    if (supplier) {
      const productSupplierId = r.products?.supplier_id ?? null;
      if (supplier === SUPPLIER_FILTER_NONE) {
        if (productSupplierId != null) return false;
      } else if (String(productSupplierId) !== String(supplier)) {
        return false;
      }
    }
    // Filtro por categoría
    if (cat && r.products?.category !== cat) return false;
    // Filtro por color
    if (color && r.color !== color) return false;
    // Filtro por talle específico
    if (size && String(r.size) !== String(size)) return false;
    // Filtro por estado activo
    if (active === "true" && !r.active) return false;
    if (active === "false" && r.active) return false;
    // Filtro "Solo bajo stock" - solo excluir si stock > 3
    // NOTA: Este filtro NO excluye talles con stock 0, solo excluye talles con stock > 3
    if (onlyLow) {
      // Calcular stock total considerando cambios pendientes
      const change = pendingChanges.get(r.rowId || `${r.id}_${r.size || 'null'}`);
      let stock_total;
      if (change) {
        const stock_general = change.stock_general !== undefined ? change.stock_general : r.stock_general;
        const stock_venta_publico = change.stock_venta_publico !== undefined ? change.stock_venta_publico : r.stock_venta_publico;
        stock_total = (stock_general || 0) + (stock_venta_publico || 0);
      } else {
        stock_total = r.stock_total || 0;
      }
      // Solo excluir si stock > 3 (incluye talles con stock 0, 1, 2, 3)
      if (Number(stock_total) > 3) return false;
    }
    return true;
  });
}

// Agrupar datos por producto
function groupByProduct(rows) {
  const productsMap = new Map();
  
  rows.forEach(r => {
    const productId = r.products?.id;
    if (!productId) return;
    
    if (!productsMap.has(productId)) {
      productsMap.set(productId, {
        product: r.products,
        variants: new Map(), // key: variantId
        totalStock: 0,
        totalStockGeneral: 0,
        totalStockVentaPublico: 0,
        colors: new Set(),
        price: r.price || 0
      });
    }
    
    const productData = productsMap.get(productId);
    const variantId = r.id;
    
    if (!productData.variants.has(variantId)) {
      productData.variants.set(variantId, {
        variant: r,
        sizes: [] // Array de talles
      });
      productData.colors.add(r.color || 'Sin color');
    }
    
    const variantData = productData.variants.get(variantId);
    const pending = pendingChanges.get(r.rowId || `${r.id}_${r.size || 'null'}`);
    
    const stock_general = pending?.stock_general !== undefined ? pending.stock_general : (r.stock_general || 0);
    const stock_venta_publico = pending?.stock_venta_publico !== undefined ? pending.stock_venta_publico : (r.stock_venta_publico || 0);
    const stock_total = stock_general + stock_venta_publico;
    
    // VERIFICAR SI EL TALLE YA EXISTE (evitar duplicados)
    // IMPORTANTE: Usar la misma función normalizeSize definida al inicio de load()
    // Asegurar que el tamaño se normalice de la misma manera que en allData
    const sizeNormalized = normalizeSize(r.size) || "null";
    const sizeKey = `${variantId}_${sizeNormalized}`;
    
    const existingSizeIndex = variantData.sizes.findIndex(s => {
      const sSizeNormalized = normalizeSize(s.size) || "null";
      const sKey = `${variantId}_${sSizeNormalized}`;
      return sKey === sizeKey;
    });
    
    if (existingSizeIndex >= 0) {
      // Talle ya existe - actualizar en lugar de agregar duplicado
      const oldSize = variantData.sizes[existingSizeIndex];
      
      // RESTAR los valores anteriores antes de actualizar
      productData.totalStock -= oldSize.stock_total || 0;
      productData.totalStockGeneral -= oldSize.stock_general || 0;
      productData.totalStockVentaPublico -= oldSize.stock_venta_publico || 0;
      
      // Actualizar el existente
      variantData.sizes[existingSizeIndex] = {
        ...r,
        size: sizeNormalized, // Asegurar que el size normalizado se guarde
        stock_general,
        stock_venta_publico,
        stock_total,
        pending
      };
      
      // SUMAR los nuevos valores después de actualizar
      productData.totalStock += stock_total;
      productData.totalStockGeneral += stock_general;
      productData.totalStockVentaPublico += stock_venta_publico;
    } else {
      // Talle no existe - agregar nuevo
      variantData.sizes.push({
        ...r,
        size: sizeNormalized, // Asegurar que el size normalizado se guarde
        stock_general,
        stock_venta_publico,
        stock_total,
        pending
      });
      
      // SUMAR los nuevos valores
      productData.totalStock += stock_total;
      productData.totalStockGeneral += stock_general;
      productData.totalStockVentaPublico += stock_venta_publico;
    }
  });
  
  // Convertir el mapa a array antes de procesar
  const result = Array.from(productsMap.values());
  
  // Ordenar talles por tamaño después de agrupar (para mostrar en orden)
  result.forEach(productData => {
    productData.variants.forEach((variantData, variantId) => {
      // Ordenar talles numéricamente cuando sea posible, o alfabéticamente
      variantData.sizes.sort((a, b) => {
        const aSize = normalizeSize(a.size);
        const bSize = normalizeSize(b.size);
        return compareCatalogSizes(aSize, bSize);
      });
    });
  });
  
  return result;
}

function render() {
  closeStockImagePreview();
  if (tbody) tbody.innerHTML = "";
  if (!productsContainer) return;
  
  productsContainer.innerHTML = "";
  const rows = applyFilters(allData);
  
  // Verificar si hay filtros activos
  const term = (q?.value || "").toLowerCase().trim();
  const cat = fCategory?.value || "";
  const color = fColor?.value || "";
  const size = fSize?.value || "";
  const active = fActive?.value;
  const supplier = fSupplier?.value || "";
  const onlyLow = fLow?.checked;
  const hasTerm = term.length >= MIN_SEARCH_CHARS;
  const hasLoadCriteria = hasTerm || Boolean(supplier);
  const hasSecondaryFilter = cat || color || size || active || onlyLow;
  const hasAnyFilter = hasLoadCriteria || hasSecondaryFilter;

  if (rows.length === 0) {
    if (noResults) {
      noResults.style.display = "block";
      if (hasAnyFilter) {
        noResults.innerHTML = "<p>No se encontraron productos con los filtros aplicados.</p>";
      } else {
        noResults.innerHTML = "<p>Ingresa un término de búsqueda o elegí un proveedor para ver los productos.</p>";
      }
    }
    return;
  }
  
  if (noResults) noResults.style.display = "none";
  
  const products = groupByProduct(rows);
  
  products.forEach(productData => {
    const card = document.createElement("div");
    card.className = "product-card";
    card.dataset.productId = productData.product.id;
    
    const colorsList = Array.from(productData.colors).join(", ");
    const lowStock = productData.totalStock <= 3;
    if (lowStock) card.classList.add("low-stock");
    
    card.innerHTML = `
      <div class="product-card-header" onclick="toggleProductCard('${productData.product.id}')">
        <div class="product-card-info">
          <div class="product-card-title">
            <span>${productData.product.name || "Sin nombre"}</span>
            <button type="button" class="stock-image-preview-btn" title="Ver imagen principal" aria-label="Ver imagen principal del producto" onclick="event.stopPropagation(); toggleStockImagePreview('${productData.product.id}', this)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7"></circle>
                <line x1="16.5" y1="16.5" x2="21" y2="21"></line>
              </svg>
            </button>
            <button class="stock-history-btn" onclick="event.stopPropagation(); showStockHistory('${productData.product.id}', '${productData.product.name || "Sin nombre"}')" title="Ver historial de stock">
              Historial
            </button>
            <button class="stock-history-btn" onclick="event.stopPropagation(); toggleGeneralEditMode('${productData.product.id}')" title="Editar stock general del producto">
              Editar general
            </button>
          </div>
          <div class="product-card-meta">
            <span>Categoría: ${productData.product.category || ""}</span>
            <span>Colores: ${colorsList}</span>
          </div>
        </div>
        <div class="product-card-price">
          <div class="product-price">$${formatNumber(productData.price || 0)}</div>
        </div>
      </div>
      <div class="product-card-body">
        <div class="product-card-section">
          <div class="stock-metrics">
            <div class="stock-metric">
              <div class="stock-metric-label">Stock total</div>
              <div class="stock-metric-value">${productData.totalStock}</div>
            </div>
            <div class="stock-metric">
              <div class="stock-metric-label">Depósito</div>
              <div class="stock-metric-value">${productData.totalStockGeneral}</div>
            </div>
            <div class="stock-metric">
              <div class="stock-metric-label">Local</div>
              <div class="stock-metric-value">${productData.totalStockVentaPublico}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="variants-container" id="variants-${productData.product.id}">
        ${renderVariants(productData)}
      </div>
    `;
    
    productsContainer.appendChild(card);
  });
  
  // Aplicar permisos después del render
  applyPermissions();
}

function renderVariants(productData) {
  let html = "";
  productData.variants.forEach((variantData, variantId) => {
    const variant = variantData.variant;
    const pending = pendingChanges.get(variantId);
    const active = pending?.active !== undefined ? pending.active : (variant.active ?? true);
    
    // Calcular totales de la variante
    let variantStockTotal = 0;
    let variantStockGeneral = 0;
    let variantStockVentaPublico = 0;
    
    variantData.sizes.forEach(size => {
      variantStockTotal += size.stock_total || 0;
      variantStockGeneral += size.stock_general || 0;
      variantStockVentaPublico += size.stock_venta_publico || 0;
    });
    
    html += `
      <div class="variant-card">
        <div class="variant-card-header" onclick="toggleVariantCard('${productData.product.id}', '${variantId}')">
          <div class="variant-card-title">
            <span class="variant-color">${variant.color || "Sin color"}</span>
            <button class="edit-variant-btn" onclick="event.stopPropagation(); toggleEditMode('${productData.product.id}', '${variantId}')">Editar</button>
            <span class="variant-summary">
              Total: ${variantStockTotal} | Depósito: ${variantStockGeneral} | Local: ${variantStockVentaPublico}
            </span>
          </div>
          <span class="variant-toggle">▼</span>
        </div>
        <div class="sizes-detail" id="sizes-${productData.product.id}-${variantId}">
          <div class="mobile-sizes-grid-wrap">
            <table class="mobile-sizes-grid" aria-label="Resumen mobile por talle">
              <thead>
                <tr>
                  <th>Deposito</th>
                  ${variantData.sizes.map(size => `<th>${size.size || "N/A"}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="mobile-sizes-row-label">General</td>
                  ${variantData.sizes.map(size => `<td>${size.stock_general ?? 0}</td>`).join("")}
                </tr>
                <tr>
                  <td class="mobile-sizes-row-label">Local</td>
                  ${variantData.sizes.map(size => `<td>${size.stock_venta_publico ?? 0}</td>`).join("")}
                </tr>
              </tbody>
            </table>
          </div>
          <table class="sizes-table" data-editing="false">
            <thead>
              <tr>
                <th>Talle</th>
                <th>SKU</th>
                <th>Stock Total</th>
                <th>Carga</th>
                <th>Imprimir</th>
                <th>Depósito</th>
                <th>Local</th>
                <th>Precio</th>
                <th>Activa</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              ${variantData.sizes.map(size => {
                const effectivePrice = size.pending?.price !== undefined ? size.pending.price : (size.price || 0);
                const sizeActive = size.pending?.active !== undefined ? size.pending.active : (size.active ?? true);
                const priceChanged = size.pending?.price !== undefined && Number(size.pending.price) !== Number(size.price ?? 0);
                const rowId = size.rowId || `${size.id}_${size.size}`; // ID único para esta fila
                const hasChanges = pendingChanges.has(rowId);
                
                return `
                  <tr class="${hasChanges ? 'dirty-row' : ''}" data-row-id="${rowId}">
                    <td title="${size.fallbackFromVariantSizes ? "Stock tomado desde variant_sizes (fallback temporal)." : ""}">
                      ${size.size || "N/A"}${size.fallbackFromVariantSizes ? ' *' : ''}
                    </td>
                    <td>${size.sku || ""}</td>
                    <td class="stock-total-cell" style="font-weight: 600; text-align: center;">${size.stock_total}</td>
                    <td>
                      <input type="number" min="0" value="" class="carga-input" 
                             data-load-input="${rowId}" placeholder="0"
                             ${!canEditStock ? 'disabled' : ''} />
                      <button class="carga-btn" data-add-load 
                              data-row-id="${rowId}" 
                              data-variant-id="${size.id}" 
                              data-size="${size.size}"
                              ${!canEditStock ? 'disabled' : ''}>+</button>
                    </td>
                    <td>
                      <button class="print-label-btn" data-print-labels
                              data-row-id="${rowId}"
                              data-product-name="${productData.product.name || ''}"
                              data-color="${variant.color || ''}"
                              data-size="${size.size || ''}"
                              data-sku="${size.sku || ''}"
                              data-qr-code="${size.qr_code || ''}"
                              ${!canEditStock ? 'disabled' : ''}>
                        Imprimir
                      </button>
                    </td>
                    <td>
                      <input type="number" min="0" value="${size.stock_general}" 
                             data-row-id="${rowId}" data-field="stock_general" 
                             readonly
                             ${!canEditStock ? 'disabled' : ''} />
                    </td>
                    <td>
                      <input type="number" min="0" value="${size.stock_venta_publico}" 
                             data-row-id="${rowId}" data-field="stock_venta_publico"
                             readonly
                             ${!canEditStock ? 'disabled' : ''} />
                    </td>
                    <td>
                      <input type="number" min="0" step="1" value="${effectivePrice}" 
                             data-row-id="${rowId}" data-field="price"
                             ${!canEditStock ? 'disabled' : ''} />
                      ${priceChanged ? `<button class="mini-btn" data-apply-price data-product-id="${productData.product.id}" data-source-id="${rowId}">Aplicar</button>` : ''}
                    </td>
                    <td style="text-align: center;">
                      <input type="checkbox" ${sizeActive ? "checked" : ""} 
                             data-row-id="${rowId}" data-field="active"
                             ${!canEditStock ? 'disabled' : ''} />
                    </td>
                    <td>
                      <button data-save="${rowId}" data-variant-id="${size.id}" data-size="${size.size}" ${!canEditStock ? 'disabled' : ''}>Guardar</button>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
          ${variantData.sizes.some(s => s.fallbackFromVariantSizes) ? '<div style="margin-top:6px;font-size:12px;color:#7a7a7a;">* Stock tomado desde variant_sizes (fallback temporal, no desde variant_size_warehouse_stock).</div>' : ''}
        </div>
      </div>
    `;
  });
  
  return html;
}

function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function isMobileStockViewport() {
  return window.innerWidth <= MOBILE_STOCK_BREAKPOINT;
}

function setStockLoadingState(isLoading) {
  if (stockLoadingOverlay) {
    stockLoadingOverlay.classList.toggle("hidden", !isLoading);
    stockLoadingOverlay.setAttribute("aria-busy", isLoading ? "true" : "false");
  }
  const disabled = isLoading;
  if (q) q.disabled = disabled;
  if (reloadBtn) reloadBtn.disabled = disabled;
  if (saveAllBtn) saveAllBtn.disabled = disabled || pendingChanges.size === 0;
  if (discardAllBtn) discardAllBtn.disabled = disabled || pendingChanges.size === 0;
  if (isLoading) {
    if (stockLoadingWatchdog) clearTimeout(stockLoadingWatchdog);
    stockLoadingWatchdog = setTimeout(() => {
      if (!isStockUiReady) {
        isStockUiReady = true;
        if (msg) {
          msg.textContent = stockLoadHintMessage();
        }
        if (stockLoadingOverlay) {
          stockLoadingOverlay.classList.add("hidden");
          stockLoadingOverlay.setAttribute("aria-busy", "false");
        }
        if (q) q.disabled = false;
        if (reloadBtn) reloadBtn.disabled = false;
      }
    }, 7000);
  } else if (stockLoadingWatchdog) {
    clearTimeout(stockLoadingWatchdog);
    stockLoadingWatchdog = null;
  }
}

function toggleVariantTableEditMode(productId, variantId) {
  const sizesDetail = document.getElementById(`sizes-${productId}-${variantId}`);
  if (sizesDetail && !sizesDetail.classList.contains("expanded")) {
    sizesDetail.classList.add("expanded");
  }

  const table = document.querySelector(`#sizes-${productId}-${variantId} .sizes-table`);
  if (!table) return;

  const isEditing = table.dataset.editing === "true";
  table.dataset.editing = isEditing ? "false" : "true";

  const stockInputs = table.querySelectorAll('input[data-field="stock_general"], input[data-field="stock_venta_publico"]');
  stockInputs.forEach((input) => {
    input.readOnly = isEditing;
  });

  const cargaInputs = table.querySelectorAll(".carga-input, .carga-btn");
  cargaInputs.forEach((el) => {
    el.style.display = isEditing ? "" : "none";
  });

  const variantCard = table.closest(".variant-card");
  const editBtn = variantCard?.querySelector(".edit-variant-btn");
  if (editBtn) {
    editBtn.textContent = isEditing ? "Editar" : "Cancelar";
  }
}

function resetMobileWizardState() {
  mobileWizardState.open = false;
  mobileWizardState.productId = null;
  mobileWizardState.variantId = null;
  mobileWizardState.scope = "variant";
  mobileWizardState.rows = [];
  mobileWizardState.selectedField = null;
  mobileWizardState.mode = null;
  mobileWizardState.currentIndex = 0;
  mobileWizardState.values = new Map();
  mobileWizardState.lectorActive = false;
  mobileLectorRowMap.clear();
  mobileLectorSizeMap.clear();
  mobileLectorVariantSizeMap.clear();
  mobileLectorQrMap.clear();
  mobileLectorCellMap.clear();
  mobileLectorScanQueue = [];
  mobileLectorIsProcessingQueue = false;
}

function clearMobileLectorUi() {
  if (mobileLectorInputTimeout) {
    clearTimeout(mobileLectorInputTimeout);
    mobileLectorInputTimeout = null;
  }
  if (mobileLectorLastFlashTimeout) {
    clearTimeout(mobileLectorLastFlashTimeout);
    mobileLectorLastFlashTimeout = null;
  }
  if (mobileLectorCheckbox) mobileLectorCheckbox.checked = false;
  if (mobileLectorInput) mobileLectorInput.value = "";
  if (mobileLectorStatus) {
    mobileLectorStatus.textContent = "";
    mobileLectorStatus.classList.remove("is-error", "is-success");
  }
  if (mobileLectorGrid) mobileLectorGrid.innerHTML = "";
  if (mobileLectorPanel) mobileLectorPanel.hidden = true;
  mobileLectorCellMap.clear();
  mobileLectorScanQueue = [];
  mobileLectorIsProcessingQueue = false;
}

function setMobileLectorStatus(message, kind) {
  if (!mobileLectorStatus) return;
  mobileLectorStatus.textContent = message || "";
  mobileLectorStatus.classList.remove("is-error", "is-success");
  if (kind === "error") mobileLectorStatus.classList.add("is-error");
  else if (kind === "success") mobileLectorStatus.classList.add("is-success");
}

function getMobileTotalCount() {
  return mobileWizardState.rows.reduce((acc, row) => {
    const n = Number(mobileWizardState.values.get(row.rowId) || 0);
    return acc + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

function renderMobileTotalCounter() {
  if (!mobileStockTotalCounterValue) return;
  mobileStockTotalCounterValue.textContent = String(getMobileTotalCount());
  if (mobileStockTotalCounter) {
    mobileStockTotalCounter.hidden = !mobileWizardState.rows.length;
  }
}

function setMobileModeTag(element, mode) {
  if (!element) return;
  element.classList.remove("mode-modify", "mode-add");
  if (mode === "modify") {
    element.classList.add("mode-modify");
    element.textContent = "Modificar";
  } else if (mode === "add") {
    element.classList.add("mode-add");
    element.textContent = "Agregar";
  } else {
    element.textContent = "";
  }
}

function switchMobileWizardStep(targetStep) {
  const steps = [mobileStepWarehouse, mobileStepMode, mobileStepSize, mobileStepSummary];
  steps.forEach((step) => {
    if (!step) return;
    step.classList.toggle("active", step === targetStep);
  });
}

function buildMobileVariantRows(productId, variantId) {
  const rows = allData.filter((row) => String(row.id) === String(variantId) && String(row.products?.id) === String(productId));
  rows.sort((a, b) => compareCatalogSizes(a.size, b.size));
  return rows;
}

function buildMobileProductRows(productId) {
  const rows = allData.filter((row) => String(row.products?.id) === String(productId));
  rows.sort((a, b) => {
    const colorCmp = String(a.color || "").localeCompare(String(b.color || ""), "es", { sensitivity: "base" });
    if (colorCmp !== 0) return colorCmp;
    return compareCatalogSizes(a.size, b.size);
  });
  return rows;
}

function rebuildMobileLectorRowIndexes() {
  mobileLectorRowMap.clear();
  mobileLectorSizeMap.clear();
  mobileLectorVariantSizeMap.clear();
  mobileWizardState.rows.forEach((row) => {
    const rowId = String(row.rowId ?? "");
    mobileLectorRowMap.set(rowId, row);
    const normalizedSize = normalizeSize(row.size);
    const variantId = String(row.id ?? "");
    mobileLectorSizeMap.set(normalizedSize, row);
    if (variantId) {
      mobileLectorVariantSizeMap.set(`${variantId}__${normalizedSize}`, row);
    }
  });
}

async function preloadMobileLectorQrCache() {
  const scope = mobileWizardState.scope || "variant";
  const productId = mobileWizardState.productId;
  const variantId = mobileWizardState.variantId;
  let query = supabase.from("variant_sizes").select("qr_code, size, variant_id").not("qr_code", "is", null);
  if (scope === "variant") {
    if (!variantId) return;
    query = query.eq("variant_id", variantId);
  } else {
    const variantIds = [...new Set(mobileWizardState.rows.map((row) => String(row.id || "")).filter(Boolean))];
    if (!variantIds.length) return;
    query = query.in("variant_id", variantIds);
  }
  const { data, error } = await query;
  if (error) {
    console.warn("[stock] No se pudo precargar cache QR lector:", error);
    return;
  }
  for (const item of data || []) {
    const qr = String(item?.qr_code ?? "").trim();
    if (!qr) continue;
    const key = `${String(item?.variant_id ?? "")}__${normalizeSize(item?.size)}`;
    const row = mobileLectorVariantSizeMap.get(key) || mobileLectorSizeMap.get(normalizeSize(item?.size));
    if (scope === "product" && productId && row && String(row.products?.id) !== String(productId)) continue;
    if (!row) continue;
    mobileLectorQrMap.set(qr, String(row.rowId ?? ""));
  }
}

function getCurrentWarehouseStock(row, field) {
  const uniqueKey = row.rowId || `${row.id}_${row.size || "null"}`;
  const pending = pendingChanges.get(uniqueKey);
  if (pending && pending[field] !== undefined) return Number(pending[field]) || 0;
  return Number(row[field] || 0);
}

function openMobileStockWizard(productId, variantId) {
  if (!mobileWizardOverlay || !mobileStepWarehouse) {
    toggleVariantTableEditMode(productId, variantId);
    return;
  }

  const rows = buildMobileVariantRows(productId, variantId).filter((row) => row.size !== null && row.size !== undefined && String(row.size).trim() !== "");
  if (rows.length === 0) {
    toggleVariantTableEditMode(productId, variantId);
    return;
  }

  resetMobileWizardState();
  mobileWizardState.open = true;
  mobileWizardState.productId = productId;
  mobileWizardState.variantId = variantId;
  mobileWizardState.scope = "variant";
  mobileWizardState.rows = rows;
  rebuildMobileLectorRowIndexes();
  const productName = rows[0]?.products?.name || "";

  if (mobileWizardSubtitle) {
    mobileWizardSubtitle.textContent = `Variante con ${rows.length} talle(s)`;
  }
  if (mobileWizardProductName) {
    mobileWizardProductName.textContent = productName ? `- ${productName}` : "";
  }
  clearMobileLectorUi();
  mobileWarehouseButtons.forEach((btn) => btn.classList.remove("active"));
  mobileModeButtons.forEach((btn) => {
    btn.classList.remove("active");
    btn.style.display = "";
  });
  setMobileModeTag(mobileModeTag, null);
  setMobileModeTag(mobileModeTagSummary, null);
  switchMobileWizardStep(mobileStepWarehouse);
  mobileWizardOverlay.classList.add("show");
  mobileWizardOverlay.setAttribute("aria-hidden", "false");
  updateMobileWizardKeyboardOffset();
}

function openMobileProductStockWizard(productId) {
  if (!mobileWizardOverlay || !mobileStepWarehouse) return;

  const rows = buildMobileProductRows(productId).filter((row) => row.size !== null && row.size !== undefined && String(row.size).trim() !== "");
  if (rows.length === 0) return;

  resetMobileWizardState();
  mobileWizardState.open = true;
  mobileWizardState.productId = productId;
  mobileWizardState.variantId = null;
  mobileWizardState.scope = "product";
  mobileWizardState.rows = rows;
  rebuildMobileLectorRowIndexes();
  const productName = rows[0]?.products?.name || "";

  if (mobileWizardSubtitle) {
    mobileWizardSubtitle.textContent = `Producto completo: ${rows.length} combinaciones color+talle`;
  }
  if (mobileWizardProductName) {
    mobileWizardProductName.textContent = productName ? `- ${productName}` : "";
  }
  clearMobileLectorUi();
  mobileWarehouseButtons.forEach((btn) => btn.classList.remove("active"));
  mobileModeButtons.forEach((btn) => {
    btn.classList.remove("active");
    const mode = btn.getAttribute("data-mobile-mode");
    btn.style.display = mode === "add" ? "none" : "";
  });
  setMobileModeTag(mobileModeTag, null);
  setMobileModeTag(mobileModeTagSummary, null);
  switchMobileWizardStep(mobileStepWarehouse);
  mobileWizardOverlay.classList.add("show");
  mobileWizardOverlay.setAttribute("aria-hidden", "false");
  updateMobileWizardKeyboardOffset();
}

function closeMobileStockWizard() {
  if (!mobileWizardOverlay) return;
  mobileWizardOverlay.classList.remove("show");
  mobileWizardOverlay.setAttribute("aria-hidden", "true");
  mobileWizardOverlay.style.setProperty("--mobile-keyboard-offset", "0px");
  if (mobileWizardProductName) {
    mobileWizardProductName.textContent = "";
  }
  clearMobileLectorUi();
  resetMobileWizardState();
}

function updateMobileWizardKeyboardOffset() {
  if (!mobileWizardOverlay || !mobileWizardOverlay.classList.contains("show")) return;
  const vv = window.visualViewport;
  if (!vv) {
    mobileWizardOverlay.style.setProperty("--mobile-keyboard-offset", "0px");
    return;
  }
  const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  mobileWizardOverlay.style.setProperty("--mobile-keyboard-offset", overlap > 0 ? `${Math.round(overlap)}px` : "0px");
}

function updateMobileSizeStep() {
  const field = mobileWizardState.selectedField;
  const mode = mobileWizardState.mode;
  const isGeneralScope = mobileWizardState.scope === "product";
  const isLector = Boolean(mobileWizardState.lectorActive && mode === "modify");

  if (mobileLectorToggle) {
    mobileLectorToggle.hidden = mode !== "modify";
    if (mode !== "modify") {
      mobileWizardState.lectorActive = false;
      if (mobileLectorCheckbox) mobileLectorCheckbox.checked = false;
    }
  }
  renderMobileTotalCounter();

  if (isLector) {
    if (mobileStepCount) mobileStepCount.style.display = "none";
    if (mobileSizeJump) mobileSizeJump.style.display = "none";
    if (mobileStockSizeBox) mobileStockSizeBox.style.display = "none";
    if (mobileStockQtyControls) mobileStockQtyControls.style.display = "none";
    if (mobileLectorPanel) mobileLectorPanel.hidden = false;
    setMobileModeTag(mobileModeTag, mode);
    renderMobileLectorGrid();
    return;
  }

  if (mobileStepCount) mobileStepCount.style.display = "";
  if (mobileSizeJump) mobileSizeJump.style.display = "";
  if (mobileStockSizeBox) mobileStockSizeBox.style.display = "";
  if (mobileStockQtyControls) mobileStockQtyControls.style.display = "";
  if (mobileLectorPanel) mobileLectorPanel.hidden = true;

  const row = mobileWizardState.rows[mobileWizardState.currentIndex];
  if (!row) return;

  const currentStock = getCurrentWarehouseStock(row, field);
  const savedValue = mobileWizardState.values.get(row.rowId);
  const inputValue = savedValue !== undefined ? savedValue : 0;

  const rowLabel = isGeneralScope
    ? `${row.color || "Sin color"} · ${row.size}`
    : `${row.size}`;
  if (mobileStepCount) {
    mobileStepCount.textContent = isGeneralScope
      ? `Item ${mobileWizardState.currentIndex + 1} de ${mobileWizardState.rows.length}`
      : `Talle ${mobileWizardState.currentIndex + 1} de ${mobileWizardState.rows.length}`;
  }
  if (mobileSizeValue) mobileSizeValue.textContent = rowLabel;
  if (mobileSizeMeta) {
    mobileSizeMeta.textContent = mode === "modify"
      ? `Stock actual: ${currentStock} | Ingresa nuevo total`
      : `Stock actual: ${currentStock} | Ingresa cantidad a sumar`;
  }
  if (mobileQtyInput) {
    mobileQtyInput.value = String(inputValue);
  }
  setMobileModeTag(mobileModeTag, mode);
  renderMobileSizeJumpButtons();
}

function renderMobileSizeJumpButtons() {
  if (!mobileSizeJump) return;
  const { rows, currentIndex, values } = mobileWizardState;
  if (!rows.length) {
    mobileSizeJump.innerHTML = "";
    return;
  }

  mobileSizeJump.innerHTML = rows
    .map((row, index) => {
      const isActive = index === currentIndex;
      const entered = Number(values.get(row.rowId) || 0);
      const hasValue = entered > 0;
      const classes = [
        "mobile-stock-size-jump-btn",
        isActive ? "active" : "",
        hasValue ? "has-value" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<button type="button" class="${classes}" data-mobile-size-index="${index}">${row.size}</button>`;
    })
    .join("");
}

function escapeMobileLectorHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function escapeMobileLectorAttr(str) {
  return escapeMobileLectorHtml(str).replace(/'/g, "&#39;");
}

function getMobileLectorColorTone(colorName) {
  const palette = [
    { border: "#7da3ff", bg: "#f1f5ff" },
    { border: "#6cbf95", bg: "#eefaf3" },
    { border: "#d29a6a", bg: "#fff5eb" },
  ];
  const normalized = String(colorName || "sin-color").toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function renderMobileLectorGrid() {
  if (!mobileLectorGrid) return;
  const { rows, values } = mobileWizardState;
  mobileLectorCellMap.clear();
  if (!rows.length) {
    mobileLectorGrid.innerHTML = "";
    return;
  }
  mobileLectorGrid.innerHTML = rows
    .map((r) => {
      const v = Number(values.get(r.rowId) || 0);
      const label = mobileWizardState.scope === "product"
        ? `${r.color || "Sin color"} · ${r.size}`
        : `${r.size}`;
      const safeSize = escapeMobileLectorHtml(label);
      const safeKey = escapeMobileLectorAttr(String(r.rowId ?? ""));
      const has = v > 0 ? " has-scans" : "";
      const tone = getMobileLectorColorTone(r.color);
      const borderStyle = `border-color:${tone.border};`;
      const bgStyle = `background:${tone.bg};`;
      return `<div class="mobile-stock-lector-cell${has}" data-row-id="${safeKey}">
        <div class="mobile-stock-lector-cell-size" style="${borderStyle}${bgStyle}border:1px solid ${tone.border};border-radius:8px;padding:4px 5px;">${safeSize}</div>
        <input type="number" class="mobile-stock-lector-cell-count" data-row-id="${safeKey}" min="0" step="1" value="${v}" inputmode="numeric" />
      </div>`;
    })
    .join("");
  mobileLectorGrid.querySelectorAll("input.mobile-stock-lector-cell-count").forEach((input) => {
    const rowId = String(input.getAttribute("data-row-id") || "");
    const cell = input.closest(".mobile-stock-lector-cell");
    if (!rowId || !cell) return;
    mobileLectorCellMap.set(rowId, { input, cell });
  });
}

function updateLectorCellForRow(rowId, flash) {
  const rid = String(rowId);
  const count = Number(mobileWizardState.values.get(rowId) ?? 0);
  const refs = mobileLectorCellMap.get(rid);
  const input = refs?.input || null;
  const cell = refs?.cell || null;
  if (input) input.value = String(count);
  if (cell) {
    cell.classList.toggle("has-scans", count > 0);
    if (flash) {
      cell.classList.remove("last-scanned");
      // reflow para reiniciar animación
      void cell.offsetWidth;
      cell.classList.add("last-scanned");
      if (mobileLectorLastFlashTimeout) clearTimeout(mobileLectorLastFlashTimeout);
      mobileLectorLastFlashTimeout = setTimeout(() => {
        cell.classList.remove("last-scanned");
        mobileLectorLastFlashTimeout = null;
      }, 500);
    }
  }
}

async function processLectorQrCode(raw) {
  const qrCode = String(raw ?? "").trim();
  if (!qrCode || !mobileWizardState.open || !mobileWizardState.lectorActive) return;

  const scope = mobileWizardState.scope || "variant";
  const variantId = mobileWizardState.variantId;
  const productId = mobileWizardState.productId;
  if (!productId) return;
  if (scope === "variant" && !variantId) return;

  let row = null;
  const cachedRowId = mobileLectorQrMap.get(qrCode);
  if (cachedRowId) {
    row = mobileLectorRowMap.get(String(cachedRowId)) || null;
  }

  if (!row) {
    const { data, error } = await supabase
      .from("variant_sizes")
      .select("variant_id, size")
      .eq("qr_code", qrCode)
      .maybeSingle();

    if (error) {
      console.error("[stock] lector QR:", error);
      setMobileLectorStatus("Error al buscar el QR. Reintentá.", "error");
      triggerMobileHapticFeedback(60);
      return;
    }

    if (!data) {
      setMobileLectorStatus(`QR no encontrado (${qrCode})`, "error");
      triggerMobileHapticFeedback(60);
      return;
    }

    if (scope === "variant" && String(data.variant_id) !== String(variantId)) {
      setMobileLectorStatus("QR de otra variante o producto. No se contabilizó.", "error");
      triggerMobileHapticFeedback(60);
      return;
    }

    row = mobileLectorVariantSizeMap.get(`${String(data.variant_id)}__${normalizeSize(data.size)}`) || null;
    if (row) {
      mobileLectorQrMap.set(qrCode, String(row.rowId ?? ""));
    }
  }

  if (!row) {
    setMobileLectorStatus("El talle del QR no coincide con esta variante.", "error");
    triggerMobileHapticFeedback(60);
    return;
  }
  if (String(row.products?.id) !== String(productId)) {
    setMobileLectorStatus("QR de otro producto. No se contabilizó.", "error");
    triggerMobileHapticFeedback(60);
    return;
  }

  const prev = Number(mobileWizardState.values.get(row.rowId) || 0);
  const next = prev + 1;
  mobileWizardState.values.set(row.rowId, next);
  updateLectorCellForRow(row.rowId, true);
  renderMobileTotalCounter();
  setMobileLectorStatus(`Talle ${row.size}: +1 → total ${next}`, "success");
  triggerMobileHapticFeedback(15);
}

function buildMobileSummary() {
  if (!mobileSummaryList) return;
  const field = mobileWizardState.selectedField;
  const mode = mobileWizardState.mode;
  if (mobileWizardState.scope === "product") {
    const grouped = new Map();
    mobileWizardState.rows.forEach((row) => {
      const color = String(row.color || "Sin color");
      if (!grouped.has(color)) grouped.set(color, []);
      grouped.get(color).push(row);
    });
    const html = [];
    grouped.forEach((rows, color) => {
      html.push(`<div class="mobile-stock-summary-item"><strong>${color}</strong><span></span></div>`);
      rows.forEach((row) => {
        const baseStock = getCurrentWarehouseStock(row, field);
        const entered = Number(mobileWizardState.values.get(row.rowId) || 0);
        const finalStock = mode === "modify" ? entered : baseStock + entered;
        html.push(`
          <div class="mobile-stock-summary-item">
            <strong>Talle ${row.size}</strong>
            <span>${baseStock} -> ${finalStock}</span>
          </div>
        `);
      });
    });
    mobileSummaryList.innerHTML = html.join("");
  } else {
    mobileSummaryList.innerHTML = mobileWizardState.rows.map((row) => {
      const baseStock = getCurrentWarehouseStock(row, field);
      const entered = Number(mobileWizardState.values.get(row.rowId) || 0);
      const finalStock = mode === "modify" ? entered : baseStock + entered;
      return `
        <div class="mobile-stock-summary-item">
          <strong>Talle ${row.size}</strong>
          <span>${baseStock} -> ${finalStock}</span>
        </div>
      `;
    }).join("");
  }
  setMobileModeTag(mobileModeTagSummary, mode);
}

async function applyMobileWizardAndSave() {
  const { rows, selectedField, mode } = mobileWizardState;
  if (!rows.length || !selectedField || !mode) return;

  rows.forEach((row) => {
    const entered = Number(mobileWizardState.values.get(row.rowId) || 0);
    const baseStock = getCurrentWarehouseStock(row, selectedField);
    const nextValue = mode === "modify" ? entered : baseStock + entered;
    markChange(row.rowId, selectedField, nextValue);
  });

  closeMobileStockWizard();
  await saveAll();
}

// Funciones globales para toggle
window.toggleStockImagePreview = function (productId, anchorBtn) {
  const popover = document.getElementById("stock-image-preview-popover");
  const img = document.getElementById("stock-image-preview-img");
  const empty = document.getElementById("stock-image-preview-empty");
  if (!popover || !img || !anchorBtn) return;

  const productKey = String(productId);
  const wasOpen = popover.classList.contains("show") && popover.dataset.productId === productKey;
  closeStockImagePreview();
  if (wasOpen) return;

  const url = productMainImageUrls.get(productKey);
  popover.dataset.productId = productKey;
  if (url) {
    img.src = url;
    img.alt = "Imagen principal del producto";
    img.hidden = false;
    if (empty) empty.hidden = true;
  } else {
    img.removeAttribute("src");
    img.hidden = true;
    if (empty) empty.hidden = false;
  }

  const rect = anchorBtn.getBoundingClientRect();
  const popoverWidth = 196;
  popover.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 280)}px`;
  popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8))}px`;
  popover.classList.add("show");
  popover.setAttribute("aria-hidden", "false");

  setTimeout(() => {
    document.addEventListener("click", onStockImagePreviewOutsideClick, true);
    document.addEventListener("keydown", onStockImagePreviewEsc, true);
  }, 0);
};

window.toggleProductCard = function(productId) {
  const card = document.querySelector(`[data-product-id="${productId}"]`);
  const variantsContainer = document.getElementById(`variants-${productId}`);
  if (!card || !variantsContainer) return;
  
  card.classList.toggle("expanded");
  variantsContainer.classList.toggle("expanded");
};

window.toggleVariantCard = function(productId, variantId) {
  const sizesDetail = document.getElementById(`sizes-${productId}-${variantId}`);
  if (!sizesDetail) return;
  
  sizesDetail.classList.toggle("expanded");
};

window.toggleEditMode = function(productId, variantId) {
  if (!canEditStock) {
    alert("No tienes permiso para editar el stock.");
    return;
  }
  if (isMobileStockViewport()) {
    openMobileStockWizard(productId, variantId);
    return;
  }
  toggleVariantTableEditMode(productId, variantId);
};

window.toggleGeneralEditMode = function(productId) {
  if (!canEditStock) {
    alert("No tienes permiso para editar el stock.");
    return;
  }
  if (!isMobileStockViewport()) {
    alert("Editar general está disponible en vista móvil.");
    return;
  }
  openMobileProductStockWizard(productId);
};

function markChange(rowId, field, value) {
  // Buscar la fila usando rowId o id+size como fallback
  const base = allData.find((r) => 
    (r.rowId && String(r.rowId) === String(rowId)) || 
    String(r.id) === String(rowId)
  );
  if (!base) {
    console.warn("No se encontró fila con rowId:", rowId);
    return;
  }
  
  // Usar rowId como clave única, o id+size si no existe rowId
  const uniqueKey = base.rowId || `${base.id}_${base.size || 'null'}`;
  
  const current = pendingChanges.get(uniqueKey) || { 
    stock_general: base.stock_general, 
    stock_venta_publico: base.stock_venta_publico, 
    price: base.price, 
    active: base.active 
  };
  current[field] = value;
  
  // Calcular stock total para comparación
  const currentStockGeneral = current.stock_general !== undefined ? current.stock_general : base.stock_general;
  const currentStockVentaPublico = current.stock_venta_publico !== undefined ? current.stock_venta_publico : base.stock_venta_publico;
  
  // Si no cambió respecto al original, quitar de pending
  const same =
    Number(currentStockGeneral ?? 0) === Number(base.stock_general ?? 0) &&
    Number(currentStockVentaPublico ?? 0) === Number(base.stock_venta_publico ?? 0) &&
    Number(current.price ?? 0) === Number(base.price ?? 0) &&
    Boolean(current.active) === Boolean(base.active);
  if (same) {
    pendingChanges.delete(uniqueKey);
  } else {
    pendingChanges.set(uniqueKey, current);
  }
  setPendingCount();
  
  // Actualizar solo la fila afectada para no perder el foco
  const inputEl = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="${field}"]`);
  const tr = inputEl ? inputEl.closest("tr") : null;
  if (tr) {
    tr.classList.toggle("dirty-row", pendingChanges.has(uniqueKey));
    
    // Recalcular stock total y actualizar visualización
    const stockTotal = currentStockGeneral + currentStockVentaPublico;
    const stockTotalCell = tr.querySelector(".stock-total-cell");
    if (stockTotalCell) {
      stockTotalCell.textContent = stockTotal;
    }
    
    // Recalcular low-stock si cambió el stock
    if (field === "stock_general" || field === "stock_venta_publico") {
      if (Number(stockTotal) <= 3) {
        tr.classList.add("low-stock");
      } else {
        tr.classList.remove("low-stock");
      }
    }
    
    if (field === "price") {
      const applyBtn = tr.querySelector("button[data-apply-price]");
      if (applyBtn) {
        const changed = Number(value) !== Number(base.price ?? 0);
        applyBtn.style.display = changed ? "inline-block" : "none";
      }
    }
  }
}

// Función para agregar carga de stock
async function addStockLoad(rowId, variantId, size, loadQty) {
  if (!loadQty || loadQty <= 0) {
    msg.textContent = "La cantidad debe ser mayor a 0";
    return;
  }
  
  msg.textContent = "Aplicando carga...";
  
  // Normalizar el tamaño PRIMERO para asegurar consistencia
  const normalizedSize = normalizeSize(size);
  if (!normalizedSize) {
    console.error("Error: No se pudo normalizar el tamaño", { size });
    msg.textContent = "Error: Tamaño inválido";
    return;
  }
  
  // Buscar la fila usando el tamaño normalizado
  // Primero intentar por rowId exacto, luego por combinación variantId+size normalizado
  const row = allData.find(r => {
    // Primero intentar por rowId exacto
    if (r.rowId === rowId) return true;
    // Si no coincide, buscar por variantId + size normalizado
    const rSizeNormalized = normalizeSize(r.size);
    return String(r.id) === String(variantId) && rSizeNormalized === normalizedSize;
  });
  
  if (!row) {
    console.error("Error: No se encontró la fila", { 
      rowId, 
      variantId, 
      size, 
      normalizedSize,
      allDataSample: allData.slice(0, 3).map(r => ({ rowId: r.rowId, id: r.id, size: r.size }))
    });
    msg.textContent = "Error: No se encontró la fila. Recargá la página.";
    return;
  }
  
  const uniqueKey = row.rowId || `${row.id}_${row.size || 'null'}`;
  const pending = pendingChanges.get(uniqueKey);
  const currentStockGeneral = Number(
    pending?.stock_general !== undefined ? pending.stock_general : (row.stock_general || 0)
  );
  const newStockGeneral = currentStockGeneral + loadQty;

  // Reflejar el valor en el input visible y marcar cambio pendiente.
  const stockGeneralInput = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="stock_general"]`);
  if (stockGeneralInput) {
    stockGeneralInput.value = String(newStockGeneral);
  }
  markChange(rowId, "stock_general", newStockGeneral);
  
  msg.textContent = `Carga pendiente: +${loadQty} (guardá cambios para confirmar)`;
  updateLowAlertBadge();
}

// Event listeners para tabla y tarjetas
// Se registra en document porque la vista activa usa tarjetas en #products-container
// mientras que #tbl tbody permanece en el DOM pero oculto.
document.addEventListener("click", async (e) => {
  console.log("Event listener ejecutado", { target: e.target.tagName, className: e.target.className });
  
  // Debug: verificar clicks en botones (incluso si están deshabilitados)
  const clickedButton = e.target.closest("button");
  if (clickedButton && (clickedButton.hasAttribute("data-print-labels") || clickedButton.hasAttribute("data-add-load"))) {
    console.log("Click detectado en botón:", {
      className: clickedButton.className,
      disabled: clickedButton.disabled,
      canEditStock: canEditStock,
      hasDataPrint: clickedButton.hasAttribute("data-print-labels"),
      hasDataAddLoad: clickedButton.hasAttribute("data-add-load")
    });
    
    // Si el botón está deshabilitado, mostrar mensaje útil
    if (clickedButton.disabled) {
      if (!canEditStock) {
        msg.textContent = "No tenés permisos para realizar esta acción";
        alert("No tenés permisos para realizar esta acción. Contactá al administrador.");
      } else {
        msg.textContent = "El botón está deshabilitado. Recargá la página.";
        console.warn("Botón deshabilitado pero usuario tiene permisos - posible error de renderizado");
      }
      return;
    }
  }
  
  // Guardar fila
  const saveBtn = e.target.closest("button[data-save]");
  if (saveBtn) {
    if (!canEditStock) {
      alert("No tienes permiso para editar el stock.");
      return;
    }
    
    const rowId = saveBtn.getAttribute("data-save");
    const variantId = saveBtn.getAttribute("data-variant-id");
    const size = saveBtn.getAttribute("data-size");
    
    if (!variantId || !size || !rowId) {
      console.error("Error: No se encontraron variantId, size o rowId en el botón", { variantId, size, rowId });
      msg.textContent = "Error: Datos incompletos en el botón de guardar";
      saveBtn.disabled = false;
      return;
    }
    
    // Validar que variantId sea un UUID válido (formato básico)
    if (!variantId || typeof variantId !== 'string' || variantId.length < 30) {
      console.error("Error: variantId no es un UUID válido:", variantId);
      msg.textContent = "Error: ID de variante inválido";
      saveBtn.disabled = false;
      return;
    }
    
    // Usar variantId directamente como UUID (string)
    const variantIdStr = variantId;
    
    const row = allData.find((r) => (r.rowId && String(r.rowId) === String(rowId)) || (String(r.id) === String(variantId) && String(r.size) === String(size)));
    if (!row) {
      console.error("Error: No se encontró la fila con rowId:", rowId, "variantId:", variantId, "size:", size);
      msg.textContent = `Error: No se encontró la fila`;
      saveBtn.disabled = false;
      return;
    }
    
    // Buscar inputs en tabla o tarjetas usando rowId
    const stockGeneralInput = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="stock_general"]`);
    const stockVentaPublicoInput = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="stock_venta_publico"]`);
    const priceInput = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="price"]`);
    const activeInput = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="active"]`);
    
    if (!stockGeneralInput || !stockVentaPublicoInput || !priceInput || !activeInput) {
      console.error("Error: No se encontraron los campos de entrada", { rowId, stockGeneralInput: !!stockGeneralInput, stockVentaPublicoInput: !!stockVentaPublicoInput, priceInput: !!priceInput, activeInput: !!activeInput });
      msg.textContent = "Error: No se encontraron los campos de entrada";
      saveBtn.disabled = false;
      return;
    }
    
    const stockGeneral = parseInt(stockGeneralInput.value || "0", 10);
    const stockVentaPublico = parseInt(stockVentaPublicoInput.value || "0", 10);
    const price = parseFloat(priceInput.value || "0");
    const active = activeInput.checked;
    
    console.log("Guardando fila:", { rowId, variantId: variantIdStr, size: row.size, stockGeneral, stockVentaPublico, price, active });
    
    saveBtn.disabled = true;
    
    // Obtener IDs de almacenes
    const { data: warehouses, error: warehousesError } = await supabase
      .from("warehouses")
      .select("id, code")
      .in("code", ["general", "venta-publico"]);
    
    if (warehousesError) {
      msg.textContent = `Error: ${warehousesError.message}`;
      saveBtn.disabled = false;
      return;
    }
    
    const warehouseMap = new Map();
    warehouses.forEach(w => warehouseMap.set(w.code, w.id));
    const generalWarehouseId = warehouseMap.get("general");
    const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
    
    if (!generalWarehouseId || !ventaPublicoWarehouseId) {
      msg.textContent = "Error: No se encontraron los almacenes necesarios";
      saveBtn.disabled = false;
      return;
    }
    
    // Preparar actualizaciones
    let error = null;
    
    // Si la fila tiene un talle (size), actualizar variant_size_warehouse_stock y variant_sizes
    if (row.size) {
      // --- Etapa 2: write-path via rpc_set_variant_size_stock_batch ---
      // Reemplaza: upsert directo a variant_size_warehouse_stock x2 + log_stock_change x2
      // La RPC es transaccional, valida stock >= 0, usa FOR UPDATE y logea en stock_history.
      // variant_sizes y variant_warehouse_stock se siguen derivando via triggers 84 y 145.
      const sizeValue = row.size;
      const rpcPayload = [
        {
          variant_id:   variantIdStr,
          product_id:   row.products?.id ?? null,
          size:         sizeValue,
          warehouse_id: generalWarehouseId,
          stock_qty:    stockGeneral,
        },
        {
          variant_id:   variantIdStr,
          product_id:   row.products?.id ?? null,
          size:         sizeValue,
          warehouse_id: ventaPublicoWarehouseId,
          stock_qty:    stockVentaPublico,
        },
      ];

      const { data: rpcData, error: rpcError } = await supabase.rpc(
        "rpc_set_variant_size_stock_batch",
        { p_items: rpcPayload, p_source: "manual_edit" }
      );

      if (rpcError) {
        console.error("❌ rpc_set_variant_size_stock_batch error:", rpcError);
        msg.textContent = `Error guardando stock por talle: ${rpcError.message}`;
        saveBtn.disabled = false;
        return;
      }

      if (!rpcData?.ok) {
        console.error("❌ rpc_set_variant_size_stock_batch respondió ok=false:", rpcData);
        msg.textContent = "Error guardando stock por talle (respuesta inesperada del servidor).";
        saveBtn.disabled = false;
        return;
      }

      console.log(
        `✅ rpc_set_variant_size_stock_batch: ${rpcData.changed_items} cambio(s), ` +
        `${rpcData.skipped_unchanged} sin cambio.`,
        rpcData.details
      );

      // Stock guardado. Ahora actualizar precio y estado activo en product_variants.
      // (Esta escritura no es sobre stock — se mantendrá separada hasta que haya
      //  una RPC específica de metadatos de variante en una etapa posterior.)
      const { error: variantError } = await supabase
        .from("product_variants")
        .update({ price, active })
        .eq("id", variantIdStr);

      error = variantError ?? null;
    } else {
      // Etapa 2: write-path via rpc_set_variant_warehouse_stock_batch (sin talle).
      // Reemplaza: upsert directo a variant_warehouse_stock x2 + log_stock_change x2.
      // La RPC es transaccional, valida stock >= 0, usa FOR UPDATE y logea en stock_history.
      const rpcPayload = [
        {
          variant_id:   variantIdStr,
          product_id:   row.products?.id ?? null,
          warehouse_id: generalWarehouseId,
          stock_qty:    stockGeneral,
        },
        {
          variant_id:   variantIdStr,
          product_id:   row.products?.id ?? null,
          warehouse_id: ventaPublicoWarehouseId,
          stock_qty:    stockVentaPublico,
        },
      ];

      const { data: rpcData, error: rpcError } = await supabase.rpc(
        "rpc_set_variant_warehouse_stock_batch",
        { p_items: rpcPayload, p_source: "manual_edit" }
      );

      if (rpcError) {
        console.error("❌ rpc_set_variant_warehouse_stock_batch error:", rpcError);
        error = rpcError;
      } else if (!rpcData?.ok) {
        console.error("❌ rpc_set_variant_warehouse_stock_batch respondió ok=false:", rpcData);
        error = new Error("Error guardando stock (respuesta inesperada del servidor).");
      } else {
        console.log(
          `✅ rpc_set_variant_warehouse_stock_batch: ${rpcData.changed_items} cambio(s), ` +
          `${rpcData.skipped_unchanged} sin cambio.`,
          rpcData.details
        );
      }

      // Precio y activo: siguen como escritura directa hasta que haya RPC de metadatos.
      if (!error) {
        const { error: variantError } = await supabase
          .from("product_variants")
          .update({ price, active })
          .eq("id", variantIdStr);
        if (variantError) error = variantError;
      }
    }
    
    saveBtn.disabled = false;
    if (!error) {
      if (row) {
        row.stock_general = stockGeneral;
        row.stock_venta_publico = stockVentaPublico;
        row.stock_total = stockGeneral + stockVentaPublico;
        row.price = price;
        row.active = active;
      }
      const uniqueKey = row.rowId || `${row.id}_${row.size || 'null'}`;
      pendingChanges.delete(uniqueKey);
      setPendingCount();
      render();
    }
    msg.textContent = error ? `Error: ${error.message}` : "Guardado";
    return;
  }
  
  // Agregar carga de stock
  // Intentar encontrar el botón de varias formas
  let addLoadBtn = e.target.closest("button[data-add-load]");
  // Si no encuentra, puede ser que el click fue en el texto dentro del botón
  if (!addLoadBtn && e.target.tagName === 'BUTTON' && e.target.hasAttribute("data-add-load")) {
    addLoadBtn = e.target;
  }
  // Si aún no encuentra, buscar por clase
  if (!addLoadBtn) {
    const btn = e.target.closest(".carga-btn");
    if (btn && btn.hasAttribute("data-add-load")) {
      addLoadBtn = btn;
    }
  }
  
  if (addLoadBtn) {
    console.log("Botón de carga encontrado", { 
      disabled: addLoadBtn.disabled, 
      canEditStock,
      hasAttributes: {
        rowId: addLoadBtn.hasAttribute("data-row-id"),
        variantId: addLoadBtn.hasAttribute("data-variant-id"),
        size: addLoadBtn.hasAttribute("data-size")
      }
    });
    
    if (addLoadBtn.disabled) {
      console.warn("Botón deshabilitado - no se puede procesar");
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    
    if (!canEditStock) {
      alert("No tienes permiso para editar el stock.");
      return;
    }
    
    const rowId = addLoadBtn.getAttribute("data-row-id");
    const variantId = addLoadBtn.getAttribute("data-variant-id");
    const size = addLoadBtn.getAttribute("data-size");
    
    if (!rowId || !variantId || !size) {
      console.error("Error: Datos incompletos en botón de carga", { rowId, variantId, size });
      msg.textContent = "Error: Datos incompletos. Recargá la página.";
      return;
    }
    
    // Buscar el input de carga en la misma fila
    const row = addLoadBtn.closest("tr");
    const loadInput = row ? row.querySelector(`input[data-load-input="${rowId}"]`) : null;
    
    if (!loadInput) {
      console.error("Error: No se encontró el input de carga", { rowId });
      msg.textContent = "Error: No se encontró el campo de carga.";
      return;
    }
    
    const loadQty = parseInt(loadInput.value || "0", 10);
    
    if (loadQty <= 0) {
      msg.textContent = "Ingresá una cantidad mayor a 0 para cargar";
      return;
    }
    
    console.log("Iniciando carga de stock:", { rowId, variantId, size, loadQty });
    
    try {
      await addStockLoad(rowId, variantId, size, loadQty);
      loadInput.value = ""; // Limpiar input después de cargar exitosamente
    } catch (error) {
      console.error("Error en carga de stock:", error);
      msg.textContent = `Error al cargar stock: ${error.message}`;
    }
    return;
  }
  
  // Imprimir etiquetas
  const printBtn = e.target.closest("button[data-print-labels]");
  if (printBtn) {
    e.preventDefault();
    e.stopPropagation();
    
    console.log("Botón de impresión clickeado", { disabled: printBtn.disabled, canEditStock });
    
    // Verificar si el botón está deshabilitado
    if (printBtn.disabled) {
      console.log("Botón de impresión deshabilitado - no se puede imprimir");
      msg.textContent = "El botón está deshabilitado. Verificá tus permisos.";
      return;
    }
    
    if (!canEditStock) {
      alert("No tienes permiso para imprimir etiquetas.");
      return;
    }
    
    const rowId = printBtn.getAttribute("data-row-id");
    const productName = printBtn.getAttribute("data-product-name");
    const color = printBtn.getAttribute("data-color");
    const size = printBtn.getAttribute("data-size");
    const sku = printBtn.getAttribute("data-sku");
    const qrCode = printBtn.getAttribute("data-qr-code") || sku;
    
    if (!rowId || !sku) {
      console.error("Error: Datos incompletos en botón de impresión", { rowId, sku, productName, color, size });
      msg.textContent = "Error: Datos incompletos. Recargá la página.";
      return;
    }
    
    // Buscar el input de carga en la misma fila
    const row = printBtn.closest("tr");
    const loadInput = row ? row.querySelector(`input[data-load-input="${rowId}"]`) : null;
    
    if (!loadInput) {
      console.error("Error: No se encontró el input de carga", { rowId });
      msg.textContent = "Error: No se encontró el campo de carga.";
      return;
    }
    
    const qty = parseInt(loadInput.value || "0", 10);
    
    if (qty <= 0) {
      msg.textContent = "Ingresá una cantidad mayor a 0 en el campo Carga para imprimir";
      return;
    }
    
    console.log("Iniciando impresión de etiquetas:", { rowId, sku, productName, color, size, qty, qrCode });
    
    // Verificar que la función de impresión esté disponible
    if (typeof printProductLabelsZebra !== 'function') {
      console.error("Error: printProductLabelsZebra no está disponible");
      msg.textContent = "Error: Función de impresión no disponible. Recargá la página.";
      alert("Error: La función de impresión no está disponible. Verificá que el módulo qz-printing.js se haya cargado correctamente.");
      return;
    }
    
    // Deshabilitar botón mientras imprime
    printBtn.disabled = true;
    const originalText = printBtn.textContent;
    printBtn.textContent = "Imprimiendo...";
    msg.textContent = `Imprimiendo ${qty} etiqueta(s)...`;
    
    // Imprimir usando la cantidad de carga
    try {
      await printProductLabelsZebra(sku, productName, color, size, qty, qrCode);
      msg.textContent = `✅ ${qty} etiqueta(s) enviada(s) a imprimir`;
    } catch (error) {
      console.error("Error imprimiendo etiquetas:", error);
      const errorMsg = error.message || 'Error desconocido';
      msg.textContent = `Error al imprimir etiquetas: ${errorMsg}`;
      alert(`Error al imprimir: ${errorMsg}\n\nVerificá que:\n- QZ Tray esté instalado y ejecutándose\n- La impresora esté conectada\n- Tengas sesión activa`);
    } finally {
      // Rehabilitar botón después de imprimir
      printBtn.disabled = false;
      printBtn.textContent = originalText;
    }
    return;
  }
  
  // Aplicar precio a todas las variantes del producto
  const applyBtn = e.target.closest("button[data-apply-price]");
  if (applyBtn) {
    const productId = applyBtn.getAttribute("data-product-id");
    const sourceRowId = applyBtn.getAttribute("data-source-id");
    const sourceInput = (tbody || document).querySelector(`input[data-row-id="${sourceRowId}"][data-field="price"]`);
    const targetPrice = parseFloat(sourceInput?.value || "0");
    if (!Number.isFinite(targetPrice)) return;
    const variants = allData.filter((r) => String(r.products?.id) === String(productId));
    variants.forEach((r) => {
      const uniqueKey = r.rowId || `${r.id}_${r.size || 'null'}`;
      const change = pendingChanges.get(uniqueKey) || { 
        stock_general: r.stock_general, 
        stock_venta_publico: r.stock_venta_publico, 
        price: r.price, 
        active: r.active 
      };
      change.price = targetPrice;
      // Si no cambió vs original, limpiar; si cambió, set
      const currentStockGeneral = change.stock_general !== undefined ? change.stock_general : r.stock_general;
      const currentStockVentaPublico = change.stock_venta_publico !== undefined ? change.stock_venta_publico : r.stock_venta_publico;
      if (Number(change.price ?? 0) === Number(r.price ?? 0) &&
          Number(currentStockGeneral ?? 0) === Number(r.stock_general ?? 0) &&
          Number(currentStockVentaPublico ?? 0) === Number(r.stock_venta_publico ?? 0) &&
          Boolean(change.active) === Boolean(r.active)) {
        pendingChanges.delete(uniqueKey);
      } else {
        pendingChanges.set(uniqueKey, change);
      }
      // Reflejar en input visible si está en el DOM
      const inputRowId = r.rowId || `${r.id}_${r.size || 'null'}`;
      const input = (tbody || document).querySelector(`input[data-row-id="${inputRowId}"][data-field="price"]`);
      if (input) input.value = String(targetPrice);
      const rowEl = input ? input.closest("tr") : null;
      if (rowEl) rowEl.classList.add("dirty-row");
    });
    setPendingCount();
    // Actualizar visibilidad de botones "Aplicar a todos"
    (tbody || document).querySelectorAll("button[data-apply-price]").forEach((b) => {
      const sid = b.getAttribute("data-source-id");
      const base = allData.find((r) => {
        const rowId = r.rowId || `${r.id}_${r.size || 'null'}`;
        return String(rowId) === String(sid);
      });
      if (base) {
        const uniqueKey = base.rowId || `${base.id}_${base.size || 'null'}`;
        const pending = pendingChanges.get(uniqueKey);
        const changed = pending && Number(pending.price ?? 0) !== Number(base?.price ?? 0);
        b.style.display = changed ? "inline-block" : "none";
      }
    });
    msg.textContent = `Precio aplicado a ${variants.length} variantes`;
  }
});

// Cambios en vivo en inputs -> marcar como pendiente (funciona para tabla y tarjetas)
document.addEventListener("input", (e) => {
  if (!canEditStock) {
    e.target.value = e.target.defaultValue;
    if (e.target.type === "checkbox") {
      e.target.checked = e.target.defaultChecked;
    }
    alert("No tienes permiso para editar el stock.");
    return;
  }
  
  const input = e.target.closest("input[data-row-id]");
  if (!input) return;
  const rowId = input.getAttribute("data-row-id");
  const field = input.getAttribute("data-field");
  let value;
  if (field === "active") {
    value = input.checked;
  } else {
    value = field === "price" ? parseFloat(input.value || "0") : parseInt(input.value || "0", 10);
    if (!Number.isFinite(value) || value < 0) value = 0;
  }
  markChange(rowId, field, value);
  if (field === "stock_general" || field === "stock_venta_publico") updateLowAlertBadge();
});

function clampMobileQty(value) {
  const parsed = parseInt(value || "0", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function triggerMobileHapticFeedback(duration = 12) {
  if (!("vibrate" in navigator)) return;
  try {
    navigator.vibrate(duration);
  } catch (_) {
    // Ignore devices/browsers that block vibration.
  }
}

function saveMobileCurrentStepValue() {
  if (mobileWizardState.lectorActive) return;
  const row = mobileWizardState.rows[mobileWizardState.currentIndex];
  if (!row || !mobileQtyInput) return;
  mobileWizardState.values.set(row.rowId, clampMobileQty(mobileQtyInput.value));
  renderMobileTotalCounter();
}

function syncCurrentMobileQtyToState() {
  const row = mobileWizardState.rows[mobileWizardState.currentIndex];
  if (!row || !mobileQtyInput || mobileWizardState.lectorActive) return;
  mobileWizardState.values.set(row.rowId, clampMobileQty(mobileQtyInput.value));
  renderMobileTotalCounter();
  renderMobileSizeJumpButtons();
}

mobileWarehouseButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    mobileWarehouseButtons.forEach((item) => item.classList.remove("active"));
    btn.classList.add("active");
    mobileWizardState.selectedField = btn.getAttribute("data-mobile-warehouse");
    mobileWizardState.lectorActive = false;
    if (mobileLectorCheckbox) mobileLectorCheckbox.checked = false;
    if (mobileWizardState.scope === "product") {
      mobileWizardState.mode = "modify";
      mobileWizardState.currentIndex = 0;
      mobileWizardState.lectorActive = true;
      if (mobileLectorCheckbox) mobileLectorCheckbox.checked = true;
      mobileWizardState.rows.forEach((r) => {
        mobileWizardState.values.set(r.rowId, 0);
      });
      mobileLectorQrMap.clear();
      void preloadMobileLectorQrCache();
      switchMobileWizardStep(mobileStepSize);
      updateMobileSizeStep();
      return;
    }
    switchMobileWizardStep(mobileStepMode);
  });
});

mobileModeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    mobileModeButtons.forEach((item) => item.classList.remove("active"));
    btn.classList.add("active");
    mobileWizardState.mode = btn.getAttribute("data-mobile-mode");
    mobileWizardState.currentIndex = 0;
    mobileWizardState.lectorActive = false;
    if (mobileLectorCheckbox) mobileLectorCheckbox.checked = false;
    switchMobileWizardStep(mobileStepSize);
    updateMobileSizeStep();
  });
});

if (mobileMinusBtn) {
  mobileMinusBtn.addEventListener("click", () => {
    if (!mobileQtyInput) return;
    triggerMobileHapticFeedback();
    const current = clampMobileQty(mobileQtyInput.value);
    mobileQtyInput.value = String(Math.max(0, current - 1));
    syncCurrentMobileQtyToState();
  });
}

if (mobilePlusBtn) {
  mobilePlusBtn.addEventListener("click", () => {
    if (!mobileQtyInput) return;
    triggerMobileHapticFeedback();
    const current = clampMobileQty(mobileQtyInput.value);
    mobileQtyInput.value = String(current + 1);
    syncCurrentMobileQtyToState();
  });
}

if (mobileQtyInput) {
  mobileQtyInput.addEventListener("input", () => {
    mobileQtyInput.value = String(clampMobileQty(mobileQtyInput.value));
    syncCurrentMobileQtyToState();
  });
}

function submitMobileLectorScan(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || !mobileWizardState.open || !mobileWizardState.lectorActive) return;
  if (!isCompleteMobileLectorCode(trimmed)) return;
  mobileLectorScanQueue.push(trimmed);
  if (mobileLectorInput) {
    mobileLectorInput.value = "";
    if (shouldAutoFocusMobileLectorInput()) {
      window.setTimeout(() => mobileLectorInput.focus(), 10);
    }
  }
  if (mobileLectorIsProcessingQueue) return;
  mobileLectorIsProcessingQueue = true;
  void (async () => {
    try {
      while (mobileLectorScanQueue.length > 0) {
        const nextCode = mobileLectorScanQueue.shift();
        if (!nextCode) continue;
        try {
          await processLectorQrCode(nextCode);
        } catch (err) {
          console.error("[stock] lector scan:", err);
          setMobileLectorStatus("Error al procesar el QR.", "error");
          triggerMobileHapticFeedback(60);
        }
      }
    } finally {
      mobileLectorIsProcessingQueue = false;
    }
  })();
}

if (mobileLectorCheckbox) {
  mobileLectorCheckbox.addEventListener("change", () => {
    mobileWizardState.lectorActive = Boolean(mobileLectorCheckbox.checked);
    if (mobileWizardState.lectorActive) {
      mobileWizardState.rows.forEach((r) => {
        mobileWizardState.values.set(r.rowId, 0);
      });
      mobileLectorQrMap.clear();
      void preloadMobileLectorQrCache();
      if (shouldAutoFocusMobileLectorInput()) {
        window.setTimeout(() => {
          if (mobileLectorInput) mobileLectorInput.focus();
        }, 30);
      }
    } else {
      mobileLectorScanQueue = [];
    }
    updateMobileSizeStep();
  });
}

if (mobileLectorInput) {
  mobileLectorInput.addEventListener("input", () => {
    if (!mobileWizardState.lectorActive) return;
    const v = mobileLectorInput.value.trim();
    if (v.length === 0) return;
    if (mobileLectorInputTimeout) clearTimeout(mobileLectorInputTimeout);
    mobileLectorInputTimeout = window.setTimeout(() => {
      mobileLectorInputTimeout = null;
      const current = mobileLectorInput.value.trim();
      if (isCompleteMobileLectorCode(current)) {
        submitMobileLectorScan(current);
      }
    }, 50);
  });

  mobileLectorInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (mobileLectorInputTimeout) {
      clearTimeout(mobileLectorInputTimeout);
      mobileLectorInputTimeout = null;
    }
    submitMobileLectorScan(mobileLectorInput.value);
  });
}

if (mobileLectorReset) {
  mobileLectorReset.addEventListener("click", () => {
    if (!mobileWizardState.lectorActive) return;
    mobileWizardState.rows.forEach((r) => {
      mobileWizardState.values.set(r.rowId, 0);
    });
    renderMobileLectorGrid();
    renderMobileTotalCounter();
    setMobileLectorStatus("Contadores reiniciados.", "success");
    if (mobileLectorInput && shouldAutoFocusMobileLectorInput()) mobileLectorInput.focus();
  });
}

if (mobileLectorGrid) {
  mobileLectorGrid.addEventListener("input", (e) => {
    const inp = e.target.closest("input.mobile-stock-lector-cell-count");
    if (!inp || !mobileWizardState.lectorActive) return;
    const attrKey = inp.getAttribute("data-row-id");
    const row = mobileWizardState.rows.find((r) => String(r.rowId) === String(attrKey));
    if (!row) return;
    const n = clampMobileQty(inp.value);
    mobileWizardState.values.set(row.rowId, n);
    renderMobileTotalCounter();
    const cell = inp.closest(".mobile-stock-lector-cell");
    if (cell) cell.classList.toggle("has-scans", n > 0);
  });
}

if (mobileSizeJump) {
  mobileSizeJump.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-mobile-size-index]");
    if (!target) return;
    const nextIndex = parseInt(target.getAttribute("data-mobile-size-index") || "-1", 10);
    if (!Number.isFinite(nextIndex) || nextIndex < 0 || nextIndex >= mobileWizardState.rows.length) return;
    saveMobileCurrentStepValue();
    mobileWizardState.currentIndex = nextIndex;
    updateMobileSizeStep();
  });
}

if (mobileBackBtn) {
  mobileBackBtn.addEventListener("click", () => {
    saveMobileCurrentStepValue();
    if (mobileWizardState.lectorActive) {
      mobileWizardState.lectorActive = false;
      if (mobileLectorCheckbox) mobileLectorCheckbox.checked = false;
      if (mobileWizardState.scope === "product") {
        switchMobileWizardStep(mobileStepWarehouse);
      } else {
        switchMobileWizardStep(mobileStepMode);
      }
      return;
    }
    if (mobileWizardState.currentIndex === 0) {
      switchMobileWizardStep(mobileStepMode);
      return;
    }
    mobileWizardState.currentIndex -= 1;
    updateMobileSizeStep();
  });
}

if (mobileNextBtn) {
  mobileNextBtn.addEventListener("click", () => {
    saveMobileCurrentStepValue();
    if (mobileWizardState.lectorActive && mobileWizardState.mode === "modify") {
      buildMobileSummary();
      switchMobileWizardStep(mobileStepSummary);
      return;
    }
    const isLast = mobileWizardState.currentIndex >= mobileWizardState.rows.length - 1;
    if (isLast) {
      buildMobileSummary();
      switchMobileWizardStep(mobileStepSummary);
      return;
    }
    mobileWizardState.currentIndex += 1;
    updateMobileSizeStep();
  });
}

if (mobileSummaryBackBtn) {
  mobileSummaryBackBtn.addEventListener("click", () => {
    switchMobileWizardStep(mobileStepSize);
    updateMobileSizeStep();
  });
}

if (mobileSaveBtn) {
  mobileSaveBtn.addEventListener("click", () => {
    if (!canEditStock) {
      alert("No tienes permiso para editar el stock.");
      return;
    }
    mobileSaveBtn.disabled = true;
    runStockTask("mobile_wizard_save", applyMobileWizardAndSave)
      .catch(() => {
        msg.textContent = "No se pudo guardar desde el asistente móvil. Reintentá.";
      })
      .finally(() => {
      mobileSaveBtn.disabled = false;
      });
  });
}

if (mobileWizardClose) {
  mobileWizardClose.addEventListener("click", closeMobileStockWizard);
}

if (window.visualViewport && !mobileKeyboardViewportListenersBound) {
  window.visualViewport.addEventListener("resize", updateMobileWizardKeyboardOffset);
  window.visualViewport.addEventListener("scroll", updateMobileWizardKeyboardOffset);
  mobileKeyboardViewportListenersBound = true;
}

if (mobileWizardOverlay) {
  mobileWizardOverlay.addEventListener("click", (e) => {
    if (e.target === mobileWizardOverlay) closeMobileStockWizard();
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && mobileWizardState.open) {
    closeMobileStockWizard();
  }
});

window.addEventListener("resize", () => {
  if (!mobileWizardState.open) return;
  if (!isMobileStockViewport()) {
    closeMobileStockWizard();
  }
});

// Guardar todos los pendientes
async function saveAll() {
  if (!canEditStock) {
    alert("No tienes permiso para editar el stock.");
    return;
  }
  
  if (pendingChanges.size === 0) return;
  saveAllBtn.disabled = true;
  msg.textContent = "Guardando cambios...";
  
  // Obtener IDs de almacenes
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  if (warehousesError) {
    msg.textContent = `Error: ${warehousesError.message}`;
    saveAllBtn.disabled = false;
    return;
  }
  
  const warehouseMap = new Map();
  warehouses.forEach(w => warehouseMap.set(w.code, w.id));
  const generalWarehouseId = warehouseMap.get("general");
  const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  
  if (!generalWarehouseId || !ventaPublicoWarehouseId) {
    msg.textContent = "Error: No se encontraron los almacenes necesarios";
    saveAllBtn.disabled = false;
    return;
  }
  
  // Preparar todas las actualizaciones y obtener stocks anteriores para historial
  const variantUpdates = [];
  // Etapa 2: ambas ramas de stock usan RPC. updates y historyLogs quedan vacíos.
  const updates = [];      // conservado; ya no recibe ítems de stock
  const historyLogs = [];  // conservado; ya no recibe ítems (ambas RPC manejan su historial)
  // ítems con talle    → rpc_set_variant_size_stock_batch (164)
  const rpcSizeItems = [];
  // ítems sin talle    → rpc_set_variant_warehouse_stock_batch (165)
  const rpcNoSizeItems = [];
  
  // Primero, obtener todos los stocks anteriores para historial
  const variantIdsForHistory = [];
  const rowsForHistory = new Map();
  pendingChanges.forEach((change, uniqueKey) => {
    const row = allData.find((r) => {
      const rKey = r.rowId || `${r.id}_${r.size || 'null'}`;
      return String(rKey) === String(uniqueKey);
    });
    if (row && (change.stock_general !== undefined || change.stock_venta_publico !== undefined)) {
      variantIdsForHistory.push(row.id);
      rowsForHistory.set(uniqueKey, row);
    }
  });
  
  // Obtener stocks anteriores en batch
  // Dividir en lotes para evitar error 400 con arrays grandes
  const oldStocksMap = new Map();
  if (variantIdsForHistory.length > 0) {
    const historyBatchSize = 100;
    const historyTotalBatches = Math.ceil(variantIdsForHistory.length / historyBatchSize);
    
    // Para variantes con talle — pre-fetch comentado: Etapa 2 lo delega a la RPC.
    // La RPC lee el stock anterior internamente con FOR UPDATE, más seguro que hacerlo aquí.
    /*
    let allOldSizeStocks = [];
    for (let batchIndex = 0; batchIndex < historyTotalBatches; batchIndex++) {
      const startIndex = batchIndex * historyBatchSize;
      const endIndex = Math.min(startIndex + historyBatchSize, variantIdsForHistory.length);
      const batchVariantIds = variantIdsForHistory.slice(startIndex, endIndex);

      if (batchVariantIds.length === 0) continue;

      const { data: oldSizeStocks } = await supabase
        .from("variant_size_warehouse_stock")
        .select("variant_id, size, warehouse_id, stock_qty")
        .in("variant_id", batchVariantIds)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

      if (oldSizeStocks && oldSizeStocks.length > 0) {
        allOldSizeStocks.push(...oldSizeStocks);
      }
    }

    if (allOldSizeStocks.length > 0) {
      allOldSizeStocks.forEach(s => {
        const key = `${s.variant_id}_${String(s.size || "").trim()}_${s.warehouse_id}`;
        oldStocksMap.set(key, s.stock_qty || 0);
      });
    }
    */

    // Para variantes sin talle — pre-fetch comentado: Etapa 2 lo delega a la RPC.
    // La RPC lee stock_before internamente con FOR UPDATE. Más seguro que hacerlo aquí.
    /*
    let allOldVariantStocks = [];
    for (let batchIndex = 0; batchIndex < historyTotalBatches; batchIndex++) {
      const startIndex = batchIndex * historyBatchSize;
      const endIndex = Math.min(startIndex + historyBatchSize, variantIdsForHistory.length);
      const batchVariantIds = variantIdsForHistory.slice(startIndex, endIndex);

      if (batchVariantIds.length === 0) continue;

      const { data: oldVariantStocks } = await supabase
        .from("variant_warehouse_stock")
        .select("variant_id, warehouse_id, stock_qty")
        .in("variant_id", batchVariantIds)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

      if (oldVariantStocks && oldVariantStocks.length > 0) {
        allOldVariantStocks.push(...oldVariantStocks);
      }
    }

    if (allOldVariantStocks.length > 0) {
      allOldVariantStocks.forEach(s => {
        const key = `${s.variant_id}_null_${s.warehouse_id}`;
        oldStocksMap.set(key, s.stock_qty || 0);
      });
    }
    */
  }
  
  pendingChanges.forEach((change, uniqueKey) => {
    // Buscar la fila usando uniqueKey (que puede ser rowId o id_size)
    const row = allData.find((r) => {
      const rKey = r.rowId || `${r.id}_${r.size || 'null'}`;
      return String(rKey) === String(uniqueKey);
    });
    
    if (!row) {
      console.warn("No se encontró fila para uniqueKey:", uniqueKey);
      return;
    }
    
    // Usar row.id directamente como UUID (string), no convertir a número
    const variantId = String(row.id);
    if (!variantId || variantId.length < 30) {
      console.warn("variantId inválido para uniqueKey:", uniqueKey, "variantId:", variantId);
      return;
    }
    
    const stockGeneral = change.stock_general !== undefined ? change.stock_general : (row?.stock_general || 0);
    const stockVentaPublico = change.stock_venta_publico !== undefined ? change.stock_venta_publico : (row?.stock_venta_publico || 0);
    
    // Obtener stock anterior para historial
    const sizeKey = row.size ? String(row.size).trim() : "null";
    const oldStockGeneralKey = `${variantId}_${sizeKey}_${generalWarehouseId}`;
    const oldStockVentaPublicoKey = `${variantId}_${sizeKey}_${ventaPublicoWarehouseId}`;
    const oldStockGeneral = oldStocksMap.get(oldStockGeneralKey) || 0;
    const oldStockVentaPublico = oldStocksMap.get(oldStockVentaPublicoKey) || 0;
    
    // Si la fila tiene un talle (size) → Etapa 2: acumular en rpcSizeItems.
    // La RPC maneja escritura, lock FOR UPDATE e historial en una sola transacción.
    // variant_sizes y variant_warehouse_stock se siguen derivando via triggers 84 y 145.
    if (row.size && (change.stock_general !== undefined || change.stock_venta_publico !== undefined)) {
      rpcSizeItems.push({
        variant_id:   variantId,
        product_id:   row.products?.id ?? null,
        size:         row.size,
        warehouse_id: generalWarehouseId,
        stock_qty:    stockGeneral,
      });
      rpcSizeItems.push({
        variant_id:   variantId,
        product_id:   row.products?.id ?? null,
        size:         row.size,
        warehouse_id: ventaPublicoWarehouseId,
        stock_qty:    stockVentaPublico,
      });
    } else {
      // Etapa 2: acumular en rpcNoSizeItems → rpc_set_variant_warehouse_stock_batch (165).
      // La RPC escribe, lockea e historiza en una sola transacción.
      if (change.stock_general !== undefined || change.stock_venta_publico !== undefined) {
        rpcNoSizeItems.push({
          variant_id:   variantId,
          product_id:   row.products?.id ?? null,
          warehouse_id: generalWarehouseId,
          stock_qty:    stockGeneral,
        });
        rpcNoSizeItems.push({
          variant_id:   variantId,
          product_id:   row.products?.id ?? null,
          warehouse_id: ventaPublicoWarehouseId,
          stock_qty:    stockVentaPublico,
        });
      }
    }
    
    // Actualizar precio y activo en product_variants
    const variantUpdate = {};
    if (change.price !== undefined) variantUpdate.price = change.price;
    if (change.active !== undefined) variantUpdate.active = change.active;
    
    if (Object.keys(variantUpdate).length > 0) {
      variantUpdates.push(
        supabase.from("product_variants").update(variantUpdate).eq("id", variantId)
      );
    }
  });
  
  // --- Etapa 2: RPC batch para ítems CON talle (164) ---
  let rpcSizeError = null;
  if (rpcSizeItems.length > 0) {
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "rpc_set_variant_size_stock_batch",
      { p_items: rpcSizeItems, p_source: "bulk_edit" }
    );
    if (rpcErr) {
      console.error("❌ rpc_set_variant_size_stock_batch (bulk) error:", rpcErr);
      rpcSizeError = rpcErr;
    } else if (!rpcData?.ok) {
      console.error("❌ rpc_set_variant_size_stock_batch (bulk) respondió ok=false:", rpcData);
      rpcSizeError = new Error("Error guardando stock por talle (respuesta inesperada del servidor).");
    } else {
      console.log(
        `✅ rpc_set_variant_size_stock_batch (bulk): ${rpcData.changed_items} cambio(s), ` +
        `${rpcData.skipped_unchanged} sin cambio.`,
        rpcData.details
      );
    }
  }

  // --- Etapa 2: RPC batch para ítems SIN talle (165) ---
  let rpcNoSizeError = null;
  if (rpcNoSizeItems.length > 0) {
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "rpc_set_variant_warehouse_stock_batch",
      { p_items: rpcNoSizeItems, p_source: "bulk_edit" }
    );
    if (rpcErr) {
      console.error("❌ rpc_set_variant_warehouse_stock_batch (bulk) error:", rpcErr);
      rpcNoSizeError = rpcErr;
    } else if (!rpcData?.ok) {
      console.error("❌ rpc_set_variant_warehouse_stock_batch (bulk) respondió ok=false:", rpcData);
      rpcNoSizeError = new Error("Error guardando stock sin talle (respuesta inesperada del servidor).");
    } else {
      console.log(
        `✅ rpc_set_variant_warehouse_stock_batch (bulk): ${rpcData.changed_items} cambio(s), ` +
        `${rpcData.skipped_unchanged} sin cambio.`,
        rpcData.details
      );
    }
  }

  // --- Ejecutar updates de precio/activo en product_variants ---
  // updates siempre vacío en Etapa 2: stock va por RPC. variantUpdates sigue en Promise.all.
  const allUpdates = [...updates, ...variantUpdates];
  const results = allUpdates.length > 0 ? await Promise.all(allUpdates) : [];
  const directError = results.find((r) => r.error)?.error ?? null;

  const error = rpcSizeError ?? rpcNoSizeError ?? directError ?? null;

  if (!error) {
    // historyLogs ya no recibe ítems: ambas RPCs historiza internamente. El forEach es no-op.
    // Conservado para no romper la estructura en caso de rollback a Etapa 1.
    historyLogs.forEach(_log => { /* vacío — mantenido por compatibilidad */ });
    // Aplicar cambios a cache y limpiar pendientes
    pendingChanges.forEach((change, uniqueKey) => {
      const row = allData.find((r) => {
        const rKey = r.rowId || `${r.id}_${r.size || 'null'}`;
        return String(rKey) === String(uniqueKey);
      });
      if (row) {
        if (change.stock_general !== undefined) row.stock_general = change.stock_general;
        if (change.stock_venta_publico !== undefined) row.stock_venta_publico = change.stock_venta_publico;
        row.stock_total = (row.stock_general || 0) + (row.stock_venta_publico || 0);
        if (change.price !== undefined) row.price = change.price;
        if (change.active !== undefined) row.active = change.active;
      }
    });
    pendingChanges.clear();
    setPendingCount();
    render();
    updateLowAlertBadge();
  }
  msg.textContent = error ? `Error: ${error.message}` : "Cambios guardados";
  saveAllBtn.disabled = false;
}

function discardAll() {
  pendingChanges.clear();
  setPendingCount();
  render();
}

async function runStockLoad() {
  const requestId = ++activeSearchRequest;

  // — Abort de la búsqueda anterior, scope propio para esta invocación —
  if (_stockSearchAbortScope) _stockSearchAbortScope.abort("new_search");
  const myScope = createAbortScope();
  _stockSearchAbortScope = myScope;
  const signal = myScope.signal;

  const { productIds, hasCriteria } = await resolveProductIdsForStockLoad({ signal });
  if (requestId !== activeSearchRequest || signal.aborted) return;

  if (!hasCriteria) {
    currentProductIds = [];
    dataLoaded = false;
    allData = [];
    pendingChanges.clear();
    setPendingCount();
    render();
    msg.textContent = stockLoadHintMessage();
    return;
  }

  if (loadInProgress) return;
  loadInProgress = true;

  try {
    if (requestId !== activeSearchRequest || signal.aborted) return;

    currentProductIds = productIds;
    if (productIds.length === 0) {
      dataLoaded = true;
      allData = [];
      pendingChanges.clear();
      setPendingCount();
      populateFilters([]);
      render();
      msg.textContent = "No se encontraron productos con los criterios seleccionados.";
      return;
    }

    const ok = await withTimeout(
      load(productIds, { signal }),
      SEARCH_LOAD_TIMEOUT_MS,
      "Timeout cargando stock. Revisa la conexión y toca Recargar."
    );
    if (requestId !== activeSearchRequest) return;
    dataLoaded = Boolean(ok);
  } catch (searchError) {
    if (requestId !== activeSearchRequest) return; // resultado de búsqueda vieja — ignorar
    const kind = searchError?.kind || classifyError(searchError);
    if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
      msg.textContent = "Sin conexión. Verificá tu red y toca Recargar.";
    } else {
      msg.textContent = searchError?.message || "Error al cargar resultados de búsqueda.";
    }
    console.error("Error en búsqueda de stock:", searchError, "kind:", kind);
  } finally {
    loadInProgress = false;
  }
}

async function runSearchByTerm(term) {
  void term;
  await runStockLoad();
}

reloadBtn.addEventListener("click", async () => {
  if (!isStockUiReady) return;
  const term = (q?.value || "").trim();
  const supplier = fSupplier?.value || "";
  if (term.length >= MIN_SEARCH_CHARS || supplier) {
    await runStockLoad();
    return;
  }

  currentProductIds = [];
  dataLoaded = false;
  allData = [];
  pendingChanges.clear();
  setPendingCount();
  render();
  msg.textContent = stockLoadHintMessage();
});

q.addEventListener("input", () => {
  if (!isStockUiReady && q?.disabled) return;
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    runSearchByTerm(q.value);
    searchTimeout = null;
  }, 450);
});

q.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (!isStockUiReady && q?.disabled) return;
  if (searchTimeout) {
    clearTimeout(searchTimeout);
    searchTimeout = null;
  }
  runSearchByTerm(q.value);
});

// Event listeners para filtros (solo filtran el set ya cargado por búsqueda)
const handleFilterChange = () => {
  if (!dataLoaded) {
    render();
    return;
  }
  if (renderTimeout) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => {
    render();
    renderTimeout = null;
  }, 120);
};

fCategory?.addEventListener("change", handleFilterChange);
fColor?.addEventListener("change", handleFilterChange);
fSize?.addEventListener("change", handleFilterChange);
fActive?.addEventListener("change", handleFilterChange);
fLow?.addEventListener("change", handleFilterChange);
fSupplier?.addEventListener("change", () => {
  if (!isStockUiReady && q?.disabled) return;
  runStockLoad();
});
// REMOVIDOS: Event listeners duplicados que causaban múltiples renders
// fColor.addEventListener("change", render);
// fSize.addEventListener("change", render);
// fActive.addEventListener("change", render);
// fLow.addEventListener("change", render);
saveAllBtn.addEventListener("click", saveAll);
discardAllBtn.addEventListener("click", discardAll);
lowAlertBtn.addEventListener("click", () => {
  const groups = computeLowStockGroups();
  lowSummary.textContent = groups.length === 0 ? "No hay grupos con bajo stock." : `${groups.length} producto(s) con bajo stock (< 12 unidades por color)`;
  lowListTbody.innerHTML = groups
    .map(
      (g) => `
      <tr>
        <td>${g.name || ""}</td>
        <td>${g.category || ""}</td>
        <td><span class="chip">${g.color || ""}</span></td>
        <td><strong>${g.total}</strong></td>
        <td>${g.variants
          .map((v) => `<span class="chip">Talle ${v.size}: ${v.qty}</span>`)
          .join(" ")}</td>
      </tr>`
    )
    .join("");
  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
});
closeOverlay.addEventListener("click", () => {
  overlay.classList.remove("show");
  overlay.setAttribute("aria-hidden", "true");
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) {
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
  }
});

// ------ Productos antiguos (18+ meses) ------
async function openOldProductsModal() {
  // Traer productos con created_at < now - 18 meses (y no archivados)
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 18);
  const cutoffIso = cutoff.toISOString();
  const { data: products, error } = await supabase
    .from("products")
    .select("id, name, handle, category, created_at, status")
    .lt("created_at", cutoffIso)
    .neq("status", "archived")
    .order("created_at", { ascending: true });
  if (error) {
    oldSummary.textContent = `Error: ${error.message}`;
    oldSummary.style.color = "#c00";
    overlayOld.classList.add("show");
    overlayOld.setAttribute("aria-hidden", "false");
    return;
  }
  // Contar variantes por producto
  let variantCounts = new Map();
  if (products?.length) {
    const { data: vc } = await supabase
      .from("product_variants")
      .select("id, product_id")
      .in(
        "product_id",
        products.map((p) => p.id)
      );
    variantCounts = new Map();
    (vc || []).forEach((v) => {
      variantCounts.set(v.product_id, (variantCounts.get(v.product_id) || 0) + 1);
    });
  }
  oldSummary.style.color = "inherit";
  oldSummary.textContent = `${products?.length || 0} producto(s) con más de 18 meses`;
  oldListTbody.innerHTML = (products || [])
    .map(
      (p) => `
      <tr>
        <td><input type="checkbox" class="old-check" data-id="${p.id}" data-handle="${p.handle}"/></td>
        <td>${p.name || ""}</td>
        <td>${p.handle || ""}</td>
        <td>${p.category || ""}</td>
        <td>${new Date(p.created_at).toLocaleDateString()}</td>
        <td>${variantCounts.get(p.id) || 0}</td>
      </tr>`
    )
    .join("");
  oldCheckAll.checked = false;
  overlayOld.classList.add("show");
  overlayOld.setAttribute("aria-hidden", "false");
}

oldBtn?.addEventListener("click", () => {
  runStockTask("open_old_products_modal", openOldProductsModal)
    .catch(() => {
      oldSummary.textContent = "No se pudo abrir la lista de productos viejos.";
      oldSummary.style.color = "#c00";
    });
});
closeOverlayOld?.addEventListener("click", () => {
  overlayOld.classList.remove("show");
  overlayOld.setAttribute("aria-hidden", "true");
});
overlayOld?.addEventListener("click", (e) => {
  if (e.target === overlayOld) {
    overlayOld.classList.remove("show");
    overlayOld.setAttribute("aria-hidden", "true");
  }
});
oldCheckAll?.addEventListener("change", () => {
  const boxes = overlayOld.querySelectorAll(".old-check");
  boxes.forEach((b) => (b.checked = oldCheckAll.checked));
});
archiveSelectedBtn?.addEventListener("click", () => {
  const lockKey = "archive-selected";
  if (_stockUiActionInFlight.has(lockKey)) return;
  _stockUiActionInFlight.add(lockKey);
  if (archiveSelectedBtn) archiveSelectedBtn.disabled = true;

  runStockTask("archive_selected_products", async () => {
  if (!canDeleteStock) {
    alert("No tienes permiso para eliminar/archivar productos.");
    return;
  }
  
  const boxes = Array.from(overlayOld.querySelectorAll(".old-check")).filter((b) => b.checked);
  if (!boxes.length) {
    oldSummary.textContent = "Seleccioná al menos un producto.";
    oldSummary.style.color = "#c00";
    return;
  }
  oldSummary.style.color = "inherit";
  oldSummary.textContent = "Archivando seleccionados...";
  // Archivar: status=archived y liberar handle con sufijo timestamp
  const updates = boxes.map((b) => {
    const id = Number(b.getAttribute("data-id"));
    const handle = b.getAttribute("data-handle") || "prod";
    const newHandle = `${handle}__arch_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    return supabase.from("products").update({ status: "archived", handle: newHandle }).eq("id", id);
  });
  const results = await Promise.all(updates);
  const failed = results.find((r) => r.error)?.error;
  if (failed) {
    oldSummary.textContent = `Error: ${failed.message}`;
    oldSummary.style.color = "#c00";
    return;
  }
  // Desactivar variantes de esos productos
  const ids = boxes.map((b) => Number(b.getAttribute("data-id")));
  await supabase.from("product_variants").update({ active: false }).in("product_id", ids);
  oldSummary.textContent = "Archivado completo. Actualizando lista…";
  dataLoaded = false; // Resetear para forzar recarga
  const ok = await load(currentProductIds); // recargar resultados actuales
  if (ok) dataLoaded = true;
  await openOldProductsModal(); // reabrir con lista actualizada
  }).catch((error) => {
    oldSummary.textContent = `Error: ${error?.message || "No se pudo archivar."}`;
    oldSummary.style.color = "#c00";
  }).finally(() => {
    _stockUiActionInFlight.delete(lockKey);
    if (archiveSelectedBtn) archiveSelectedBtn.disabled = false;
  });
});
// No cargar automáticamente al inicio - solo cargar cuando hay filtros o búsqueda
// load(); // Comentado: no cargar automáticamente

async function bootstrapStockUi() {
  isStockUiReady = false;
  setStockLoadingState(true);
  if (stockBuildVersionEl) {
    stockBuildVersionEl.textContent = STOCK_BUILD_VERSION;
  }
  try {
    // Validar sesión sin bloquear la inicialización del buscador.
    requireAuthWithTimeout().catch((err) => console.warn("requireAuthWithTimeout async:", err));
    // Verificar permisos en paralelo, sin bloquear el arranque inicial
    applyStockPermissions().catch((err) => console.warn("applyStockPermissions async:", err));
    await loadProductNames();
    await loadSuppliersForFilter();
    msg.textContent = stockLoadHintMessage();
    isStockUiReady = true;
  } catch (initError) {
    console.error("Error inicializando stock UI:", initError);
    isStockUiReady = true;
    if (msg) {
      msg.textContent = "Panel cargado con fallback. Probá buscar nuevamente.";
    }
  } finally {
    setStockLoadingState(false);
  }
}

bootstrapStockUi();

// ========== FUNCIONES DE HISTORIAL DE STOCK ==========

// Cargar historial de stock para un producto
async function loadStockHistory(productId) {
  try {
    const { data: history, error } = await supabase
      .from("stock_history")
      .select(`
        id,
        variant_id,
        size,
        warehouse_id,
        change_type,
        stock_before,
        stock_after,
        quantity_changed,
        from_warehouse_id,
        to_warehouse_id,
        notes,
        created_at,
        product_variants(color, sku),
        warehouse:warehouse_id(code, name),
        from_warehouse:from_warehouse_id(code, name),
        to_warehouse:to_warehouse_id(code, name)
      `)
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(500); // Limitar a 500 registros más recientes
    
    if (error) {
      console.error("Error cargando historial de stock:", error);
      return [];
    }
    
    return history || [];
  } catch (err) {
    console.error("Error en loadStockHistory:", err);
    return [];
  }
}

// Mostrar historial de stock en modal
async function showStockHistory(productId, productName) {
  const overlay = document.getElementById("overlay-history");
  const historyTitle = document.getElementById("history-title");
  const historySummary = document.getElementById("history-summary");
  const historyList = document.getElementById("history-list");
  
  if (!overlay || !historyTitle || !historySummary || !historyList) {
    console.error("Elementos del modal de historial no encontrados");
    return;
  }
  
  // Actualizar título
  historyTitle.textContent = `Historial de Stock - ${productName}`;
  historySummary.textContent = "Cargando historial...";
  historyList.innerHTML = "";
  
  // Mostrar modal
  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
  
  // Cargar historial
  const history = await loadStockHistory(productId);
  
  if (history.length === 0) {
    historySummary.textContent = "No hay historial de stock registrado para este producto.";
    historyList.innerHTML = "<tr><td colspan='7' style='text-align:center;padding:20px;color:#666;'>No hay registros de historial</td></tr>";
    return;
  }
  
  // Formatear historial
  historySummary.textContent = `${history.length} registro(s) de historial encontrado(s)`;
  
  historyList.innerHTML = history.map(h => {
    const date = new Date(h.created_at);
    const dateStr = date.toLocaleString("es-AR", { 
      year: "numeric", 
      month: "2-digit", 
      day: "2-digit", 
      hour: "2-digit", 
      minute: "2-digit" 
    });
    
    // Determinar tipo de cambio
    let changeTypeLabel = "";
    let changeTypeClass = "";
    switch (h.change_type) {
      case "load":
        changeTypeLabel = "Carga";
        changeTypeClass = "history-load";
        break;
      case "move_to_general":
        changeTypeLabel = "Movimiento → Depósito";
        changeTypeClass = "history-move";
        break;
      case "move_to_venta_publico":
        changeTypeLabel = "Movimiento → Local";
        changeTypeClass = "history-move";
        break;
      case "adjustment":
        changeTypeLabel = "Ajuste";
        changeTypeClass = "history-adjust";
        break;
      default:
        changeTypeLabel = h.change_type || "Cambio";
        changeTypeClass = "history-other";
    }
    
    // Determinar almacén (usar la relación especificada)
    let warehouseLabel = "N/A";
    if (h.warehouse) {
      warehouseLabel = h.warehouse.name || h.warehouse.code || "N/A";
    } else if (h.from_warehouse && h.to_warehouse) {
      // Para movimientos, mostrar ambos almacenes
      const fromName = h.from_warehouse.name || h.from_warehouse.code || "N/A";
      const toName = h.to_warehouse.name || h.to_warehouse.code || "N/A";
      warehouseLabel = `${fromName} → ${toName}`;
    } else if (h.from_warehouse) {
      warehouseLabel = h.from_warehouse.name || h.from_warehouse.code || "N/A";
    } else if (h.to_warehouse) {
      warehouseLabel = h.to_warehouse.name || h.to_warehouse.code || "N/A";
    }
    
    // Variante y talle
    const variantColor = h.product_variants?.color || "N/A";
    const size = h.size || "N/A";
    const variantTalle = `${variantColor}${size !== "N/A" ? ` / Talle ${size}` : ""}`;
    
    // Cambio con signo
    const change = h.quantity_changed || 0;
    const changeStr = change > 0 ? `+${change}` : String(change);
    const changeClass = change > 0 ? "history-positive" : change < 0 ? "history-negative" : "";
    
    return `
      <tr>
        <td style="font-size: 12px; white-space: nowrap;">${dateStr}</td>
        <td><span class="history-badge ${changeTypeClass}">${changeTypeLabel}</span></td>
        <td>${variantTalle}</td>
        <td>${warehouseLabel}</td>
        <td style="text-align: center;">${h.stock_before || 0}</td>
        <td style="text-align: center; font-weight: 600;">${h.stock_after || 0}</td>
        <td style="text-align: center; font-weight: 600;" class="${changeClass}">${changeStr}</td>
      </tr>
    `;
  }).join("");
}

// Event listeners para modal de historial
const closeOverlayHistory = document.getElementById("close-overlay-history");
const overlayHistory = document.getElementById("overlay-history");

if (closeOverlayHistory) {
  closeOverlayHistory.addEventListener("click", () => {
    if (overlayHistory) {
      overlayHistory.classList.remove("show");
      overlayHistory.setAttribute("aria-hidden", "true");
    }
  });
}

if (overlayHistory) {
  overlayHistory.addEventListener("click", (e) => {
    if (e.target === overlayHistory) {
      overlayHistory.classList.remove("show");
      overlayHistory.setAttribute("aria-hidden", "true");
    }
  });
}

// Hacer showStockHistory disponible globalmente
window.showStockHistory = showStockHistory;
