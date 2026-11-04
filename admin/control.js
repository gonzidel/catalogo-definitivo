// admin/control.js — Panel de control: publicados recientes
import { supabase, supabaseReady } from "../scripts/supabase-client.js?v=m260607";
import { preloadAuthState, can, isAdminUser } from "./auth-state.js?v=m260607";
import { normalizeSize, compareCatalogSizes } from "../scripts/utils/size-normalizer.js?v=m260607";

const DROP_RATIO = 0.4;
const IN_CHUNK = 150;

const state = {
  rows: [],
  days: 7,
  category: "calzado",
  search: "",
  footwearSegment: "adulto", // nino | adulto — solo aplica a calzado
  loading: false,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cloudinaryOptimized(url, width) {
  if (!url || typeof url !== "string") return url || "";
  const u = url.startsWith("http://") ? url.replace("http://", "https://") : url;
  if (!u.includes("res.cloudinary.com") || !u.includes("/image/upload/")) return u;
  if (u.includes("/upload/f_") || u.includes("/upload/v")) {
    if (u.includes("w_") && /\bw_\d+/.test(u)) {
      return u.replace(/w_\d+/g, `w_${width}`);
    }
  }
  return u.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_${width}/`);
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function categoryBucket(category) {
  const c = String(category || "").trim().toLowerCase();
  if (c === "calzado") return "calzado";
  if (c === "ropa") return "ropa";
  return "otro";
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getGeneralWarehouseId() {
  const { data, error } = await supabase
    .from("warehouses")
    .select("id")
    .eq("code", "general")
    .maybeSingle();
  if (error) {
    console.warn("[control] warehouse general:", error);
    return null;
  }
  return data?.id || null;
}

async function fetchInChunks(table, select, column, ids, applyExtra = (q) => q) {
  if (!ids.length) return [];
  const rows = [];
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await applyExtra(
      supabase.from(table).select(select).in(column, part)
    );
    if (error) {
      console.warn(`[control] ${table}:`, error);
      continue;
    }
    if (data?.length) rows.push(...data);
  }
  return rows;
}

function pickMainImage(images) {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => {
    if (!!b.is_main !== !!a.is_main) return (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0);
    return (a.position ?? 0) - (b.position ?? 0);
  });
  for (const img of sorted) {
    const u = img.url || img.secure_url;
    if (u) return u;
  }
  return null;
}

/** Último load/initial_load por variant_id+size → mapa "variantId|size" → qty */
function buildLastInboundByVariantSize(historyRows) {
  const best = new Map();
  for (const h of historyRows || []) {
    if (!h.variant_id) continue;
    const size = normalizeSize(h.size);
    if (!size) continue;
    const key = `${h.variant_id}|${size}`;
    const prev = best.get(key);
    const at = h.created_at ? new Date(h.created_at).getTime() : 0;
    if (!prev || at > prev.at) {
      const qty = Math.abs(Number(h.quantity_changed) || 0);
      best.set(key, { at, qty });
    }
  }
  const out = new Map();
  for (const [key, { qty }] of best) out.set(key, qty);
  return out;
}

async function loadControlData() {
  await supabaseReady;

  const since = new Date();
  since.setDate(since.getDate() - state.days);
  const sinceIso = since.toISOString();

  const { data: variants, error: vErr } = await supabase
    .from("product_variants")
    .select("id, product_id, color, last_published_at")
    .eq("active", true)
    .not("last_published_at", "is", null)
    .gte("last_published_at", sinceIso);

  if (vErr) throw vErr;
  if (!variants?.length) return [];

  const variantIds = variants.map((v) => v.id);
  const productIds = [...new Set(variants.map((v) => v.product_id).filter(Boolean))];

  const [products, stockRows, imageRows, historyRows] = await Promise.all([
    fetchInChunks(
      "products",
      "id, name, category, supplier_id",
      "id",
      productIds
    ),
    (async () => {
      const wid = await getGeneralWarehouseId();
      if (!wid) return [];
      return fetchInChunks(
        "variant_size_warehouse_stock",
        "variant_id, size, stock_qty",
        "variant_id",
        variantIds,
        (q) => q.eq("warehouse_id", wid)
      );
    })(),
    fetchInChunks(
      "variant_images",
      "variant_id, url, secure_url, position, is_main",
      "variant_id",
      variantIds
    ),
    fetchInChunks(
      "stock_history",
      "variant_id, size, quantity_changed, created_at, change_type",
      "variant_id",
      variantIds,
      (q) => q.in("change_type", ["load", "initial_load"])
    ),
  ]);

  const supplierIds = [
    ...new Set(products.map((p) => p.supplier_id).filter(Boolean)),
  ];
  const suppliers = supplierIds.length
    ? await fetchInChunks("suppliers", "id, name", "id", supplierIds)
    : [];
  const supplierById = new Map(suppliers.map((s) => [s.id, s.name || ""]));
  const productById = new Map(products.map((p) => [p.id, p]));

  const stockByVariant = new Map();
  for (const row of stockRows) {
    const size = normalizeSize(row.size);
    if (!size) continue;
    if (!stockByVariant.has(row.variant_id)) stockByVariant.set(row.variant_id, new Map());
    const m = stockByVariant.get(row.variant_id);
    m.set(size, (m.get(size) || 0) + (Number(row.stock_qty) || 0));
  }

  const imagesByVariant = new Map();
  for (const img of imageRows) {
    if (!imagesByVariant.has(img.variant_id)) imagesByVariant.set(img.variant_id, []);
    imagesByVariant.get(img.variant_id).push(img);
  }

  const lastInbound = buildLastInboundByVariantSize(historyRows);
  const inboundByVariant = new Map();
  for (const [key, qty] of lastInbound) {
    const sep = key.indexOf("|");
    const vid = key.slice(0, sep);
    const size = key.slice(sep + 1);
    if (!inboundByVariant.has(vid)) inboundByVariant.set(vid, new Map());
    inboundByVariant.get(vid).set(size, qty);
  }

  // Agrupar por productId + color
  const groups = new Map();
  for (const v of variants) {
    const key = `${v.product_id}||${v.color || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        productId: v.product_id,
        color: v.color || "",
        variantIds: [],
        publishedAt: null,
      });
    }
    const g = groups.get(key);
    g.variantIds.push(v.id);
    if (v.last_published_at) {
      const t = new Date(v.last_published_at).getTime();
      if (!g.publishedAt || t > new Date(g.publishedAt).getTime()) {
        g.publishedAt = v.last_published_at;
      }
    }
  }

  const rows = [];
  for (const g of groups.values()) {
    const product = productById.get(g.productId);
    if (!product) continue;

    const sizeStock = new Map();
    const sizeInbound = new Map();
    let thumb = null;

    for (const vid of g.variantIds) {
      const sm = stockByVariant.get(vid);
      if (sm) {
        for (const [size, qty] of sm) {
          sizeStock.set(size, (sizeStock.get(size) || 0) + qty);
        }
      }
      const im = inboundByVariant.get(vid);
      if (im) {
        for (const [size, qty] of im) {
          sizeInbound.set(size, (sizeInbound.get(size) || 0) + qty);
        }
      }
      if (!thumb) {
        thumb = pickMainImage(imagesByVariant.get(vid) || []);
      }
    }

    // Incluir talles que solo aparecen en ingreso (stock 0)
    for (const size of sizeInbound.keys()) {
      if (!sizeStock.has(size)) sizeStock.set(size, 0);
    }

    const sizes = {};
    const inboundSizes = {};
    let currentTotal = 0;
    for (const [size, qty] of sizeStock) {
      sizes[size] = qty;
      currentTotal += qty;
    }

    let lastInboundTotal = 0;
    let hasInbound = false;
    for (const [size, qty] of sizeInbound) {
      inboundSizes[size] = qty;
      hasInbound = true;
      lastInboundTotal += qty;
    }

    const isDrop =
      hasInbound && lastInboundTotal > 0 && currentTotal / lastInboundTotal <= DROP_RATIO;

    rows.push({
      productId: g.productId,
      productName: product.name || "Sin nombre",
      category: product.category || "",
      color: g.color,
      thumb,
      sizes,
      inboundSizes,
      currentTotal,
      lastInboundTotal: hasInbound ? lastInboundTotal : null,
      isDrop,
      supplierName: product.supplier_id
        ? supplierById.get(product.supplier_id) || "—"
        : "—",
      publishedAt: g.publishedAt,
    });
  }

  return rows;
}

