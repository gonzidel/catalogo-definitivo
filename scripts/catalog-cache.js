// scripts/catalog-cache.js — Cache SWR local del payload de boot del catálogo (Fase 1)

import { FYL_VERSION } from "./fyl-version.js?v=m260607";
import { fylPerf } from "./fyl-perf.js?v=m260607";

export const CATALOG_BOOT_CACHE_KEY = "fyl_catalog_boot_v1";
export const CATALOG_BOOT_CACHE_TTL_MS = 15 * 60 * 1000;
export const CATALOG_BOOT_CACHE_MAX_BYTES = 1_500_000;

function fylBootCacheStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch (_e) {
    return null;
  }
}

function fylBootCacheValidShape(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.appVersion !== "string" || !obj.appVersion) return false;
  if (typeof obj.savedAt !== "number" || !Number.isFinite(obj.savedAt)) return false;
  if (!Array.isArray(obj.rows)) return false;
  if (typeof obj.count !== "number" || obj.count !== obj.rows.length) return false;
  if (obj.catalogVersion != null && typeof obj.catalogVersion !== "string") return false;
  return true;
}

/** Lectura sync — fallback silencioso si falla parse/storage. */
export function readBootCache() {
  const storage = fylBootCacheStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(CATALOG_BOOT_CACHE_KEY);
    if (!raw) return null;
    if (raw.length > CATALOG_BOOT_CACHE_MAX_BYTES) {
      fylPerf("catalog_cache_storage_error", { reason: "read_oversized", bytes: raw.length });
      clearBootCache();
      return null;
    }
    const obj = JSON.parse(raw);
    if (!fylBootCacheValidShape(obj)) {
      fylPerf("catalog_cache_storage_error", { reason: "invalid_shape" });
      clearBootCache();
      return null;
    }
    return obj;
  } catch (_e) {
    fylPerf("catalog_cache_storage_error", { reason: "read_parse" });
    clearBootCache();
    return null;
  }
}

/** Solo camino crítico: FYL_VERSION + TTL + integridad. Cero red. */
export function isUsableOnCriticalPath(obj) {
  if (!fylBootCacheValidShape(obj)) return false;
  if (obj.appVersion !== FYL_VERSION) return false;
  if (Date.now() - obj.savedAt > CATALOG_BOOT_CACHE_TTL_MS) return false;
  if (obj.rows.length === 0) return false;
  return true;
}

export function clearBootCache() {
  const storage = fylBootCacheStorage();
  if (!storage) return;
  try {
    storage.removeItem(CATALOG_BOOT_CACHE_KEY);
  } catch (_e) {
    /* fallback silencioso */
  }
}

/** Guard de tamaño obligatorio antes de escribir. Fallback silencioso si falla. */
export function writeBootCache(rows, catalogVersion = null) {
  const storage = fylBootCacheStorage();
  if (!storage || !Array.isArray(rows)) return false;

  const safeRows = rows;
  const payloadObj = {
    appVersion: FYL_VERSION,
    catalogVersion: catalogVersion != null ? String(catalogVersion) : null,
    savedAt: Date.now(),
    rows: safeRows,
    count: safeRows.length,
  };

  let serialized;
  try {
    serialized = JSON.stringify(payloadObj);
  } catch (_e) {
    fylPerf("catalog_cache_storage_error", { reason: "stringify" });
    return false;
  }

  if (serialized.length > CATALOG_BOOT_CACHE_MAX_BYTES) {
    fylPerf("catalog_cache_storage_error", {
      reason: "write_oversized",
      bytes: serialized.length,
      rows: safeRows.length,
    });
    return false;
  }

  try {
    storage.setItem(CATALOG_BOOT_CACHE_KEY, serialized);
    return true;
  } catch (_e) {
    fylPerf("catalog_cache_storage_error", { reason: "write_quota" });
    return false;
  }
}

function fylBootRowFingerprint(row) {
  if (!row) return "";
  return [
    String(row.Articulo || "").trim(),
    String(row.Color || "").trim(),
    String(row.Precio ?? ""),
    String(row.PrecioOferta ?? ""),
    String(row.OfertaActiva ?? ""),
    String(row.Mostrar ?? ""),
    String(row.FechaPublicacion ?? ""),
  ].join("|");
}

/** Compara dos payloads de boot (para revalidación en background). */
export function bootRowsChanged(prevRows = [], nextRows = []) {
  if (!Array.isArray(prevRows) || !Array.isArray(nextRows)) return true;
  if (prevRows.length !== nextRows.length) return true;
  const prevFp = prevRows.map(fylBootRowFingerprint).join("\n");
  const nextFp = nextRows.map(fylBootRowFingerprint).join("\n");
  return prevFp !== nextFp;
}
