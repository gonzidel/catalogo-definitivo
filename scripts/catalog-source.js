// scripts/catalog-source.js — Misma fuente de datos que main-supabase.js

import { fylDevLog } from "./config.js?v=m260607";

export const CATALOG_AVAILABLE_VIEW = "catalog_public_available_view";
export const CATALOG_PUBLIC_SNAPSHOT = "catalog_public_snapshot";

/** Vista/tabla usada por el catálogo principal (snapshot por defecto). */
export function getCatalogAvailableSource() {
  try {
    const localOverride =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("FYL_USE_CATALOG_SNAPSHOT")
        : null;
    if (localOverride === "0" || localOverride === "false") {
      return CATALOG_AVAILABLE_VIEW;
    }
    if (typeof window !== "undefined" && window.FYL_USE_CATALOG_SNAPSHOT === false) {
      return CATALOG_AVAILABLE_VIEW;
    }
  } catch (_e) {}
  return CATALOG_PUBLIC_SNAPSHOT;
}

/**
 * Si el snapshot tiene menos filas que la vista en vivo, usar la vista para esta sesión.
 * Cubre productos nuevos guardados antes de "Actualizar catálogo público" en admin.
 */
export async function resolveCatalogSourceIfStale(supabase) {
  if (!supabase || getCatalogAvailableSource() !== CATALOG_PUBLIC_SNAPSHOT) {
    return getCatalogAvailableSource();
  }
  try {
    const [snap, live] = await Promise.all([
      supabase.from(CATALOG_PUBLIC_SNAPSHOT).select("*", { count: "exact", head: true }),
      supabase.from(CATALOG_AVAILABLE_VIEW).select("*", { count: "exact", head: true }),
    ]);
    const snapCount = Number(snap?.count) || 0;
    const liveCount = Number(live?.count) || 0;
    if (liveCount > snapCount && typeof window !== "undefined") {
      window.FYL_USE_CATALOG_SNAPSHOT = false;
      fylDevLog(
        `[FYL catalog] Snapshot desactualizado (${snapCount} vs ${liveCount} filas); usando vista en vivo`
      );
    }
  } catch (_e) {}
  return getCatalogAvailableSource();
}

const CATALOG_SNAPSHOT_META = "catalog_public_snapshot_meta";

/**
 * Versión del snapshot público (refreshed_at). Solo para revalidación en background.
 * Falla silenciosamente para anon hasta Fase 1.5 (grant/RPC).
 */
export async function getCatalogVersion(supabase) {
  if (!supabase) return null;

  try {
    if (typeof supabase.rpc === "function") {
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        "rpc_catalog_public_version"
      );
      if (!rpcError && rpcData && typeof rpcData === "object" && rpcData.refreshed_at) {
        return String(rpcData.refreshed_at);
      }
    }
  } catch (_e) {
    /* RPC no desplegada aún (Fase 1.5) */
  }

  try {
    if (typeof supabase.from !== "function") return null;
    const { data, error } = await supabase
      .from(CATALOG_SNAPSHOT_META)
      .select("refreshed_at")
      .eq("id", true)
      .maybeSingle();
    if (error || !data?.refreshed_at) return null;
    return String(data.refreshed_at);
  } catch (_e) {
    return null;
  }
}
