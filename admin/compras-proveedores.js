// admin/compras-proveedores.js — purchase_* (temporadas, proveedores, reglas, pedidos, recepciones, arqueo)
import { supabase } from "../scripts/supabase-client.js";
import { preloadAuthState, can, isAdminUser } from "./auth-state.js";

const globalErr = document.getElementById("global-err");
let _comprasAuthAllowed = false;
let _comprasAuthChecked = false;

const comprasAuthReady = (async () => {
  try {
    const { user } = await preloadAuthState();
    if (!user) {
      window.location.href = "./index.html";
      return false;
    }
    const ok = can("proveedores", "view") || isAdminUser();
    if (!ok) {
      window.location.href = "./index.html";
      return false;
    }
    _comprasAuthAllowed = true;
    return true;
  } catch (authErr) {
    console.warn("[compras-proveedores] auth gate error:", authErr);
    window.location.href = "./index.html";
    return false;
  } finally {
    _comprasAuthChecked = true;
  }
})();

async function ensureComprasAuth() {
  if (_comprasAuthChecked && !_comprasAuthAllowed) return false;
  const ok = await comprasAuthReady;
  return ok && _comprasAuthAllowed;
}

function runComprasTask(label, task) {
  Promise.resolve()
    .then(task)
    .catch((err) => {
      console.error(`[compras-proveedores] ${label} failed:`, err);
      showErr(err?.message || "Error inesperado");
    });
}

