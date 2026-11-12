"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import type { SearchProfileRow, SearchProfileStatus } from "@/lib/search/search-profiles-types";

async function requireSearchView() {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, "search", "view")) {
    throw new Error("Sin permiso de búsqueda.");
  }
  return ctx;
}

async function requireSearchEdit() {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, "search", "edit")) {
    throw new Error("Sin permiso de edición de búsqueda.");
  }
  return ctx;
}

export async function listSearchProfiles(
  status: SearchProfileStatus | "all" = "draft",
  limit = 80
): Promise<SearchProfileRow[]> {
  await requireSearchView();
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("product_search_profiles")
    .select("*")
    .order("generated_at", { ascending: false })
    .limit(limit);
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as SearchProfileRow[];
}

export async function setSearchProfileStatus(
  productId: string,
  status: Exclude<SearchProfileStatus, "stale">,
  note?: string
): Promise<void> {
  const ctx = await requireSearchEdit();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("product_search_profiles")
    .update({
      status,
      reviewed_by: ctx.userId,
      reviewed_at: new Date().toISOString(),
      review_note: note ?? null,
    })
    .eq("product_id", productId);
  if (error) throw new Error(error.message);
}

export async function bulkApproveSearchProfiles(productIds: string[]): Promise<number> {
  const ctx = await requireSearchEdit();
  if (!productIds.length) return 0;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("product_search_profiles")
    .update({
      status: "approved",
      reviewed_by: ctx.userId,
      reviewed_at: new Date().toISOString(),
    })
    .in("product_id", productIds.slice(0, 100))
    .eq("status", "draft")
    .select("product_id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

const BACKFILL_BATCH = 20;
// Perfil generado con esta confianza o más se aprueba solo (entra al buscador sin revisión manual).
// Por debajo de esto queda en "draft" para que un admin lo revise a mano.
const AUTO_APPROVE_CONFIDENCE = 0.75;

export interface GenerateMissingResult {
  generated: number;
  autoApproved: number;
  candidates: number;
  errors: string[];
  totalCostUsd: number;
}

/**
 * Backfill controlado: productos con tag1+tag2, talles y foto, sin perfil.
 * Lote máx. 20 (límite de la Edge). Los de alta confianza se auto-aprueban.
 */
export async function generateMissingSearchProfiles(
  limit = BACKFILL_BATCH
): Promise<GenerateMissingResult> {
  const ctx = await requireSearchEdit();
  const supabase = await createSupabaseServerClient();
  const batchLimit = Math.min(Math.max(1, limit), BACKFILL_BATCH);

  const { data: existingRows, error: existingErr } = await supabase
    .from("product_search_profiles")
    .select("product_id");
  if (existingErr) throw new Error(existingErr.message);
  const existing = new Set((existingRows ?? []).map((r) => r.product_id));

  const { data: tagged, error: taggedErr } = await supabase
    .from("product_tags")
    .select("product_id, tag1_id, tag2_id, tag3_ids")
    .not("tag1_id", "is", null)
    .not("tag2_id", "is", null)
    .limit(400);
  if (taggedErr) throw new Error(taggedErr.message);

  const candidates = (tagged ?? []).filter((t) => !existing.has(t.product_id));
  const productsPayload: Array<{
    product_id: string;
    articulo: string;
    category: string;
    description: string | null;
    tags: string[];
    image_urls: string[];
  }> = [];
  const errors: string[] = [];

  for (const row of candidates) {
    if (productsPayload.length >= batchLimit) break;

    const { data: product } = await supabase
      .from("products")
      .select("id, name, handle, category, description")
      .eq("id", row.product_id)
      .maybeSingle();
    if (!product) continue;

    const { data: variants } = await supabase
      .from("product_variants")
      .select("id")
      .eq("product_id", row.product_id);
    const variantIds = (variants ?? []).map((v) => v.id);
    if (!variantIds.length) continue;

    const [{ count: sizeCount }, { data: images }] = await Promise.all([
      supabase
        .from("variant_sizes")
        .select("id", { count: "exact", head: true })
        .in("variant_id", variantIds),
      supabase
        .from("variant_images")
        .select("secure_url, url")
        .in("variant_id", variantIds)
        .order("is_main", { ascending: false })
        .order("position", { ascending: true, nullsFirst: false })
        .limit(4),
    ]);
    if (!sizeCount || sizeCount < 1) continue;

    const image_urls = (images ?? [])
      .map((img) => String(img.secure_url || img.url || "").trim())
      .filter((u) => /^https:\/\//i.test(u))
      .slice(0, 4);
    if (!image_urls.length) continue;

    const tagIds = [
      row.tag1_id,
      row.tag2_id,
      ...((row.tag3_ids as string[] | null) ?? []),
    ].filter(Boolean) as string[];
    const { data: tagNames } = await supabase.from("tags").select("name").in("id", tagIds);
    const articulo = String(product.name || product.handle || "").trim();
    if (!articulo) continue;

    productsPayload.push({
      product_id: product.id,
      articulo,
      category: String(product.category || "Otros"),
      description: product.description ?? null,
      tags: (tagNames ?? []).map((t) => String(t.name)).filter(Boolean),
      image_urls,
    });
  }

  if (productsPayload.length === 0) {
    return { generated: 0, autoApproved: 0, candidates: candidates.length, errors: [], totalCostUsd: 0 };
  }

  const { data, error } = await supabase.functions.invoke("search_profile_ai", {
    body: {
      provider: "openai",
      persist: true,
      products: productsPayload,
    },
  });
  if (error) throw new Error(error.message || "Error invocando search_profile_ai");

  const results = Array.isArray(data?.results) ? data.results : [];
  let generated = 0;
  const highConfidenceIds: string[] = [];
  for (const r of results) {
    if (r?.error) {
      errors.push(`${r.articulo || "?"}: ${r.error}`);
      continue;
    }
    generated += 1;
    if (r?.product_id && typeof r.confidence === "number" && r.confidence >= AUTO_APPROVE_CONFIDENCE) {
      highConfidenceIds.push(r.product_id as string);
    }
  }

  let autoApproved = 0;
  if (highConfidenceIds.length > 0) {
    const { data: approvedRows, error: approveErr } = await supabase
      .from("product_search_profiles")
      .update({
        status: "approved",
        reviewed_by: ctx.userId,
        reviewed_at: new Date().toISOString(),
        review_note: `auto: confianza IA >= ${AUTO_APPROVE_CONFIDENCE}`,
      })
      .in("product_id", highConfidenceIds)
      .eq("status", "draft")
      .select("product_id");
    if (!approveErr) autoApproved = approvedRows?.length ?? 0;
  }

  return {
    generated,
    autoApproved,
    candidates: candidates.length,
    errors,
    totalCostUsd: Number(data?.total_cost_usd ?? 0),
  };
}
