// admin/search-profile-auto.js
// Dispara search_profile_ai la primera vez que el producto tiene tags + talles + foto.
import { supabase } from "../scripts/supabase-client.js?v=m260607";

/**
 * @param {string} productId
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, articulo?: string, error?: string }>}
 */
export async function maybeGenerateSearchProfile(productId) {
  if (!productId) return { ok: true, skipped: true, reason: "product_id vacío" };

  try {
    const { data: existing } = await supabase
      .from("product_search_profiles")
      .select("product_id")
      .eq("product_id", productId)
      .maybeSingle();
    if (existing) return { ok: true, skipped: true, reason: "perfil ya existe" };

    const payload = await buildProductPayload(productId);
    if (!payload) return { ok: true, skipped: true, reason: "producto no encontrado" };
    if (!payload.ready) return { ok: true, skipped: true, reason: payload.reason };

    const { data, error } = await supabase.functions.invoke("search_profile_ai", {
      body: {
        provider: "openai",
        persist: true,
        products: [payload.product],
      },
    });

    if (error) {
      console.warn("[search-profile-auto]", error.message);
      return { ok: false, error: error.message };
    }
    const first = Array.isArray(data?.results) ? data.results[0] : null;
    if (first?.error) {
      console.warn("[search-profile-auto]", first.error);
      return { ok: false, error: String(first.error) };
    }

    console.log("[search-profile-auto] draft generado:", payload.product.articulo);
    return { ok: true, skipped: false, articulo: payload.product.articulo };
  } catch (e) {
    const msg = e?.message || "error desconocido";
    console.warn("[search-profile-auto]", msg);
    return { ok: false, error: msg };
  }
}

export async function maybeGenerateSearchProfileForVariant(variantId) {
  if (!variantId) return { ok: true, skipped: true, reason: "variant_id vacío" };
  const { data } = await supabase
    .from("product_variants")
    .select("product_id")
    .eq("id", variantId)
    .maybeSingle();
  if (!data?.product_id) return { ok: true, skipped: true, reason: "variante sin producto" };
  return maybeGenerateSearchProfile(data.product_id);
}

async function buildProductPayload(productId) {
  const { data: product } = await supabase
    .from("products")
    .select("id, name, handle, category, description")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return null;

  const { data: tagsRow } = await supabase
    .from("product_tags")
    .select("tag1_id, tag2_id, tag3_ids")
    .eq("product_id", productId)
    .maybeSingle();
  if (!tagsRow?.tag1_id || !tagsRow?.tag2_id) {
    return { ready: false, reason: "faltan tag1/tag2" };
  }

  const tagIds = [
    tagsRow.tag1_id,
    tagsRow.tag2_id,
    ...(Array.isArray(tagsRow.tag3_ids) ? tagsRow.tag3_ids : []),
  ].filter(Boolean);

  const { data: tagNames } = await supabase.from("tags").select("id, name").in("id", tagIds);
  const tags = (tagNames || []).map((t) => String(t.name)).filter(Boolean);

  const { data: variants } = await supabase
    .from("product_variants")
    .select("id")
    .eq("product_id", productId);
  const variantIds = (variants || []).map((v) => v.id);
  if (!variantIds.length) return { ready: false, reason: "sin variantes" };

  const [{ count: sizeCount }, { data: images }] = await Promise.all([
    supabase
      .from("variant_sizes")
      .select("id", { count: "exact", head: true })
      .in("variant_id", variantIds),
    supabase
      .from("variant_images")
      .select("secure_url, url, position, is_main")
      .in("variant_id", variantIds)
      .order("is_main", { ascending: false })
      .order("position", { ascending: true, nullsFirst: false })
      .limit(8),
  ]);

  if (!sizeCount || sizeCount < 1) return { ready: false, reason: "sin talles" };

  const image_urls = (images || [])
    .map((img) => String(img.secure_url || img.url || "").trim())
    .filter((u) => /^https:\/\//i.test(u))
    .slice(0, 4);
  if (!image_urls.length) return { ready: false, reason: "sin foto" };

  const articulo = String(product.name || product.handle || "").trim();
  if (!articulo) return { ready: false, reason: "sin nombre de artículo" };

  return {
    ready: true,
    product: {
      product_id: product.id,
      articulo,
      category: String(product.category || "Otros"),
      description: product.description ?? null,
      tags,
      image_urls,
    },
  };
}