function showErr(msg) {
  if (!globalErr) return;
  if (msg) {
    globalErr.textContent = msg;
    globalErr.style.display = "block";
  } else {
    globalErr.textContent = "";
    globalErr.style.display = "none";
  }
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function fmtMoney(n) {
  if (n == null || n === "") return "—";
  const x = Number(n);
  if (Number.isNaN(x)) return "—";
  return x.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setOrdersPanelMsg(html) {
  const el = document.getElementById("orders-panel-msg");
  if (!el) return;
  el.innerHTML = html || "";
}

function setOrdersIngestMsg(html) {
  const el = document.getElementById("orders-ingest-msg");
  if (!el) return;
  el.innerHTML = html || "";
}

function truncateText(s, max) {
  const t = String(s || "");
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

/** Etiquetas en español para `supplier_message_ingest.parsed_status` */
const PARSED_STATUS_LABELS = {
  received: "Recibido",
  parsed: "Interpretado",
  needs_review: "Revisar",
  failed: "Falló",
  no_order_content: "Sin pedido",
};

function labelParsedStatus(code) {
  const c = String(code || "").trim();
  return PARSED_STATUS_LABELS[c] || (c ? c : "—");
}

const ORDER_STATUS_LABELS = {
  open: "Abierto",
  closed: "Cerrado",
  cancelled: "Anulado",
};

function labelOrderStatus(code) {
  const c = String(code || "").trim().toLowerCase();
  return ORDER_STATUS_LABELS[c] || (code ? String(code) : "—");
}

/**
 * Texto corto para humanos a partir de `parse_error` (código o código:detalle).
 * @param {unknown} rawErr
 */
function humanizeParseErrorShort(rawErr) {
  const s = String(rawErr || "").trim();
  if (!s) return "—";
  const key = s.split(/[|:]/)[0].trim().toLowerCase();
  const map = {
    compute_lines_failed: "No se pudo calcular el pedido (reglas o unidades del proveedor).",
    not_found: "Proveedor no encontrado: revisá nombre y alias en admin.",
    empty_hint: "No se detectó qué proveedor es en el mensaje.",
    unit_not_in_rules: "La unidad del mensaje no está permitida en las reglas.",
    resolve_supplier_failed: "No se pudo resolver el proveedor.",
    no_active_rules: "El proveedor no tiene reglas activas.",
    no_default_season: "No hay temporada activa configurada.",
  };
  return map[key] || `Revisar: ${truncateText(s, 110)}`;
}

/** @param {unknown} raw jsonb `openai_response_raw` */
function summarizeOpenAiIngest(raw) {
  if (raw == null || raw === "") return "—";
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return truncateText(raw, 100);
    }
  }
  if (typeof obj !== "object" || obj === null) return "—";
  const o = /** @type {Record<string, unknown>} */ (obj);
  const items = Array.isArray(o.items)
    ? o.items
    : Array.isArray(o.parsed_items)
      ? o.parsed_items
      : [];
  if (!items.length) {
    if (o.has_actionable_order === false) return "Sin ítems de pedido";
    const hint = o.supplier_hint != null ? String(o.supplier_hint) : "";
    return hint ? truncateText(`Proveedor sugerido: ${hint}`, 120) : "—";
  }
  const parts = items.map((it) => {
    if (!it || typeof it !== "object") return "";
    const row = /** @type {Record<string, unknown>} */ (it);
    const d = row.description ?? row.desc ?? row.name ?? row.article ?? row.article_code ?? "";
    const q = row.qty ?? row.quantity;
    const u = row.unit ?? "";
    return [String(d || "").trim(), q != null && q !== "" ? String(q) : "", String(u || "").trim()]
      .filter(Boolean)
      .join(" ");
  });
  const out = parts.filter(Boolean).join(" · ");
  return out ? truncateText(out, 220) : "—";
}

/** @param {unknown} lines */
function summarizePurchaseLines(lines) {
  if (!lines || !Array.isArray(lines) || lines.length === 0) return "—";
  const sorted = [...lines].sort((a, b) => Number(a.line_index) - Number(b.line_index));
  const parts = [];
  for (const pl of sorted) {
    if (!pl || typeof pl !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (pl);
    const raw = String(row.raw_line_text || "").trim();
    if (raw) {
      parts.push(truncateText(raw, 95));
      continue;
    }
    const bits = [row.article_code, row.color, row.size].filter(Boolean).map((x) => String(x));
    const head = bits.join(" ").trim();
    const q = row.qty_ordered != null && row.qty_ordered !== "" ? String(row.qty_ordered) : "";
    const u = row.unit_text ? String(row.unit_text) : "";
    const tail = [q, u].filter(Boolean).join(" ");
    const one = [head, tail].filter(Boolean).join(" — ");
    parts.push(one || "—");
  }
  const joined = parts.join(" · ");
  return joined ? truncateText(joined, 240) : "—";
}

function supplierNameFromOrderRow(o, supMap) {
  const rel = o?.purchase_suppliers;
  const fromJoin =
    rel && typeof rel === "object" && !Array.isArray(rel)
      ? /** @type {{ display_name?: string }} */ (rel).display_name
      : Array.isArray(rel) && rel[0]
        ? /** @type {{ display_name?: string }} */ (rel[0]).display_name
        : null;
  return fromJoin || supMap[o.supplier_id] || "—";
}

/** @type {Record<string, unknown>[]} */
let suppliersCache = [];
/** @type {Record<string, unknown>[]} */
let seasonsCache = [];
/** @type {Record<string, unknown>[]} */
let ordersCache = [];
/** @type {Set<string>} */
let suppliersWithActiveRules = new Set();

/**
 * @param {HTMLSelectElement | null} unitEl
 * @param {HTMLInputElement | null} pairsEl
 * @param {HTMLSelectElement | null} basisEl
 * @param {boolean} [alsoResetValues=true] si false, solo actualiza disabled/required (p. ej. tras cargar reglas desde BD).
 */
function syncUnitDerivedFields(unitEl, pairsEl, basisEl, alsoResetValues = true) {
  if (!unitEl || !pairsEl || !basisEl) return;
  const unit = unitEl.value;
  if (alsoResetValues) {
    basisEl.value = defaultBasisByUnit(unit);
    const pairsDefault = defaultPairsByUnit(unit);
    pairsEl.disabled = unit === "par" || unit === "docena";
    pairsEl.required = unit === "bulto";
    if (pairsDefault != null) pairsEl.value = String(pairsDefault);
    if (unit === "bulto" && !pairsEl.value) pairsEl.value = "";
  } else {
    pairsEl.disabled = unit === "par" || unit === "docena";
    pairsEl.required = unit === "bulto";
  }
}

/**
 * Construye el objeto `rules` para `purchase_create_rule_version` desde inputs del DOM.
 * @param {string} fieldPrefix ej. `new-rule-` o `rule-rev-` → ids `prefix + currency`, etc.
 */
function buildRulesFromFieldPrefix(fieldPrefix) {
  const currency = (document.getElementById(`${fieldPrefix}currency`)?.value || "ARS").trim().toUpperCase();
  const discountPct = Number(document.getElementById(`${fieldPrefix}discount`)?.value ?? 0);
  const unit = document.getElementById(`${fieldPrefix}unit`)?.value || "par";
  const basis = document.getElementById(`${fieldPrefix}basis`)?.value || "per_par";
  const pairsRaw = document.getElementById(`${fieldPrefix}pairs`)?.value ?? "";
  const pairsPerUnit = pairsRaw === "" ? null : Number(pairsRaw);

  if (!Number.isFinite(discountPct)) throw new Error("Descuento inválido.");
  if (unit === "bulto" && (!Number.isFinite(pairsPerUnit) || pairsPerUnit <= 0)) {
    throw new Error("Si la unidad principal es bulto, completá pares por unidad.");
  }
  if (pairsPerUnit != null && (!Number.isFinite(pairsPerUnit) || pairsPerUnit <= 0)) {
    throw new Error("Pares por unidad inválido.");
  }

  const units = {};
  const tareaPairs = unit === "tarea" && Number.isFinite(pairsPerUnit) && pairsPerUnit > 0 ? pairsPerUnit : 24;

  units["par"] = {
    pairs_per_unit: 1,
    default_price_basis: "per_par",
    match: ["par", "pares", "prs", "pr"],
  };
  units["tarea"] = {
    pairs_per_unit: tareaPairs,
    default_price_basis: unit === "tarea" ? basis : "per_tarea",
    allowed_price_bases: ["per_tarea", "per_par"],
    match: ["tarea", "tareas", "tar"],
  };
  units["docena"] = {
    pairs_per_unit: 12,
    default_price_basis: unit === "docena" ? basis : "per_docena",
    allowed_price_bases: ["per_docena", "per_par"],
    match: ["docena", "docenas", "doc", "dz"],
  };

  if (unit === "bulto") {
    units["bulto"] = {
      pairs_per_unit: pairsPerUnit,
      default_price_basis: basis,
      allowed_price_bases: ["per_bulto", "per_par"],
      match: ["bulto", "bultos"],
    };
  }

  return {
    currency: currency || "ARS",
    default_discount_pct: discountPct,
    units,
  };
}

function buildBasicRulesFromForm() {
  return buildRulesFromFieldPrefix("new-rule-");
}

/** Lee reglas activas y deduce unidad principal para el formulario de revisión. */
function inferPrimaryFromRules(rules) {
  const u = rules && typeof rules === "object" ? /** @type {Record<string, unknown>} */ (rules).units : null;
  const currency =
    rules && typeof rules === "object" && /** @type {Record<string, unknown>} */ (rules).currency
      ? String(/** @type {Record<string, unknown>} */ (rules).currency).toUpperCase()
      : "ARS";
  const discount = rules && typeof rules === "object" ? Number(/** @type {Record<string, unknown>} */ (rules).default_discount_pct ?? 0) : 0;

  if (!u || typeof u !== "object") {
    return { currency, discount: Number.isFinite(discount) ? discount : 0, unit: "par", pairs: 1, basis: "per_par" };
  }
  const units = /** @type {Record<string, Record<string, unknown>>} */ (u);

  if (units.tarea) {
    const tp = Number(units.tarea.pairs_per_unit);
    const basis = String(units.tarea.default_price_basis || "per_tarea");
    return {
      currency,
      discount: Number.isFinite(discount) ? discount : 0,
      unit: "tarea",
      pairs: Number.isFinite(tp) && tp > 0 ? tp : 24,
      basis: ["per_tarea", "per_par"].includes(basis) ? basis : "per_tarea",
    };
  }
  if (units.docena) {
    const basis = String(units.docena.default_price_basis || "per_docena");
    return {
      currency,
      discount: Number.isFinite(discount) ? discount : 0,
      unit: "docena",
      pairs: 12,
      basis: ["per_docena", "per_par"].includes(basis) ? basis : "per_docena",
    };
  }
  if (units.bulto) {
    const bp = Number(units.bulto.pairs_per_unit);
    const basis = String(units.bulto.default_price_basis || "per_bulto");
    return {
      currency,
      discount: Number.isFinite(discount) ? discount : 0,
      unit: "bulto",
      pairs: Number.isFinite(bp) && bp > 0 ? bp : "",
      basis: ["per_bulto", "per_par"].includes(basis) ? basis : "per_bulto",
    };
  }
  if (units.par) {
    const basis = String(units.par.default_price_basis || "per_par");
    return {
      currency,
      discount: Number.isFinite(discount) ? discount : 0,
      unit: "par",
      pairs: 1,
      basis: basis === "per_par" ? basis : "per_par",
    };
  }
  const keys = Object.keys(units);
  const k = keys[0];
  if (!k) return { currency, discount: Number.isFinite(discount) ? discount : 0, unit: "par", pairs: 1, basis: "per_par" };
  const block = units[k];
  const known = k === "par" || k === "tarea" || k === "docena" || k === "bulto";
  const pp = Number(block?.pairs_per_unit);
  const rawBasis = String(block?.default_price_basis || "per_par");
  const allowedB = new Set(["per_par", "per_tarea", "per_docena", "per_bulto"]);
  const basis = allowedB.has(rawBasis) ? rawBasis : defaultBasisByUnit(known ? k : "par");
  return {
    currency,
    discount: Number.isFinite(discount) ? discount : 0,
    unit: known ? k : "par",
    pairs: Number.isFinite(pp) && pp > 0 ? pp : 1,
    basis,
  };
}

/** Conserva unidades “extra” y `size_mix_per_unit` de la versión activa al guardar desde el formulario simple. */
async function mergeRulesPreservingExtras(supplierId, built) {
  const { data: rows, error } = await supabase
    .from("purchase_supplier_rule_versions")
    .select("rules")
    .eq("supplier_id", supplierId)
    .eq("is_active", true)
    .limit(1);
  const data = rows?.[0];
  if (error || !data?.rules || typeof data.rules !== "object") return built;
  const prev = /** @type {Record<string, unknown>} */ (data.rules);
  const prevUnits = prev.units && typeof prev.units === "object" ? /** @type {Record<string, unknown>} */ (prev.units) : {};
  const out = { ...built, units: { ...prevUnits, .../** @type {Record<string, unknown>} */ (built).units } };
  if (prev.size_mix_per_unit) out.size_mix_per_unit = prev.size_mix_per_unit;
  return out;
}

async function loadActiveRulesIntoRevForm(supplierId) {
  const cur = document.getElementById("rule-rev-currency");
  const disc = document.getElementById("rule-rev-discount");
  const unitEl = document.getElementById("rule-rev-unit");
  const pairsEl = document.getElementById("rule-rev-pairs");
  const basisEl = document.getElementById("rule-rev-basis");
  const msg = document.getElementById("rule-msg");
  if (!cur || !disc || !unitEl || !pairsEl || !basisEl) return;

  if (!supplierId) {
    cur.value = "ARS";
    disc.value = "0";
    unitEl.value = "par";
    syncUnitDerivedFields(unitEl, pairsEl, basisEl, true);
    if (msg) msg.textContent = "";
    return;
  }

  const { data: rows, error } = await supabase
    .from("purchase_supplier_rule_versions")
    .select("rules")
    .eq("supplier_id", supplierId)
    .eq("is_active", true)
    .limit(1);
  const data = rows?.[0];

  if (error) {
    if (msg) msg.textContent = error.message;
    return;
  }

  if (!data?.rules) {
    cur.value = "ARS";
    disc.value = "0";
    unitEl.value = "par";
    syncUnitDerivedFields(unitEl, pairsEl, basisEl, true);
    if (msg) msg.textContent = "Este proveedor aún no tiene reglas activas: los valores por defecto se usan al guardar.";
    return;
  }

  const inf = inferPrimaryFromRules(data.rules);
  cur.value = inf.currency || "ARS";
  disc.value = String(inf.discount ?? 0);
  unitEl.value = inf.unit;
  pairsEl.value = inf.pairs === "" ? "" : String(inf.pairs);
  const allowed = new Set(["per_par", "per_tarea", "per_docena", "per_bulto"]);
  basisEl.value = allowed.has(inf.basis) ? inf.basis : defaultBasisByUnit(inf.unit);
  syncUnitDerivedFields(unitEl, pairsEl, basisEl, false);

  const extraKeys =
    data.rules && typeof data.rules === "object" && /** @type {Record<string, unknown>} */ (data.rules).units
      ? Object.keys(/** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (data.rules).units))
      : [];
  const standard = new Set(["par", "tarea", "docena", "bulto"]);
  const custom = extraKeys.filter((k) => !standard.has(k));
  if (msg) {
    msg.textContent = custom.length
      ? `Reglas cargadas. Hay unidades personalizadas (${custom.join(", ")}): se conservan al guardar con este formulario.`
      : "Reglas activas cargadas en el formulario.";
  }
}

function bindRulesRevisionPanel() {
  const sel = document.getElementById("rule-supplier");
  const unitEl = /** @type {HTMLSelectElement | null} */ (document.getElementById("rule-rev-unit"));
  const pairsEl = /** @type {HTMLInputElement | null} */ (document.getElementById("rule-rev-pairs"));
  const basisEl = /** @type {HTMLSelectElement | null} */ (document.getElementById("rule-rev-basis"));
  if (!sel || sel.dataset.rulesRevBound === "1") return;
  sel.dataset.rulesRevBound = "1";
  unitEl?.addEventListener("change", () => syncUnitDerivedFields(unitEl, pairsEl, basisEl));
  sel.addEventListener("change", () => {
    loadActiveRulesIntoRevForm(sel.value).catch((e) => console.error(e));
  });
  syncUnitDerivedFields(unitEl, pairsEl, basisEl, true);
}

function setupTabs() {
  document.querySelectorAll("#tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-panel");
      document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("open"));
      btn.classList.add("active");
      const panel = document.getElementById(id || "");
      panel?.classList.add("open");
      if (id === "p-orders") {
        runComprasTask("open_orders_panel", async () => {
          if (!(await ensureComprasAuth())) return;
          await loadOrdersPanel();
        });
      }
    });
  });
}

