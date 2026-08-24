import type { SupabaseClient } from "@supabase/supabase-js";
import type { NameMatchSource, SentDateOrigin } from "@/lib/reconciliation/matching";
import { enrichMatchCandidatesDisplayNames } from "@/lib/reconciliation/enrich-match-candidates";

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
  sheetRevision: number;
  sheetEditedAt: string | null;
  sheetEditCount: number;
};

export type RemittanceRowDetail = {
  id: string;
  rowIndex: number;
  sheetRevision: number;
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
  activeAdjustmentId: string | null;
  activeAdjustmentKind: string | null;
};

export type RemittanceDetail = RemittanceListItem & {
  notes: string | null;
  createdBy: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  sheetEditReason: string | null;
  rows: RemittanceRowDetail[];
};

function isMissingRevisionColumn(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("sheet_revision") ||
    m.includes("sheet_edited") ||
    m.includes("sheet_edit_") ||
    m.includes("does not exist") ||
    m.includes("schema cache")
  );
}

function mapRow(r: Record<string, unknown>): RemittanceRowDetail {
  const source = r.matched_name_source;
  const origin = r.order_sent_date_origin;
  return {
    id: String(r.id),
    rowIndex: Number(r.row_index) || 0,
    sheetRevision: Number(r.sheet_revision) || 1,
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
    activeAdjustmentId: null,
    activeAdjustmentKind: null,
  };
}

export async function listCodRemittances(
  supabase: SupabaseClient,
  limit = 50
): Promise<RemittanceListItem[]> {
  const selectFull = `
      id, remittance_date, transport_id, row_count, reported_total, calculated_total,
      status, content_hash, created_at, analyzed_at,
      sheet_revision, sheet_edited_at, sheet_edit_count,
      transports ( id, name )
    `;
  const selectLegacy = `
      id, remittance_date, transport_id, row_count, reported_total, calculated_total,
      status, content_hash, created_at, analyzed_at,
      transports ( id, name )
    `;

  let { data, error } = await supabase
    .from("cod_remittances")
    .select(selectFull)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error && isMissingRevisionColumn(error.message)) {
    ({ data, error } = await supabase
      .from("cod_remittances")
      .select(selectLegacy)
      .order("created_at", { ascending: false })
      .limit(limit));
  }

  if (error) throw new Error(error.message);

  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown> & {
      id: string;
      remittance_date: string;
      transport_id: string;
      row_count: number;
      reported_total: number;
      calculated_total: number | null;
      status: string;
      content_hash: string | null;
      created_at: string;
      analyzed_at: string | null;
      transports: { id: string; name: string } | { id: string; name: string }[] | null;
    };
    const t = row.transports;
    const transport = Array.isArray(t) ? t[0] : t;
    return {
      id: row.id,
      remittanceDate: row.remittance_date,
      transportId: row.transport_id,
      transportName: transport?.name ?? null,
      rowCount: Number(row.row_count) || 0,
      reportedTotal: Number(row.reported_total) || 0,
      calculatedTotal: row.calculated_total != null ? Number(row.calculated_total) : null,
      status: row.status,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      analyzedAt: row.analyzed_at ?? null,
      sheetRevision: Number(row.sheet_revision) || 1,
      sheetEditedAt: (row.sheet_edited_at as string | null | undefined) ?? null,
      sheetEditCount: Number(row.sheet_edit_count) || 0,
    };
  });
}

/** Filas de una revisión (default: operativa actual). */
export async function getCodRemittanceRowsForRevision(
  supabase: SupabaseClient,
  remittanceId: string,
  sheetRevision: number
): Promise<RemittanceRowDetail[]> {
  const selectFull = `
      id, row_index, sheet_revision, raw_line,
      raw_transport_date_text, raw_customer_name_text, raw_amount_text,
      parsed_transport_date, parsed_amount, row_status, matched_order_id,
      match_score, match_breakdown, match_candidates, matched_via_broadened_search,
      transport_mismatch, will_create_irregularity, order_number_snapshot,
      matched_name_snapshot, matched_name_source, transport_name_snapshot,
      order_sent_date_snapshot, order_sent_date_origin, expected_amount_snapshot
    `;
  const selectLegacy = `
      id, row_index, raw_line,
      raw_transport_date_text, raw_customer_name_text, raw_amount_text,
      parsed_transport_date, parsed_amount, row_status, matched_order_id,
      match_score, match_breakdown, match_candidates, matched_via_broadened_search,
      transport_mismatch, will_create_irregularity, order_number_snapshot,
      matched_name_snapshot, matched_name_source, transport_name_snapshot,
      order_sent_date_snapshot, order_sent_date_origin, expected_amount_snapshot
    `;

  let q = supabase
    .from("cod_remittance_rows")
    .select(selectFull)
    .eq("remittance_id", remittanceId)
    .eq("sheet_revision", sheetRevision)
    .order("row_index", { ascending: true });

  let { data: rows, error: rowsError } = await q;

  if (rowsError && isMissingRevisionColumn(rowsError.message)) {
    ({ data: rows, error: rowsError } = await supabase
      .from("cod_remittance_rows")
      .select(selectLegacy)
      .eq("remittance_id", remittanceId)
      .order("row_index", { ascending: true }));
  }

  if (rowsError) throw new Error(rowsError.message);
  const mapped = (rows ?? []).map((r) => mapRow(r as Record<string, unknown>));
  const enriched = await attachActiveAdjustments(supabase, mapped);
  return enrichMatchCandidatesDisplayNames(supabase, enriched);
}

