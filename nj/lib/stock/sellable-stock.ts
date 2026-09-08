import type { SupabaseClient } from "@supabase/supabase-js";
import type { ColorDetail, GroupedProduct } from "@/types/catalog";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export const SELLABLE_BATCH_MAX = 500;

export type SellableByVariant = Map<string, Map<string, number>>;

export type SellableStockOk = {
  ok: true;
  byVariant: SellableByVariant;
};

export type SellableStockFail = {
  ok: false;
  error: { kind: "query_failed"; message: string };
};

export type SellableStockResult = SellableStockOk | SellableStockFail;

export type CartLineStockStatus =
  | { kind: "unknown" }
  | { kind: "ok"; sellable: number }
  | { kind: "limited"; sellable: number }
  | { kind: "out" };

export type PdpVariantSize = {
  size: string;
  sku: string;
  /** `null` = la RPC no devolvió este talle (unknown). No es sellable 0. */
  sellable_qty: number | null;
};

export type PdpVariantInfo = {
  variantId: string;
  color: string;
  sku: string;
  sizes: PdpVariantSize[];
};

type SellableBatchRow = {
  variant_id: string;
  size: string;
  sellable_qty: number;
};

/**
 * Misma semántica que `fn_norm_size`: trim; si es puramente numérico
 * (`^\d+(\.\d+)?$`) usa la parte entera. No lower-case (Unico ≠ unico).
 */
export function normalizeSellableSize(size: string | null | undefined): string {
  if (size == null) return "";
  const trimmed = String(size).trim();
  if (trimmed === "") return "";
  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed.split(".")[0] ?? trimmed;
  return trimmed;
}

export function sellableStockKey(variantId: string, size: string): string {
  return `${variantId}__${normalizeSellableSize(size)}`;
}

export function sellableSwrKey(variantIds: readonly string[]): string[] | null {
  const ids = uniqueVariantIds(variantIds);
  if (ids.length === 0) return null;
  return ["sellable-stock", ...ids];
}

/**
 * Stock confirmado de un variant+talle.
 * `null` = la respuesta no incluye esa variante o ese talle (unknown).
 * `0` = la RPC confirmó sellable 0.
 */
export function lookupSellableQty(
  byVariant: SellableByVariant,
  variantId: string,
  size: string
): number | null {
  const sizes = byVariant.get(variantId);
  if (!sizes) return null;
  const qty = sizes.get(normalizeSellableSize(size));
  return qty === undefined ? null : qty;
}

export function variantHasSellableStock(
  byVariant: SellableByVariant,
  variantId: string
): boolean {
  const sizes = byVariant.get(variantId);
  if (!sizes) return false;
  for (const qty of sizes.values()) {
    if (qty > 0) return true;
  }
  return false;
}

export function cartLineStockStatus(
  cartQty: number,
  sellable: number | null
): CartLineStockStatus {
  if (sellable === null) return { kind: "unknown" };
  if (sellable <= 0) return { kind: "out" };
  if (cartQty > sellable) return { kind: "limited", sellable };
  return { kind: "ok", sellable };
}

export function formatSellableRemaining(sellable: number): string {
  if (sellable <= 0) return "Sin stock";
  if (sellable === 1) return "Solo queda 1 disponible";
  return `Solo quedan ${sellable} disponibles`;
}

export function clampQtyToSellable(qty: number, sellable: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(sellable) || sellable <= 0) return 0;
  return Math.min(Math.floor(qty), Math.floor(sellable));
}

export function applySellableToPdpVariants(
  variants: Array<{
    variantId: string;
    color: string;
    sku: string;
    sizes: Array<{ size: string; sku: string }>;
  }>,
  byVariant: SellableByVariant
): PdpVariantInfo[] {
  return variants.map((v) => ({
    variantId: v.variantId,
    color: v.color,
    sku: v.sku,
    sizes: v.sizes.map((s) => ({
      size: s.size,
      sku: s.sku,
      sellable_qty: lookupSellableQty(byVariant, v.variantId, s.size),
    })),
  }));
}

export function applySellableHasStockToProduct(
  product: GroupedProduct,
  variants: PdpVariantInfo[]
): GroupedProduct {
  const byColor = new Map(
    variants.map((v) => [v.color.trim().toLowerCase(), v] as const)
  );

  const detalleColor: ColorDetail[] = (product.DetalleColor ?? []).map((dc) => {
    const variant = byColor.get(dc.color.trim().toLowerCase());
    const hasStock = variant
      ? variant.sizes.some((s) => s.sellable_qty != null && s.sellable_qty > 0)
      : false;
    return { ...dc, hasStock };
  });

  return {
    ...product,
    DetalleColor: detalleColor,
    hasAnyStock: detalleColor.some((c) => c.hasStock !== false),
  };
}

