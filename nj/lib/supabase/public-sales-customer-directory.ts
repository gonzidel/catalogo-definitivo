import type { SupabaseClient } from "@supabase/supabase-js";
import {
  formatCustomerDisplayName,
  formatPhoneAr,
  normalizeCustomerSearchText,
  rankCustomersForSearch,
  tokenizeCustomerSearch,
  validatePhoneAr,
  type CustomerDirectoryRow,
} from "@/lib/supabase/customer-directory";

export interface PublicSalesCustomerRow {
  id: string;
  customer_number: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  document_number: string | null;
  qr_code: string | null;
}

export interface NewLocalCustomerFormInput {
  firstName: string;
  lastName: string;
  phone: string;
  dni?: string;
  email?: string;
}

const PSC_SELECT =
  "id, customer_number, first_name, last_name, phone, email, document_number, qr_code";

export function mapPublicSalesCustomerToDirectoryRow(
  row: PublicSalesCustomerRow
): CustomerDirectoryRow {
  const first = String(row.first_name || "").trim();
  const last = String(row.last_name || "").trim();
  const full_name = [first, last].filter(Boolean).join(" ") || null;
  return {
    id: row.id,
    customer_number: row.customer_number,
    full_name,
    dni: row.document_number,
    phone: row.phone,
    email: row.email,
    city: null,
    province: null,
  };
}

export function validateNewLocalCustomerForm(
  raw: NewLocalCustomerFormInput
): { ok: true; data: NewLocalCustomerFormInput } | { ok: false; error: string } {
  const firstName = String(raw.firstName || "").trim();
  const lastName = String(raw.lastName || "").trim();
  const phone = String(raw.phone || "").trim();
  const dni = String(raw.dni || "").trim();
  const email = String(raw.email || "").trim();

  if (!firstName) {
    return { ok: false, error: "El nombre es obligatorio." };
  }
  if (!phone) {
    return { ok: false, error: "Teléfono es obligatorio." };
  }
  if (!validatePhoneAr(phone)) {
    return {
      ok: false,
      error: "El teléfono debe tener entre 8 y 10 dígitos (código de área + número).",
    };
  }
  if (dni && (dni.length < 7 || dni.length > 8 || !/^\d+$/.test(dni))) {
    return { ok: false, error: "El DNI debe tener entre 7 y 8 dígitos numéricos." };
  }

  return {
    ok: true,
    data: {
      firstName,
      lastName,
      phone: formatPhoneAr(phone),
      dni: dni || undefined,
      email: email || undefined,
    },
  };
}

/**
 * Busca en public_sales_customers (clientes del local).
 * Query directa (admins) con teléfono incluido; el RPC legacy no filtra por phone.
 */
export async function searchPublicSalesCustomersByQuery(
  supabase: SupabaseClient,
  rawQuery: string
): Promise<CustomerDirectoryRow[]> {
  const cleanQuery = String(rawQuery || "").trim();
  if (cleanQuery.length < 2) return [];

  const normQuery = normalizeCustomerSearchText(cleanQuery);
  const tokens = tokenizeCustomerSearch(normQuery);
  const escapedQuery = cleanQuery.replace(/[%_]/g, "");

  const { data, error } = await supabase
    .from("public_sales_customers")
    .select(PSC_SELECT)
    .or(
      [
        `first_name.ilike.%${escapedQuery}%`,
        `last_name.ilike.%${escapedQuery}%`,
        `phone.ilike.%${escapedQuery}%`,
        `email.ilike.%${escapedQuery}%`,
        `document_number.ilike.%${escapedQuery}%`,
        `customer_number.ilike.%${escapedQuery}%`,
      ].join(",")
    )
    .limit(80);

  if (error) throw error;

  const mapped = ((data || []) as PublicSalesCustomerRow[]).map(
    mapPublicSalesCustomerToDirectoryRow
  );
  return rankCustomersForSearch(mapped, normQuery, tokens).slice(0, 12);
}

export async function findPublicSalesCustomerByDni(
  supabase: SupabaseClient,
  dni: string
): Promise<CustomerDirectoryRow | null> {
  const clean = String(dni || "").trim();
  if (!clean) return null;
  const { data } = await supabase
    .from("public_sales_customers")
    .select(PSC_SELECT)
    .eq("document_number", clean)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return mapPublicSalesCustomerToDirectoryRow(data as PublicSalesCustomerRow);
}