async function loadSeasons() {
  const tbody = document.getElementById("tbody-seasons");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="muted">Cargando…</td></tr>`;
  const { data, error } = await supabase
    .from("purchase_seasons")
    .select("id,label,date_start,date_end,active")
    .order("created_at", { ascending: false });
  if (error) {
    tbody.innerHTML = `<tr><td colspan="4">${error.message}</td></tr>`;
    return;
  }
  seasonsCache = data || [];
  tbody.innerHTML = "";
  for (const row of seasonsCache) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(String(row.label))}</td><td>${row.date_start || "—"}</td><td>${row.date_end || "—"}</td><td>${row.active ? "Sí" : "No"}</td>`;
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slugify(raw) {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeAliases(raw) {
  const seen = new Set();
  const aliases = [];
  for (const token of String(raw || "").split(",")) {
    const cleaned = token
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    aliases.push(cleaned);
  }
  return aliases;
}

function setNewSupplierMsg(text, kind = "muted") {
  const el = document.getElementById("new-supplier-msg");
  if (!el) return;
  el.textContent = text || "";
  if (kind === "ok") el.className = "msg-ok";
  else if (kind === "warn") el.className = "msg-warn";
  else if (kind === "err") el.className = "msg-err";
  else el.className = "muted";
}

function setEditSupplierMsg(text, kind = "muted") {
  const el = document.getElementById("edit-supplier-msg");
  if (!el) return;
  el.textContent = text || "";
  if (kind === "ok") el.className = "msg-ok";
  else if (kind === "warn") el.className = "msg-warn";
  else if (kind === "err") el.className = "msg-err";
  else el.className = "muted";
}

function defaultPairsByUnit(unit) {
  if (unit === "par") return 1;
  if (unit === "docena") return 12;
  if (unit === "tarea") return 24;
  return null;
}

function defaultBasisByUnit(unit) {
  if (unit === "tarea") return "per_tarea";
  if (unit === "docena") return "per_docena";
  if (unit === "bulto") return "per_bulto";
  return "per_par";
}

async function addSeason() {
  const label = document.getElementById("new-season-label")?.value?.trim();
  const date_start = document.getElementById("new-season-start")?.value || null;
  const date_end = document.getElementById("new-season-end")?.value || null;
  if (!label) {
    showErr("Indicá una etiqueta de temporada.");
    return;
  }
  showErr("");
  const { error } = await supabase.from("purchase_seasons").insert({ label, date_start, date_end, active: true });
  if (error) {
    showErr(error.message);
    return;
  }
  await loadSeasons();
}

function fillRuleSupplierSelect() {
  const sel = document.getElementById("rule-supplier");
  if (!sel) return;
  sel.innerHTML = "";
  for (const s of suppliersCache) {
    const o = document.createElement("option");
    o.value = String(s.id);
    o.textContent = `${s.display_name} (${s.slug})`;
    sel.appendChild(o);
  }
}

function fillEditSupplierSelect() {
  const sel = document.getElementById("edit-supplier-id");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— Elegir proveedor —</option>';
  for (const s of suppliersCache) {
    const o = document.createElement("option");
    o.value = String(s.id);
    o.textContent = `${s.display_name} (${s.slug})`;
    sel.appendChild(o);
  }
  if (current && suppliersCache.some((s) => String(s.id) === current)) {
    sel.value = current;
  }
}

function loadSelectedSupplierIntoForm() {
  const sel = document.getElementById("edit-supplier-id");
  if (!sel) return;
  const id = sel.value;
  const row = suppliersCache.find((s) => String(s.id) === id);
  const nameEl = document.getElementById("edit-supplier-name");
  const slugEl = document.getElementById("edit-supplier-slug");
  const aliasesEl = document.getElementById("edit-supplier-aliases");
  const activeEl = document.getElementById("edit-supplier-active");
  const notesEl = document.getElementById("edit-supplier-notes");
  if (!row) {
    if (nameEl) nameEl.value = "";
    if (slugEl) slugEl.value = "";
    if (aliasesEl) aliasesEl.value = "";
    if (activeEl) activeEl.value = "true";
    if (notesEl) notesEl.value = "";
    return;
  }
  if (nameEl) nameEl.value = row.display_name || "";
  if (slugEl) slugEl.value = row.slug || "";
  if (aliasesEl) aliasesEl.value = Array.isArray(row.aliases) ? row.aliases.join(", ") : "";
  if (activeEl) activeEl.value = row.active ? "true" : "false";
  if (notesEl) notesEl.value = row.notes || "";
}

async function loadSuppliers() {
  const tbody = document.getElementById("tbody-suppliers");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="muted">Cargando…</td></tr>`;
  const [{ data, error }, activeRes] = await Promise.all([
    supabase
    .from("purchase_suppliers")
    .select("id,slug,display_name,aliases,active,notes")
    .order("display_name"),
    supabase.from("purchase_supplier_rule_versions").select("supplier_id").eq("is_active", true),
  ]);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="6">${error.message}</td></tr>`;
    return;
  }
  if (activeRes.error) {
    tbody.innerHTML = `<tr><td colspan="6">${activeRes.error.message}</td></tr>`;
    return;
  }
  suppliersCache = data || [];
  suppliersWithActiveRules = new Set((activeRes.data || []).map((r) => String(r.supplier_id)));
  tbody.innerHTML = "";
  for (const s of suppliersCache) {
    const tr = document.createElement("tr");
    const aliasesStr = Array.isArray(s.aliases) ? s.aliases.join(", ") : "";
    const hasActiveRules = suppliersWithActiveRules.has(String(s.id));
    tr.innerHTML = `
      <td><input type="text" data-field="display_name" data-id="${s.id}" value="${escapeHtml(String(s.display_name))}" /></td>
      <td><code>${escapeHtml(String(s.slug))}</code></td>
      <td><input type="text" data-field="aliases" data-id="${s.id}" value="${escapeHtml(aliasesStr)}" style="max-width:100%" /></td>
      <td><input type="checkbox" data-field="active" data-id="${s.id}" ${s.active ? "checked" : ""} /></td>
      <td>${hasActiveRules ? '<span class="badge">Sí</span>' : '<span class="badge">No</span>'}</td>
      <td><button type="button" class="btn btn-secondary btn-save-sup" data-id="${s.id}">Guardar</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".btn-save-sup").forEach((btn) => {
    btn.addEventListener("click", () => {
      runComprasTask("save_supplier_row", async () => {
        if (!(await ensureComprasAuth())) return;
        await saveSupplierRow(btn.getAttribute("data-id"));
      });
    });
  });
  fillRuleSupplierSelect();
  fillEditSupplierSelect();
  loadSelectedSupplierIntoForm();
  const ruleSel = document.getElementById("rule-supplier");
  if (ruleSel?.value) await loadActiveRulesIntoRevForm(ruleSel.value);
  else await loadActiveRulesIntoRevForm("");
}

async function saveSupplierRow(id) {
  if (!id) return;
  const row = document.querySelector(`.btn-save-sup[data-id="${id}"]`)?.closest("tr");
  if (!row) return;
  const display = row.querySelector('[data-field="display_name"]')?.value?.trim();
  const aliasesRaw = row.querySelector('[data-field="aliases"]')?.value || "";
  const aliases = normalizeAliases(aliasesRaw);
  const active = !!row.querySelector('[data-field="active"]')?.checked;
  showErr("");
  const { error } = await supabase.from("purchase_suppliers").update({ display_name: display, aliases, active }).eq("id", id);
  if (error) showErr(error.message);
  else await loadSuppliers();
}

async function updateSupplierFromForm() {
  const id = document.getElementById("edit-supplier-id")?.value || "";
  if (!id) throw new Error("Elegí un proveedor para editar.");
  const displayName = document.getElementById("edit-supplier-name")?.value?.trim() || "";
  const slug = slugify(document.getElementById("edit-supplier-slug")?.value || "");
  const aliases = normalizeAliases(document.getElementById("edit-supplier-aliases")?.value || "");
  const active = (document.getElementById("edit-supplier-active")?.value || "true") === "true";
  const notesRaw = document.getElementById("edit-supplier-notes")?.value?.trim() || "";
  const notes = notesRaw || null;
  if (!displayName) throw new Error("Nombre del proveedor requerido.");
  if (!slug) throw new Error("Slug requerido.");
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("Slug inválido.");

  const dup = await supabase.from("purchase_suppliers").select("id").eq("slug", slug).neq("id", id).limit(1);
  if (dup.error) throw dup.error;
  if ((dup.data || []).length) throw new Error("Slug en uso por otro proveedor.");

  const { error } = await supabase
    .from("purchase_suppliers")
    .update({
      display_name: displayName,
      slug,
      aliases,
      active,
      notes,
    })
    .eq("id", id);
  if (error) throw error;
}

async function deleteSupplierFromForm() {
  const id = document.getElementById("edit-supplier-id")?.value || "";
  if (!id) throw new Error("Elegí un proveedor para eliminar.");
  const target = suppliersCache.find((s) => String(s.id) === id);
  const label = target?.display_name || id;
  const ok = window.confirm(`¿Eliminar proveedor "${label}"?\nEsta acción no se puede deshacer.`);
  if (!ok) return false;
  const { error } = await supabase.from("purchase_suppliers").delete().eq("id", id);
  if (error) throw error;
  return true;
}

async function createSupplierQuick() {
  const displayName = document.getElementById("new-supplier-name")?.value?.trim() || "";
  const slug = slugify(document.getElementById("new-supplier-slug")?.value || "");
  const aliases = normalizeAliases(document.getElementById("new-supplier-aliases")?.value || "");
  const active = (document.getElementById("new-supplier-active")?.value || "true") === "true";
  const notesRaw = document.getElementById("new-supplier-notes")?.value?.trim() || "";
  const notes = notesRaw || null;

  if (!displayName) throw new Error("Nombre del proveedor requerido.");
  if (!slug) throw new Error("Slug requerido.");
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("Slug inválido: usar minúsculas, números y guiones.");

  const dup = await supabase.from("purchase_suppliers").select("id").eq("slug", slug).limit(1);
  if (dup.error) throw dup.error;
  if ((dup.data || []).length) throw new Error("El slug ya existe.");

  const ins = await supabase
    .from("purchase_suppliers")
    .insert({ slug, display_name: displayName, aliases, active, notes })
    .select("id")
    .single();

  if (ins.error) {
    if ((ins.error.message || "").toLowerCase().includes("row-level security")) {
      throw new Error("Error creando proveedor (RLS). Revisá policy o usá RPC segura.");
    }
    throw ins.error;
  }

  const rules = buildBasicRulesFromForm();
  const rulesRes = await supabase.rpc("purchase_create_rule_version", {
    p_supplier_id: ins.data.id,
    p_rules: rules,
  });
  if (rulesRes.error) {
    if ((rulesRes.error.message || "").toLowerCase().includes("row-level security")) {
      throw new Error("Proveedor creado, pero faltan reglas (RLS).");
    }
    throw new Error("Proveedor creado, pero faltan reglas: " + rulesRes.error.message);
  }
}

function bindNewSupplierForm() {
  const form = document.getElementById("new-supplier-form");
  const nameEl = document.getElementById("new-supplier-name");
  const slugEl = document.getElementById("new-supplier-slug");
  const unitEl = document.getElementById("new-rule-unit");
  const pairsEl = document.getElementById("new-rule-pairs");
  const basisEl = document.getElementById("new-rule-basis");
  if (!form || !nameEl || !slugEl || !unitEl || !pairsEl || !basisEl) return;

  nameEl.addEventListener("input", () => {
    if (slugEl.dataset.touched === "true") return;
    slugEl.value = slugify(nameEl.value);
  });
  slugEl.addEventListener("input", () => {
    slugEl.dataset.touched = "true";
    slugEl.value = slugify(slugEl.value);
  });
  unitEl.addEventListener("change", () => {
    syncUnitDerivedFields(unitEl, pairsEl, basisEl);
  });
  unitEl.dispatchEvent(new Event("change"));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runComprasTask("create_supplier_quick", async () => {
      if (!(await ensureComprasAuth())) return;
      setNewSupplierMsg("Guardando…");
      try {
        await createSupplierQuick();
        setNewSupplierMsg("Proveedor creado correctamente", "ok");
        form.reset();
        slugEl.dataset.touched = "";
        unitEl.dispatchEvent(new Event("change"));
        await loadSuppliers();
      } catch (err) {
        const msg = err?.message || String(err);
        if (msg.toLowerCase().includes("proveedor creado, pero faltan reglas")) {
          setNewSupplierMsg("Proveedor creado, pero faltan reglas", "warn");
        } else if (msg.toLowerCase().includes("error creando proveedor")) {
          setNewSupplierMsg("Error creando proveedor", "err");
        } else {
          setNewSupplierMsg(msg, "err");
        }
      }
    });
  });
}

function bindEditSupplierArea() {
  const sel = document.getElementById("edit-supplier-id");
  const btnUpdate = document.getElementById("btn-update-supplier");
  const btnDelete = document.getElementById("btn-delete-supplier");
  sel?.addEventListener("change", () => {
    loadSelectedSupplierIntoForm();
    setEditSupplierMsg("");
  });
  btnUpdate?.addEventListener("click", () => {
    runComprasTask("update_supplier", async () => {
      if (!(await ensureComprasAuth())) return;
      setEditSupplierMsg("Guardando…");
      try {
        await updateSupplierFromForm();
        setEditSupplierMsg("Proveedor actualizado correctamente", "ok");
        await loadSuppliers();
      } catch (err) {
        setEditSupplierMsg(err?.message || String(err), "err");
      }
    });
  });
  btnDelete?.addEventListener("click", () => {
    runComprasTask("delete_supplier", async () => {
      if (!(await ensureComprasAuth())) return;
      setEditSupplierMsg("");
      try {
        const deleted = await deleteSupplierFromForm();
        if (!deleted) return;
        setEditSupplierMsg("Proveedor eliminado correctamente", "ok");
        await loadSuppliers();
      } catch (err) {
        const msg = err?.message || String(err);
        if (msg.toLowerCase().includes("violates foreign key constraint")) {
          setEditSupplierMsg("No se puede eliminar: el proveedor tiene dependencias (pedidos/reglas).", "err");
        } else {
          setEditSupplierMsg(msg, "err");
        }
      }
    });
  });
}

async function activateRulesFromForm() {
  const sid = document.getElementById("rule-supplier")?.value;
  const msg = document.getElementById("rule-msg");
  if (!sid) {
    if (msg) msg.textContent = "Elegí un proveedor.";
    return;
  }
  let built;
  try {
    built = buildRulesFromFieldPrefix("rule-rev-");
  } catch (e) {
    if (msg) msg.textContent = e?.message || String(e);
    return;
  }
  if (msg) msg.textContent = "Guardando…";
  const rules = await mergeRulesPreservingExtras(sid, built);
  const { data, error } = await supabase.rpc("purchase_create_rule_version", {
    p_supplier_id: sid,
    p_rules: rules,
  });
  if (error) {
    if (msg) msg.textContent = error.message;
    return;
  }
  if (msg) msg.textContent = "Listo: nueva versión activa (" + String(data ?? "ok") + ").";
  await loadSuppliers();
}

async function activateRulesFromJson() {
  const sid = document.getElementById("rule-supplier")?.value;
  const raw = document.getElementById("rule-json")?.value?.trim();
  const msg = document.getElementById("rule-msg");
  if (!sid) {
    if (msg) msg.textContent = "Elegí un proveedor.";
    return;
  }
  if (!raw) {
    if (msg) msg.textContent = "Pegá el JSON en el cuadro de opciones avanzadas.";
    return;
  }
  let rules;
  try {
    rules = JSON.parse(raw);
  } catch (e) {
    if (msg) msg.textContent = "JSON inválido: " + (e?.message || String(e));
    return;
  }
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    if (msg) msg.textContent = "El JSON debe ser un objeto { ... }.";
    return;
  }
  if (msg) msg.textContent = "Guardando…";
  const { data, error } = await supabase.rpc("purchase_create_rule_version", {
    p_supplier_id: sid,
    p_rules: rules,
  });
  if (error) {
    if (msg) msg.textContent = error.message;
    return;
  }
  if (msg) msg.textContent = "Listo: versión activa desde JSON (" + String(data ?? "ok") + ").";
  await loadSuppliers();
}

async function loadOrders() {
  const tbody = document.getElementById("tbody-orders");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" class="muted">Cargando…</td></tr>`;
  setOrdersPanelMsg("");
  const { data, error } = await supabase
    .from("purchase_orders")
    .select(
      "id,supplier_id,season_id,status,ordered_at,total_net,total_estimated_pairs,needs_review,purchase_suppliers(display_name),purchase_seasons(label),purchase_order_lines(line_index,raw_line_text,article_code,color,size,unit_text,qty_ordered,estimated_pairs)"
    )
    .order("ordered_at", { ascending: false })
    .limit(80);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`;
    setOrdersPanelMsg(`<span class="msg-err">No se pudieron cargar pedidos: ${escapeHtml(error.message)}</span>`);
    return;
  }
  const supMap = Object.fromEntries(suppliersCache.map((s) => [s.id, s.display_name]));
  const seaMap = Object.fromEntries(seasonsCache.map((s) => [s.id, s.label]));
  ordersCache = data || [];
  tbody.innerHTML = "";
  if (!ordersCache.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">No hay pedidos en <code>purchase_orders</code> todavía.</td></tr>`;
    setOrdersPanelMsg(
      "<span class=\"msg-warn\">Si Telegram ya registró mensajes, revisá la tabla de ingests abajo: suele quedar <code>parse_error</code> o <code>parsed_status=failed</code> cuando no se llegó a crear el pedido.</span>"
    );
  } else {
    setOrdersPanelMsg(`<span class="muted">Mostrando ${ordersCache.length} pedido(s) recientes.</span>`);
  }
  for (const o of ordersCache) {
    const tr = document.createElement("tr");
    const relSea = o.purchase_seasons;
    const seaFromJoin =
      relSea && typeof relSea === "object" && !Array.isArray(relSea)
        ? /** @type {{label?: string}} */ (relSea).label
        : Array.isArray(relSea) && relSea[0]
          ? /** @type {{label?: string}} */ (relSea[0]).label
          : null;
    const sup = supplierNameFromOrderRow(o, supMap);
    const sea = seaFromJoin || seaMap[o.season_id] || "—";
    const lines = o.purchase_order_lines;
    const detail = summarizePurchaseLines(Array.isArray(lines) ? lines : []);
    const detailTitle = escapeHtml(detail === "—" ? "" : detail);
    tr.innerHTML = `<td>${fmtDate(o.ordered_at)}</td><td>${escapeHtml(String(sup))}</td><td title="${detailTitle}">${escapeHtml(detail)}</td><td>${escapeHtml(String(sea))}</td><td>${fmtMoney(o.total_net)}</td><td>${o.total_estimated_pairs ?? "—"}</td><td>${o.needs_review ? '<span class="badge">Sí</span>' : "No"}</td><td>${escapeHtml(labelOrderStatus(o.status))}</td>`;
    tbody.appendChild(tr);
  }
  fillReceiptOrderSelect();
}

async function loadOrdersIngestPreview() {
  const tbody = document.getElementById("tbody-orders-ingest");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="muted">Cargando…</td></tr>`;
  setOrdersIngestMsg("");
  const { data, error } = await supabase
    .from("supplier_message_ingest")
    .select(
      "id,created_at,parsed_status,inferred_supplier_name,has_actionable_order,is_processed,parse_error,purchase_supplier_id,openai_response_raw"
    )
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="7">${escapeHtml(error.message)}</td></tr>`;
    setOrdersIngestMsg(`<span class="msg-err">No se pudieron cargar ingests: ${escapeHtml(error.message)}</span>`);
    return;
  }
  const rows = data || [];
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">No hay filas en <code>supplier_message_ingest</code> (o no tenés permiso de lectura).</td></tr>`;
    setOrdersIngestMsg(
      "<span class=\"msg-warn\">Si esperabas ver mensajes: verificá que n8n esté insertando en esta tabla y que reaplicaste las políticas RLS (<code>180_supplier_telegram_ingest.sql</code>) con permiso <code>proveedores</code>.</span>"
    );
    return;
  }
  setOrdersIngestMsg(`<span class="muted">Últimos ${rows.length} mensajes.</span>`);
  for (const r of rows) {
    const tr = document.createElement("tr");
    const st = labelParsedStatus(String(r.parsed_status || ""));
    const stTitle = r.parsed_status
      ? escapeHtml(`Código interno: ${String(r.parsed_status)} — ${st}`)
      : escapeHtml(st);
    const ia = summarizeOpenAiIngest(r.openai_response_raw);
    const iaTitle = escapeHtml(ia === "—" ? "" : ia);
    const errHuman = humanizeParseErrorShort(r.parse_error);
    const errTech = r.parse_error ? String(r.parse_error) : "";
    const errTitle = errTech ? escapeHtml(`Detalle técnico: ${errTech}`) : "";
    const doneLabel = r.is_processed ? "Sí, listo" : "No, pendiente";
    tr.innerHTML = `<td>${fmtDate(r.created_at)}</td><td title="${stTitle}">${escapeHtml(st)}</td><td>${escapeHtml(String(r.inferred_supplier_name || "—"))}</td><td title="${iaTitle}">${escapeHtml(ia)}</td><td>${r.has_actionable_order ? "Sí" : "No"}</td><td>${escapeHtml(doneLabel)}</td><td title="${errTitle}">${escapeHtml(errHuman)}</td>`;
    tbody.appendChild(tr);
  }
}

