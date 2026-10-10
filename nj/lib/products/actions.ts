"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import { slugify } from "@/lib/products/naming";

export interface CategoryPricingDefault {
  percentage: number;
  logistic_amount: number;
}

async function requireSuperAdmin() {
  const ctx = await getAdminContext();
  if (!ctx?.isSuperAdmin) {
    throw new Error("No tenés permiso para ver costos.");
  }
  return ctx;
}

async function requireProductsView() {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, "products", "view")) {
    throw new Error("No tenés permiso para ver productos.");
  }
  return ctx;
}

export async function getCategoryPricingDefault(
  category: string
): Promise<CategoryPricingDefault> {
  await requireSuperAdmin();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("category_pricing_defaults")
    .select("percentage, logistic_amount")
    .eq("category", category)
    .maybeSingle();

  return {
    percentage: data ? Number(data.percentage) : 30,
    logistic_amount: data ? Number(data.logistic_amount) : 500,
  };
}

export async function getNextRopaNumber(): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("products")
    .select("name")
    .eq("category", "Ropa")
    .not("name", "is", null);

  let maxNumber = 0;
  for (const row of data ?? []) {
    const match = (row.name || "").trim().toUpperCase().match(/^R(\d+)/);
    if (match) maxNumber = Math.max(maxNumber, parseInt(match[1], 10));
  }
  return maxNumber + 1;
}

export interface SupplierRow {
  id: string;
  name: string;
  code: string;
}

export async function listSuppliers(): Promise<SupplierRow[]> {
  await requireProductsView();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("suppliers")
    .select("id, name, code")
    .order("name", { ascending: true });
  return (data as SupplierRow[]) ?? [];
}

async function requireProductsEdit() {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, "products", "edit")) {
    throw new Error("No tenés permiso para editar productos.");
  }
  return ctx;
}

export async function createSupplier(
  name: string,
  code?: string
): Promise<SupplierRow> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("suppliers")
    .insert({ name: name.trim(), code: (code || "").trim() || slugify(name).toUpperCase() })
    .select("id, name, code")
    .single();

  if (error) throw new Error(error.message);
  return data as SupplierRow;
}

export async function updateSupplierCode(id: string, code: string): Promise<void> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("suppliers")
    .update({ code: code.trim() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export interface ProductGeneralInput {
  name: string;
  handle: string;
  category: "Calzado" | "Ropa" | "Otros";
  status: string;
  description: string;
  supplierId: string | null;
  cost: number | null;
  costIsEstimated: boolean;
  pricePercentage: number | null;
  logisticAmount: number | null;
}

export interface ProductPricing {
  cost: number | null;
  costIsEstimated: boolean;
  pricePercentage: number | null;
  logisticAmount: number | null;
}

interface ProductPricingRow {
  product_id: string;
  cost: number | string | null;
  cost_is_estimated: boolean | null;
  price_percentage: number | string | null;
  logistic_amount: number | string | null;
}

const toNumberOrNull = (value: number | string | null) => (value === null ? null : Number(value));

/** authenticated no tiene permiso de columna sobre los costos de products: se leen y escriben por RPC. */
export async function getProductPricing(id: string): Promise<ProductPricing | null> {
  await requireSuperAdmin();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_admin_get_product_pricing", {
    p_product_ids: [id],
  });
  if (error) throw new Error(`No se pudo leer el costo del producto: ${error.message}`);
  const row = (data as ProductPricingRow[] | null)?.[0];
  if (!row) return null;
  return {
    cost: toNumberOrNull(row.cost),
    costIsEstimated: row.cost_is_estimated === true,
    pricePercentage: toNumberOrNull(row.price_percentage),
    logisticAmount: toNumberOrNull(row.logistic_amount),
  };
}

/**
 * Los campos de costo se ignoran si quien llama no es super_admin, sin importar lo que mande el cliente.
 * Devuelve el mensaje de error si el producto se guardó pero el costo no.
 */
async function saveSensitiveFields(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  productId: string,
  input: ProductGeneralInput
): Promise<string | null> {
  const ctx = await getAdminContext();
  if (!ctx?.isSuperAdmin) return null;
  const { error } = await supabase.rpc("rpc_admin_set_product_pricing", {
    p_product_id: productId,
    p_cost: input.cost,
    p_cost_is_estimated: input.costIsEstimated,
    p_price_percentage: input.pricePercentage,
    p_logistic_amount: input.logisticAmount,
  });
  return error ? `Producto guardado, pero no se pudo guardar el costo: ${error.message}` : null;
}

export async function createProduct(
  input: ProductGeneralInput
): Promise<{ id: string; pricingError: string | null }> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("products")
    .insert({
      name: input.name.trim(),
      handle: input.handle.trim() || slugify(input.name),
      category: input.category,
      status: input.status || "pending_stock",
      description: input.description || null,
      supplier_id: input.supplierId,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  const id = data.id as string;
  const pricingError = await saveSensitiveFields(supabase, id, input);
  revalidatePath("/admin/products");
  return { id, pricingError };
}

export async function updateProductGeneral(
  id: string,
  input: ProductGeneralInput
): Promise<void> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from("products")
    .update({
      name: input.name.trim(),
      handle: input.handle.trim(),
      category: input.category,
      status: input.status,
      description: input.description || null,
      supplier_id: input.supplierId,
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  const pricingError = await saveSensitiveFields(supabase, id, input);
  revalidatePath("/admin/products");
  revalidatePath(`/admin/products/${id}`);
  if (pricingError) throw new Error(pricingError);
}