export async function createPublicSalesCustomer(
  supabase: SupabaseClient,
  data: NewLocalCustomerFormInput
): Promise<CustomerDirectoryRow> {
  const { data: result, error } = await supabase.rpc("rpc_create_public_customer", {
    p_first_name: data.firstName,
    p_last_name: data.lastName || null,
    p_phone: data.phone || null,
    p_email: data.email || null,
    p_document_number: data.dni || null,
  });

  if (error) throw error;
  if (!result?.success && !result?.customer_id) {
    throw new Error(result?.message || result?.error || "No se pudo crear el cliente del local.");
  }

  const customerId = String(result.customer_id);
  const { data: customer, error: fetchError } = await supabase
    .from("public_sales_customers")
    .select(PSC_SELECT)
    .eq("id", customerId)
    .single();

  if (fetchError || !customer) {
    return {
      id: customerId,
      customer_number: result.customer_number ?? null,
      full_name: [data.firstName, data.lastName].filter(Boolean).join(" "),
      dni: data.dni || null,
      phone: data.phone || null,
      email: data.email || null,
      city: null,
      province: null,
    };
  }

  return mapPublicSalesCustomerToDirectoryRow(customer as PublicSalesCustomerRow);
}

/**
 * Puente public_sales_customers → customers (orders.customer_id).
 * Misma semántica que fyl_private.resolve_customer_for_public_sales (311),
 * callable desde el admin NJ sin RPC nueva.
 */
export async function resolveOrdersCustomerIdFromPublicSales(
  supabase: SupabaseClient,
  publicSalesCustomerId: string
): Promise<string> {
  const pscId = String(publicSalesCustomerId || "").trim();
  if (!pscId) throw new Error("Cliente del local inválido.");

  const { data: psc, error: pscErr } = await supabase
    .from("public_sales_customers")
    .select(PSC_SELECT)
    .eq("id", pscId)
    .single();

  if (pscErr || !psc) throw new Error("Cliente del local no encontrado.");

  const row = psc as PublicSalesCustomerRow;

  const { data: linked } = await supabase
    .from("customers")
    .select("id")
    .eq("public_sales_customer_id", pscId)
    .limit(1)
    .maybeSingle();
  if (linked?.id) {
    await ensureRetiraLocalTransport(supabase, linked.id);
    return String(linked.id);
  }

  const dni = String(row.document_number || "").trim();
  if (dni) {
    const { data: byDni } = await supabase
      .from("customers")
      .select("id")
      .eq("dni", dni)
      .order("created_by_admin", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byDni?.id) {
      await linkPublicSalesCustomer(supabase, byDni.id, pscId);
      await ensureRetiraLocalTransport(supabase, byDni.id);
      return String(byDni.id);
    }
  }

  const phone = String(row.phone || "").trim();
  if (phone) {
    const { data: byPhone } = await supabase
      .from("customers")
      .select("id")
      .eq("phone", phone)
      .order("created_by_admin", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byPhone?.id) {
      await linkPublicSalesCustomer(supabase, byPhone.id, pscId);
      await ensureRetiraLocalTransport(supabase, byPhone.id);
      return String(byPhone.id);
    }
  }

  const email = String(row.email || "").trim();
  if (email) {
    const { data: byEmail } = await supabase
      .from("customers")
      .select("id")
      .ilike("email", email)
      .order("created_by_admin", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byEmail?.id) {
      await linkPublicSalesCustomer(supabase, byEmail.id, pscId);
      await ensureRetiraLocalTransport(supabase, byEmail.id);
      return String(byEmail.id);
    }
  }

  const fullName =
    [String(row.first_name || "").trim(), String(row.last_name || "").trim()]
      .filter(Boolean)
      .join(" ") || "Cliente local";

  const { data: created, error: createErr } = await supabase.rpc("rpc_create_admin_customer", {
    p_full_name: fullName,
    p_email: email || null,
    p_phone: phone || null,
    p_dni: dni || null,
    p_address: null,
    p_city: null,
    p_province: null,
  });

  if (createErr) throw createErr;
  if (!created?.success || !created?.customer_id) {
    throw new Error(created?.message || "No se pudo vincular el cliente del local al pedido.");
  }

  const ordersCustomerId = String(created.customer_id);
  await linkPublicSalesCustomer(supabase, ordersCustomerId, pscId);
  await ensureRetiraLocalTransport(supabase, ordersCustomerId);
  return ordersCustomerId;
}

async function linkPublicSalesCustomer(
  supabase: SupabaseClient,
  ordersCustomerId: string,
  publicSalesCustomerId: string
): Promise<void> {
  const { error } = await supabase
    .from("customers")
    .update({ public_sales_customer_id: publicSalesCustomerId })
    .eq("id", ordersCustomerId);
  if (error) throw error;
}

async function ensureRetiraLocalTransport(
  supabase: SupabaseClient,
  ordersCustomerId: string
): Promise<void> {
  const { data: transport } = await supabase
    .from("transports")
    .select("id, name")
    .or("name.ilike.retira local,name.ilike.retiro de local,name.ilike.retiro local")
    .limit(5);

  const rows = transport || [];
  const preferred =
    rows.find((t) => String(t.name || "").trim().toLowerCase() === "retira local") || rows[0];
  if (!preferred?.id) return;

  await supabase
    .from("customers")
    .update({ transport_id: preferred.id })
    .eq("id", ordersCustomerId)
    .is("transport_id", null);
}

export { formatCustomerDisplayName };