function uniqueVariantIds(variantIds: readonly string[]): string[] {
  return [
    ...new Set(
      variantIds
        .map((id) => String(id ?? "").trim())
        .filter((id) => id.length > 0)
    ),
  ].sort();
}

function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

function emptyByVariant(): SellableByVariant {
  return new Map();
}

/**
 * Una llamada batch (chunked a 500) a `fn_sellable_stock_batch`.
 * No suma warehouses en el cliente.
 */
export async function getSellableStockForVariants(
  variantIds: readonly string[],
  supabase: SupabaseClient = getSupabaseBrowserClient()
): Promise<SellableStockResult> {
  const ids = uniqueVariantIds(variantIds);
  if (ids.length === 0) {
    return { ok: true, byVariant: emptyByVariant() };
  }

  const byVariant: SellableByVariant = emptyByVariant();

  try {
    for (const chunk of chunkIds(ids, SELLABLE_BATCH_MAX)) {
      const { data, error } = await supabase.rpc("fn_sellable_stock_batch", {
        p_variant_ids: chunk,
      });

      if (error) {
        return {
          ok: false,
          error: { kind: "query_failed", message: error.message },
        };
      }

      for (const raw of (data ?? []) as SellableBatchRow[]) {
        const variantId = String(raw.variant_id ?? "").trim();
        const size = normalizeSellableSize(raw.size);
        if (!variantId || !size) continue;
        const qty = Math.max(0, Math.floor(Number(raw.sellable_qty ?? 0)));
        const sizes = byVariant.get(variantId) ?? new Map<string, number>();
        sizes.set(size, qty);
        byVariant.set(variantId, sizes);
      }
    }

    return { ok: true, byVariant };
  } catch (err) {
    const message = err instanceof Error ? err.message : "query_failed";
    return { ok: false, error: { kind: "query_failed", message } };
  }
}

export async function fetchSellableByVariantOrThrow(
  variantIds: readonly string[],
  supabase?: SupabaseClient
): Promise<SellableByVariant> {
  const result = await getSellableStockForVariants(variantIds, supabase);
  if (!result.ok) {
    throw new Error(result.error.message || "No pudimos verificar el stock");
  }
  return result.byVariant;
}

export function sellableMapToRecord(
  byVariant: SellableByVariant,
  items: Array<{ variant_id: string; size: string }>
): Record<string, number | null> {
  const map: Record<string, number | null> = {};
  for (const item of items) {
    if (!item.variant_id) continue;
    map[sellableStockKey(item.variant_id, item.size)] = lookupSellableQty(
      byVariant,
      item.variant_id,
      item.size
    );
  }
  return map;
}

export type FreshSellableAddReason = "query_failed" | "incomplete";

export type FreshSellableAddResult<T> =
  | { ok: false; reason: FreshSellableAddReason }
  | { ok: true; lines: T[] };

/**
 * Tras un fetch fresco de `fn_sellable_stock_batch`:
 * - query fallida → no agregar;
 * - todas las líneas sin fila en la respuesta → incomplete (no asumir stock);
 * - miss por línea → no agregar esa línea;
 * - sellable 0 → no agregar esa línea;
 * - qty > sellable → clamp.
 */
export function resolveAddLinesFromFreshSellable<
  T extends { variantId: string; size: string; qty: number },
>(
  items: readonly T[],
  result: SellableStockResult
): FreshSellableAddResult<T> {
  if (!result.ok) return { ok: false, reason: "query_failed" };

  const lines: T[] = [];
  let anyConfirmed = false;
  let anyUnknown = false;

  for (const item of items) {
    const live = lookupSellableQty(result.byVariant, item.variantId, item.size);
    if (live === null) {
      anyUnknown = true;
      continue;
    }
    anyConfirmed = true;
    const qty = clampQtyToSellable(item.qty, live);
    if (qty <= 0) continue;
    lines.push({ ...item, qty });
  }

  if (items.length > 0 && anyUnknown && !anyConfirmed) {
    return { ok: false, reason: "incomplete" };
  }

  return { ok: true, lines };
}