async function attachActiveAdjustments(
  supabase: SupabaseClient,
  rows: RemittanceRowDetail[]
): Promise<RemittanceRowDetail[]> {
  const ids = rows
    .filter((r) => r.rowStatus === "classified_adjustment")
    .map((r) => r.id);
  if (!ids.length) return rows;

  const { data, error } = await supabase
    .from("cod_transport_adjustments")
    .select("id, remittance_row_id, kind, status")
    .in("remittance_row_id", ids)
    .neq("status", "voided");

  if (error || !data?.length) return rows;

  const byRow = new Map(
    data.map((a) => [String(a.remittance_row_id), a] as const)
  );

  return rows.map((r) => {
    const adj = byRow.get(r.id);
    if (!adj) return r;
    return {
      ...r,
      activeAdjustmentId: String(adj.id),
      activeAdjustmentKind: String(adj.kind),
    };
  });
}

export async function getCodRemittanceDetail(
  supabase: SupabaseClient,
  id: string
): Promise<RemittanceDetail | null> {
  const headerFull = `
      id, remittance_date, transport_id, row_count, reported_total, calculated_total,
      status, content_hash, created_at, analyzed_at, notes, created_by,
      confirmed_by, confirmed_at, voided_by, voided_at, void_reason,
      sheet_revision, sheet_edited_at, sheet_edit_count, sheet_edit_reason,
      transports ( id, name )
    `;
  const headerLegacy = `
      id, remittance_date, transport_id, row_count, reported_total, calculated_total,
      status, content_hash, created_at, analyzed_at, notes, created_by,
      confirmed_by, confirmed_at, voided_by, voided_at, void_reason,
      transports ( id, name )
    `;

  let { data, error } = await supabase
    .from("cod_remittances")
    .select(headerFull)
    .eq("id", id)
    .maybeSingle();

  if (error && isMissingRevisionColumn(error.message)) {
    ({ data, error } = await supabase
      .from("cod_remittances")
      .select(headerLegacy)
      .eq("id", id)
      .maybeSingle());
  }

  if (error) throw new Error(error.message);
  if (!data) return null;

  const header = data as Record<string, unknown> & {
    id: string;
    remittance_date: string;
    transport_id: string;
    row_count: number;
    reported_total: number;
    calculated_total: number | null;
    status: string;
    content_hash: string | null;
    created_at: string;
    analyzed_at: string | null;
    notes: string | null;
    created_by: string;
    confirmed_by: string | null;
    confirmed_at: string | null;
    voided_by: string | null;
    voided_at: string | null;
    void_reason: string | null;
    transports: { id: string; name: string } | { id: string; name: string }[] | null;
  };

  const sheetRevision = Number(header.sheet_revision) || 1;
  const rows = await getCodRemittanceRowsForRevision(supabase, id, sheetRevision);

  const t = header.transports;
  const transport = Array.isArray(t) ? t[0] : t;

  return {
    id: header.id,
    remittanceDate: header.remittance_date,
    transportId: header.transport_id,
    transportName: transport?.name ?? null,
    rowCount: Number(header.row_count) || 0,
    reportedTotal: Number(header.reported_total) || 0,
    calculatedTotal: header.calculated_total != null ? Number(header.calculated_total) : null,
    status: header.status,
    contentHash: header.content_hash,
    createdAt: header.created_at,
    analyzedAt: header.analyzed_at ?? null,
    sheetRevision,
    sheetEditedAt: (header.sheet_edited_at as string | null | undefined) ?? null,
    sheetEditCount: Number(header.sheet_edit_count) || 0,
    notes: header.notes,
    createdBy: header.created_by,
    confirmedBy: header.confirmed_by ?? null,
    confirmedAt: header.confirmed_at ?? null,
    voidedBy: header.voided_by ?? null,
    voidedAt: header.voided_at ?? null,
    voidReason: header.void_reason ?? null,
    sheetEditReason: (header.sheet_edit_reason as string | null | undefined) ?? null,
    rows,
  };
}

export async function listTransportsForRemittance(
  supabase: SupabaseClient
): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabase.from("transports").select("id, name").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((t) => ({ id: t.id, name: t.name }));
}
