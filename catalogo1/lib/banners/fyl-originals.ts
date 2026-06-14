import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CATALOG_SOURCE, CATALOG_SELECT } from "@/lib/utils/catalog";
import { parseCatalogDateMs } from "@/lib/banners/catalog-dates";
import type {
  CatalogImage,
  CatalogRow,
  ColorDetail,
  GroupedProduct,
  VariantDetail,
} from "@/types/catalog";

// ─── Date helpers (paridad scripts/fyl-originals-banner.js) ─────────────────

export function parseDateMs(value: unknown): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  return parseCatalogDateMs(value as string | null | undefined);
}

function buildLocalDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function stableStringHash(text: string): number {
  const input = String(text || "");
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getMainImage(producto: GroupedProduct): string {
  const principal = producto?.VariantePrincipal;
  if (typeof principal === "string" && principal) return principal;
  if (principal && typeof principal === "object" && "url" in principal) {
    return String(principal.url || principal.secure_url || "");
  }
  const first = producto?.DetalleColor?.[0]?.images?.[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "url" in first) {
    return String(first.url || first.secure_url || "");
  }
  return "";
}

function getPrimaryColorLabel(producto: GroupedProduct): string {
  return (producto?.DetalleColor?.[0]?.color || "sin-color").trim().toLowerCase();
}

function getFirstVariantDetail(producto: GroupedProduct): VariantDetail | null {
  for (const detalleColor of producto?.DetalleColor || []) {
    const details = (detalleColor as ColorDetail & { variantDetails?: VariantDetail[] })
      .variantDetails;
    for (const vd of details || []) {
      if (!vd) continue;
      if (vd.sku || vd.variantId) return vd;
    }
  }
  if (producto.variantDetails?.length) {
    return producto.variantDetails[0];
  }
  return null;
}

function obtenerSKUDefecto(producto: GroupedProduct): string | null {
  if (!producto?.DetalleColor) return null;

  for (const detalleColor of producto.DetalleColor) {
    const details = (detalleColor as ColorDetail & { variantDetails?: VariantDetail[] })
      .variantDetails;
    if (!details) continue;

    const conStock = details.find(
      (vd) => vd.sku && (vd.available === null || vd.available > 0)
    );
    if (conStock?.sku) return conStock.sku;

    const primerSku = details.find((vd) => vd.sku);
    if (primerSku?.sku) return primerSku.sku;
  }
  return null;
}

function getProductIdentity(producto: GroupedProduct): string | null {
  if (!producto) return null;
  const sku = obtenerSKUDefecto(producto);
  if (sku) return `sku:${String(sku).trim().toLowerCase()}`;

  const firstVariant = getFirstVariantDetail(producto);
  if (firstVariant?.variantId) {
    return `variant:${String(firstVariant.variantId).trim().toLowerCase()}`;
  }

  const articulo = (producto.Articulo || "").trim().toLowerCase();
  const color = getPrimaryColorLabel(producto);
  if (articulo) return `articuloColor:${articulo}__${color}`;
  return null;
}

function isActiveProduct(producto: GroupedProduct): boolean {
  const activo = producto?.Activo;
  if (activo === false) return false;
  if (typeof activo === "string" && activo.trim().toLowerCase() === "false") return false;
  return true;
}

function hasPositiveStock(producto: GroupedProduct): boolean {
  let total = 0;
  let sawNumericSignal = false;

  for (const detalleColor of producto?.DetalleColor || []) {
    const details = (detalleColor as ColorDetail & { variantDetails?: VariantDetail[] })
      .variantDetails;
    for (const vd of details || []) {
      if (vd?.available === null || vd?.available === undefined) continue;
      const num = Number(vd.available);
      if (!Number.isNaN(num)) {
        total += num;
        sawNumericSignal = true;
      }
    }
  }

  if (!sawNumericSignal) return true;
  return total > 0;
}

function isRenderableProduct(producto: GroupedProduct): boolean {
  const image = getMainImage(producto);
  const nombre = (producto?.Articulo || producto?.Descripcion || "").trim();
  const id = getProductIdentity(producto);
  return Boolean(image && nombre && id);
}

function normalizeCategory(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function isVisuallyDistinctFromTop3(
  producto: GroupedProduct,
  top3: (GroupedProduct | null)[]
): boolean {
  const ownCategory = normalizeCategory(
    producto?.Filtro1 || producto?.Filtro2 || producto?.Filtro3
  );
  const ownColor = getPrimaryColorLabel(producto);

  for (const p of top3) {
    if (!p) continue;
    const cat = normalizeCategory(p?.Filtro1 || p?.Filtro2 || p?.Filtro3);
    const color = getPrimaryColorLabel(p);
    if (ownCategory && cat && ownCategory === cat) return false;
    if (ownColor && color && ownColor === color) return false;
  }
  return true;
}

function dedupeBySafeIdentity(products: GroupedProduct[]): GroupedProduct[] {
  const seen = new Set<string>();
  const out: GroupedProduct[] = [];
  products.forEach((p) => {
    const id = getProductIdentity(p);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(p);
  });
  return out;
}

function excludeProducts(
  base: GroupedProduct[],
  excludedProducts: (GroupedProduct | null)[]
): GroupedProduct[] {
  const excludedIds = new Set(
    excludedProducts.map((p) => getProductIdentity(p!)).filter(Boolean) as string[]
  );
  return base.filter((p) => !excludedIds.has(getProductIdentity(p)!));
}

function pickBestCandidate(
  pool: GroupedProduct[],
  scorer: (p: GroupedProduct) => number
): GroupedProduct | null {
  let best: GroupedProduct | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  pool.forEach((p) => {
    const score = scorer(p);
    const id = getProductIdentity(p) || "";
    const bestId = getProductIdentity(best!) || "";

    if (score > bestScore || (score === bestScore && id < bestId)) {
      best = p;
      bestScore = score;
    }
  });

  return best;
}

export function getPublicationRecencyMs(producto: GroupedProduct): number {
  if (!producto) return 0;

  const catalogPub = parseDateMs(producto.FechaPublicacion);
  if (catalogPub > 0) return catalogPub;

  let colorPubMax = 0;
  for (const detalleColor of producto?.DetalleColor || []) {
    if (detalleColor?.__variantRecencySource === "last_published_at") {
      const ms = Number(detalleColor?.__variantRecencyMs) || 0;
      if (ms > colorPubMax) colorPubMax = ms;
    }
  }
  if (colorPubMax > 0) return colorPubMax;

  return getBestRecencyMs(producto);
}

function getBestRecencyMs(producto: GroupedProduct): number {
  const pubMs = parseDateMs(producto?.FechaPublicacion);
  if (pubMs > 0) return pubMs;

  let colorMax = 0;
  for (const detalleColor of producto?.DetalleColor || []) {
    const ms =
      Number(detalleColor?.__variantRecencyMs) ||
      Number(detalleColor?.__recencyMs) ||
      0;
    if (ms > colorMax) colorMax = ms;
  }
  if (colorMax > 0) return colorMax;

  const candidates = [
    producto?.FechaIngreso,
    (producto as GroupedProduct & { updated_at?: string }).updated_at,
    (producto as GroupedProduct & { created_at?: string }).created_at,
  ];

  for (const value of candidates) {
    const ms = parseDateMs(value);
    if (ms > 0) return ms;
  }

  return 0;
}

type VariantRecencyRow = {
  FechaPublicacion?: string | null;
  republished_at?: string | null;
  republishedAt?: string | null;
  last_published_at?: string | null;
  variant_updated_at?: string | null;
  product_variant_updated_at?: string | null;
  updated_at?: string | null;
  variant_created_at?: string | null;
  product_variant_created_at?: string | null;
  created_at?: string | null;
  FechaIngreso?: string | null;
};

function getVariantRecency(row: VariantRecencyRow): { ms: number; source: string } {
  if (!row || typeof row !== "object") return { ms: 0, source: "" };

  const candidates: [string, unknown][] = [
    ["FechaPublicacion", row.FechaPublicacion],
    ["republished_at", row.republished_at],
    ["republished_at", row.republishedAt],
    ["last_published_at", row.last_published_at],
    ["variant_updated_at", row.variant_updated_at],
    ["product_variant_updated_at", row.product_variant_updated_at],
    ["updated_at", row.updated_at],
    ["variant_created_at", row.variant_created_at],
    ["product_variant_created_at", row.product_variant_created_at],
    ["created_at", row.created_at],
    ["FechaIngreso", row.FechaIngreso],
  ];

  for (const [source, value] of candidates) {
    const ms = parseDateMs(value);
    if (ms > 0) return { ms, source };
  }
  return { ms: 0, source: "" };
}

function pickMostRecentVariant(
  rows: Array<VariantRecencyRow & { __color?: ColorDetail }>
): { row: VariantRecencyRow & { __color?: ColorDetail }; ms: number; source: string } | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let winner: (VariantRecencyRow & { __color?: ColorDetail }) | null = null;
  let winnerMs = -1;
  let winnerSource = "";
  let winnerIndex = -1;

  rows.forEach((row, index) => {
    const { ms, source } = getVariantRecency(row);
    if (ms > winnerMs || (ms === winnerMs && index < winnerIndex)) {
      winner = row;
      winnerMs = ms;
      winnerSource = source;
      winnerIndex = index;
    }
  });

  return winner ? { row: winner, ms: winnerMs, source: winnerSource } : null;
}

function fallbackBasicOrdering(products: GroupedProduct[]): GroupedProduct[] {
  if (!Array.isArray(products) || products.length === 0) return [];

  const dated = products
    .map((product) => ({
      product,
      ms: parseDateMs(product?.FechaIngreso),
    }))
    .filter((item) => item.ms > 0);

  if (dated.length > 0) {
    return [...products].sort(
      (a, b) => getPublicationRecencyMs(b) - getPublicationRecencyMs(a)
    );
  }

  console.warn("[FYL] Fallback sin fecha válida: se mantiene orden original", {
    totalProducts: products.length,
  });
  return products;
}

function sumKnownStock(producto: GroupedProduct): number {
  let sum = 0;

  const candidates = [
    (producto as GroupedProduct & { Stock?: number }).Stock,
    (producto as GroupedProduct & { stock?: number }).stock,
  ];
  candidates.forEach((v) => {
    const n = Number(v);
    if (!Number.isNaN(n) && n > 0) sum += n;
  });

  for (const detalleColor of producto?.DetalleColor || []) {
    const details = (detalleColor as ColorDetail & { variantDetails?: VariantDetail[] })
      .variantDetails;
    for (const vd of details || []) {
      const n = Number(vd?.available);
      if (!Number.isNaN(n) && n > 0) sum += n;
    }
  }
  return sum;
}

function scoreSlot1Publication(producto: GroupedProduct): number {
  return getPublicationRecencyMs(producto);
}

function scoreStrongProduct(producto: GroupedProduct): number {
  let score = 0;
  if (producto?.OfertaActiva === true) score += 4;
  if (String(producto?.PromoActiva || "").trim() !== "") score += 3;
  score += Math.min(3, Math.floor(sumKnownStock(producto) / 5));
  score += parseDateMs(producto?.FechaIngreso) / 1e13;
  return score;
}

function scorePushProduct(producto: GroupedProduct): number {
  const stock = sumKnownStock(producto);
  const recencyPenalty = parseDateMs(producto?.FechaIngreso) / 1e12;
  return stock - recencyPenalty;
}

function pickDailyHookByDateIndex(
  pool: GroupedProduct[],
  dateKey: string
): GroupedProduct | null {
  if (!pool || pool.length === 0) return null;
  const sorted = [...pool].sort((a, b) => {
    const ida = getProductIdentity(a) || "";
    const idb = getProductIdentity(b) || "";
    return ida.localeCompare(idb);
  });
  const dateHash = stableStringHash(dateKey);
  const index = dateHash % sorted.length;
  return sorted[index] || null;
}

/** Curaduría slots 1–4 + resto (paridad vanilla). */
export function curateFylOriginalsSlots(
  products: GroupedProduct[],
  now: Date = new Date()
): GroupedProduct[] {
  if (!Array.isArray(products) || products.length === 0) return [];

  const eligible = dedupeBySafeIdentity(
    products
      .filter(isActiveProduct)
      .filter(isRenderableProduct)
      .filter(hasPositiveStock)
  );

  if (eligible.length === 0) {
    console.warn("[FYL] Curaduría no aplicada: eligible vacío", {
      totalProducts: products.length,
    });
    return fallbackBasicOrdering(products);
  }

  const slot1 = pickBestCandidate(eligible, scoreSlot1Publication);
  const poolAfter1 = excludeProducts(eligible, [slot1]);
  const slot2 = pickBestCandidate(poolAfter1, scoreStrongProduct);
  const poolAfter2 = excludeProducts(poolAfter1, [slot2]);
  const slot3 = pickBestCandidate(poolAfter2, scorePushProduct);
  const poolAfter3 = excludeProducts(poolAfter2, [slot3]);

  const top3 = [slot1, slot2, slot3].filter(Boolean);
  const diverseCandidates = poolAfter3.filter((p) =>
    isVisuallyDistinctFromTop3(p, top3)
  );
  const slot4Pool = diverseCandidates.length > 0 ? diverseCandidates : poolAfter3;
  const dateKey = buildLocalDateKey(now);
  const slot4 = pickDailyHookByDateIndex(slot4Pool, dateKey) || slot4Pool[0] || null;

  const top4 = [slot1, slot2, slot3, slot4].filter(Boolean) as GroupedProduct[];
  const rest = excludeProducts(products, top4);
  return [...top4, ...rest];
}

// ─── Agrupación FYL (con __recencyMs por color, como vanilla) ─────────────────

function rowImages(row: CatalogRow): CatalogImage[] {
  return [row["Imagen Principal"], row["Imagen 1"], row["Imagen 2"], row["Imagen 3"]].filter(
    Boolean
  ) as CatalogImage[];
}

function getRowRecencyMs(row: CatalogRow): number {
  return (
    parseDateMs(row.FechaPublicacion) ||
    parseDateMs((row as CatalogRow & { updated_at?: string }).updated_at) ||
    parseDateMs((row as CatalogRow & { created_at?: string }).created_at) ||
    parseDateMs(row.FechaIngreso) ||
    0
  );
}

export function agruparFylOriginals(rows: CatalogRow[]): GroupedProduct[] {
  const grupos: Record<string, GroupedProduct> = {};

  for (const row of rows) {
    const art = row.Articulo?.trim();
    if (!art) continue;
    const rowRecencyMs = getRowRecencyMs(row);

    if (!grupos[art]) {
      grupos[art] = {
        Articulo: art,
        Descripcion: row.Descripcion ?? "",
        Precio: row.Precio ?? "",
        VariantePrincipal: row["Imagen Principal"],
        Oferta: row.Oferta ?? "",
        FechaIngreso: row.FechaIngreso ?? "",
        FechaPublicacion: row.FechaPublicacion ?? "",
        Categoria: row.Categoria ?? "",
        Filtro1: row.Filtro1 ?? "",
        Filtro2: row.Filtro2 ?? "",
        Filtro3: row.Filtro3 ?? "",
        DetallesSimilitud: "",
        OfertaActiva: false,
        PrecioOferta: "",
        PromoActiva: "",
        SupplierCode: row.SupplierCode ?? "FYL",
        DetalleColor: [],
      };
    }

    const g = grupos[art];

    if (row.OfertaActiva === true || row.OfertaActiva === "true") {
      g.OfertaActiva = true;
      if (!g.PrecioOferta && row.PrecioOferta) g.PrecioOferta = row.PrecioOferta;
    }
    if (row.PromoActiva) g.PromoActiva = row.PromoActiva;

    const incomingPubMs = parseDateMs(row.FechaPublicacion);
    const currentPubMs = parseDateMs(g.FechaPublicacion);
    if (incomingPubMs > currentPubMs) {
      g.FechaPublicacion = row.FechaPublicacion ?? g.FechaPublicacion;
    }

    const colorKey = (row.Color || "Sin color").trim().toLowerCase();
    const colorExists = g.DetalleColor.find(
      (c) => (c.color || "").trim().toLowerCase() === colorKey
    );

    if (!colorExists) {
      const talles = String(row.Numeracion || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      g.DetalleColor.push({
        color: row.Color || "Sin color",
        hex_color: row.ColorHex ?? null,
        ColorDisplayNumber: row.ColorDisplayNumber ?? null,
        talles: talles.length > 0 ? talles : ["Único"],
        images: rowImages(row),
        OfertaActiva: row.OfertaActiva === true || row.OfertaActiva === "true",
        PrecioOferta: row.PrecioOferta ?? "",
        PromoActiva: row.PromoActiva ?? "",
        __recencyMs: rowRecencyMs,
      });
    } else {
      const existingRecency = Number(colorExists.__recencyMs) || 0;
      if (rowRecencyMs > existingRecency) {
        const incomingImages = rowImages(row);
        if (incomingImages.length > 0) {
          colorExists.images = incomingImages;
        }
        colorExists.__recencyMs = rowRecencyMs;
      }
    }
  }

  const grouped = Object.values(grupos);
  for (const g of grouped) {
    const colorMs = (g.DetalleColor || []).map((c) => Number(c.__recencyMs) || 0);
    const maxColor = colorMs.length ? Math.max(...colorMs) : 0;
    const productPub = parseDateMs(g.FechaPublicacion);
    if (maxColor > productPub) {
      g.FechaPublicacion = new Date(maxColor).toISOString();
    }
  }

  return grouped;
}

// ─── Enrich variant recency (products + product_variants) ───────────────────

type ProductVariantJoin = {
  color: string;
  active: boolean;
  last_published_at: string | null;
};

export async function enrichGroupedProductsWithVariantRecency(
  productosAgrupados: GroupedProduct[],
  supabase: SupabaseClient = getSupabaseBrowserClient()
): Promise<GroupedProduct[]> {
  if (!Array.isArray(productosAgrupados) || productosAgrupados.length === 0) {
    return [];
  }

  const articulos = productosAgrupados
    .map((p) => (p.Articulo || "").trim())
    .filter(Boolean);

  const articleColorRecency = new Map<string, Map<string, { ms: number; source: string }>>();

  if (articulos.length > 0) {
    try {
      const { data: variantsData, error: variantsError } = await supabase
        .from("products")
        .select("name, product_variants(color, active, last_published_at)")
        .in("name", articulos);

      if (variantsError) {
        console.warn(
          "[FYL] No se pudieron obtener fechas de variantes:",
          variantsError.message
        );
      } else if (Array.isArray(variantsData)) {
        for (const row of variantsData) {
          const articuloKey = (row?.name || "").trim().toLowerCase();
          if (!articuloKey) continue;

          const colorMap = articleColorRecency.get(articuloKey) || new Map();
          for (const v of (row.product_variants || []) as ProductVariantJoin[]) {
            if (!v || v.active === false) continue;
            const colorKey = (v.color || "").trim().toLowerCase();
            if (!colorKey) continue;
            const { ms, source } = getVariantRecency(v);
            if (ms <= 0) continue;
            const prev = colorMap.get(colorKey);
            if (!prev || ms > prev.ms) {
              colorMap.set(colorKey, { ms, source });
            }
          }
          if (colorMap.size > 0) {
            articleColorRecency.set(articuloKey, colorMap);
          }
        }
      }
    } catch (e) {
      console.warn("[FYL] Excepción cargando fechas de variantes:", e);
    }
  }

  return productosAgrupados.map((producto) => {
    const colors = Array.isArray(producto.DetalleColor) ? producto.DetalleColor : [];
    if (colors.length === 0) return producto;

    const articuloKey = (producto.Articulo || "").trim().toLowerCase();
    const colorRecencyMap = articleColorRecency.get(articuloKey) || null;

    let usedRealVariantDates = false;
    if (colorRecencyMap) {
      colors.forEach((color) => {
        const colorKey = (color?.color || "").trim().toLowerCase();
        const entry = colorRecencyMap.get(colorKey);
        if (entry && entry.ms > 0) {
          color.__variantRecencyMs = entry.ms;
          color.__variantRecencySource = entry.source;
          usedRealVariantDates = true;
        }
      });
    }

    const colorsWithImage = colors.filter(
      (c) => Array.isArray(c?.images) && c.images.length > 0 && c.images[0]
    );

    const variantPick = pickMostRecentVariant(
      colorsWithImage.map((c) => ({
        __color: c,
        updated_at:
          Number(c?.__variantRecencyMs) > 0
            ? new Date(Number(c.__variantRecencyMs)).toISOString()
            : null,
        created_at: null,
        FechaIngreso:
          Number(c?.__recencyMs) > 0
            ? new Date(Number(c.__recencyMs)).toISOString()
            : producto.FechaIngreso || null,
      }))
    );

    const bestColor = variantPick?.row?.__color || null;

    if (bestColor?.images?.[0]) {
      producto.VariantePrincipal = bestColor.images[0];

      if (usedRealVariantDates) {
        producto.__variantePrincipalSource = "recency-banner";
        producto.DetalleColor = [...colors].sort((a, b) => {
          const aMs = Number(a?.__variantRecencyMs) || Number(a?.__recencyMs) || 0;
          const bMs = Number(b?.__variantRecencyMs) || Number(b?.__recencyMs) || 0;
          return bMs - aMs;
        });
      }
    }

    const pubMs = getPublicationRecencyMs(producto);
    if (pubMs > parseDateMs(producto.FechaPublicacion)) {
      producto.FechaPublicacion = new Date(pubMs).toISOString();
    }

    return producto;
  });
}

/** Todos los FYL agrupados + enrich (vista colección, paridad filterBySupplierFYL). */
export async function fetchFylOriginalsAll(
  supabase: SupabaseClient
): Promise<GroupedProduct[]> {
  const { data, error } = await supabase
    .from(CATALOG_SOURCE)
    .select(CATALOG_SELECT)
    .eq("SupplierCode", "FYL");

  if (error || !data || data.length === 0) return [];

  let grouped = agruparFylOriginals(data as unknown as CatalogRow[]);
  grouped.sort((a, b) => getPublicationRecencyMs(b) - getPublicationRecencyMs(a));
  grouped = await enrichGroupedProductsWithVariantRecency(grouped, supabase);
  return grouped;
}

/** Fetch + enrich + curate (carrusel home). */
export async function fetchFylOriginalsCurated(): Promise<GroupedProduct[]> {
  const supabase = getSupabaseBrowserClient();
  const grouped = await fetchFylOriginalsAll(supabase);
  return curateFylOriginalsSlots(grouped, new Date());
}
