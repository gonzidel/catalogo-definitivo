import type { SupabaseClient } from "@supabase/supabase-js";
import type { NameMatchSource, SentDateOrigin } from "@/lib/reconciliation/matching";

export type RemittanceListItem = {
  id: string;
  remittanceDate: string;
  transportId: string;
  transportName: string | null;
  rowCount: number;
  reportedTotal: number;
  calculatedTotal: number | null;
  status: string;
  contentHash: string | null;
  createdAt: string;
  analyzedAt: string | null;
};

export type RemittanceRowDetail = {
  id: string;
  rowIndex: number;
  rawLine: string | null;
  rawTransportDateText: string;
  rawCustomerNameText: string;
  rawAmountText: string;
  parsedTransportDate: string | null;
  parsedAmount: number | null;
  rowStatus: string;
  matchedOrderId: string | null;
  matchScore: number | null;
  matchBreakdown: Record<string, unknown> | null;
  matchCandidates: unknown[] | null;
  matchedViaBroadenedSearch: boolean;
  transportMismatch: boolean;
  willCreateIrregularity: boolean;
  orderNumberSnapshot: string | null;
  matchedNameSnapshot: string | null;
  matchedNameSource: NameMatchSource | null;
  transportNameSnapshot: string | null;
  orderSentDateSnapshot: string | null;
  orderSentDateOrigin: SentDateOrigin | null;
  expectedAmountSnapshot: number | null;
};

export type RemittanceDetail = RemittanceListItem & {
  notes: string | null;
  createdBy: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  rows: RemittanceRowDetail[];
};

export async function listCodRemittances(
  supabase: SupabaseClient,
  limit = 50
): Promise<RemittanceListItem[]> {
  const { data, error } = await supabase
    .from("cod_remittances")
    .select(
      `
      id,
      remittance_date,
      transport_id,
      row_count,
      reported_total,
      calculated_total,
      status,
      content_hash,
      created_at,
      analyzed_at,
      transports ( id, name )
    `
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return (data ?? []).map((r) => {
    const t = r.transports as { id: string; name: string } | { id: string; name: string }[] | null;
    const transport = Array.isArray(t) ? t[0] : t;
    return {
      id: r.id,
      remittanceDate: r.remittance_date,
      transportId: r.transport_id,
      transportName: transport?.name ?? null,
      rowCount: Number(r.row_count) || 0,
      reportedTotal: Number(r.reported_total) || 0,
      calculatedTotal: r.calculated_total != null ? Number(r.calculated_total) : null,
      status: r.status,
      contentHash: r.content_hash,
      createdAt: r.created_at,
      analyzedAt: r.analyzed_at ?? null,
    };
  });
}

function mapRow(r: Record<string, unknown>): RemittanceRowDetail {
  const source = r.matched_name_source;
  const origin = r.order_sent_date_origin;
  return {
    id: String(r.id),
    rowIndex: Number(r.row_index) || 0,
    rawLine: (r.raw_line as string | null) ?? null,
    rawTransportDateText: String(r.raw_transport_date_text ?? ""),
    rawCustomerNameText: String(r.raw_customer_name_text ?? ""),
    rawAmountText: String(r.raw_amount_text ?? ""),
    parsedTransportDate: (r.parsed_transport_date as string | null) ?? null,
    parsedAmount: r.parsed_amount != null ? Number(r.parsed_amount) : null,
    rowStatus: String(r.row_status ?? "pending_analysis"),
    matchedOrderId: (r.matched_order_id as string | null) ?? null,
    matchScore: r.match_score != null ? Number(r.match_score) : null,
    matchBreakdown: (r.match_breakdown as Record<string, unknown> | null) ?? null,
    matchCandidates: Array.isArray(r.match_candidates) ? (r.match_candidates as unknown[]) : null,
    matchedViaBroadenedSearch: Boolean(r.matched_via_broadened_search),
    transportMismatch: Boolean(r.transport_mismatch),
    willCreateIrregularity: Boolean(r.will_create_irregularity),
    orderNumberSnapshot: (r.order_number_snapshot as string | null) ?? null,
    matchedNameSnapshot: (r.matched_name_snapshot as string | null) ?? null,
    matchedNameSource:
      source === "label" || source === "titular" || source === "sub_name" ? source : null,
    transportNameSnapshot: (r.transport_name_snapshot as string | null) ?? null,
    orderSentDateSnapshot: (r.order_sent_date_snapshot as string | null) ?? null,
    orderSentDateOrigin:
      origin === "sent_at" || origin === "closed_at_fallback" ? origin : null,
    expectedAmountSnapshot:
      r.expected_amount_snapshot != null ? Number(r.expected_amount_snapshot) : null,
  };
}

export async function getCodRemittanceDetail(
  supabase: SupabaseClient,
  id: string
): Promise<RemittanceDetail | null> {
  const { data, error } = await supabase
    .from("cod_remittances")
    .select(
      `
      id,
      remittance_date,
      transport_id,
      row_count,
      reported_total,
      calculated_total,
      status,
      content_hash,
      created_at,
      analyzed_at,
      notes,
      created_by,
      confirmed_by,
      confirmed_at,
      voided_by,
      voided_at,
      void_reason,
      transports ( id, name )
    `
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const { data: rows, error: rowsError } = await supabase
    .from("cod_remittance_rows")
    .select(
      `
      id,
      row_index,
      raw_line,
      raw_transport_date_text,
      raw_customer_name_text,
      raw_amount_text,
      parsed_transport_date,
      parsed_amount,
      row_status,
      matched_order_id,
      match_score,
      match_breakdown,
      match_candidates,
      matched_via_broadened_search,
      transport_mismatch,
      will_create_irregularity,
      order_number_snapshot,
      matched_name_snapshot,
      matched_name_source,
      transport_name_snapshot,
      order_sent_date_snapshot,
      order_sent_date_origin,
      expected_amount_snapshot
    `
    )
    .eq("remittance_id", id)
    .order("row_index", { ascending: true });

  if (rowsError) throw new Error(rowsError.message);

  const t = data.transports as { id: string; name: string } | { id: string; name: string }[] | null;
  const transport = Array.isArray(t) ? t[0] : t;

  return {
    id: data.id,
    remittanceDate: data.remittance_date,
    transportId: data.transport_id,
    transportName: transport?.name ?? null,
    rowCount: Number(data.row_count) || 0,
    reportedTotal: Number(data.reported_total) || 0,
    calculatedTotal: data.calculated_total != null ? Number(data.calculated_total) : null,
    status: data.status,
    contentHash: data.content_hash,
    createdAt: data.created_at,
    analyzedAt: data.analyzed_at ?? null,
    notes: data.notes,
    createdBy: data.created_by,
    confirmedBy: (data.confirmed_by as string | null) ?? null,
    confirmedAt: (data.confirmed_at as string | null) ?? null,
    voidedBy: (data.voided_by as string | null) ?? null,
    voidedAt: (data.voided_at as string | null) ?? null,
    voidReason: (data.void_reason as string | null) ?? null,
    rows: (rows ?? []).map((r) => mapRow(r as Record<string, unknown>)),
  };
}

export async function listTransportsForRemittance(
  supabase: SupabaseClient
): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabase.from("transports").select("id, name").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((t) => ({ id: t.id, name: t.name }));
}
