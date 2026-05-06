// admin/stock-audit.js
// Módulo "Salud de stock" — v1
// Evolución de la pantalla de auditoría técnica hacia una vista operativa.
// Spec: docs/FYL-Obsidian/26-SPEC-MODULO-ADMIN-STOCK.md

import { supabase } from "../scripts/supabase-client.js";
import { preloadAuthState, can, isAdminUser } from "./auth-state.js";
import { isSuperAdmin } from "./permissions-helper.js";

// ─────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────

const MAX_ROWS = 50;       // filas mostradas por card
const MAX_VARIANT_ROWS = 5; // filas en vista colapsada antes de "ver más"

// ─────────────────────────────────────────────────────────────────
// ESTADO
// ─────────────────────────────────────────────────────────────────

const state = {
  gate: null,
  phantom: [],       // C1: talles visibles sin stock real
  deflated: [],      // C2: reserved_qty deflated
  inflated: [],      // A1: reserved_qty inflated (muestra, hasta MAX_ROWS)
  inflatedTotal: 0,  // A1: conteo global infladas (vista)
  sizesDiff: [],     // A2: diffs variant_sizes (no-phantom)
  ledgerRows: null,  // 188: count(*) order_reserved_qty_released; null = error/no leído
  ledgerLastAt: null,
  ledgerError: null,
  orphan: [],        // A3: filas huérfanas
  noImages: [],      // O1: variantes activas sin imágenes
  draftStock: [],    // O2: productos draft/missing_tags con stock
  inactiveVariants: [], // O3: variantes inactivas con stock
  deadStock: [],        // P1: productos sin movimiento ≥ 90 días
  fastSellers: [],      // B1/B2/B3: productos con ventas activas (fast sellers + nuevos + acumulado)
  pubInefficiency: [],  // B4: publicados sin conversión a ventas
  lastPubPerformance: [], // B5: ventas 24/72/7d tras última publicación (solo last_published_at)
  publicationEventsPerformance: [], // B6: ventas 24/72/7d por evento (FASE 2)
  publicationPerformanceSource: "last_published_at", // publication_events | last_published_at
  tagSummary: [],       // AI: agregados por tag para preguntas comerciales
  productFlags: new Map(), // clasificación: is_own_manufacturing, supplier_code, supplier_name
  superAdmin: false,
  canReconcileDerivatives: false, // rpc(false): super_admin o stock_manager
  canReconcileReserved: false,    // rpc(true):  solo super_admin
};

// ─────────────────────────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtDate(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  return d.toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function totalStock(sizes) {
  if (!Array.isArray(sizes)) return 0;
  return sizes.reduce((sum, s) => sum + (Number(s?.stock_qty) || 0), 0);
}

// ─────────────────────────────────────────────────────────────────
// CLASIFICACIÓN: FABRICACIÓN PROPIA + ESTACIONALIDAD
// ─────────────────────────────────────────────────────────────────

// Patrones que identifican proveedores de fabricación propia / marca FYL.
// Ajustar si el código o nombre real del proveedor en DB difiere.
const OWN_MANUFACTURING_PATTERNS = ["FYL", "F&L", "F Y L", "FABRICACION PROPIA", "PROPIO", "INTERNO"];

// Tags de calzado con comportamiento estacional marcado (carryover verano/invierno).
// Detección heurística basada en nombre de tag1; NO hay campo DB para esto todavía.
// GAP documentado: falta `lifecycle_status` o `season_type` en products.
const SEASONAL_TAG_KEYWORDS = ["ojota", "sandalia", "chancleta", "hawaiana", "pantufla", "botin verano", "calzado verano"];

// Carga supplier_id + supplier code/name para un conjunto de product_ids.
// Se usa para enriquecer estado post-carga sin modificar las vistas SQL.
async function loadProductSupplierFlags(productIds) {
  if (!productIds.length) return new Map();
  const { data, error } = await supabase
    .from("products")
    .select("id, supplier_id, supplier:suppliers(code, name)")
    .in("id", productIds)
    .limit(500);
  if (error) {
    console.warn("[stock-audit] loadProductSupplierFlags error:", error.message);
    return new Map();
  }
  const map = new Map();
  for (const p of data || []) {
    const code = (p.supplier?.code || "").toUpperCase();
    const name = (p.supplier?.name || "").toUpperCase();
    const isOwn = !p.supplier_id ||
      OWN_MANUFACTURING_PATTERNS.some((pat) => code.includes(pat) || name.includes(pat));
    map.set(p.id, {
      supplier_id: p.supplier_id,
      supplier_code: p.supplier?.code || null,
      supplier_name: p.supplier?.name || null,
      is_own_manufacturing: isOwn,
    });
  }
  return map;
}

// Devuelve true si el product_id está clasificado como fabricación propia/FYL.
// Retorna null si no hay datos de proveedor cargados.
function isOwnManufacturing(productId) {
  if (!state.productFlags.has(productId)) return null;
  return state.productFlags.get(productId).is_own_manufacturing;
}

