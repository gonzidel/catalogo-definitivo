// scripts/commercial-tags.js — Puente legacy: solo si la vista no expone DetallesSimilitud.
// Objetivo: 0 requests en Home tras migración 219 + CATALOG_PUBLIC_SELECT.

import { supabase } from "./supabase-client.js?v=m260607";
import { fylPerf } from "./fyl-perf.js?v=m260607";
import {
  canonicalTagKey,
  collectUnifiedCommercialTagsFromRows,
  mergeCommercialTagFieldValues,
  normalizeTagDisplay,
  sanitizeDetallesSimilitudField,
  sanitizeRowDetallesSimilitud,
  splitCommercialTags,
} from "./tag-normalize.js?v=m260607";

/** Copia DetallesSimilitud del catálogo crudo al cache agrupado (bridge no siempre llega al grupo). */
export function syncGroupedProductsDetallesSimilitud(grouped, rawRows) {
  if (!Array.isArray(grouped) || !grouped.length) return grouped || [];
  const byArt = new Map();
  for (const row of rawRows || []) {
    const art = String(row?.Articulo ?? "").trim();
    const det = String(row?.DetallesSimilitud ?? "").trim();
    if (!art || !det) continue;
    byArt.set(art, mergeCommercialTagFieldValues(byArt.get(art), det));
    const key = canonicalTagKey(art);
    if (key) byArt.set(key, mergeCommercialTagFieldValues(byArt.get(key), det));
  }
  if (!byArt.size) return grouped;

  let patched = 0;
  const out = grouped.map((p) => {
    if (String(p?.DetallesSimilitud ?? "").trim()) return p;
    const art = String(p?.Articulo ?? "").trim();
    const det = byArt.get(art) || byArt.get(canonicalTagKey(art));
    if (!det) return p;
    patched += 1;
    return { ...p, DetallesSimilitud: det };
  });
  if (patched > 0) {
    fylPerf("banner_detalles_sync", { patched, grouped: grouped.length });
  }
  return out;
}

const DETALLES_CACHE_MS = 5 * 60 * 1000;

let detallesByArticuloCache = null;
let detallesByArticuloCacheAt = 0;

function articuloMapKey(articulo) {
  return canonicalTagKey(String(articulo ?? "").trim()) || String(articulo ?? "").trim();
}

/** ¿La API devolvió la columna DetallesSimilitud en al menos una fila? */
export function catalogRowsExposeDetallesSimilitud(rows) {
  if (
    typeof window !== "undefined" &&
    window.__FYL_DETALLES_SIMILITUD_IN_VIEW === false
  ) {
    return false;
  }
  return (rows || []).some(
    (r) => r && Object.prototype.hasOwnProperty.call(r, "DetallesSimilitud")
  );
}

/**
 * Mapa Articulo → detalles (solo pre-migración / admin sin catálogo cargado).
 * Dedupe: window.__FYL_COMMERCIAL_TAGS_INFLIGHT
 */
export async function fetchDetallesSimilitudByArticulo({ force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    detallesByArticuloCache &&
    now - detallesByArticuloCacheAt < DETALLES_CACHE_MS
  ) {
    return detallesByArticuloCache;
  }

  if (
    typeof window !== "undefined" &&
    window.__FYL_COMMERCIAL_TAGS_INFLIGHT
  ) {
    return window.__FYL_COMMERCIAL_TAGS_INFLIGHT;
  }

  const run = async () => {
    let commercialRequests = 0;
    const byProductId = new Map();
    const pageSize = 1000;
    let from = 0;

    while (true) {
      commercialRequests += 1;
      const { data, error } = await supabase
        .from("product_tag_details")
        .select("product_id, tags(name)")
        .range(from, from + pageSize - 1);

      if (error) {
        console.warn("[FYL commercial-tags] Error cargando product_tag_details:", error);
        break;
      }

      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        const pid = row?.product_id;
        const name = row?.tags?.name;
        if (!pid || !name) continue;
        const display = normalizeTagDisplay(name);
        if (!display) continue;
        const list = byProductId.get(pid) || [];
        list.push(display);
        byProductId.set(pid, list);
      }

      if (rows.length < pageSize) break;
      from += pageSize;
    }

    const productIds = [...byProductId.keys()];
    const idToArticulo = new Map();
    const idChunk = 200;

    for (let i = 0; i < productIds.length; i += idChunk) {
      commercialRequests += 1;
      const chunk = productIds.slice(i, i + idChunk);
      const { data: products, error: prodErr } = await supabase
        .from("products")
        .select("id, name")
        .in("id", chunk)
        .eq("status", "active");

      if (prodErr) {
        console.warn("[FYL commercial-tags] Error cargando products:", prodErr);
        continue;
      }

      for (const p of products || []) {
        if (p?.id && p?.name) idToArticulo.set(p.id, String(p.name).trim());
      }
    }

    const map = new Map();
    for (const [productId, tagNames] of byProductId) {
      const articulo = idToArticulo.get(productId);
      if (!articulo) continue;

      const seen = new Set();
      const merged = [];
      for (const tag of tagNames) {
        const key = canonicalTagKey(tag);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(tag);
      }
      merged.sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
      const joined = merged.join(", ");
      for (const k of [articulo, articuloMapKey(articulo)]) {
        const prev = map.get(k);
        const mergedVal = prev
          ? mergeCommercialTagFieldValues(prev, joined)
          : joined;
        map.set(
          k,
          sanitizeDetallesSimilitudField(mergedVal, {
            context: "bridge_build",
            sku: articulo,
            silent: true,
          }).value
        );
      }
    }

    detallesByArticuloCache = map;
    detallesByArticuloCacheAt = Date.now();
    fylPerf("commercial_requests", {
      requests: commercialRequests,
      mapSize: map.size,
      bridge: true,
    });
    return map;
  };

  if (typeof window !== "undefined") {
    window.__FYL_COMMERCIAL_TAGS_INFLIGHT = run().finally(() => {
      window.__FYL_COMMERCIAL_TAGS_INFLIGHT = null;
    });
    return window.__FYL_COMMERCIAL_TAGS_INFLIGHT;
  }

  return run();
}