async function loadOrdersPanel() {
  await Promise.all([loadOrders(), loadOrdersIngestPreview()]);
}

function fillReceiptOrderSelect() {
  const sel = document.getElementById("receipt-order");
  if (!sel) return;
  const supMap = Object.fromEntries(suppliersCache.map((s) => [s.id, s.display_name]));
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Elegir pedido —</option>';
  for (const o of ordersCache) {
    const sup = supplierNameFromOrderRow(o, supMap);
    const lines = o.purchase_order_lines;
    const hint = summarizePurchaseLines(Array.isArray(lines) ? lines : []);
    const shortHint = hint !== "—" ? truncateText(hint, 48) : "";
    const opt = document.createElement("option");
    opt.value = String(o.id);
    opt.textContent = shortHint ? `${fmtDate(o.ordered_at)} · ${sup} — ${shortHint}` : `${fmtDate(o.ordered_at)} · ${sup}`;
    sel.appendChild(opt);
  }
  if (cur) sel.value = cur;
}

async function loadReceiptLines(orderId) {
  const host = document.getElementById("receipt-lines");
  if (!host || !orderId) {
    if (host) host.innerHTML = "";
    return;
  }
  host.innerHTML = "<p class=\"muted\">Cargando líneas…</p>";
  const { data: lines, error: e1 } = await supabase
    .from("purchase_order_lines")
    .select("id,line_index,article_code,color,unit_text,qty_ordered,estimated_pairs")
    .eq("order_id", orderId)
    .order("line_index");
  if (e1) {
    host.innerHTML = `<p class="muted">${e1.message}</p>`;
    return;
  }
  const ids = (lines || []).map((l) => l.id);
  let ful = [];
  if (ids.length) {
    const { data: f, error: e2 } = await supabase.from("purchase_order_line_fulfillment").select("*").in("order_line_id", ids);
    if (!e2 && f) ful = f;
  }
  const pendingMap = new Map(ful.map((x) => [x.order_line_id, x]));
  host.innerHTML = "";
  for (const l of lines || []) {
    const f = pendingMap.get(l.id);
    const pend = f ? Number(f.qty_pending) : Number(l.qty_ordered);
    if (pend <= 0) continue;
    const pairRatio = l.qty_ordered > 0 && l.estimated_pairs != null ? Number(l.estimated_pairs) / Number(l.qty_ordered) : 0;
    const div = document.createElement("div");
    div.className = "receipt-line";
    div.dataset.lineId = String(l.id);
    div.dataset.pairRatio = String(pairRatio);
    div.innerHTML = `
      <div><strong>#${l.line_index}</strong> ${escapeHtml([l.article_code, l.color].filter(Boolean).join(" · ") || "—")} · ${escapeHtml(String(l.unit_text || ""))}</div>
      <div class="muted">Pedido: ${l.qty_ordered} · Pendiente: ${pend}</div>
      <label>Cant. recibida (unidad línea)</label>
      <input type="number" class="qty-in" min="0" step="0.0001" max="${pend}" value="" />
      <label>Pares recibidos</label>
      <input type="number" class="pairs-in" min="0" step="0.0001" value="" />
    `;
    const qtyIn = div.querySelector(".qty-in");
    const pairsIn = div.querySelector(".pairs-in");
    qtyIn?.addEventListener("input", () => {
      const q = Number(qtyIn.value);
      if (pairRatio > 0 && pairsIn && Number.isFinite(q)) {
        pairsIn.value = String(Math.round(q * pairRatio * 10000) / 10000);
      }
    });
    host.appendChild(div);
  }
  if (!host.children.length) {
    host.innerHTML = "<p class=\"muted\">No hay cantidades pendientes en este pedido.</p>";
  }
}

