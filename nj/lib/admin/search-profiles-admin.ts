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
