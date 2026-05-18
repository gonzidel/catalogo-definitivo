// scripts/catalog-source.js — Misma fuente de datos que main-supabase.js

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