// Detección heurística de estacionalidad por nombre del producto o tag1.
// Sin campo DB confiable, solo busca palabras clave estacionales en el nombre.
function isSeasonalHint(nombre) {
  if (!nombre) return false;
  const lower = nombre.toLowerCase();
  return SEASONAL_TAG_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─────────────────────────────────────────────────────────────────
// CLASIFICACIÓN DE ESTADO
// ─────────────────────────────────────────────────────────────────

function classifyStatus() {
  const g = state.gate;
  if (!g) return "cargando";

  const hasPhantom = state.phantom.length > 0;
  const hasDeflated = state.deflated.length > 0;
  const triggersDown = !g.trigger_84_active || !g.trigger_145_active;
  const hasCriticalSignals = (g.critical_signals ?? 0) > 0;

  if (hasPhantom || hasDeflated || triggersDown || hasCriticalSignals) return "critico";

  const hasInflated = (state.inflatedTotal > 0) || (state.inflated.length > 0);
  const hasSizesDiff = (g.variant_sizes_diffs ?? 0) > 0;
  const hasOrphan = (g.orphan_rows ?? 0) > 0;

  if (hasInflated || hasSizesDiff || hasOrphan) return "atencion";

  return "saludable";
}

// ─────────────────────────────────────────────────────────────────
// CARGA DE DATOS
// ─────────────────────────────────────────────────────────────────

async function fetchHealthGateOrFallback() {
  const gate = await supabase
    .from("vw_stock_audit_release_gate")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (!gate.error && gate.data) return gate.data;

  const health = await supabase
    .from("vw_stock_audit_health_score")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (health.error) throw health.error;
  return health.data || null;
}

// C1: talles con stock en variant_sizes pero sin stock real en depósitos
async function loadPhantomStock() {
  const { data, error } = await supabase
    .from("vw_stock_audit_variant_sizes_diff")
    .select("product_id, product_name, variant_id, variant_color, variant_sku, size, variant_sizes_qty, sum_size_warehouse_qty")
    .gt("variant_sizes_qty", 0)
    .eq("sum_size_warehouse_qty", 0)
    .limit(MAX_ROWS);
  if (error) throw error;
  return data || [];
}

// C2: reserved_qty deflated (stock sobreestimado → riesgo sobreventa)
async function loadDeflatedReserved() {
  const { data, error } = await supabase
    .from("vw_stock_audit_reserved_qty_diff")
    .select("product_id, product_name, variant_id, variant_color, variant_sku, stored_reserved_qty, real_reserved_qty, cart_open_qty, order_sources_qty, delta")
    .eq("anomaly_type", "reserved_qty_deflated")
    .order("delta")
    .limit(MAX_ROWS);
  if (error) throw error;
  return data || [];
}

// A1: reserved_qty inflated — lista acotada + conteo global para UX post-188
async function loadInflatedReserved() {
  const sel = "product_id, product_name, variant_id, variant_color, variant_sku, stored_reserved_qty, real_reserved_qty, cart_open_qty, order_sources_qty, delta";
  const base = () =>
    supabase.from("vw_stock_audit_reserved_qty_diff").select(sel).eq("anomaly_type", "reserved_qty_inflated");
  const [listRes, countRes] = await Promise.all([
    base().order("delta", { ascending: false }).limit(MAX_ROWS),
    supabase
      .from("vw_stock_audit_reserved_qty_diff")
      .select("*", { count: "exact", head: true })
      .eq("anomaly_type", "reserved_qty_inflated"),
  ]);
  if (listRes.error) throw listRes.error;
  if (countRes.error) throw countRes.error;
  return {
    items: listRes.data || [],
    total: typeof countRes.count === "number" ? countRes.count : 0,
  };
}

// 188: estadísticas del ledger (solo lectura)
async function loadReservedReleaseLedger() {
  const { count, error: cErr } = await supabase
    .from("order_reserved_qty_released")
    .select("*", { count: "exact", head: true });
  if (cErr) {
    return { rows: null, lastAt: null, error: cErr.message || String(cErr) };
  }
  const { data: lastRow, error: lErr } = await supabase
    .from("order_reserved_qty_released")
    .select("released_at")
    .order("released_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lErr) {
    return { rows: count ?? 0, lastAt: null, error: lErr.message || String(lErr) };
  }
  return { rows: count ?? 0, lastAt: lastRow?.released_at ?? null, error: null };
}

// A2: diffs en variant_sizes que tienen stock real > 0 (no son phantom)
async function loadSizesDiff() {
  const { data, error } = await supabase
    .from("vw_stock_audit_variant_sizes_diff")
    .select("product_id, product_name, variant_id, variant_color, variant_sku, size, variant_sizes_qty, sum_size_warehouse_qty, delta")
    .gt("sum_size_warehouse_qty", 0)
    .limit(MAX_ROWS);
  if (error) throw error;
  return data || [];
}

// A3: filas huérfanas
async function loadOrphanRows() {
  const { data, error } = await supabase
    .from("vw_stock_audit_orphan_size_rows")
    .select("product_id, product_name, variant_id, variant_color, variant_sku, size, warehouse_code, size_wh_qty")
    .limit(MAX_ROWS);
  if (error) throw error;
  return data || [];
}

// O1: variantes activas de productos activos, con stock pero sin imágenes
async function loadVariantsNoImages() {
  const { data, error } = await supabase
    .from("product_variants")
    .select(`
      id, color, sku, product_id,
      product:products(id, name, status, category),
      images:variant_images(id),
      sizes:variant_sizes(stock_qty)
    `)
    .eq("active", true)
    .limit(300);
  if (error) throw error;
  return (data || []).filter(
    (v) =>
      v.product?.status === "active" &&
      (!v.images || v.images.length === 0) &&
      totalStock(v.sizes) > 0
  );
}

// O2: productos draft o missing_tags con al menos una variante con stock
async function loadDraftWithStock() {
  const { data, error } = await supabase
    .from("products")
    .select(`
      id, name, status, category,
      variants:product_variants(id, color, sku, active, sizes:variant_sizes(stock_qty))
    `)
    .in("status", ["draft", "missing_tags"])
    .limit(100);
  if (error) throw error;

  return (data || [])
    .map((p) => {
      const stock = (p.variants || []).reduce(
        (sum, v) => sum + totalStock(v.sizes), 0
      );
      return { ...p, total_stock: stock };
    })
    .filter((p) => p.total_stock > 0)
    .sort((a, b) => b.total_stock - a.total_stock);
}

// O3: variantes inactivas en productos activos con stock significativo (> 5)
async function loadInactiveWithStock() {
  const { data, error } = await supabase
    .from("product_variants")
    .select(`
      id, color, sku, product_id,
      product:products(id, name, status),
      sizes:variant_sizes(stock_qty)
    `)
    .eq("active", false)
    .limit(300);
  if (error) throw error;

  return (data || [])
    .filter((v) => v.product?.status === "active" && totalStock(v.sizes) > 5)
    .map((v) => ({ ...v, total_stock: totalStock(v.sizes) }))
    .sort((a, b) => b.total_stock - a.total_stock);
}

// B1/B2/B3: productos con ventas activas (fast sellers, nuevos con rotación, stock acumulado)
async function loadFastSellers() {
  const { data, error } = await supabase
    .from("vw_stock_fast_sellers")
    .select("product_id, nombre, category, alta_en, units_sold_90d, stock_total, unidades_por_dia, dias_stock_restante, es_nuevo")
    .order("units_sold_90d", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return data || [];
}

// AI: agregados de ventas+stock por tag1/tag2 para el sistema de preguntas
async function loadTagSummary() {
  const { data, error } = await supabase
    .from("vw_stock_tag_summary")
    .select("tag1_nombre, category, tag2_nombre, productos_activos, unidades_30d, unidades_90d, stock_total, unidades_por_dia")
    .order("unidades_90d", { ascending: false })
    .limit(40); // suficiente para el contexto de la IA
  if (error) throw error;
  return data || [];
}

// B5: rendimiento post-última publicación (ventanas 0–24h, 24–72h, 7d) — ver meta.notas
async function loadLastPubPerformance() {
  const { data, error } = await supabase
    .from("vw_stock_publication_last_pub_performance")
    .select(
      "product_id, nombre, category, last_published_at, variants_published, dias_desde_publicacion, u_0_24h, u_24_72h, u_0_7d, ventas_totales_post_ultima_pub, stock_total"
    )
    .order("u_0_7d", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return data || [];
}

// B6: rendimiento por evento real de publicación (FASE 2)
async function loadPublicationEventsPerformance() {
  const { data, error } = await supabase
    .from("vw_publication_events_performance")
    .select("id, product_id, product_name, category, variant_id, variant_color, channel, price_at_publish, published_at, weekday_name, weekday_iso, month_stage, product_event_rank, product_publication_count, sales_24h, sales_72h, sales_7d")
    .order("published_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return data || [];
}

// B4: productos publicados en redes sin conversión a ventas
async function loadPubInefficiency() {
  const { data, error } = await supabase
    .from("vw_stock_publication_inefficiency")
    .select("product_id, nombre, category, last_published_at, variants_published, dias_desde_publicacion, ventas_tras_publicacion, stock_total")
    .order("dias_desde_publicacion", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return data || [];
}

// P1: productos activos sin movimiento >= 90 días (análisis de oportunidad)
async function loadDeadStock() {
  const { data, error } = await supabase
    .from("vw_stock_dead_products")
    .select("product_id, nombre, category, stock_total, ultima_actividad, dias_sin_movimiento, fuente_actividad")
    .order("dias_sin_movimiento", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return data || [];
}

// ─────────────────────────────────────────────────────────────────
// Orquestador: carga todo en paralelo
async function loadAll() {
  renderHeaderLoading();

  const [gateResult, ledgerResult, ...dataResults] = await Promise.allSettled([
    fetchHealthGateOrFallback(),
    loadReservedReleaseLedger(),
    loadPhantomStock(),
    loadDeflatedReserved(),
    loadInflatedReserved(),
    loadSizesDiff(),
    loadOrphanRows(),
    loadVariantsNoImages(),
    loadDraftWithStock(),
    loadInactiveWithStock(),
    loadDeadStock(),
    loadFastSellers(),
    loadPubInefficiency(),
    loadTagSummary(),
    loadLastPubPerformance(),
    loadPublicationEventsPerformance(),
  ]);

  state.gate = gateResult.status === "fulfilled" ? gateResult.value : null;

  if (ledgerResult.status === "fulfilled" && ledgerResult.value) {
    const lv = ledgerResult.value;
    state.ledgerRows = lv.rows;
    state.ledgerLastAt = lv.lastAt;
    state.ledgerError = lv.error;
  } else {
    state.ledgerRows = null;
    state.ledgerLastAt = null;
    const reason =
      ledgerResult.status === "rejected" && ledgerResult.reason
        ? ledgerResult.reason?.message || String(ledgerResult.reason)
        : "No se pudo cargar el ledger.";
    state.ledgerError = reason;
  }

  state.phantom          = dataResults[0].status === "fulfilled" ? dataResults[0].value : [];
  state.deflated         = dataResults[1].status === "fulfilled" ? dataResults[1].value : [];
  const infl = dataResults[2].status === "fulfilled" ? dataResults[2].value : { items: [], total: 0 };
  state.inflated         = Array.isArray(infl) ? infl : (infl.items || []);
  state.inflatedTotal    = Array.isArray(infl) ? infl.length : (Number(infl.total) || 0);
  state.sizesDiff        = dataResults[3].status === "fulfilled" ? dataResults[3].value : [];
  state.orphan           = dataResults[4].status === "fulfilled" ? dataResults[4].value : [];
  state.noImages         = dataResults[5].status === "fulfilled" ? dataResults[5].value : [];
  state.draftStock       = dataResults[6].status === "fulfilled" ? dataResults[6].value : [];
  state.inactiveVariants = dataResults[7].status === "fulfilled" ? dataResults[7].value : [];
  state.deadStock        = dataResults[8].status === "fulfilled" ? dataResults[8].value : [];
  state.fastSellers      = dataResults[9].status === "fulfilled" ? dataResults[9].value : [];
  state.pubInefficiency  = dataResults[10].status === "fulfilled" ? dataResults[10].value : [];
  state.tagSummary       = dataResults[11].status === "fulfilled" ? dataResults[11].value : [];
  state.lastPubPerformance =
    dataResults[12].status === "fulfilled" ? dataResults[12].value : [];
  state.publicationEventsPerformance =
    dataResults[13].status === "fulfilled" ? dataResults[13].value : [];
  state.publicationPerformanceSource =
    state.publicationEventsPerformance.length >= MIN_EVENTS_FOR_HISTORY
      ? "publication_events"
      : "last_published_at";

  // Enriquecer con flags de proveedor (fabricación propia) — query post-paralelo
  const allProductIds = [
    ...state.fastSellers.map((p) => p.product_id),
    ...state.deadStock.map((p) => p.product_id),
    ...state.pubInefficiency.map((p) => p.product_id),
  ].filter(Boolean);
  const uniqueIds = [...new Set(allProductIds)];
  state.productFlags = await loadProductSupplierFlags(uniqueIds);

  // Mostrar aviso si la vista de tags no devolvió datos (sin tag1 asignado o vista ausente)
  const tagHint = $("ai-tag-hint");
  if (tagHint) {
    const noTags = state.tagSummary.length === 0;
    tagHint.textContent = noTags
      ? "No hay datos suficientes por tags para comparar categorías. Las preguntas sobre tipos de productos pueden ser imprecisas."
      : "";
    tagHint.style.display = noTags ? "block" : "none";
  }

  renderAll();
}

// ─────────────────────────────────────────────────────────────────
// RENDER — HEADER
// ─────────────────────────────────────────────────────────────────

function renderHeaderLoading() {
  const el = $("health-header");
  el.className = "sh-header cargando";
  el.innerHTML = `<span class="sh-status-badge cargando"><span class="sh-spinner"></span> Cargando...</span>`;
}

function renderHealthHeader(status) {
  const el = $("health-header");
  el.className = `sh-header ${status}`;

  const LABELS = {
    saludable: { badge: "✓ En orden",   msg: "Todos los indicadores están en cero. No hay acciones requeridas." },
    atencion:  { badge: "⚠ Atención",   msg: "Hay situaciones a revisar. Sin riesgo inmediato de sobreventa." },
    critico:   { badge: "✕ Crítico",    msg: "Hay riesgo activo de sobreventa o inconsistencias en el catálogo." },
    cargando:  { badge: "Cargando...",  msg: "" },
  };

  const { badge, msg } = LABELS[status] || LABELS.cargando;
  const updatedAt = state.gate?.measured_at ? fmtDate(state.gate.measured_at) : null;

  const ledgerOk = state.ledgerError === null && state.ledgerRows !== null;
  const releaseLabel = ledgerOk ? "Activa" : "Inactiva";
  const ledgerCountStr = ledgerOk ? String(state.ledgerRows) : "—";
  const ledgerLastStr = ledgerOk && state.ledgerLastAt ? fmtDate(state.ledgerLastAt) : "—";
  const techBlock = `
    <div class="sh-header-tech" role="note">
      <p class="sh-header-tech-line"><strong>Liberación automática de reservas:</strong> ${releaseLabel}</p>
      <p class="sh-header-tech-line"><strong>Pedidos procesados por 188:</strong> ${escapeHtml(ledgerCountStr)}</p>
      <p class="sh-header-tech-line"><strong>Última liberación:</strong> ${escapeHtml(ledgerLastStr)}</p>
      ${
        !ledgerOk && state.ledgerError
          ? `<p class="sh-header-tech-warn">${escapeHtml(state.ledgerError)}</p>`
          : ""
      }
    </div>
  `;

  el.innerHTML = `
    <span class="sh-status-badge ${status}">${badge}</span>
    <div class="sh-header-info">
      ${msg ? `<p>${escapeHtml(msg)}</p>` : ""}
      ${updatedAt ? `<p class="sh-header-meta">Última revisión: ${updatedAt}</p>` : ""}
      ${techBlock}
    </div>
    <div class="sh-header-actions">
      <button id="btn-refresh" class="sh-btn ghost sm">↺ Actualizar</button>
    </div>
  `;

  $("btn-refresh")?.addEventListener("click", loadAll);
}

// ─────────────────────────────────────────────────────────────────
// RENDER — COMPONENTES REUTILIZABLES
// ─────────────────────────────────────────────────────────────────

// Contador para generar IDs únicos de secciones expandibles
let _expandSeq = 0;

// Función global para el toggle (necesaria porque se llama desde onclick inline)
window._shToggleExpand = function (btn, expandId) {
  const el = document.getElementById(expandId);
  if (!el) return;
  const isVisible = el.style.display !== "none";
  el.style.display = isVisible ? "none" : "";
  btn.textContent = isVisible ? "Ver todos" : "Colapsar";
};

// Renderiza una lista de variantes en una card, con limit y botón "Ver todos"
function renderVariantRows(items, rowFn, limit = MAX_VARIANT_ROWS) {
  if (!items.length) return "";
  const visible = items.slice(0, limit);
  const remaining = items.length - limit;

  let html = `<div class="sh-variant-list">`;
  for (const item of visible) {
    html += `<div class="sh-variant-row">${rowFn(item)}</div>`;
  }
  html += `</div>`;

  if (remaining > 0) {
    const expandId = `sh-exp-${++_expandSeq}`;
    // Filas ocultas
    let hiddenHtml = `<div class="sh-variant-list" id="${expandId}" style="display:none;">`;
    for (const item of items.slice(limit)) {
      hiddenHtml += `<div class="sh-variant-row">${rowFn(item)}</div>`;
    }
    hiddenHtml += `</div>`;
    html += hiddenHtml;
    html += `<p class="sh-empty" style="margin-top:6px;">
      +${remaining} más —
      <button
        class="sh-btn ghost sm"
        style="padding:2px 8px;font-size:11px;vertical-align:middle;"
        onclick="_shToggleExpand(this,'${expandId}')">Ver todos</button>
    </p>`;
  }

  return html;
}

// Construye una card completa
function buildCard({ containerId, type, title, desc, count, variantsHtml, footerHtml, hintHtml }) {
  const container = $(containerId);
  if (!container) return;

  if (!count) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <div class="sh-card ${type}">
      <div class="sh-card-header">
        <div>
          <p class="sh-card-title">${title}</p>
          <p class="sh-card-desc">${desc}</p>
          ${hintHtml ? `<p class="sh-card-hint">${escapeHtml(hintHtml)}</p>` : ""}
        </div>
        <span class="sh-card-count ${type}">${count}</span>
      </div>
      ${variantsHtml || ""}
      ${footerHtml ? `<div class="sh-card-footer">${footerHtml}</div>` : ""}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────
// RENDER — BLOQUE CRÍTICO
// ─────────────────────────────────────────────────────────────────

function renderCardPhantom() {
  const items = state.phantom;
  const grouped = {};
  for (const row of items) {
    const key = `${row.variant_id}`;
    if (!grouped[key]) {
      grouped[key] = { ...row, talles: [] };
    }
    if (row.size) grouped[key].talles.push(row.size);
  }
  const variants = Object.values(grouped);

  buildCard({
    containerId: "card-phantom",
    type: "critico",
    title: "Productos visibles sin stock real",
    desc: `${variants.length} ${variants.length === 1 ? "variante aparece" : "variantes aparecen"} en el catálogo pero no tienen unidades en depósito.`,
    count: variants.length,
    variantsHtml: renderVariantRows(variants, (v) => `
      <span class="sh-vr-product">${escapeHtml(v.product_name || "—")}</span>
      <span class="sh-vr-color">${escapeHtml(v.variant_color || "—")}</span>
      <span class="sh-vr-sku">${escapeHtml(v.variant_sku || "—")}</span>
      ${v.talles.length ? `<span class="sh-vr-detail">Talles: ${v.talles.map(escapeHtml).join(", ")}</span>` : ""}
      <span class="sh-vr-badge danger">Stock real: 0</span>
    `),
    footerHtml: state.canReconcileDerivatives
      ? `<button class="sh-btn danger" data-action="reconcile-false">Sincronizar stock visible</button>`
      : `<button class="sh-btn danger" disabled title="Requiere super_admin o stock_manager">Sincronizar stock visible</button>`,
  });
}

function renderCardDeflated() {
  const items = state.deflated;

  buildCard({
    containerId: "card-deflated",
    type: "critico",
    title: "Riesgo de sobreventa",
    desc: `${items.length} ${items.length === 1 ? "variante tiene" : "variantes tienen"} más unidades reservadas de lo que el sistema registra. El stock disponible visible es mayor al real.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (v) => `
      <span class="sh-vr-product">${escapeHtml(v.product_name || "—")}</span>
      <span class="sh-vr-color">${escapeHtml(v.variant_color || "—")}</span>
      <span class="sh-vr-sku">${escapeHtml(v.variant_sku || "—")}</span>
      <span class="sh-vr-detail">En carritos: ${v.cart_open_qty || 0}</span>
      <span class="sh-vr-badge danger">Diferencia: ${Math.abs(v.delta || 0)}</span>
    `),
    footerHtml: state.canReconcileReserved
      ? `<button class="sh-btn danger" data-action="reconcile-true">Corregir reservas</button>`
      : `<button class="sh-btn danger" disabled title="Requiere super_admin">Corregir reservas</button>`,
  });
}

function renderCardTriggers() {
  const g = state.gate;
  const triggersDown = g && (!g.trigger_84_active || !g.trigger_145_active);

  const container = $("card-triggers");
  if (!container) return;

  if (!triggersDown) {
    container.innerHTML = "";
    return;
  }

  const names = [];
  if (!g.trigger_84_active) names.push("Sincronización variant_sizes (84)");
  if (!g.trigger_145_active) names.push("Sincronización variant_warehouse_stock (145)");

  container.innerHTML = `
    <div class="sh-card critico">
      <div class="sh-card-header">
        <div>
          <p class="sh-card-title">Sincronización automática desactivada</p>
          <p class="sh-card-desc">Los triggers que mantienen el catálogo sincronizado están inactivos. Los cambios de stock no se reflejan automáticamente.</p>
        </div>
        <span class="sh-card-count critico">${names.length}</span>
      </div>
      <div class="sh-variant-list">
        ${names.map((n) => `<div class="sh-variant-row"><span class="sh-vr-badge danger">${escapeHtml(n)}</span></div>`).join("")}
      </div>
      <div class="sh-card-footer">
        <span style="font-size:12px;color:#374151;">Requiere intervención técnica en la base de datos.</span>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────
// RENDER — BLOQUE ATENCIÓN
// ─────────────────────────────────────────────────────────────────

function renderCardInflated() {
  const items = state.inflated;
  const total = state.inflatedTotal > 0 ? state.inflatedTotal : items.length;
  if (!total) {
    const c = $("card-inflated");
    if (c) c.innerHTML = "";
    return;
  }

  const lr = state.ledgerRows;
  let hintHtml = "";
  if (total > 0 && lr === 0) {
    hintHtml =
      "Hay reservas históricas pendientes. Validá un pedido enviado y luego ejecutá la reconciliación histórica una vez.";
  } else if (total > 0 && typeof lr === "number" && lr > 0) {
    hintHtml =
      "Hay reservas desalineadas recientes o históricas. Revisar si ocurrieron antes o después de la última liberación automática.";
  } else if (total > 0 && lr === null) {
    hintHtml =
      "No se pudo leer el ledger de liberaciones automáticas; aplicá permisos de lectura o revisá conexión.";
  }

  const shown = items.length;
  const descCore = `${total} ${total === 1 ? "variante tiene" : "variantes tienen"} reservas registradas por encima de lo que explican carritos abiertos y pedidos activos (posible arrastre pre-188 o casos límite).`;
  const descTail = shown < total ? ` Se muestran las ${shown} con mayor delta.` : "";

  buildCard({
    containerId: "card-inflated",
    type: "atencion",
    title: "Reservas desalineadas",
    desc: descCore + descTail,
    count: total,
    hintHtml: hintHtml || undefined,
    variantsHtml: renderVariantRows(items, (v) => `
      <span class="sh-vr-product">${escapeHtml(v.product_name || "—")}</span>
      <span class="sh-vr-color">${escapeHtml(v.variant_color || "—")}</span>
      <span class="sh-vr-sku">${escapeHtml(v.variant_sku || "—")}</span>
      <span class="sh-vr-badge warning">+${Math.abs(v.delta || 0)} unidades</span>
    `),
    footerHtml: state.canReconcileReserved
      ? `<button class="sh-btn secondary" data-action="reconcile-true">Corregir reservas</button>`
      : `<button class="sh-btn secondary" disabled title="Requiere super_admin">Corregir reservas</button>`,
  });
}

function renderCardSizesDiff() {
  const items = state.sizesDiff;

  buildCard({
    containerId: "card-sizes-diff",
    type: "atencion",
    title: "Stock por talle desalineado",
    desc: `${items.length} ${items.length === 1 ? "talle tiene" : "talles tienen"} diferencias entre el stock declarado y el real en depósitos.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (v) => `
      <span class="sh-vr-product">${escapeHtml(v.product_name || "—")}</span>
      <span class="sh-vr-color">${escapeHtml(v.variant_color || "—")}</span>
      ${v.size ? `<span class="sh-vr-detail">Talle: ${escapeHtml(v.size)}</span>` : ""}
      <span class="sh-vr-badge warning">Δ ${v.delta > 0 ? "+" : ""}${v.delta}</span>
    `),
    footerHtml: state.canReconcileDerivatives
      ? `<button class="sh-btn secondary" data-action="reconcile-false">Sincronizar stock visible</button>`
      : `<button class="sh-btn secondary" disabled title="Requiere super_admin o stock_manager">Sincronizar stock visible</button>`,
  });
}

function renderCardOrphan() {
  const items = state.orphan;

  buildCard({
    containerId: "card-orphan",
    type: "atencion",
    title: "Stock en depósito no visible",
    desc: `${items.length} ${items.length === 1 ? "talle tiene" : "talles tienen"} unidades en depósito que no están registradas como disponibles.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (v) => `
      <span class="sh-vr-product">${escapeHtml(v.product_name || "—")}</span>
      <span class="sh-vr-color">${escapeHtml(v.variant_color || "—")}</span>
      ${v.size ? `<span class="sh-vr-detail">Talle: ${escapeHtml(v.size)}</span>` : ""}
      <span class="sh-vr-badge info">${v.size_wh_qty || 0} u · ${escapeHtml(v.warehouse_code || "—")}</span>
    `),
    footerHtml: state.canReconcileDerivatives
      ? `<button class="sh-btn secondary" data-action="reconcile-false">Sincronizar stock visible</button>`
      : `<button class="sh-btn secondary" disabled title="Requiere super_admin o stock_manager">Sincronizar stock visible</button>`,
  });
}

// ─────────────────────────────────────────────────────────────────
// RENDER — BLOQUE OPERATIVO
// ─────────────────────────────────────────────────────────────────

function renderCardNoImages() {
  const items = state.noImages;

  buildCard({
    containerId: "card-no-images",
    type: "operativo",
    title: "Variantes con stock pero sin imágenes",
    desc: `${items.length} ${items.length === 1 ? "variante tiene" : "variantes tienen"} mercadería disponible pero no aparecen en el catálogo por falta de imágenes.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (v) => `
      <span class="sh-vr-product">${escapeHtml(v.product?.name || "—")}</span>
      <span class="sh-vr-color">${escapeHtml(v.color || "—")}</span>
      <span class="sh-vr-sku">${escapeHtml(v.sku || "—")}</span>
      <span class="sh-vr-badge info">${totalStock(v.sizes)} u</span>
    `, MAX_VARIANT_ROWS),
    footerHtml: `<span class="sh-more-hint">Cargar imágenes desde <a href="./products.html">Productos</a></span>`,
  });
}

function getLinkForStatus(status) {
  if (status === "pending_stock") return "./incomplete-products.html";
  if (status === "missing_tags") return "./complete-tags.html";
  return "./products.html"; // draft y otros
}

function renderCardDraftStock() {
  const items = state.draftStock;

  buildCard({
    containerId: "card-draft-stock",
    type: "operativo",
    title: "Altas de producto pendientes",
    desc: `${items.length} ${items.length === 1 ? "producto tiene" : "productos tienen"} stock cargado pero el alta está incompleta.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (p) => `
      <span class="sh-vr-product">${escapeHtml(p.name || "—")}</span>
      <span class="sh-vr-badge ${p.status === "draft" ? "warning" : "info"}">${p.status === "draft" ? "draft" : "faltan tags"}</span>
      <span class="sh-vr-detail">${p.total_stock} u</span>
      <a href="${getLinkForStatus(p.status)}" style="font-size:12px;color:#2563eb;text-decoration:underline;margin-left:auto;">Completar →</a>
    `, MAX_VARIANT_ROWS),
    footerHtml: `<span class="sh-more-hint">Cada producto tiene link directo a su pantalla de alta</span>`,
  });
}

function renderCardInactiveVariants() {
  const items = state.inactiveVariants;

  buildCard({
    containerId: "card-inactive-variants",
    type: "operativo",
    title: "Variantes inactivas con stock",
    desc: `${items.length} ${items.length === 1 ? "variante está" : "variantes están"} desactivadas pero tienen unidades en depósito.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (v) => `
      <span class="sh-vr-product">${escapeHtml(v.product?.name || "—")}</span>
      <span class="sh-vr-color">${escapeHtml(v.color || "—")}</span>
      <span class="sh-vr-sku">${escapeHtml(v.sku || "—")}</span>
      <span class="sh-vr-badge info">${v.total_stock} u</span>
    `, MAX_VARIANT_ROWS),
    footerHtml: `<span class="sh-more-hint">Revisar si reactivar o aceptar como discontinuado</span>`,
  });
}

// ─────────────────────────────────────────────────────────────────
// RENDER — BLOQUE COMPORTAMIENTO DE PRODUCTOS
// ─────────────────────────────────────────────────────────────────

// B1: Alta demanda — top sellers por unidades vendidas en 90 días
function renderCardFastSellers() {
  const items = state.fastSellers;
  buildCard({
    containerId: "card-fast-sellers",
    type: "analisis",
    title: "Alta demanda",
    desc: `${items.length} ${items.length === 1 ? "producto vendió" : "productos vendieron"} 3 o más unidades en los últimos 90 días.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (p) => {
      const own = isOwnManufacturing(p.product_id);
      const vel = `${p.unidades_por_dia}/día`;

      // Para fabricación propia: no mostrar días de stock como alerta (reposición interna)
      let diasHtml = "";
      if (own) {
        diasHtml = `<span class="sh-vr-badge neutral" title="Fabricación propia: días de stock no aplica como alerta">Reposición interna</span>`;
      } else if (p.dias_stock_restante !== null) {
        const cls = p.dias_stock_restante < 30 ? "warning" : "neutral";
        diasHtml = `<span class="sh-vr-badge ${cls}">${p.dias_stock_restante}d de stock</span>`;
      } else {
        diasHtml = `<span class="sh-vr-badge neutral">stock sin ref.</span>`;
      }

      return `
        <span class="sh-vr-product">${escapeHtml(p.nombre || "—")}</span>
        <span class="sh-vr-detail" style="color:#6b7280">${escapeHtml(p.category || "")}</span>
        <span class="sh-vr-badge positive">${p.units_sold_90d} u / 90d</span>
        <span class="sh-vr-badge neutral">${vel}</span>
        ${diasHtml}
        ${p.es_nuevo ? '<span class="sh-vr-badge positive">Nuevo ✓</span>' : ""}
      `;
    }, MAX_VARIANT_ROWS),
    footerHtml: `<span class="sh-more-hint">Asegurar stock antes de publicar nuevamente</span>`,
  });
}

// B2: Nuevos con buena rotación — creados hace < 120 días con ventas activas
function renderCardNewRotation() {
  const items = state.fastSellers.filter((p) => p.es_nuevo);
  buildCard({
    containerId: "card-new-rotation",
    type: "analisis",
    title: "Nuevos con buena rotación",
    desc: `${items.length} ${items.length === 1 ? "producto nuevo está" : "productos nuevos están"} vendiendo bien desde su lanzamiento.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (p) => {
      const altaDate = p.alta_en ? fmtDate(p.alta_en) : "—";
      return `
        <span class="sh-vr-product">${escapeHtml(p.nombre || "—")}</span>
        <span class="sh-vr-detail" style="color:#6b7280">${escapeHtml(p.category || "")}</span>
        <span class="sh-vr-badge positive">${p.units_sold_90d} u vendidas</span>
        <span class="sh-vr-detail">Alta: ${altaDate}</span>
        <span class="sh-vr-detail">${p.stock_total} u en stock</span>
      `;
    }, MAX_VARIANT_ROWS),
    footerHtml: `<span class="sh-more-hint">Considerar reponer stock si días restantes < 30</span>`,
  });
}

// B3: Stock acumulado — productos con ventas pero días de stock > 180
function renderCardStockAcum() {
  // Solo fast sellers con demasiado stock relativo a su velocidad
  // Excluir fabricación propia: su stock alto es intencional (reposición interna)
  const raw = state.fastSellers.filter(
    (p) => p.dias_stock_restante !== null && p.dias_stock_restante > 180
  );
  const items = raw; // Mostramos todos, pero marcamos los de fabricación propia
  buildCard({
    containerId: "card-stock-acum",
    type: "oportunidad",
    title: "Stock acumulado",
    desc: `${items.length} ${items.length === 1 ? "producto tiene" : "productos tienen"} más de 180 días de stock al ritmo de venta actual.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (p) => {
      const own = isOwnManufacturing(p.product_id);
      const meses = `~${Math.round((p.dias_stock_restante ?? 0) / 30)} meses`;
      const acumBadge = own
        ? `<span class="sh-vr-badge neutral" title="Fabricación propia: acumulación esperada">${meses} · Reposición interna</span>`
        : `<span class="sh-vr-badge oportunidad">${meses} de stock</span>`;
      return `
        <span class="sh-vr-product">${escapeHtml(p.nombre || "—")}</span>
        <span class="sh-vr-detail" style="color:#6b7280">${escapeHtml(p.category || "")}</span>
        ${acumBadge}
        <span class="sh-vr-detail">${p.stock_total} u</span>
        <span class="sh-vr-badge neutral">${p.unidades_por_dia}/día</span>
      `;
    }, MAX_VARIANT_ROWS),
    footerHtml: `<span class="sh-more-hint">Evaluar promo, reubicación o reducción de compras futuras</span>`,
  });
}

// B4: Publicados sin conversión — publicados en redes, sin ventas desde la publicación
function renderCardPubInefficiency() {
  const items = state.pubInefficiency;
  buildCard({
    containerId: "card-pub-inefficiency",
    type: "analisis",
    title: "Publicados sin ventas",
    desc: `${items.length} ${items.length === 1 ? "producto fue publicado" : "productos fueron publicados"} en redes pero no generaron ninguna venta desde entonces.`,
    count: items.length,
    variantsHtml: renderVariantRows(items, (p) => {
      const pubDate = p.last_published_at ? fmtDate(p.last_published_at) : "—";
      const diasBadgeClass = p.dias_desde_publicacion > 60 ? "warning" : "neutral";
      return `
        <span class="sh-vr-product">${escapeHtml(p.nombre || "—")}</span>
        <span class="sh-vr-detail" style="color:#6b7280">${escapeHtml(p.category || "")}</span>
        <span class="sh-vr-badge ${diasBadgeClass}">${p.dias_desde_publicacion}d sin conversión</span>
        <span class="sh-vr-detail">Publicado: ${pubDate}</span>
        <span class="sh-vr-detail">${p.stock_total} u en stock</span>
        <a href="./publications.html" style="font-size:11px;color:#2563eb;text-decoration:underline;margin-left:auto;">Re-publicar →</a>
      `;
    }, MAX_VARIANT_ROWS),
    footerHtml: `<span class="sh-more-hint">Revisar precio, imagen o canal de publicación</span>`,
  });
}

// ─────────────────────────────────────────────────────────────────
// RENDER — BLOQUE OPORTUNIDAD
// ─────────────────────────────────────────────────────────────────

// localStorage key para productos ocultados por el operador
const DEAD_STOCK_HIDDEN_KEY = "sh_dead_stock_hidden";

function getHiddenDeadIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DEAD_STOCK_HIDDEN_KEY) || "[]"));
  } catch { return new Set(); }
}

function hideDeadProduct(productId) {
  const hidden = getHiddenDeadIds();
  hidden.add(productId);
  localStorage.setItem(DEAD_STOCK_HIDDEN_KEY, JSON.stringify([...hidden]));
}

function fmtDias(dias) {
  if (dias >= 180) return `${dias}d`;
  if (dias >= 120) return `${dias}d`;
  return `${dias}d`;
}

function deadStockBadgeClass(dias) {
  if (dias >= 180) return "warning";   // naranja: muy inmovilizado
  if (dias >= 120) return "oportunidad"; // violeta: moderado
  return "info";                         // azul: seguimiento
}

function renderCardDeadStock() {
  const hidden = getHiddenDeadIds();
  const items = state.deadStock.filter((p) => !hidden.has(p.product_id));

  if (!items.length) {
    $("card-dead-stock").innerHTML = "";
    return;
  }

  // Agrupar por bucket para el resumen
  const b90  = items.filter((p) => p.dias_sin_movimiento >= 90  && p.dias_sin_movimiento < 120).length;
  const b120 = items.filter((p) => p.dias_sin_movimiento >= 120 && p.dias_sin_movimiento < 180).length;
  const b180 = items.filter((p) => p.dias_sin_movimiento >= 180).length;

  const bucketHint = [
    b90  ? `+90d: ${b90}`  : "",
    b120 ? `+120d: ${b120}` : "",
    b180 ? `+180d: ${b180}` : "",
  ].filter(Boolean).join(" · ");

  // renderCardDeadStock usa renderVariantRows indirectamente
  // pero necesita los botones de acción → construimos manualmente con la misma lógica de expand
  const expandId = `sh-exp-${++_expandSeq}`;
  function buildDeadRow(p) {
    const own = isOwnManufacturing(p.product_id);
    const seasonal = isSeasonalHint(p.nombre);
    const badgeClass = deadStockBadgeClass(p.dias_sin_movimiento);
    const fuente = p.fuente_actividad === "stock_movement" ? "movimiento" : p.fuente_actividad === "order" ? "pedido" : "alta";
    const contextBadge = own
      ? `<span class="sh-vr-badge neutral" title="Stock propio: no requiere acción urgente">Reposición interna</span>`
      : seasonal
        ? `<span class="sh-vr-badge neutral" title="Producto estacional detectado por nombre">Carryover estacional</span>`
        : "";
    return `
      <div class="sh-variant-row">
        <span class="sh-vr-product">${escapeHtml(p.nombre || "—")}</span>
        <span class="sh-vr-detail" style="color:#6b7280">${escapeHtml(p.category || "")}</span>
        <span class="sh-vr-badge ${badgeClass}">${fmtDias(p.dias_sin_movimiento)} sin movimiento</span>
        ${contextBadge}
        <span class="sh-vr-detail">${p.stock_total} u</span>
        <span class="sh-vr-detail" style="color:#9ca3af;font-size:11px;">via ${fuente}</span>
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center;">
          <a href="./products.html" style="font-size:11px;color:#2563eb;text-decoration:underline;">Ver →</a>
          <button
            class="sh-btn ghost sm"
            data-action="dead-hide"
            data-product-id="${escapeHtml(p.product_id)}"
            title="No volver a mostrar este producto en esta pantalla">
            Ocultar
          </button>
          <button
            class="sh-btn ghost sm"
            data-action="dead-discontinue"
            data-product-id="${escapeHtml(p.product_id)}"
            data-product-name="${escapeHtml(p.nombre || "")}"
            title="Marcar como archivado (discontinuado)">
            Discontinuar
          </button>
        </span>
      </div>`;
  }

  let rowsHtml = `<div class="sh-variant-list">`;
  for (const p of items.slice(0, MAX_VARIANT_ROWS)) {
    rowsHtml += buildDeadRow(p);
  }
  rowsHtml += `</div>`;

  const remaining = items.length - MAX_VARIANT_ROWS;
  if (remaining > 0) {
    let hiddenHtml = `<div class="sh-variant-list" id="${expandId}" style="display:none;">`;
    for (const p of items.slice(MAX_VARIANT_ROWS)) {
      hiddenHtml += buildDeadRow(p);
    }
    hiddenHtml += `</div>`;
    rowsHtml += hiddenHtml;
    rowsHtml += `<p class="sh-empty" style="margin-top:6px;">
      +${remaining} más —
      <button class="sh-btn ghost sm" style="padding:2px 8px;font-size:11px;vertical-align:middle;"
        onclick="_shToggleExpand(this,'${expandId}')">Ver todos</button>
    </p>`;
  }

  buildCard({
    containerId: "card-dead-stock",
    type: "oportunidad",
    title: "Productos sin movimiento",
    desc: `${items.length} ${items.length === 1 ? "producto activo lleva" : "productos activos llevan"} más de 90 días sin ventas ni movimiento de stock. (${bucketHint})`,
    count: items.length,
    variantsHtml: rowsHtml,
    footerHtml: `<span class="sh-more-hint">Oportunidad para revisar precio, visibilidad o discontinuar</span>`,
  });
}

// ─────────────────────────────────────────────────────────────────
// RENDER — ORQUESTADOR
// ─────────────────────────────────────────────────────────────────

function renderAll() {
  const status = classifyStatus();

  renderHealthHeader(status);

  // Bloque crítico
  renderCardPhantom();
  renderCardDeflated();
  renderCardTriggers();
  const hasCritical = state.phantom.length > 0 || state.deflated.length > 0 ||
    (state.gate && (!state.gate.trigger_84_active || !state.gate.trigger_145_active));
  const blockCritical = $("block-critical");
  if (blockCritical) blockCritical.classList.toggle("hidden", !hasCritical);

  // Bloque atención
  renderCardInflated();
  renderCardSizesDiff();
  renderCardOrphan();
  const hasAttention =
    state.inflatedTotal > 0 ||
    state.inflated.length > 0 ||
    state.sizesDiff.length > 0 ||
    state.orphan.length > 0;
  const blockAttention = $("block-attention");
  if (blockAttention) blockAttention.classList.toggle("hidden", !hasAttention);

  // Bloque operativo
  renderCardNoImages();
  renderCardDraftStock();
  renderCardInactiveVariants();
  const hasOperational = state.noImages.length > 0 || state.draftStock.length > 0 || state.inactiveVariants.length > 0;
  const blockOperational = $("block-operational");
  if (blockOperational) blockOperational.classList.toggle("hidden", !hasOperational);

  // Bloque comportamiento: inteligencia operativa
  renderCardFastSellers();
  renderCardNewRotation();
  renderCardStockAcum();
  renderCardPubInefficiency();
  const acumItems = state.fastSellers.filter(
    (p) => p.dias_stock_restante !== null && p.dias_stock_restante > 180
  );
  const hasBehavior = state.fastSellers.length > 0 ||
    state.pubInefficiency.length > 0 ||
    acumItems.length > 0;
  const blockBehavior = $("block-behavior");
  if (blockBehavior) blockBehavior.classList.toggle("hidden", !hasBehavior);

  // Bloque oportunidad: stock sin movimiento
  renderCardDeadStock();
  const hidden = getHiddenDeadIds();
  const visibleDead = state.deadStock.filter((p) => !hidden.has(p.product_id));
  const blockOpportunity = $("block-opportunity");
  if (blockOpportunity) blockOpportunity.classList.toggle("hidden", visibleDead.length === 0);

  // Última revisión
  const lastReview = $("last-review");
  if (lastReview) {
    const ts = state.gate?.measured_at ? fmtDate(state.gate.measured_at) : null;
    lastReview.textContent = ts ? `Revisión: ${ts}` : "";
    lastReview.classList.toggle("hidden", !ts);
  }

  // Bind de acciones en los cards recién renderizados
  bindActionButtons();
}

// ─────────────────────────────────────────────────────────────────
// MODAL DE CONFIRMACIÓN
// ─────────────────────────────────────────────────────────────────

let _modalCallback = null;

function showModal(message, onConfirm) {
  _modalCallback = onConfirm;
  const modal = $("confirm-modal");
  const msgEl = $("confirm-message");
  if (modal && msgEl) {
    msgEl.textContent = message;
    modal.classList.remove("hidden");
    $("confirm-cancel")?.focus();
  }
}

function closeModal() {
  _modalCallback = null;
  $("confirm-modal")?.classList.add("hidden");
}

function bindModalButtons() {
  $("confirm-cancel")?.addEventListener("click", closeModal);
  $("confirm-ok")?.addEventListener("click", () => {
    const cb = _modalCallback;
    closeModal();
    if (typeof cb === "function") cb();
  });
  $("confirm-modal")?.addEventListener("click", (e) => {
    if (e.target === $("confirm-modal")) closeModal();
  });
}

// ─────────────────────────────────────────────────────────────────
// ACCIONES — RECONCILE
// ─────────────────────────────────────────────────────────────────

async function reconcile(fixReserved) {
  const hasPermission = fixReserved
    ? state.canReconcileReserved
    : state.canReconcileDerivatives;

  if (!hasPermission) {
    alert("No tenés permiso para ejecutar esta acción.");
    return;
  }

  const inflatedN = state.inflatedTotal > 0 ? state.inflatedTotal : state.inflated.length;
  const message = fixReserved
    ? `Esta acción alinea reserved_qty para ${inflatedN + state.deflated.length} variantes con drift (reservas infladas o defladas). El stock disponible visible puede cambiar. No puede deshacerse automáticamente.`
    : "Esto va a sincronizar el stock visible del catálogo con el stock real de depósitos. Los talles sin stock real dejarán de mostrarse.";

  showModal(message, async () => {
    const allBtns = document.querySelectorAll("[data-action]");
    allBtns.forEach((b) => (b.disabled = true));

    try {
      const { data, error } = await supabase.rpc("rpc_reconcile_stock", {
        p_fix_reserved_qty: fixReserved,
      });

      if (error) throw error;

      const after = data?.after || {};
      const fixed = data?.reserved_qty?.fixed ?? 0;

      let msg = "Completado.\n";
      if (after.variant_sizes_diffs === 0 && after.orphan_rows === 0) {
        msg += "Stock del catálogo sincronizado correctamente.";
      }
      if (fixReserved && fixed > 0) {
        msg += `\n${fixed} reservas corregidas.`;
      }

      alert(msg);
      await loadAll();
    } catch (err) {
      alert(`Error: ${err?.message || "Ocurrió un problema al ejecutar la acción."}`);
      allBtns.forEach((b) => (b.disabled = false));
    }
  });
}

function bindActionButtons() {
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const action = e.currentTarget.dataset.action;
      if (action === "reconcile-false") reconcile(false);
      if (action === "reconcile-true")  reconcile(true);

      if (action === "dead-hide") {
        const productId = e.currentTarget.dataset.productId;
        if (!productId) return;
        hideDeadProduct(productId);
        // Re-renderizar solo el card sin recargar todo
        const hidden = getHiddenDeadIds();
        const visibleDead = state.deadStock.filter((p) => !hidden.has(p.product_id));
        renderCardDeadStock();
        const blockOpportunity = $("block-opportunity");
        if (blockOpportunity) blockOpportunity.classList.toggle("hidden", visibleDead.length === 0);
      }

      if (action === "dead-discontinue") {
        const productId   = e.currentTarget.dataset.productId;
        const productName = e.currentTarget.dataset.productName || "este producto";
        if (!productId) return;
        showModal(
          `¿Archivar "${productName}"? El producto dejará de aparecer en el catálogo. Podés reactivarlo desde Artículos.`,
          async () => {
            const { error } = await supabase
              .from("products")
              .update({ status: "archived" })
              .eq("id", productId);
            if (error) {
              alert(`Error al archivar: ${error.message}`);
              return;
            }
            // Quitar del estado local y re-renderizar sin recargar todo
            state.deadStock = state.deadStock.filter((p) => p.product_id !== productId);
            renderCardDeadStock();
            const hidden2 = getHiddenDeadIds();
            const visibleDead2 = state.deadStock.filter((p) => !hidden2.has(p.product_id));
            const blockOpportunity = $("block-opportunity");
            if (blockOpportunity) blockOpportunity.classList.toggle("hidden", visibleDead2.length === 0);
          }
        );
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────
// IA — STOCK REPORT AI
// ─────────────────────────────────────────────────────────────────

const AI_TIMEOUT_MS = 90_000;
const LAST_PUB_WORST_MIN_DAYS = 10;
const LAST_PUB_WORST_MAX_U7D = 1;
const MIN_EVENTS_FOR_HISTORY = 3;

/** Limitaciones estructurales del dato de publicación (FASE 1 / sin publication_events). */
const PUBLICATION_META_NOTAS = [
  "No existe historial de publicaciones múltiples. Métricas basadas en última publicación (last_published_at).",
  "No se puede medir frecuencia de publicación ni rendimiento por campaña hasta registrar publication_events (FASE 2).",
];

// Construye payload compacto (máx 5 items/categoría) para la Edge Function.
// No envía UUIDs. Solo nombres, números y días.
function buildStockReportPayload() {
  const TOP = 5;
  const hasHistory = state.publicationEventsPerformance.length >= MIN_EVENTS_FOR_HISTORY;
  const publicationRows = hasHistory ? state.publicationEventsPerformance : state.lastPubPerformance;

  const stockAcumulado = state.fastSellers
    .filter((p) => p.dias_stock_restante !== null && p.dias_stock_restante > 180)
    .slice(0, TOP)
    .map((p) => ({
      nombre: p.nombre,
      categoria: p.category,
      meses_stock: Math.round((p.dias_stock_restante ?? 0) / 30),
      stock_total: p.stock_total,
      velocidad: p.unidades_por_dia,
    }));

  const worstLastPubPerformance = publicationRows
    .filter((p) => {
      const u7d = Number(p.u_0_7d ?? p.sales_7d) || 0;
      const dias = Number(
        p.dias_desde_publicacion ??
        (p.published_at ? Math.floor((Date.now() - new Date(p.published_at).getTime()) / 86400000) : 0)
      ) || 0;
      return u7d <= LAST_PUB_WORST_MAX_U7D && dias > LAST_PUB_WORST_MIN_DAYS;
    })
    .sort((a, b) => {
      const aU7d = Number(a.u_0_7d ?? a.sales_7d) || 0;
      const bU7d = Number(b.u_0_7d ?? b.sales_7d) || 0;
      if (aU7d !== bU7d) return aU7d - bU7d;
      const bDays = Number(
        b.dias_desde_publicacion ??
        (b.published_at ? Math.floor((Date.now() - new Date(b.published_at).getTime()) / 86400000) : 0)
      ) || 0;
      const aDays = Number(
        a.dias_desde_publicacion ??
        (a.published_at ? Math.floor((Date.now() - new Date(a.published_at).getTime()) / 86400000) : 0)
      ) || 0;
      return bDays - aDays;
    })
    .slice(0, TOP);

  return {
    fecha: new Date().toLocaleDateString("es-AR"),
    catalogo: {
      total_fast_sellers: state.fastSellers.length,
      total_dead_stock: state.deadStock.length,
      total_stock_acumulado: stockAcumulado.length,
      total_pub_ineficiente: state.pubInefficiency.length,
      total_sin_imagenes: state.noImages.length,
      total_alta_incompleta: state.draftStock.length,
      total_inactivas_con_stock: state.inactiveVariants.length,
      gate_ok: !!(state.gate?.go_live_ready),
    },
    fast_sellers: state.fastSellers.slice(0, TOP).map((p) => ({
      nombre: p.nombre,
      categoria: p.category,
      unidades_90d: p.units_sold_90d,
      dias_stock: p.dias_stock_restante,
      velocidad: p.unidades_por_dia,
      is_own_manufacturing: isOwnManufacturing(p.product_id) ?? null,
      is_seasonal: isSeasonalHint(p.nombre),
    })),
    stock_acumulado: stockAcumulado,
    dead_stock: state.deadStock.slice(0, TOP).map((p) => ({
      nombre: p.nombre,
      categoria: p.category,
      stock_total: p.stock_total,
      dias_sin_movimiento: p.dias_sin_movimiento,
      fuente: p.fuente_actividad,
      is_own_manufacturing: isOwnManufacturing(p.product_id) ?? null,
      is_seasonal: isSeasonalHint(p.nombre),
    })),
    pub_ineficiente: state.pubInefficiency.slice(0, TOP).map((p) => ({
      nombre: p.nombre,
      categoria: p.category,
      dias_desde_pub: p.dias_desde_publicacion,
      stock_total: p.stock_total,
    })),
    sin_imagenes: state.noImages.slice(0, TOP).map((v) => ({
      nombre: v.product?.name || v.color || "—",
      stock_total: v.total_stock || 0,
    })),
    alta_incompleta: state.draftStock.slice(0, TOP).map((p) => ({
      nombre: p.name || "—",
      status: p.status,
      stock_total: p.total_stock || 0,
    })),
    tags_resumen: state.tagSummary.slice(0, 30),
    last_pub_performance: state.lastPubPerformance.slice(0, TOP).map((p) => ({
      nombre: p.nombre,
      categoria: p.category,
      dias_desde_pub: p.dias_desde_publicacion,
      u_0_24h: Number(p.u_0_24h) || 0,
      u_24_72h: Number(p.u_24_72h) || 0,
      u_0_7d: Number(p.u_0_7d) || 0,
      ventas_totales_post_ultima_pub: Number(p.ventas_totales_post_ultima_pub) || 0,
      stock_total: p.stock_total,
    })),
    publication_events_performance: state.publicationEventsPerformance.slice(0, TOP).map((p) => ({
      nombre: p.product_name,
      categoria: p.category,
      canal: p.channel || "sin_canal",
      dia_semana: (p.weekday_name || "").trim().toLowerCase(),
      etapa_mes: p.month_stage || null,
      horas_24: Number(p.sales_24h) || 0,
      horas_72: Number(p.sales_72h) || 0,
      dias_7: Number(p.sales_7d) || 0,
      dias_desde_pub: p.published_at ? Math.floor((Date.now() - new Date(p.published_at).getTime()) / 86400000) : 0,
      publicaciones_producto: Number(p.product_publication_count) || 0,
    })),
    worst_last_pub_performance: worstLastPubPerformance.map((p) => ({
      nombre: p.nombre || p.product_name,
      categoria: p.category,
      dias_desde_pub: Number(
        p.dias_desde_publicacion ??
        (p.published_at ? Math.floor((Date.now() - new Date(p.published_at).getTime()) / 86400000) : 0)
      ) || 0,
      u_0_7d: Number(p.u_0_7d ?? p.sales_7d) || 0,
      ventas_totales_post_ultima_pub: Number(p.ventas_totales_post_ultima_pub ?? p.sales_7d) || 0,
      stock_total: p.stock_total ?? 0,
    })),
    meta: {
      publication_data_source: hasHistory ? "publication_events" : "last_published_at",
      notas: hasHistory
        ? ["Se usa historial de publication_events. Si falta muestra, se complementa con agregados actuales."]
        : [...PUBLICATION_META_NOTAS],
      worst_last_pub_threshold: {
        min_dias_desde_publicacion: LAST_PUB_WORST_MIN_DAYS,
        max_u_0_7d: LAST_PUB_WORST_MAX_U7D,
      },
      min_events_for_history: MIN_EVENTS_FOR_HISTORY,
    },
  };
}

// Invoca la Edge Function stock_report_ai con timeout de 90s.
async function invokeStockReportAI(mode, pregunta = null) {
  const payload = buildStockReportPayload();
  const body = { mode, payload };
  if (mode === "question" && pregunta) body.pregunta = pregunta;

  const invokePromise = supabase.functions.invoke("stock_report_ai", { body });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("La IA tardó demasiado. Intentá nuevamente.")), AI_TIMEOUT_MS)
  );

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);

  if (error) {
    console.error("[stock_report_ai] Error de invocación:", error);
    let msg;
    if (error?.status === 404 || error?.message?.includes("not found")) {
      msg = "No se pudo generar el informe inteligente. Revisar Edge Function stock_report_ai (puede no estar desplegada).";
    } else if (error?.status === 429) {
      msg = "Demasiadas solicitudes a la IA. Esperá un momento e intentá nuevamente.";
    } else if (error?.status >= 500) {
      msg = "Error interno en la Edge Function stock_report_ai. Revisá los logs en el Dashboard de Supabase.";
    } else if (error?.message?.includes("timeout") || error?.message?.includes("tardó demasiado")) {
      msg = "La IA tardó demasiado en responder. Intentá nuevamente en unos segundos.";
    } else {
      msg = error?.message || "No se pudo generar el informe inteligente. Revisá la Edge Function stock_report_ai.";
    }
    throw new Error(msg);
  }
  if (!data) {
    console.error("[stock_report_ai] Respuesta vacía");
    throw new Error("Respuesta vacía de la IA. Intentá nuevamente.");
  }
  if (data.error) {
    console.error("[stock_report_ai] Error devuelto por la función:", data.error);
    // Distinguir error de JSON inválido de OpenAI vs otros errores de la función
    const isJsonError = data.error.toLowerCase().includes("formato") || data.error.toLowerCase().includes("json") || data.error.toLowerCase().includes("parsear");
    if (isJsonError) {
      throw new Error("La IA respondió en un formato no válido. Intentá nuevamente.");
    }
    throw new Error(data.error);
  }
  return data;
}