function isNumericSize(size) {
  return /^-?\d+(\.\d+)?$/.test(String(size ?? "").trim());
}

/** Adulto: talles numéricos >= 35. Niño: numéricos < 35. */
function sizeMatchesFootwearSegment(size, segment) {
  if (!isNumericSize(size)) return segment === "adulto";
  const n = Number(size);
  if (segment === "adulto") return n >= 35;
  return n < 35;
}

function collectSizeColumns(rows) {
  const set = new Set();
  for (const r of rows) {
    for (const size of Object.keys(r.sizes || {})) set.add(size);
    for (const size of Object.keys(r.inboundSizes || {})) set.add(size);
  }
  let cols = [...set].sort(compareCatalogSizes);
  if (state.category === "calzado") {
    cols = cols.filter((s) => sizeMatchesFootwearSegment(s, state.footwearSegment));
  }
  return cols;
}

function rowTotalsForSizes(row, sizeCols) {
  let current = 0;
  let inbound = 0;
  let hasInbound = false;
  for (const s of sizeCols) {
    current += Number(row.sizes?.[s]) || 0;
    if (row.inboundSizes && Object.prototype.hasOwnProperty.call(row.inboundSizes, s)) {
      hasInbound = true;
      inbound += Number(row.inboundSizes[s]) || 0;
    }
  }
  return {
    currentTotal: current,
    lastInboundTotal: hasInbound ? inbound : null,
  };
}

