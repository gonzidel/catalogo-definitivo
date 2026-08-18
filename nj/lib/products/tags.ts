"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";

export interface TagRow {
  id: string;
  name: string;
}

export interface SimilarTag extends TagRow {
  similarity: number;
}

async function requireProductsEdit() {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, "products", "edit")) {
    throw new Error("No tenés permiso para editar tags.");
  }
  return ctx;
}

export async function listTags1(category: string): Promise<TagRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("tags")
    .select("id, name")
    .eq("category", category)
    .eq("level", 1)
    .order("name");
  return (data as TagRow[]) ?? [];
}

export async function listTags2(tag1Id: string): Promise<TagRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("tags")
    .select("id, name")
    .eq("parent_id", tag1Id)
    .eq("level", 2)
    .order("name");
  return (data as TagRow[]) ?? [];
}

/** Tags3 disponibles para un tag1: todos los hijos de sus tag2 (para jerarquia y para "Detalles"). */
export async function listTags3ByTag1(tag1Id: string): Promise<TagRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data: tag2s } = await supabase
    .from("tags")
    .select("id")
    .eq("parent_id", tag1Id)
    .eq("level", 2);

  const tag2Ids = (tag2s ?? []).map((t) => t.id);
  if (tag2Ids.length === 0) return [];

  const { data } = await supabase
    .from("tags")
    .select("id, name")
    .in("parent_id", tag2Ids)
    .eq("level", 3)
    .order("name");
  return (data as TagRow[]) ?? [];
}

export async function findSimilarTags(
  name: string,
  level: number,
  category: string,
  parentId: string | null
): Promise<SimilarTag[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_find_similar_tags", {
    p_name: name.trim(),
    p_level: level,
    p_category: category,
    p_parent_id: parentId,
  });
  if (error) return [];
  return (data as SimilarTag[]) ?? [];
}

export interface CreateTagResult {
  tag?: TagRow;
  suggestion?: SimilarTag;
}

/**
 * Sin aprobación humana: el chequeo de similitud es el único control. Si hay un
 * parecido y no se fuerza, devuelve la sugerencia en vez de crear. Con force=true
 * (el empleado confirmó que es distinto) crea directo.
 */
export async function createTagChecked(
  name: string,
  level: number,
  category: string,
  parentId: string | null,
  force = false
): Promise<CreateTagResult> {
  await requireProductsEdit();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("El nombre del tag no puede estar vacío");

  if (!force) {
    const similar = await findSimilarTags(trimmed, level, category, parentId);
    if (similar.length > 0) {
      return { suggestion: similar[0] };
    }
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tags")
    .insert({ name: trimmed, level, category, parent_id: parentId })
    .select("id, name")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("Ya existe un tag con ese nombre exacto.");
    throw new Error(error.message);
  }
  return { tag: data as TagRow };
}

export async function deleteTag(id: string): Promise<{ deleted: boolean; reason?: string }> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();

  const { data: children } = await supabase.from("tags").select("id").eq("parent_id", id);
  if (children && children.length > 0) {
    return { deleted: false, reason: "Tiene tags hijos. Eliminá primero los hijos." };
  }

  const { data: usedAsTag } = await supabase
    .from("product_tags")
    .select("product_id")
    .or(`tag1_id.eq.${id},tag2_id.eq.${id},tag3_ids.cs.{${id}}`)
    .limit(1);
  if (usedAsTag && usedAsTag.length > 0) {
    return { deleted: false, reason: "Está en uso en al menos un producto." };
  }

  const { data: usedAsDetail } = await supabase
    .from("product_tag_details")
    .select("product_id")
    .eq("tag3_id", id)
    .limit(1);
  if (usedAsDetail && usedAsDetail.length > 0) {
    return { deleted: false, reason: "Está en uso como detalle en al menos un producto." };
  }

  const { error } = await supabase.from("tags").delete().eq("id", id);
  if (error) return { deleted: false, reason: error.message };
  return { deleted: true };
}

export interface ProductTagsState {
  tag1Id: string | null;
  tag2Id: string | null;
  tag3Ids: string[];
}

export async function getProductTags(productId: string): Promise<ProductTagsState> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("product_tags")
    .select("tag1_id, tag2_id, tag3_ids")
    .eq("product_id", productId)
    .maybeSingle();

  return {
    tag1Id: data?.tag1_id ?? null,
    tag2Id: data?.tag2_id ?? null,
    tag3Ids: data?.tag3_ids ?? [],
  };
}

export async function saveProductTags(
  productId: string,
  state: ProductTagsState
): Promise<void> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();

  const payload = {
    tag1_id: state.tag1Id,
    tag2_id: state.tag2Id,
    tag3_ids: state.tag3Ids.length > 0 ? state.tag3Ids : null,
  };

  const { data: existing } = await supabase
    .from("product_tags")
    .select("product_id")
    .eq("product_id", productId)
    .maybeSingle();

  const { error } = existing
    ? await supabase.from("product_tags").update(payload).eq("product_id", productId)
    : await supabase.from("product_tags").insert({ product_id: productId, ...payload });

  if (error) throw new Error(error.message);
}

export async function getProductDetails(productId: string): Promise<string[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("product_tag_details")
    .select("tag3_id")
    .eq("product_id", productId);
  return (data ?? []).map((d) => d.tag3_id as string);
}

export async function saveDetailsAndHighlights(
  productId: string,
  detailIds: string[],
  highlightIds: string[]
): Promise<void> {
  await requireProductsEdit();
  if (highlightIds.length > 2) {
    throw new Error("Máximo 2 destacados.");
  }
  const supabase = await createSupabaseServerClient();

  const { data: current } = await supabase
    .from("product_tag_details")
    .select("tag3_id")
    .eq("product_id", productId);

  const currentIds = new Set((current ?? []).map((d) => d.tag3_id as string));
  const nextIds = new Set(detailIds);

  const toInsert = detailIds.filter((id) => !currentIds.has(id));
  const toDelete = [...currentIds].filter((id) => !nextIds.has(id));

  if (toInsert.length > 0) {
    const { error } = await supabase
      .from("product_tag_details")
      .insert(toInsert.map((tag3_id) => ({ product_id: productId, tag3_id })));
    if (error) throw new Error(error.message);
  }
  if (toDelete.length > 0) {
    const { error } = await supabase
      .from("product_tag_details")
      .delete()
      .eq("product_id", productId)
      .in("tag3_id", toDelete);
    if (error) throw new Error(error.message);
  }

  const tagsState = await getProductTags(productId);
  await saveProductTags(productId, { ...tagsState, tag3Ids: highlightIds });
}
