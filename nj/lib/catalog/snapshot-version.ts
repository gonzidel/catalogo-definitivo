"use client";

import { useEffect } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type CatalogPublicVersion = {
  revision: number;
  refreshedAt: string | null;
  rowCount: number | null;
};

export async function fetchCatalogPublicVersion(): Promise<CatalogPublicVersion | null> {
  try {
    const { data, error } = await getSupabaseBrowserClient().rpc(
      "rpc_catalog_public_version"
    );
    if (error || !data || typeof data !== "object") return null;
    const row = data as {
      revision?: number;
      refreshed_at?: string;
      row_count?: number;
    };
    return {
      revision: Number(row.revision ?? 0),
      refreshedAt: row.refreshed_at ?? null,
      rowCount: row.row_count ?? null,
    };
  } catch {
    return null;
  }
}

/** Si el snapshot cambió, revalida SWR al volver a la pestaña. Sin polling. */
export function useCatalogSnapshotRevalidate(mutate: () => unknown) {
  useEffect(() => {
    let lastRevision: number | null = null;
    let lastRefreshed: string | null = null;
    let cancelled = false;

    async function check() {
      const next = await fetchCatalogPublicVersion();
      if (cancelled || !next) return;
      const changed =
        (lastRevision != null && next.revision !== lastRevision) ||
        (lastRefreshed != null &&
          next.refreshedAt != null &&
          next.refreshedAt !== lastRefreshed);
      lastRevision = next.revision;
      lastRefreshed = next.refreshedAt;
      if (changed) mutate();
    }

    function onVisibility() {
      if (document.visibilityState === "visible") void check();
    }

    void check();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mutate]);
}
