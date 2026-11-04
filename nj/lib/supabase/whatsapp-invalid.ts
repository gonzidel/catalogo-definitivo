import type { SupabaseClient } from "@supabase/supabase-js";

export async function rpcAdminMarkWhatsappInvalid(
  supabase: SupabaseClient,
  customerId: string
): Promise<{ ok: boolean; phone?: string | null }> {
  const { data, error } = await supabase.rpc("rpc_admin_mark_whatsapp_invalid", {
    p_customer_id: customerId,
  });
  if (error) throw error;
  const row = data as { ok?: boolean; phone?: string | null } | null;
  return { ok: Boolean(row?.ok), phone: row?.phone ?? null };
}

export async function rpcCustomerFixPhoneClearWhatsappInvalid(
  supabase: SupabaseClient,
  phoneE164: string
): Promise<void> {
  const { data, error } = await supabase.rpc(
    "rpc_customer_fix_phone_clear_whatsapp_invalid",
    { p_phone: phoneE164 }
  );
  if (error) throw error;
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    throw new Error("No se pudo actualizar el teléfono");
  }
}
