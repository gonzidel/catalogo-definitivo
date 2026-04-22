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

/** @type {Record<string, unknown>[]} */
let suppliersCache = [];
/** @type {Record<string, unknown>[]} */
let seasonsCache = [];
/** @type {Record<string, unknown>[]} */
let ordersCache = [];

const EXAMPLE_RULES = `{
  "currency": "ARS",
  "default_discount_pct": 20,
  "units": {
    "par": {
      "pairs_per_unit": 1,
      "default_price_basis": "per_par",
      "match": ["par", "pares", "prs"]
    },
    "tarea": {
      "pairs_per_unit": 24,
      "default_price_basis": "per_tarea",
      "allowed_price_bases": ["per_tarea", "per_par"],
      "match": ["tarea", "tareas", "tar"]
    }
  }
}`;

function setupTabs() {
  document.querySelectorAll("#tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-panel");
      document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("open"));
      btn.classList.add("active");
      const panel = document.getElementById(id || "");
      panel?.classList.add("open");
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

async function loadSuppliers() {
  const tbody = document.getElementById("tbody-suppliers");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="muted">Cargando…</td></tr>`;
  const { data, error } = await supabase
    .from("purchase_suppliers")
    .select("id,slug,display_name,aliases,active")
    .order("display_name");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="4">${error.message}</td></tr>`;
    return;
  }
  suppliersCache = data || [];
  tbody.innerHTML = "";
  for (const s of suppliersCache) {
    const tr = document.createElement("tr");
    const aliasesStr = Array.isArray(s.aliases) ? s.aliases.join(", ") : "";
    tr.innerHTML = `
      <td><input type="text" data-field="display_name" data-id="${s.id}" value="${escapeHtml(String(s.display_name))}" /></td>
      <td><code>${escapeHtml(String(s.slug))}</code></td>
      <td><input type="text" data-field="aliases" data-id="${s.id}" value="${escapeHtml(aliasesStr)}" style="max-width:100%" /></td>
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
  const ta = document.getElementById("rule-json");
  if (ta && !ta.value.trim()) ta.value = EXAMPLE_RULES;
}

async function saveSupplierRow(id) {
  if (!id) return;
  const row = document.querySelector(`.btn-save-sup[data-id="${id}"]`)?.closest("tr");
  if (!row) return;
  const display = row.querySelector('[data-field="display_name"]')?.value?.trim();
  const aliasesRaw = row.querySelector('[data-field="aliases"]')?.value || "";
  const aliases = aliasesRaw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  showErr("");
  const { error } = await supabase.from("purchase_suppliers").update({ display_name: display, aliases }).eq("id", id);
  if (error) showErr(error.message);
  else await loadSuppliers();
}

async function activateRules() {
  const sid = document.getElementById("rule-supplier")?.value;
  const raw = document.getElementById("rule-json")?.value?.trim();
  const msg = document.getElementById("rule-msg");
  if (!sid || !raw) {
    if (msg) msg.textContent = "Completá proveedor y JSON.";
    return;
  }
  let rules;
  try {
    rules = JSON.parse(raw);
  } catch (e) {
    if (msg) msg.textContent = "JSON inválido: " + (e?.message || String(e));
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
  if (msg) msg.textContent = "Versión activa: " + (data ?? "ok");
}

async function loadOrders() {
  const tbody = document.getElementById("tbody-orders");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="muted">Cargando…</td></tr>`;
  const { data, error } = await supabase
    .from("purchase_orders")
    .select("id,supplier_id,season_id,ordered_at,total_net,total_estimated_pairs,needs_review")
    .order("ordered_at", { ascending: false })
    .limit(80);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="6">${error.message}</td></tr>`;
    return;
  }
  const supMap = Object.fromEntries(suppliersCache.map((s) => [s.id, s.display_name]));
  const seaMap = Object.fromEntries(seasonsCache.map((s) => [s.id, s.label]));
  ordersCache = data || [];
  tbody.innerHTML = "";
  for (const o of ordersCache) {
    const tr = document.createElement("tr");
    const sup = supMap[o.supplier_id] ?? "—";
    const sea = seaMap[o.season_id] ?? "—";
    tr.innerHTML = `<td>${fmtDate(o.ordered_at)}</td><td>${escapeHtml(String(sup))}</td><td>${escapeHtml(String(sea))}</td><td>${fmtMoney(o.total_net)}</td><td>${o.total_estimated_pairs ?? "—"}</td><td>${o.needs_review ? '<span class="badge">Sí</span>' : "No"}</td>`;
    tbody.appendChild(tr);
  }
  fillReceiptOrderSelect();
}

function fillReceiptOrderSelect() {
  const sel = document.getElementById("receipt-order");
  if (!sel) return;
  const supMap = Object.fromEntries(suppliersCache.map((s) => [s.id, s.display_name]));
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Elegir pedido —</option>';
  for (const o of ordersCache) {
    const sup = supMap[o.supplier_id] ?? String(o.supplier_id ?? "");
    const opt = document.createElement("option");
    opt.value = String(o.id);
    opt.textContent = `${fmtDate(o.ordered_at)} · ${sup}`;
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

  setupTabs();
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
  document.getElementById("btn-activate-rules")?.addEventListener("click", () => {
    runComprasTask("activate_rules", async () => {
      if (!(await ensureComprasAuth())) return;
      await activateRules();
    });
  });
  document.getElementById("btn-reload-orders")?.addEventListener("click", () => {
    runComprasTask("reload_orders", async () => {
      if (!(await ensureComprasAuth())) return;
      await loadOrders();
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
  await Promise.all([loadOrders(), loadArqueo()]);
}

init().catch((e) => {
  console.error(e);
  showErr(e?.message || String(e));
});