async function submitReceipt() {
  const orderId = document.getElementById("receipt-order")?.value;
  const note = document.getElementById("receipt-note")?.value || null;
  const msg = document.getElementById("receipt-msg");
  if (!orderId) {
    if (msg) msg.textContent = "Elegí un pedido.";
    return;
  }
  const host = document.getElementById("receipt-lines");
  const blocks = host?.querySelectorAll(".receipt-line") || [];
  /** @type {{order_line_id:string,qty_received:number,pairs_received:number}[]} */
  const p_lines = [];
  for (const div of blocks) {
    const oid = div.dataset.lineId;
    const q = Number(div.querySelector(".qty-in")?.value);
    const pr = Number(div.querySelector(".pairs-in")?.value);
    if (!oid || !Number.isFinite(q) || q <= 0) continue;
    if (!Number.isFinite(pr) || pr < 0) {
      if (msg) msg.textContent = "Completá pares recibidos (≥ 0) en cada línea con cantidad.";
      return;
    }
    p_lines.push({ order_line_id: oid, qty_received: q, pairs_received: pr });
  }
  if (!p_lines.length) {
    if (msg) msg.textContent = "No hay líneas con cantidad a registrar.";
    return;
  }
  if (msg) msg.textContent = "Enviando…";
  const { data, error } = await supabase.rpc("purchase_register_receipt", {
    p_order_id: orderId,
    p_received_at: new Date().toISOString(),
    p_note: note,
    p_source: "manual_admin",
    p_lines,
  });
  if (error) {
    if (msg) msg.textContent = error.message;
    return;
  }
  if (msg) msg.textContent = JSON.stringify(data);
  await loadReceiptLines(orderId);
}

