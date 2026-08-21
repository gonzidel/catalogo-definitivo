import type { SupabaseClient } from "@supabase/supabase-js";

export type UnassignedConfirmedRow = {
  id: string;
  remittanceId: string;
  remittanceDate: string | null;
  transportId: string;
  transportName: string | null;
  rowIndex: number;
  rawCustomerNameText: string;
  rawTransportDateText: string;
  rawAmountText: string;
  parsedTransportDate: string | null;
  parsedAmount: number | null;
};

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function unwrapTransportName(rel: unknown): string | null {
  if (!rel) return null;
  if (Array.isArray(rel)) {
    const first = rel[0] as { name?: string } | undefined;
    return first?.name ?? null;
  }
  return (rel as { name?: string }).name ?? null;
}

/**
 * Definición operativa de "Pagos sin identificar" (dashboard KPI + listado 6B):
 *   row_status = 'unassigned' AND remittance.status = 'confirmed'
 * Excluye draft / analyzed / voided (y cualquier otro status ≠ confirmed).
 */
export async function countUnassignedConfirmedPayments(
  supabase: SupabaseClient
): Promise<{ count: number; amount: number }> {
  const pageSize = 1000;
  const all: { parsed_amount: number | string | null }[] = [];
  let from = 0;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("cod_remittance_rows")
      .select(
        `
        parsed_amount,
        cod_remittances!inner ( status )
      `
      )
      .eq("row_status", "unassigned")
      .eq("cod_remittances.status", "confirmed")
      .range(from, to);

    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return {
    count: all.length,
    amount: all.reduce((s, r) => s + (toNumber(r.parsed_amount) ?? 0), 0),
  };
}

/**
 * Pagos sin identificar en rendiciones ya confirmadas (Fase 6B).
 * Misma definición que countUnassignedConfirmedPayments.
 */
export async function listUnassignedConfirmedPayments(
  supabase: SupabaseClient,
  limit = 200
): Promise<UnassignedConfirmedRow[]> {
  const { data, error } = await supabase
    .from("cod_remittance_rows")
    .select(
      `
      id,
      remittance_id,
      row_index,
      raw_customer_name_text,
      raw_transport_date_text,
      raw_amount_text,
      parsed_transport_date,
      parsed_amount,
      cod_remittances!inner (
        id,
        remittance_date,
        transport_id,
        status,
        transports ( name )
      )
    `
    )
    .eq("row_status", "unassigned")
    .eq("cod_remittances.status", "confirmed")
    .order("parsed_transport_date", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return (data ?? []).map((r) => {
    const rem = Array.isArray(r.cod_remittances)
      ? r.cod_remittances[0]
      : r.cod_remittances;
    const remObj = rem as {
      id?: string;
      remittance_date?: string;
      transport_id?: string;
      transports?: unknown;
    } | null;

    return {
      id: r.id as string,
      remittanceId: (remObj?.id as string) || (r.remittance_id as string),
      remittanceDate: (remObj?.remittance_date as string | null) ?? null,
      transportId: (remObj?.transport_id as string) || "",
      transportName: unwrapTransportName(remObj?.transports),
      rowIndex: Number(r.row_index) || 0,
      rawCustomerNameText: r.raw_customer_name_text as string,
      rawTransportDateText: r.raw_transport_date_text as string,
      rawAmountText: r.raw_amount_text as string,
      parsedTransportDate: (r.parsed_transport_date as string | null) ?? null,
      parsedAmount: toNumber(r.parsed_amount),
    };
  });
}
