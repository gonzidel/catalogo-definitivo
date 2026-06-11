import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { resolveImageSrc } from "@/lib/cloudinary";
import {
  CATALOG_AVAILABLE_VIEW,
  CATALOG_SELECT,
  agruparProductos,
} from "@/lib/utils/catalog";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";
import {
  FIRST_PUBLISH_SYNC_MS,
  NUEVOS_INGRESOS_DAYS,
  catalogRecencyMs,
  isWithinLastDays,
  parseCatalogDateMs,
} from "@/lib/banners/catalog-dates";

function hasRenderableImage(product: GroupedProduct): boolean {
  return Boolean(resolveImageSrc(product.VariantePrincipal));
}

type FirstPublishRow = {
  product_name: string;
  first_published_at: string;
};

/** Primera publicación real vía RPC (min(publication_events.published_at)). */
async function fetchFirstPublishMapFromRpc(
  supabase: SupabaseClient
): Promise<Map<string, number> | null> {
  const { data, error } = await supabase.rpc("rpc_get_nuevos_ingresos_products", {
    p_days: NUEVOS_INGRESOS_DAYS,
  });

  if (error) {
    console.warn("[nuevos-ingresos] RPC no disponible, usando fallback:", error.message);
    return null;
  }

  const map = new Map<string, number>();
  for (const row of (data ?? []) as FirstPublishRow[]) {
    const name = String(row.product_name ?? "").trim().toLowerCase();
    const ms = parseCatalogDateMs(row.first_published_at);
    if (name && ms > 0) map.set(name, ms);
  }
  return map;
}

/**
 * Fallback sin RPC: variantes publicadas juntas sin fechas antiguas,
 * más productos con nuevos_ingresos_highlight_at reciente (reingreso admin).
 */
async function fetchFirstPublishMapFallback(
  supabase: SupabaseClient,
  articulos: string[]
): Promise<Map<string, number>> {
  if (articulos.length === 0) return new Map();

  const { data, error } = await supabase
    .from("products")
    .select("name, nuevos_ingresos_highlight_at, product_variants(active, last_published_at)")
    .in("name", articulos)
    .eq("status", "active");

  if (error || !data) return new Map();

  const map = new Map<string, number>();

  for (const row of data) {
    const name = String(row.name ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();

    const highlightMs = parseCatalogDateMs(
      (row as { nuevos_ingresos_highlight_at?: string | null }).nuevos_ingresos_highlight_at
    );
    if (highlightMs > 0 && isWithinLastDays(highlightMs, NUEVOS_INGRESOS_DAYS)) {
      const prev = map.get(key) ?? 0;
      map.set(key, Math.max(prev, highlightMs));
    }

    const variants = (row.product_variants ?? []).filter(
      (v: { active?: boolean | null }) => v?.active !== false
    );
    const publishedMs = variants
      .map((v: { last_published_at?: string | null }) =>
        parseCatalogDateMs(v.last_published_at)
      )
      .filter((ms: number) => ms > 0);

    if (publishedMs.length === 0) continue;

    const hasStalePublication = publishedMs.some(
      (ms: number) => !isWithinLastDays(ms, NUEVOS_INGRESOS_DAYS)
    );
    if (hasStalePublication) continue;

    const recentMs = publishedMs.filter((ms: number) =>
      isWithinLastDays(ms, NUEVOS_INGRESOS_DAYS)
    );
    if (recentMs.length === 0) continue;

    const maxRecent = Math.max(...recentMs);
    const minRecent = Math.min(...recentMs);
    const batchPublish =
      recentMs.length === publishedMs.length &&
      maxRecent - minRecent <= FIRST_PUBLISH_SYNC_MS;
    const singleVariantFirst =
      publishedMs.length === 1 &&
      isWithinLastDays(publishedMs[0], NUEVOS_INGRESOS_DAYS);

    if (batchPublish || singleVariantFirst) {
      const prev = map.get(key) ?? 0;
      map.set(key, Math.max(prev, maxRecent));
    }
  }

  return map;
}

export function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function mixProductsByCategory(
  products: GroupedProduct[],
  firstPublishMap: Map<string, number>
): GroupedProduct[] {
  if (products.length <= 1) return products;

  const byCategory = new Map<string, GroupedProduct[]>();
  for (const product of products) {
    const key = product.Categoria?.trim() || "Otros";
    const bucket = byCategory.get(key) ?? [];
    bucket.push(product);
    byCategory.set(key, bucket);
  }

  const recency = (p: GroupedProduct) =>
    firstPublishMap.get(p.Articulo.trim().toLowerCase()) ?? catalogRecencyMs(p);

  const buckets = shuffleInPlace(
    [...byCategory.values()].map((items) =>
      items.sort((a, b) => recency(b) - recency(a))
    )
  );

  const mixed: GroupedProduct[] = [];
  let hasMore = true;
  while (hasMore) {
    hasMore = false;
    for (const bucket of buckets) {
      const next = bucket.shift();
      if (next) {
        mixed.push(next);
        hasMore = true;
      }
    }
  }

  return mixed;
}

export function sortAndMixNuevosIngresos(
  products: GroupedProduct[],
  firstPublishMap: Map<string, number>
): GroupedProduct[] {
  const sorted = [...products].sort(
    (a, b) =>
      (firstPublishMap.get(b.Articulo.trim().toLowerCase()) ?? 0) -
      (firstPublishMap.get(a.Articulo.trim().toLowerCase()) ?? 0)
  );
  return mixProductsByCategory(sorted, firstPublishMap);
}

async function loadCatalogGrouped(supabase: SupabaseClient): Promise<GroupedProduct[]> {
  const { data, error } = await supabase
    .from(CATALOG_AVAILABLE_VIEW)
    .select(CATALOG_SELECT)
    .order("FechaPublicacion", { ascending: false, nullsFirst: false })
    .limit(800);

  if (error || !data?.length) return [];
  return agruparProductos(data as unknown as CatalogRow[]);
}

function filterEligible(
  grouped: GroupedProduct[],
  firstPublishMap: Map<string, number>
): GroupedProduct[] {
  return grouped.filter(
    (p) =>
      hasRenderableImage(p) &&
      firstPublishMap.has(p.Articulo.trim().toLowerCase())
  );
}

export async function fetchNuevosIngresosCollection(
  supabase: SupabaseClient,
  options: { limit?: number } = {}
): Promise<GroupedProduct[]> {
  const { limit } = options;
  const rpcMap = await fetchFirstPublishMapFromRpc(supabase);
  const grouped = await loadCatalogGrouped(supabase);

  if (grouped.length === 0) return [];

  let firstPublishMap = rpcMap;

  if (!firstPublishMap) {
    const candidates = grouped.filter((p) => hasRenderableImage(p));
    firstPublishMap = await fetchFirstPublishMapFallback(
      supabase,
      candidates.map((p) => p.Articulo)
    );
  }

  if (firstPublishMap.size === 0) return [];

  const eligible = filterEligible(grouped, firstPublishMap);
  if (eligible.length === 0) return [];

  const sorted = sortAndMixNuevosIngresos(eligible, firstPublishMap);
  return limit != null && limit > 0 ? sorted.slice(0, limit) : sorted;
}

/** Carrusel home (máx. 32). */
export async function fetchNuevosIngresos(): Promise<GroupedProduct[]> {
  const supabase = getSupabaseBrowserClient();
  return fetchNuevosIngresosCollection(supabase, { limit: 32 });
}