async function loadArqueo() {
  const tbody = document.getElementById("tbody-arqueo");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="muted">Cargando…</td></tr>`;
  const { data, error } = await supabase.from("purchase_spend_by_season").select("*").order("sum_net", { ascending: false });
  if (error) {
    tbody.innerHTML = `<tr><td colspan="7">${error.message}</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  for (const r of data || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(String(r.season_label || "—"))}</td><td>${escapeHtml(String(r.supplier_name || "—"))}</td><td>${r.order_count}</td><td>${fmtMoney(r.sum_net)}</td><td>${fmtMoney(r.sum_gross)}</td><td>${fmtMoney(r.sum_discount)}</td><td>${r.sum_estimated_pairs ?? "—"}</td>`;
    tbody.appendChild(tr);
  }
}

async function init() {
  const ok = await ensureComprasAuth();
  if (!ok) return;

  if (!supabase || typeof supabase.from !== "function") {
    showErr("Cliente Supabase no disponible. Revisá scripts/config.js (URL y anon key) y recargá la página.");
    return;
  }

  setupTabs();
  bindNewSupplierForm();
  bindEditSupplierArea();
  document.getElementById("btn-reload-seasons")?.addEventListener("click", () => {
    runComprasTask("reload_seasons", async () => {
      if (!(await ensureComprasAuth())) return;
      await loadSeasons();
    });
  });
  document.getElementById("btn-add-season")?.addEventListener("click", () => {
    runComprasTask("add_season", async () => {
      if (!(await ensureComprasAuth())) return;
      await addSeason();
    });
  });
  document.getElementById("btn-reload-suppliers")?.addEventListener("click", () => {
    runComprasTask("reload_suppliers", async () => {
      if (!(await ensureComprasAuth())) return;
      await loadSuppliers();
    });
  });
  bindRulesRevisionPanel();
  document.getElementById("btn-activate-rules")?.addEventListener("click", () => {
    runComprasTask("activate_rules", async () => {
      if (!(await ensureComprasAuth())) return;
      await activateRulesFromForm();
    });
  });
  document.getElementById("btn-activate-rules-json")?.addEventListener("click", () => {
    runComprasTask("activate_rules_json", async () => {
      if (!(await ensureComprasAuth())) return;
      await activateRulesFromJson();
    });
  });
  document.getElementById("btn-reload-orders")?.addEventListener("click", () => {
    runComprasTask("reload_orders", async () => {
      if (!(await ensureComprasAuth())) return;
      await loadOrdersPanel();
    });
  });
  document.getElementById("btn-reload-arqueo")?.addEventListener("click", () => {
    runComprasTask("reload_arqueo", async () => {
      if (!(await ensureComprasAuth())) return;
      await loadArqueo();
    });
  });
  document.getElementById("receipt-order")?.addEventListener("change", (e) => {
    const t = /** @type {HTMLSelectElement} */ (e.target);
    runComprasTask("load_receipt_lines", async () => {
      if (!(await ensureComprasAuth())) return;
      await loadReceiptLines(t.value);
    });
  });
  document.getElementById("btn-submit-receipt")?.addEventListener("click", () => {
    runComprasTask("submit_receipt", async () => {
      if (!(await ensureComprasAuth())) return;
      await submitReceipt();
    });
  });

  await loadSeasons();
  await loadSuppliers();
  await Promise.all([loadOrdersPanel(), loadArqueo()]);
}

init().catch((e) => {
  console.error(e);
  showErr(e?.message || String(e));
});