export function applyDetallesSimilitudToRow(row, detallesMap) {
  if (!row) return row;
  if (Object.prototype.hasOwnProperty.call(row, "DetallesSimilitud")) {
    return sanitizeRowDetallesSimilitud(row, "catalog_row");
  }
  if (!detallesMap?.size) return row;
  const art = String(row.Articulo ?? "").trim();
  if (!art) return row;

  const fromMap =
    detallesMap.get(art) || detallesMap.get(articuloMapKey(art)) || "";
  if (!fromMap) return row;

  row.DetallesSimilitud = sanitizeDetallesSimilitudField(fromMap, {
    context: "bridge_apply",
    sku: art,
    silent: true,
  }).value;
  return row;
}

/** Sin red si la vista ya incluye DetallesSimilitud. */
export async function enrichCatalogRowsWithDetallesSimilitud(
  rows,
  { force = false } = {}
) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;

  const hasFromView = catalogRowsExposeDetallesSimilitud(list);
  if (typeof window !== "undefined") {
    window.__FYL_DETALLES_SIMILITUD_IN_VIEW = hasFromView;
  }

  if (!force && hasFromView) {
    fylPerf("commercial_early_return", {
      rows: list.length,
      reason: "DetallesSimilitud_en_vista",
    });
    return list.map((row) =>
      sanitizeRowDetallesSimilitud({ ...row }, "catalog_enrich")
    );
  }

  fylPerf("commercial_bridge", { rows: list.length, reason: "columna_no_en_vista" });
  const map = await fetchDetallesSimilitudByArticulo({ force });
  return list.map((row) => applyDetallesSimilitudToRow({ ...row }, map));
}

/** Admin / fallback: tags desde catálogo en memoria o bridge. */
export async function loadCommercialTagNamesForAdmin() {
  const raw = typeof window !== "undefined" ? window.__allCatalogRawRows : null;
  if (
    Array.isArray(raw) &&
    raw.length &&
    catalogRowsExposeDetallesSimilitud(raw)
  ) {
    return collectCommercialTagsFromCatalogRows(raw);
  }
  const map = await fetchDetallesSimilitudByArticulo();
  const groups = new Map();

  for (const value of map.values()) {
    for (const token of splitCommercialTags(value, { silent: true }).tags) {
      const key = canonicalTagKey(token);
      if (!key) continue;
      const prev = groups.get(key);
      if (!prev) groups.set(key, token);
      else if (token.length < prev.length) groups.set(key, token);
    }
  }

  return Array.from(groups.values()).sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );
}

export function collectCommercialTagsFromCatalogRows(rows) {
  return collectUnifiedCommercialTagsFromRows(rows);
}

export function commercialTagDebugSnapshot(row, selectedTags) {
  const detalles = String(row?.DetallesSimilitud ?? "").trim();
  const tagsUsados = detalles
    ? splitCommercialTags(detalles, { silent: true }).tags
    : [];

  return {
    sku: row?.Articulo || "",
    tags3_tecnico: row?.Filtro3 || "",
    detalles_similitud: detalles,
    tags_usados_por_banner: tagsUsados,
    selectedTags: Array.isArray(selectedTags) ? selectedTags : [selectedTags],
  };
}
