"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";

async function requireProductsEdit() {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, "products", "edit")) {
    throw new Error("No tenés permiso para editar variantes.");
  }
  return ctx;
}

export interface ColorRow {
  id: string;
  name: string;
  code: string | null;
}

export async function getFirstProductImageUrl(productId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data: variants } = await supabase
    .from("product_variants")
    .select("id")
    .eq("product_id", productId);
  const variantIds = (variants ?? []).map((v) => v.id);
  if (variantIds.length === 0) return null;

  const { data: image } = await supabase
    .from("variant_images")
    .select("secure_url, url")
    .in("variant_id", variantIds)
    .order("position", { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  return image ? image.secure_url || image.url : null;
}

export async function listColors(): Promise<ColorRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("colors").select("id, name, code").order("name");
  return (data as ColorRow[]) ?? [];
}

function colorCode(color: string, colors: ColorRow[]): string {
  if (!color) return "CLR";
  const found = colors.find((c) => c.name?.toLowerCase() === color.toLowerCase());
  if (found?.code) return found.code.toUpperCase();
  return color.toLowerCase().replace(/[^a-z]/g, "").slice(0, 3).toUpperCase() || "CLR";
}

export async function makeSkuBase(handle: string, color: string, supplierId: string | null): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const colors = await listColors();
  const h = (handle || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const colorPart = colorCode(color, colors);

  let supplierCode: string | null = null;
  if (supplierId) {
    const { data } = await supabase.from("suppliers").select("code").eq("id", supplierId).maybeSingle();
    supplierCode = data?.code ?? null;
  }

  return supplierCode ? `${supplierCode.toUpperCase()}-${h}-${colorPart}` : `${h}-${colorPart}`;
}

export interface VariantRow {
  id: string;
  color: string;
  sku: string;
  price: number;
  active: boolean;
  stockTotal: number;
  imageCount: number;
}

export async function listVariants(productId: string): Promise<VariantRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data: variants } = await supabase
    .from("product_variants")
    .select("id, color, sku, price, active")
    .eq("product_id", productId)
    .order("color");

  const rows = variants ?? [];
  if (rows.length === 0) return [];

  const variantIds = rows.map((v) => v.id);
  const [{ data: sizes }, { data: images }] = await Promise.all([
    supabase.from("variant_sizes").select("variant_id, stock_qty").in("variant_id", variantIds),
    supabase.from("variant_images").select("variant_id").in("variant_id", variantIds),
  ]);

  const stockByVariant = new Map<string, number>();
  for (const s of sizes ?? []) {
    stockByVariant.set(s.variant_id, (stockByVariant.get(s.variant_id) ?? 0) + (s.stock_qty ?? 0));
  }
  const imagesByVariant = new Map<string, number>();
  for (const img of images ?? []) {
    imagesByVariant.set(img.variant_id, (imagesByVariant.get(img.variant_id) ?? 0) + 1);
  }

  return rows.map((v) => ({
    id: v.id,
    color: v.color,
    sku: v.sku,
    price: Number(v.price) || 0,
    active: !!v.active,
    stockTotal: stockByVariant.get(v.id) ?? 0,
    imageCount: imagesByVariant.get(v.id) ?? 0,
  }));
}

export async function createVariant(
  productId: string,
  color: string,
  handle: string,
  supplierId: string | null
): Promise<VariantRow> {
  await requireProductsEdit();
  const sku = await makeSkuBase(handle, color, supplierId);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("product_variants")
    .insert({ product_id: productId, color: color.trim(), sku, price: 0, stock_qty: 0, reserved_qty: 0, active: true })
    .select("id, color, sku, price, active")
    .single();

  if (error) throw new Error(error.message);
  return { ...data, price: Number(data.price) || 0, active: !!data.active, stockTotal: 0, imageCount: 0 };
}

export async function updateVariant(
  variantId: string,
  input: { price: number; active: boolean }
): Promise<void> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("product_variants")
    .update({ price: input.price, active: input.active })
    .eq("id", variantId);
  if (error) throw new Error(error.message);
}

export interface SizeStockRow {
  size: string;
  stock_qty: number;
  sku: string | null;
}

export async function getVariantSizes(variantId: string): Promise<SizeStockRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("variant_sizes")
    .select("size, stock_qty, sku")
    .eq("variant_id", variantId)
    .order("size");
  return (data as SizeStockRow[]) ?? [];
}

/** Reemplazo completo del stock por talle en depósito general — vía RPC atómica, nunca escritura directa. */
export async function saveVariantSizes(
  variantId: string,
  skuBase: string,
  items: { size: string; stock_qty: number }[]
): Promise<void> {
  await requireProductsEdit();
  if (items.length === 0) throw new Error("Definí al menos un talle.");

  const supabase = await createSupabaseServerClient();
  const pItems = items.map((it) => ({
    size: it.size.trim(),
    stock_qty: Math.max(0, Math.floor(it.stock_qty) || 0),
    sku: skuBase ? `${skuBase}-${it.size.trim()}` : null,
  }));

  const { error } = await supabase.rpc("rpc_save_product_variant_initial_stock", {
    p_variant_id: variantId,
    p_items: pItems,
  });

  if (error) throw new Error(error.message);
}

