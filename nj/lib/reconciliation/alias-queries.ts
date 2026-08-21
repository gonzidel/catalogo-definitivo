import type { SupabaseClient } from "@supabase/supabase-js";

export type TransportAliasListItem = {
  id: string;
  transportId: string;
  transportName: string | null;
  customerId: string;
  customerName: string | null;
  customerNumber: number | null;
  rawAlias: string;
  normalizedAlias: string;
  isActive: boolean;
  sourceRemittanceRowId: string | null;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
};

export async function listTransportCustomerAliases(
  supabase: SupabaseClient
): Promise<TransportAliasListItem[]> {
  const { data, error } = await supabase
    .from("cod_transport_customer_aliases")
    .select(
      `
      id,
      transport_id,
      customer_id,
      raw_alias,
      normalized_alias,
      is_active,
      source_remittance_row_id,
      notes,
      created_at,
      updated_at,
      transports ( name ),
      customers ( full_name, customer_number )
    `
    )
    .order("updated_at", { ascending: false })
    .limit(500);

  if (error) {
    // Tabla aún no migrada
    if (/schema cache|does not exist|Could not find/i.test(error.message)) {
      return [];
    }
    throw new Error(error.message);
  }

  return (data ?? []).map((r) => {
    const transport = Array.isArray(r.transports) ? r.transports[0] : r.transports;
    const customer = Array.isArray(r.customers) ? r.customers[0] : r.customers;
    return {
      id: r.id as string,
      transportId: r.transport_id as string,
      transportName: (transport as { name?: string } | null)?.name ?? null,
      customerId: r.customer_id as string,
      customerName: (customer as { full_name?: string } | null)?.full_name ?? null,
      customerNumber:
        (customer as { customer_number?: number | null } | null)?.customer_number ?? null,
      rawAlias: r.raw_alias as string,
      normalizedAlias: r.normalized_alias as string,
      isActive: !!r.is_active,
      sourceRemittanceRowId: (r.source_remittance_row_id as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      notes: (r.notes as string | null) ?? null,
    };
  });
}
