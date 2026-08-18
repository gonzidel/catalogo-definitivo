"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";

export interface AutoTagsResult {
  category: "Calzado" | "Ropa" | "Otros";
  tag1: string;
  tag2: string;
  season: "verano" | "invierno" | "todo_anio";
  target_audience: "mujer" | "hombre" | "ninos" | "unisex";
  details: string[];
  highlights: string[];
  description: string;
  confidence: number;
}

export async function invokeAutoTags(
  imageUrl: string,
  productName: string,
  categoryHint: string,
  description: string | null
): Promise<AutoTagsResult> {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, "products", "edit")) {
    throw new Error("No tenés permiso para usar el auto-etiquetado.");
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.functions.invoke("auto_tags", {
    body: {
      image_url: imageUrl,
      product_name: productName,
      category_hint: categoryHint,
      description: description || null,
    },
  });

  if (error) throw new Error(error.message || "Error invocando auto-tags");
  if (!data || data.error) throw new Error(data?.error || "Respuesta vacía de la IA");

  return data as AutoTagsResult;
}

/** Aplica season/target_audience/descripcion directo al producto (campos planos, sin ambiguedad de mapeo). */
export async function applyAutoTagsPlainFields(
  productId: string,
  fields: { season: string; targetAudience: string; description: string }
): Promise<void> {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, "products", "edit")) {
    throw new Error("No tenés permiso para editar productos.");
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("products")
    .update({
      season: fields.season,
      target_audience: fields.targetAudience,
      description: fields.description,
    })
    .eq("id", productId);
  if (error) throw new Error(error.message);
}
