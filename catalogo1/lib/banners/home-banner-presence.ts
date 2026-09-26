import { unstable_cache } from "next/cache";
import { getPublicCatalogClient } from "@/lib/supabase/public-catalog";
import {
  CURATED_SPECIAL_TAG,
  CURATED_TAG,
} from "@/lib/banners/curated-banner-tags";
import { CATALOG_SOURCE } from "@/lib/utils/catalog";

/** Tri-state: no mapear errores de red/Supabase a "ausente". */
export type BannerPresenceState = "present" | "absent" | "unknown";

export type HomeBannerPresence = {
  nuevosIngresos: BannerPresenceState;
  fylOriginals: BannerPresenceState;
  curatedSpecial: BannerPresenceState;
  curated: BannerPresenceState;
};

export function shouldReserveBannerSlot(
  state: BannerPresenceState
): boolean {
  return state === "present";
}

export function shouldFetchBanner(state: BannerPresenceState): boolean {
  return state === "present" || state === "unknown";
}

export function allUnknownPresence(): HomeBannerPresence {
  return {
    nuevosIngresos: "unknown",
    fylOriginals: "unknown",
    curatedSpecial: "unknown",
    curated: "unknown",
  };
}

/**
 * Interpreta una respuesta head/limit(1) de Supabase.
 * - error → unknown (el cliente puede recuperar vía SWR)
 * - fila(s) → present
 * - vacío sin error → absent
 * - emptyItems: config/existe señal pero sin items válidos → absent
 */
export function interpretPresenceProbe(options: {
  error: { message?: string } | null | undefined;
  rowCount: number;
  /** Señal de existencia OK pero sin contenido usable (cards/items). */
  emptyItems?: boolean;
}): BannerPresenceState {
  if (options.error) return "unknown";
  if (options.emptyItems) return "absent";
  return options.rowCount > 0 ? "present" : "absent";
}

async function probeLimitOne(
  run: () => Promise<{
    data: unknown[] | null;
    error: { message?: string } | null;
  }>
): Promise<BannerPresenceState> {
  try {
    const { data, error } = await run();
    return interpretPresenceProbe({
      error,
      rowCount: data?.length ?? 0,
    });
  } catch {
    return "unknown";
  }
}

async function loadHomeBannerPresenceUncached(): Promise<HomeBannerPresence> {
  const supabase = getPublicCatalogClient();

  const [nuevosIngresos, fylOriginals, curatedSpecial, curated] =
    await Promise.all([
      probeLimitOne(async () => {
        const { data, error } = await supabase
          .from("products")
          .select("id")
          .not("nuevos_ingresos_highlight_at", "is", null)
          .in("status", ["active", "pending_stock"])
          .limit(1);
        return { data, error };
      }),
      probeLimitOne(async () => {
        const { data, error } = await supabase
          .from(CATALOG_SOURCE)
          .select("Articulo")
          .eq("SupplierCode", "FYL")
          .limit(1);
        return { data, error };
      }),
      probeLimitOne(async () => {
        const { data, error } = await supabase
          .from("custom_product_banners")
          .select("id")
          .eq("enabled", true)
          .eq("tag_value", CURATED_SPECIAL_TAG)
          .limit(1);
        return { data, error };
      }),
      probeLimitOne(async () => {
        const { data, error } = await supabase
          .from("custom_product_banners")
          .select("id")
          .eq("enabled", true)
          .eq("tag_value", CURATED_TAG)
          .limit(1);
        return { data, error };
      }),
    ]);

  return { nuevosIngresos, fylOriginals, curatedSpecial, curated };
}

/**
 * Señales públicas (anon, sin cookies) cacheadas.
 * revalidate 300 + tag catalog-products.
 * No incluye sesión, carrito ni stock sellable.
 */
export async function getHomeBannerPresence(): Promise<HomeBannerPresence> {
  const cached = unstable_cache(
    loadHomeBannerPresenceUncached,
    ["home-banner-presence"],
    {
      revalidate: 300,
      tags: ["catalog-products"],
    }
  );
  try {
    return await cached();
  } catch {
    return allUnknownPresence();
  }
}
