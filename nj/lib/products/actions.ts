"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import { slugify } from "@/lib/products/naming";

export interface CategoryPricingDefault {
  percentage: number;
  logistic_amount: number;
}

export async function getCategoryPricingDefault(
  category: string
): Promise<CategoryPricingDefault> {
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

interface SensitiveDbFields {
  cost?: number | null;
  cost_is_estimated?: boolean;
  price_percentage?: number | null;
  logistic_amount?: number | null;
}

/** Los campos de costo se ignoran si quien llama no es super_admin, sin importar lo que mande el cliente. */
async function sanitizeSensitiveFields(input: ProductGeneralInput): Promise<SensitiveDbFields> {
  const ctx = await getAdminContext();
  if (ctx?.isSuperAdmin) {
    return {
      cost: input.cost,
      cost_is_estimated: input.costIsEstimated,
      price_percentage: input.pricePercentage,
      logistic_amount: input.logisticAmount,
    };
  }
  return {};
}

export async function createProduct(
  input: ProductGeneralInput
): Promise<{ id: string }> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();
  const sensitive = await sanitizeSensitiveFields(input);

  const { data, error } = await supabase
    .from("products")
    .insert({
      name: input.name.trim(),
      handle: input.handle.trim() || slugify(input.name),
      category: input.category,
      status: input.status || "pending_stock",
      description: input.description || null,
      supplier_id: input.supplierId,
      ...sensitive,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  revalidatePath("/admin/products");
  return { id: data.id as string };
}

export async function updateProductGeneral(
  id: string,
  input: ProductGeneralInput
): Promise<void> {
  await requireProductsEdit();
  const supabase = await createSupabaseServerClient();
  const sensitive = await sanitizeSensitiveFields(input);

  const { error } = await supabase
    .from("products")
    .update({
      name: input.name.trim(),
      handle: input.handle.trim(),
      category: input.category,
      status: input.status,
      description: input.description || null,
      supplier_id: input.supplierId,
      ...sensitive,
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/admin/products");
  revalidatePath(`/admin/products/${id}`);
}
