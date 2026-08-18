import type { SupabaseClient } from "@supabase/supabase-js";
import { PROVINCE_CITIES_DATA } from "@/lib/data/argentina-cities-data";

export interface CustomerDirectoryRow {
  id: string;
  customer_number: number | string | null;
  full_name: string | null;
  dni: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  province: string | null;
}

export const PROVINCE_CITIES: Record<string, string[]> = PROVINCE_CITIES_DATA;
export const ARGENTINA_PROVINCES: string[] = Object.keys(PROVINCE_CITIES_DATA).sort();

export function normalizeCustomerSearchText(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeCustomerSearch(value: string | null | undefined): string[] {
  return normalizeCustomerSearchText(value)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function normalizePhoneDigitsForMatch(text: string | null | undefined): string {
  let d = String(text || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("54") && d.length > 10) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d;
}

const PHONE_SEARCH_SUFFIX_LEN = 7;

function phonesMatchBySuffix(
  queryText: string,
  storedPhone: string | null | undefined,
  suffixLen = PHONE_SEARCH_SUFFIX_LEN
): boolean {
  const q = normalizePhoneDigitsForMatch(queryText);
  const p = normalizePhoneDigitsForMatch(storedPhone);
  if (!q || !p) return false;

  const compareLen = Math.min(suffixLen, q.length, p.length);
  if (compareLen < 4) return false;

  if (q.length >= suffixLen && p.length >= suffixLen) {
    return q.slice(-suffixLen) === p.slice(-suffixLen);
  }
  return q.slice(-compareLen) === p.slice(-compareLen);
}

export function rankCustomersForSearch(
  customers: CustomerDirectoryRow[],
  normQuery: string,
  tokens: string[]
): CustomerDirectoryRow[] {
  return [...customers]
    .map((customer) => {
      const fullName = normalizeCustomerSearchText(customer.full_name || "");
      const dni = String(customer.dni || "").toLowerCase();
      const email = String(customer.email || "").toLowerCase();
      const phone = normalizePhoneDigitsForMatch(customer.phone || "");
      const customerNumber = String(customer.customer_number || "").toLowerCase();
      const queryDigits = normalizePhoneDigitsForMatch(normQuery);
      const allTokensMatch = tokens.length > 0 && tokens.every((t) => fullName.includes(t));
      const startsWithAllTokens =
        tokens.length > 0 &&
        Boolean(fullName) &&
        tokens.every((t) => fullName.startsWith(t) || fullName.includes(` ${t}`));

      let score = 0;
      if (fullName === normQuery) score += 140;
      if (fullName.startsWith(normQuery)) score += 100;
      if (startsWithAllTokens) score += 75;
      if (allTokensMatch) score += 55;
      if (customerNumber && customerNumber.includes(normQuery)) score += 45;
      if (dni && dni.includes(normQuery)) score += 35;
      if (queryDigits && phonesMatchBySuffix(normQuery, customer.phone)) score += 90;
      else if (queryDigits && phone.includes(queryDigits)) score += 35;
      if (email && email.includes(normQuery)) score += 20;
      if (!fullName && (dni || email || customerNumber || phone)) score += 5;

      return { customer, score, fullName };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.fullName.localeCompare(b.fullName, "es", { sensitivity: "base" });
    })
    .map((row) => row.customer);
}

export function formatCustomerDisplayName(customer: CustomerDirectoryRow | null | undefined): string {
  const full = String(customer?.full_name || "").trim();
  if (!full) return "Cliente sin nombre";
  const parts = full.split(/\s+/);
  if (parts.length === 1) return full;
  const last = parts.pop();
  const first = parts.join(" ");
  return `${last}, ${first}`;
}

const CUSTOMER_SELECT_FIELDS =
  "id, customer_number, full_name, dni, phone, email, city, province";

export async function searchCustomersByQuery(
  supabase: SupabaseClient,
  rawQuery: string
): Promise<CustomerDirectoryRow[]> {
  const cleanQuery = String(rawQuery || "").trim();
  if (cleanQuery.length < 2) return [];

  const normQuery = normalizeCustomerSearchText(cleanQuery);
  const tokens = tokenizeCustomerSearch(normQuery);
  const escapedQuery = cleanQuery.replace(/[%_]/g, "");

  const { data, error } = await supabase
    .from("customers")
    .select(CUSTOMER_SELECT_FIELDS)
    .or(
      `full_name.ilike.%${escapedQuery}%,dni.ilike.%${escapedQuery}%,phone.ilike.%${escapedQuery}%,email.ilike.%${escapedQuery}%,customer_number.ilike.%${escapedQuery}%`
    )
    .limit(80);

  if (error) throw error;

  return rankCustomersForSearch((data || []) as CustomerDirectoryRow[], normQuery, tokens).slice(0, 12);
}

export async function findCustomerByDni(
  supabase: SupabaseClient,
  dni: string
): Promise<CustomerDirectoryRow | null> {
  const { data } = await supabase
    .from("customers")
    .select(CUSTOMER_SELECT_FIELDS)
    .eq("dni", dni)
    .maybeSingle();
  return (data as CustomerDirectoryRow) || null;
}

export function validatePhoneAr(phone: string | null | undefined): boolean {
  if (!phone) return false;
  let cleaned = String(phone).replace(/^\+54\s?/i, "");
  cleaned = cleaned.replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("9")) cleaned = cleaned.substring(1);
  return /^\d{8,10}$/.test(cleaned);
}

export function formatPhoneAr(phone: string | null | undefined): string {
  if (!phone) return "";
  let cleaned = String(phone).replace(/^\+54\s?/i, "");
  cleaned = cleaned.replace(/[\s\-()]/g, "");
  if (!cleaned.startsWith("9") && cleaned.length >= 8) cleaned = "9" + cleaned;
  if (cleaned.length >= 10) {
    const match = cleaned.match(/^9?(\d{2,4})(\d{6,8})$/);
    if (match) {
      const areaCode = match[1];
      const number = match[2];
      const formattedNumber =
        number.length > 4 ? `${number.slice(0, -4)}-${number.slice(-4)}` : number;
      return `+54 9 ${areaCode} ${formattedNumber}`;
    }
  }
  return `+54 ${cleaned}`;
}

export interface NewCustomerFormInput {
  firstName: string;
  lastName: string;
  dni?: string;
  phone: string;
  email?: string;
  address: string;
  province: string;
  city: string;
}

export interface NewCustomerPayload {
  full_name: string;
  phone: string;
  email: string | null;
  dni: string | null;
  address: string;
  city: string;
  province: string;
}

export function validateNewCustomerForm(
  raw: NewCustomerFormInput
): { ok: true; data: NewCustomerPayload } | { ok: false; error: string } {
  const firstName = String(raw.firstName || "").trim();
  const lastName = String(raw.lastName || "").trim();
  const dni = String(raw.dni || "").trim();
  const phone = String(raw.phone || "").trim();
  const email = String(raw.email || "").trim();
  const address = String(raw.address || "").trim();
  const province = String(raw.province || "").trim();
  const city = String(raw.city || "").trim();

  if (!firstName || !lastName) {
    return { ok: false, error: "Nombre y apellido son obligatorios." };
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
  if (!address) {
    return { ok: false, error: "Dirección es obligatoria." };
  }
  if (!province) {
    return { ok: false, error: "Provincia es obligatoria." };
  }
  if (!ARGENTINA_PROVINCES.includes(province)) {
    return { ok: false, error: "La provincia seleccionada no es válida." };
  }
  if (!city) {
    return { ok: false, error: "Ciudad es obligatoria." };
  }
  const cities = PROVINCE_CITIES[province] || [];
  if (!cities.includes(city)) {
    return { ok: false, error: "La ciudad no es válida para la provincia elegida." };
  }
  if (dni && (dni.length < 7 || dni.length > 8 || !/^\d+$/.test(dni))) {
    return { ok: false, error: "El DNI debe tener entre 7 y 8 dígitos numéricos." };
  }

  return {
    ok: true,
    data: {
      full_name: `${firstName} ${lastName}`.trim(),
      phone: formatPhoneAr(phone),
      email: email || null,
      dni: dni || null,
      address,
      city,
      province,
    },
  };
}

export async function createAdminCustomer(
  supabase: SupabaseClient,
  data: NewCustomerPayload
): Promise<CustomerDirectoryRow> {
  const { data: result, error } = await supabase.rpc("rpc_create_admin_customer", {
    p_full_name: data.full_name,
    p_email: data.email,
    p_phone: data.phone,
    p_dni: data.dni,
    p_address: data.address,
    p_city: data.city,
    p_province: data.province,
  });

  if (error) throw error;
  if (!result?.success) {
    throw new Error(result?.message || result?.error || "No se pudo crear el cliente.");
  }

  const { data: customer, error: fetchError } = await supabase
    .from("customers")
    .select(CUSTOMER_SELECT_FIELDS)
    .eq("id", result.customer_id)
    .single();

  if (fetchError || !customer) throw new Error("Cliente creado pero no se pudo cargar.");
  return customer as CustomerDirectoryRow;
}