// ─────── RENDER: Informe completo ───────

function confianzaBadge(nivel) {
  const map = {
    alta:  { cls: "positive", label: "Confianza alta" },
    media: { cls: "neutral",  label: "Confianza media" },
    baja:  { cls: "warning",  label: "Confianza baja" },
  };
  const c = map[nivel] || map.media;
  return `<span class="sh-vr-badge ${c.cls}" style="font-size:11px">${c.label}</span>`;
}

function renderSection(icon, title, items, emptyText) {
  if (!items || !items.length) {
    return `<div class="ai-section">
      <p class="ai-section-title">${icon} ${title}</p>
      <p class="ai-empty">${emptyText || "Sin elementos detectados."}</p>
    </div>`;
  }
  const rows = items.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  return `<div class="ai-section">
    <p class="ai-section-title">${icon} ${title}</p>
    <ul class="ai-list">${rows}</ul>
  </div>`;
}

function renderStockReport(report) {
  const panel = $("ai-report-panel");
  if (!panel) return;

  const ts = new Date().toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  panel.innerHTML = `
    <div class="ai-panel">
      <div class="ai-panel-header">
        <span class="ai-panel-title">🧠 Informe inteligente — ${ts}</span>
        ${confianzaBadge(report.confianza)}
        <button class="sh-btn ghost sm" id="ai-report-close" style="margin-left:auto">✕</button>
      </div>

      <div class="ai-section ai-resumen">
        <p class="ai-section-title">📋 Resumen ejecutivo</p>
        <p>${escapeHtml(report.resumen || "—")}</p>
      </div>

      ${renderSection("⚠", "Alertas", report.alertas, "Sin alertas activas.")}
      ${renderSection("◆", "Oportunidades", report.oportunidades, "Sin oportunidades detectadas.")}
      ${renderSection("✦", "Recomendaciones", report.recomendaciones, "Sin recomendaciones.")}
      ${renderSection("→", "Próximas acciones sugeridas", report.acciones_sugeridas, "Sin acciones sugeridas.")}

      <p class="ai-footnote">Análisis generado con los datos cargados en esta sesión. No modifica datos.</p>
    </div>
  `;

  panel.classList.remove("hidden");
  $("ai-report-close")?.addEventListener("click", () => panel.classList.add("hidden"));
}