function filteredRows() {
  const q = state.search.trim().toLowerCase();
  let list = state.rows.filter((r) => categoryBucket(r.category) === state.category);
  if (q) {
    list = list.filter((r) => {
      const name = String(r.productName || "").toLowerCase();
      const color = String(r.color || "").toLowerCase();
      return name.includes(q) || color.includes(q);
    });
  }

  if (state.category === "calzado") {
    list = list.filter((r) => {
      const keys = new Set([
        ...Object.keys(r.sizes || {}),
        ...Object.keys(r.inboundSizes || {}),
      ]);
      for (const s of keys) {
        if (sizeMatchesFootwearSegment(s, state.footwearSegment)) return true;
      }
      return false;
    });
  }

  list.sort((a, b) => {
    if (a.isDrop !== b.isDrop) return a.isDrop ? -1 : 1;
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  return list;
}

function syncTitle() {
  const title = $("ctrl-title");
  if (title) title.textContent = `Control — publicados ${state.days} días`;
}

function syncFootwearUi() {
  const el = $("ctrl-footwear");
  if (!el) return;
  el.classList.toggle("visible", state.category === "calzado");
}

async function reloadData() {
  const statusEl = $("ctrl-status");
  const wrap = $("ctrl-table-wrap");
  if (state.loading) return;
  state.loading = true;
  syncTitle();
  statusEl.hidden = false;
  statusEl.className = "ctrl-status";
  statusEl.textContent = `Cargando publicaciones (${state.days} días)…`;
  wrap.hidden = true;
  try {
    state.rows = await loadControlData();
    render();
  } catch (err) {
    console.error("[control]", err);
    statusEl.hidden = false;
    statusEl.className = "ctrl-status error";
    statusEl.textContent = "Error al cargar el panel. Revisá la consola.";
  } finally {
    state.loading = false;
  }
}

function render() {
  const statusEl = $("ctrl-status");
  const wrap = $("ctrl-table-wrap");
  const meta = $("ctrl-meta");
  syncTitle();
  syncFootwearUi();
  const rows = filteredRows();

  if (!state.rows.length) {
    statusEl.hidden = false;
    statusEl.className = "ctrl-status";
    statusEl.textContent = `No hay productos publicados en los últimos ${state.days} días.`;
    wrap.hidden = true;
    wrap.innerHTML = "";
    meta.textContent = "";
    return;
  }

  if (!rows.length) {
    statusEl.hidden = false;
    statusEl.className = "ctrl-status";
    statusEl.textContent = "Sin resultados para este filtro.";
    wrap.hidden = true;
    wrap.innerHTML = "";
    const inCat = state.rows.filter((r) => categoryBucket(r.category) === state.category).length;
    meta.textContent = `${inCat} en categoría · 0 visibles`;
    return;
  }

  statusEl.hidden = true;
  wrap.hidden = false;

  const sizeCols = collectSizeColumns(rows);
  const dropCount = rows.filter((r) => r.isDrop).length;
  meta.innerHTML =
    `${rows.length} producto${rows.length === 1 ? "" : "s"}` +
    (dropCount
      ? ` · <span class="drop-hint">${dropCount} con caída ≤40% del último ingreso (arriba)</span>`
      : "");

  const headSizes = sizeCols
    .map((s) => `<th class="size-col" title="Talle ${escapeHtml(s)}">${escapeHtml(s)}</th>`)
    .join("");

  const body = rows
    .map((r) => {
      const cells = sizeCols
        .map((s) => {
          const qty = r.sizes[s];
          if (qty == null || qty === 0) {
            return `<td class="size-col empty">${qty === 0 ? "0" : "—"}</td>`;
          }
          return `<td class="size-col">${qty}</td>`;
        })
        .join("");

      const img = r.thumb
        ? `<img class="ctrl-thumb" src="${escapeHtml(cloudinaryOptimized(r.thumb, 80))}" alt="" loading="lazy" width="40" height="40" />`
        : `<span class="ctrl-thumb-ph" aria-hidden="true"></span>`;

      const totals = rowTotalsForSizes(r, sizeCols);
      const inbound =
        totals.lastInboundTotal == null ? "—" : String(totals.lastInboundTotal);

      return `<tr class="${r.isDrop ? "stock-drop" : ""}">
        <td class="col-thumb">${img}</td>
        <td class="col-name">${escapeHtml(r.productName)}${
          r.color ? `<span class="color">${escapeHtml(r.color)}</span>` : ""
        }</td>
        ${cells}
        <td class="col-total">${totals.currentTotal}</td>
        <td class="col-inbound">${inbound}</td>
        <td class="col-supplier">${escapeHtml(r.supplierName)}</td>
        <td class="col-date">${escapeHtml(fmtDate(r.publishedAt))}</td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `<table class="ctrl-table">
    <thead>
      <tr>
        <th class="col-thumb"></th>
        <th class="col-name">Producto</th>
        ${headSizes}
        <th class="col-total">Total</th>
        <th class="col-inbound">Últ. ingreso</th>
        <th class="col-supplier">Proveedor</th>
        <th class="col-date">Publicado</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`;
}

function bindUi() {
  document.querySelectorAll(".ctrl-days button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const days = Number(btn.dataset.days) || 7;
      if (days === state.days) return;
      document.querySelectorAll(".ctrl-days button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.days = days;
      reloadData();
    });
  });

  document.querySelectorAll(".ctrl-filters button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".ctrl-filters button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.category = btn.dataset.category || "calzado";
      render();
    });
  });

  document.querySelectorAll("#ctrl-footwear button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#ctrl-footwear button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.footwearSegment = btn.dataset.segment || "adulto";
      render();
    });
  });

  const search = $("ctrl-search");
  let t = null;
  search?.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.search = search.value || "";
      render();
    }, 150);
  });
}

async function init() {
  try {
    const { user } = await preloadAuthState();
    if (!user) {
      window.location.href = "./index.html";
      return;
    }
    if (!can("control", "view") && !isAdminUser()) {
      window.location.href = "./index.html";
      return;
    }

    bindUi();
    await reloadData();
  } catch (err) {
    console.error("[control]", err);
    const statusEl = $("ctrl-status");
    statusEl.hidden = false;
    statusEl.className = "ctrl-status error";
    statusEl.textContent = "Error al cargar el panel. Revisá la consola.";
  }
}

init();