export interface VariantImageRow {
  id: string;
  url: string;
  secure_url: string | null;
  public_id: string | null;
  position: number | null;
  is_main: boolean | null;
}

export async function listVariantImages(variantId: string): Promise<VariantImageRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("variant_images")
    .select("id, url, secure_url, public_id, position, is_main")
    .eq("variant_id", variantId)
    .order("position", { ascending: true, nullsFirst: false });
  return (data as VariantImageRow[]) ?? [];
}

/** Sube un archivo (base64) via la Edge Function "upload-image" existente — las credenciales de Cloudinary quedan del lado servidor, nunca en el cliente. */
export async function uploadVariantImage(
  variantId: string,
  base64: string,
  category: string,
  skuBase: string,
  color: string,
  position: number
): Promise<VariantImageRow> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.functions.invoke("upload-image", {
    body: { variant_id: variantId, file: base64, category, sku_base: skuBase, color, position },
  });

  if (error) throw new Error(error.message || "Error subiendo imagen");
  if (!data) throw new Error("Respuesta vacía al subir imagen");

  const { data: inserted, error: insertErr } = await supabase
    .from("variant_images")
    .insert({
      variant_id: variantId,
      url: data.url || data.secure_url,
      secure_url: data.secure_url,
      public_id: data.public_id,
      position,
      is_main: position === 1,
    })
    .select("id, url, secure_url, public_id, position, is_main")
    .single();

  if (insertErr) throw new Error(insertErr.message);
  return inserted as VariantImageRow;
}

function parsePublicIdFromCloudinaryUrl(url: string): { publicId: string | null; secureUrl: string } {
  const secureUrl = url.startsWith("http://") ? url.replace("http://", "https://") : url;
  const match = secureUrl.match(/\/image\/upload\/(?:[^/]+\/)*(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
  return { publicId: match ? match[1] : null, secureUrl };
}

/** Carga imágenes ya subidas a Cloudinary pegando URLs directas — sin volver a subir el archivo. */
export async function loadImagesFromUrls(
  variantId: string,
  urls: string[]
): Promise<VariantImageRow[]> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();
  const existing = await listVariantImages(variantId);
  let nextPosition = existing.length + 1;

  const rows = urls
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => {
      const { publicId, secureUrl } = parsePublicIdFromCloudinaryUrl(u);
      const row = {
        variant_id: variantId,
        url: secureUrl,
        secure_url: secureUrl,
        public_id: publicId,
        position: nextPosition,
        is_main: nextPosition === 1,
      };
      nextPosition += 1;
      return row;
    });

  if (rows.length === 0) return [];

  const { data, error } = await supabase.from("variant_images").insert(rows).select("id, url, secure_url, public_id, position, is_main");
  if (error) throw new Error(error.message);
  return (data as VariantImageRow[]) ?? [];
}

export async function reorderVariantImages(variantId: string, orderedImageIds: string[]): Promise<void> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();
  for (let i = 0; i < orderedImageIds.length; i++) {
    const { error } = await supabase
      .from("variant_images")
      .update({ position: i + 1, is_main: i === 0 })
      .eq("id", orderedImageIds[i])
      .eq("variant_id", variantId);
    if (error) throw new Error(error.message);
  }
}

export async function deleteVariantImage(imageId: string): Promise<void> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("variant_images").delete().eq("id", imageId);
  if (error) throw new Error(error.message);
}

/** Oferta por color — vive en color_price_offers (product_id + color), no en el producto en general. */
export interface ColorOffer {
  id: string;
  offer_price: number;
  start_date: string;
  end_date: string;
}

export async function getActiveColorOffer(productId: string, color: string): Promise<ColorOffer | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("color_price_offers")
    .select("id, offer_price, start_date, end_date")
    .eq("product_id", productId)
    .eq("color", color)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as ColorOffer | null;
}

export async function setColorOffer(
  productId: string,
  color: string,
  active: boolean,
  offerPrice: number | null
): Promise<void> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();
  const existing = await getActiveColorOffer(productId, color);

  if (!active) {
    if (existing) {
      const { error } = await supabase.from("color_price_offers").update({ status: "inactive" }).eq("id", existing.id);
      if (error) throw new Error(error.message);
    }
    return;
  }

  if (!offerPrice || offerPrice <= 0) {
    throw new Error("Ingresá un precio de oferta válido.");
  }

  if (existing) {
    const { error } = await supabase
      .from("color_price_offers")
      .update({ offer_price: offerPrice })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return;
  }

  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 30);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const { error } = await supabase.from("color_price_offers").insert({
    product_id: productId,
    color,
    offer_price: offerPrice,
    start_date: fmt(today),
    end_date: fmt(endDate),
    status: "active",
  });
  if (error) throw new Error(error.message);
}