// ─────── RENDER: Respuesta a pregunta ───────

function renderStockAnswer(response, pregunta) {
  const container = $("ai-answer-container");
  if (!container) return;

  container.innerHTML = `
    <div class="ai-answer">
      <p class="ai-answer-question">❓ ${escapeHtml(pregunta)}</p>
      <p class="ai-answer-text">${escapeHtml(response.respuesta || "—")}</p>
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
        ${confianzaBadge(response.confianza)}
        <span style="font-size:11px;color:#9ca3af;">Basado en datos de esta sesión</span>
      </div>
    </div>
  `;
  container.classList.remove("hidden");
}

// ─────── HANDLERS DE BOTONES ───────

function renderAIError(containerId, message) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = `
    <div style="border:1px solid #fecaca;border-left:4px solid #dc2626;border-radius:8px;padding:14px 16px;background:#fff5f5;margin-bottom:8px;">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#dc2626;">⚠ Error</p>
      <p style="margin:0;font-size:13px;color:#374151;">${escapeHtml(message)}</p>
    </div>`;
  el.classList.remove("hidden");
}

async function handleGenerateReport() {
  const btn = $("ai-report-btn");
  const statusEl = $("ai-report-status");
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = "Analizando catálogo...";
  if (statusEl) statusEl.textContent = "";
  // Limpiar panel de error anterior
  const panel = $("ai-report-panel");
  if (panel) panel.innerHTML = "";

  try {
    const report = await invokeStockReportAI("report");
    renderStockReport(report);
  } catch (err) {
    console.error("[stock_report_ai] Error en handleGenerateReport:", err);
    // Mostrar error tanto en el topbar (pequeño) como en el panel (visible)
    if (statusEl) { statusEl.textContent = "Error al generar informe"; statusEl.style.color = "#dc2626"; }
    renderAIError("ai-report-panel", err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🧠 Generar informe";
  }
}

async function handleAskQuestion(pregunta) {
  if (!pregunta?.trim()) return;

  const btn = $("ai-ask-btn");
  const input = $("ai-question-input");
  const statusEl = $("ai-ask-status");
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = "Consultando...";
  if (statusEl) statusEl.textContent = "";

  try {
    const response = await invokeStockReportAI("question", pregunta.trim());
    renderStockAnswer(response, pregunta.trim());
    if (input) input.value = "";
  } catch (err) {
    console.error("[stock_report_ai] Error en handleAskQuestion:", err);
    if (statusEl) { statusEl.textContent = err.message; statusEl.style.color = "#dc2626"; }
    // Mostrar el error también en el contenedor de respuesta para máxima visibilidad
    renderAIError("ai-answer-container", err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Preguntar";
  }
}

function bindAIButtons() {
  $("ai-report-btn")?.addEventListener("click", handleGenerateReport);

  $("ai-ask-btn")?.addEventListener("click", () => {
    const val = $("ai-question-input")?.value || "";
    handleAskQuestion(val);
  });

  $("ai-question-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = e.target.value || "";
      handleAskQuestion(val);
    }
  });

  // Preguntas sugeridas
  document.querySelectorAll("[data-ai-question]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const q = e.currentTarget.dataset.aiQuestion;
      handleAskQuestion(q);
    });
  });
}

// ─────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────

async function init() {
  // Cargar auth
  const { user } = await preloadAuthState();
  if (!user) {
    window.location.href = "./index.html";
    return;
  }

  // Verificar permiso de vista
  if (!can("stock-audit", "view") && !isAdminUser()) {
    alert("No tenés acceso a esta sección.");
    window.location.href = "./index.html";
    return;
  }

  // Resolver permisos para acciones
  state.superAdmin = await isSuperAdmin();
  state.canReconcileReserved = state.superAdmin;
  state.canReconcileDerivatives = state.superAdmin || can("stock", "edit");

  // Binds fijos
  bindModalButtons();
  bindAIButtons();

  // Cargar datos
  await loadAll();
}

init().catch((err) => {
  console.error("[stock-audit] Error crítico en init:", err);
  const h = $("health-header");
  if (h) {
    h.className = "sh-header critico";
    h.innerHTML = `<span class="sh-status-badge critico">✕ Error</span><div class="sh-header-info"><p>No se pudo cargar el módulo. Recargá la página.</p></div>`;
  }
});
