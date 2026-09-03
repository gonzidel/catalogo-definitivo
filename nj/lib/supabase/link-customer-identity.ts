import type { SupabaseClient } from "@supabase/supabase-js";

export type LinkCustomerResult = {
  customerNumber: string | null;
  linked: boolean;
  matchType: string | null;
  errorMessage: string | null;
};

/**
 * Vincula (merge) un cliente admin existente con la cuenta auth actual.
 * Teléfono + provincia/localidad como clave principal.
 * No lanza: el caller decide si bloquea el guardado.
 */
export async function linkOrCreateCustomerIdentity(
  supabase: SupabaseClient,
  params: {
    userId: string;
    email: string;
    phone: string;
    fullName: string;
    dni: string;
    province: string;
    city: string;
  }
): Promise<LinkCustomerResult> {
  const { data, error } = await supabase.rpc("rpc_link_or_create_customer", {
    p_user_id: params.userId,
    p_email: params.email,
    p_phone: params.phone,
    p_full_name: params.fullName,
    p_dni: params.dni,
    p_province: params.province,
    p_city: params.city,
  });

  if (error) {
    return {
      customerNumber: null,
      linked: false,
      matchType: null,
      errorMessage: error.message || "Error al vincular cliente",
    };
  }

  const action =
    data && typeof data === "object"
      ? String((data as { action?: string }).action || "")
      : "";

  if (action === "error") {
    return {
      customerNumber: null,
      linked: false,
      matchType: null,
      errorMessage:
        (data as { message?: string }).message || "No se pudo vincular",
    };
  }

  const customerNumber =
    data && typeof data === "object" && (data as { customer_number?: string }).customer_number
      ? String((data as { customer_number: string }).customer_number)
      : null;

  return {
    customerNumber,
    linked: action === "linked" || action === "already_linked",
    matchType:
      data && typeof data === "object"
        ? ((data as { match_type?: string | null }).match_type ?? null)
        : null,
    errorMessage: null,
  };
}
