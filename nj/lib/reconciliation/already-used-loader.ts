/**
 * Carga ocupación COD de pedidos confirmados / aprobados (para aviso «ya rendido»).
 *
 * Nota PostgREST: `.in(col, ids)` con cientos de UUIDs en GET → HTTP 400 "Bad Request"
 * (URL demasiado larga). Por eso todas las consultas `.in` van en chunks.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AlreadyUsedKind,
  OrderCodOccupancy,
} from "@/lib/reconciliation/already-used-match";
import {
  buildIdentities,
  type CodCandidateOrder,
  type SentDateOrigin,
} from "@/lib/reconciliation/matching";
import { resolveEffectiveSent } from "@/lib/reconciliation/queries";
import {
  COD_PAYMENT_METHOD,
  RECONCILIATION_START_DATE,
} from "@/lib/reconciliation/constants";

/** Límite seguro para filtros `.in` vía PostgREST GET (~100 UUIDs). */
const IN_CHUNK = 80;

type RemittanceMeta = {
  sheet_revision: number | null;
  status: string | null;
  remittance_date: string | null;
  transport_id: string | null;
};

type OccupancyFlatRow = {
  id: string;
  matched_order_id: string | null;
  remittance_id: string;
  sheet_revision: number | null;
  row_index: number | null;
  raw_customer_name_text: string | null;
  row_status: string;
  parsed_amount: number | string | null;
  expected_amount_snapshot: number | string | null;
};

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function kindFromRow(
  rowStatus: string,
  amountDiff: number | null
): AlreadyUsedKind {
  if (rowStatus === "approved_pending_confirmation") return "approved_pending";
  if (rowStatus === "confirmed_with_irregularity") return "confirmed_with_diff";
  if (
    rowStatus === "confirmed_matched" &&
    amountDiff != null &&
    Math.abs(amountDiff) >= 0.005
  ) {
    return "confirmed_with_diff";
  }
  if (rowStatus === "confirmed_matched") return "confirmed_exact";
  return "confirmed_with_diff";
}

async function fetchInChunks<T>(
  ids: string[],
  run: (
    chunk: string[]
  ) => Promise<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data, error } = await run(chunk);
    if (error) throw new Error(error.message);
    if (data?.length) out.push(...data);
  }
  return out;
}

/**
 * Mapa order_id → ocupación operativa (revisión actual, no voided).
 * Preferimos confirmed_* sobre approved_pending si ambos existieran.
 */
export async function loadOrderCodOccupancyMap(
  supabase: SupabaseClient
): Promise<Map<string, OrderCodOccupancy>> {
  // Sin nest transports: evita ambigüedad FK y reduce payload.
  // Remesas + transportes se resuelven en consultas aparte.
  const { data, error } = await supabase
    .from("cod_remittance_rows")
    .select(
      `
      id,
      matched_order_id,
      remittance_id,
      sheet_revision,
      row_index,
      raw_customer_name_text,
      row_status,
      parsed_amount,
      expected_amount_snapshot
    `
    )
    .in("row_status", [
      "confirmed_matched",
      "confirmed_with_irregularity",
      "approved_pending_confirmation",
    ])
    .not("matched_order_id", "is", null)
    .limit(8000);

  if (error) throw new Error(error.message);

  const flat = (data ?? []) as OccupancyFlatRow[];
  const remittanceIds = [
    ...new Set(flat.map((r) => r.remittance_id).filter(Boolean)),
  ];

  const remRows = await fetchInChunks<{
    id: string;
    sheet_revision: number | null;
    status: string | null;
    remittance_date: string | null;
    transport_id: string | null;
  }>(remittanceIds, async (chunk) =>
    supabase
      .from("cod_remittances")
      .select("id, sheet_revision, status, remittance_date, transport_id")
      .in("id", chunk)
  );

  const remById = new Map<string, RemittanceMeta>();
  const transportIds = new Set<string>();
  for (const r of remRows) {
    remById.set(r.id, {
      sheet_revision: r.sheet_revision,
      status: r.status,
      remittance_date: r.remittance_date,
      transport_id: r.transport_id,
    });
    if (r.transport_id) transportIds.add(r.transport_id);
  }

  const transportNameById = new Map<string, string>();
  const transports = await fetchInChunks<{ id: string; name: string | null }>(
    [...transportIds],
    async (chunk) =>
      supabase.from("transports").select("id, name").in("id", chunk)
  );
  for (const t of transports) {
    if (t.name?.trim()) transportNameById.set(t.id, t.name.trim());
  }

  const pendingByOrder = new Map<string, OccupancyFlatRow>();
  for (const raw of flat) {
    if (!raw.matched_order_id) continue;
    const rem = remById.get(raw.remittance_id);
    if (!rem || rem.status === "voided") continue;
    const rowRev = Number(raw.sheet_revision) || 1;
    const remRev = Number(rem.sheet_revision) || 1;
    if (rowRev !== remRev) continue;
    pendingByOrder.set(raw.matched_order_id, raw);
  }

  const orderIds = [...pendingByOrder.keys()];
  const map = new Map<string, OrderCodOccupancy>();
  if (orderIds.length === 0) return map;

  const irregRows = await fetchInChunks<{
    order_id: string;
    status: string;
    amount_diff: number | string | null;
  }>(orderIds, async (chunk) =>
    supabase
      .from("cod_irregularities")
      .select("order_id, status, amount_diff, remittance_row_id")
      .in("order_id", chunk)
      .in("status", ["open", "in_review", "resolved", "superseded"])
      .limit(4000)
  );

  const irregByOrder = new Map<
    string,
    { status: OrderCodOccupancy["irregularityStatus"]; amountDiff: number | null }
  >();
  for (const i of irregRows) {
    const oid = i.order_id;
    if (!oid) continue;
    const prev = irregByOrder.get(oid);
    const st = i.status as OrderCodOccupancy["irregularityStatus"];
    const rank = (s: string | null) =>
      s === "open" ? 3 : s === "in_review" ? 2 : s === "resolved" ? 1 : 0;
    if (!prev || rank(st) > rank(prev.status)) {
      irregByOrder.set(oid, {
        status: st,
        amountDiff: toNumber(i.amount_diff),
      });
    }
  }

  for (const [orderId, raw] of pendingByOrder) {
    const rem = remById.get(raw.remittance_id);
    if (!rem) continue;
    const reported = toNumber(raw.parsed_amount);
    const expected = toNumber(raw.expected_amount_snapshot);
    const irreg = irregByOrder.get(orderId);
    const amountDiff =
      irreg?.amountDiff ??
      (reported != null && expected != null
        ? Math.round((reported - expected) * 100) / 100
        : null);

    const kind = kindFromRow(raw.row_status, amountDiff);
    const existing = map.get(orderId);
    if (
      existing &&
      (existing.kind === "confirmed_exact" || existing.kind === "confirmed_with_diff") &&
      kind === "approved_pending"
    ) {
      continue;
    }

    map.set(orderId, {
      orderId,
      kind,
      otherRemittanceId: raw.remittance_id,
      otherRemittanceDate: rem.remittance_date
        ? String(rem.remittance_date).slice(0, 10)
        : null,
      otherTransportName: rem.transport_id
        ? transportNameById.get(rem.transport_id) ?? null
        : null,
      otherReportedAmount: reported,
      otherRowStatus: raw.row_status,
      otherRowId: raw.id,
      otherRowIndex: raw.row_index != null ? Number(raw.row_index) : null,
      otherRawCustomerName: raw.raw_customer_name_text?.trim() || null,
      irregularityStatus: irreg?.status ?? null,
      amountDiff,
      expectedAmountSnapshot: expected,
      // Hasta tener helper SQL aplicado, el acumulado ≈ suma de filas
      // confirmed del mismo order (mapa actual 1 primary; post-supp se enriquecerá).
      activeReportedTotal: reported,
    });
  }

  // Acumulado real: sumar parsed_amount de todas las filas confirmed del pedido.
  const reportedByOrder = new Map<string, number>();
  for (const raw of flat) {
    if (!raw.matched_order_id) continue;
    const rem = remById.get(raw.remittance_id);
    if (!rem || rem.status === "voided") continue;
    const rowRev = Number(raw.sheet_revision) || 1;
    const remRev = Number(rem.sheet_revision) || 1;
    if (rowRev !== remRev) continue;
    if (
      raw.row_status !== "confirmed_matched" &&
      raw.row_status !== "confirmed_with_irregularity"
    ) {
      continue;
    }
    const amt = toNumber(raw.parsed_amount) ?? 0;
    reportedByOrder.set(
      raw.matched_order_id,
      Math.round(((reportedByOrder.get(raw.matched_order_id) ?? 0) + amt) * 100) / 100
    );
  }
  for (const [orderId, total] of reportedByOrder) {
    const occ = map.get(orderId);
    if (!occ) continue;
    map.set(orderId, { ...occ, activeReportedTotal: total });
  }

  return map;
}

type RawOrder = {
  id: string;
  order_number: string | null;
  total_amount: number | string | null;
  sent_at: string | null;
  closed_at: string | null;
  label_customer_name: string | null;
  transport_id: string | null;
  customers:
    | {
        id?: string;
        full_name: string | null;
        transport_id: string | null;
        additional_names: unknown;
        customer_number?: string | number | null;
      }
    | {
        id?: string;
        full_name: string | null;
        transport_id: string | null;
        additional_names: unknown;
        customer_number?: string | number | null;
      }[]
    | null;
};

function unwrapCustomer(row: RawOrder) {
  const c = row.customers;
  if (!c) return null;
  return Array.isArray(c) ? c[0] ?? null : c;
}

/**
 * Candidatos COD que están ocupados (confirmados / approved) — para scoring informativo.
 */
export async function loadOccupiedCodCandidates(
  supabase: SupabaseClient,
  occupiedOrderIds: Set<string>,
  transportNames: Map<string, string>
): Promise<{
  candidates: CodCandidateOrder[];
  customerNumberByOrderId: Map<string, string | null>;
}> {
  if (occupiedOrderIds.size === 0) {
    return { candidates: [], customerNumberByOrderId: new Map() };
  }

  const ids = [...occupiedOrderIds];
  const rawOrders = await fetchInChunks<RawOrder>(ids, async (chunk) =>
    supabase
      .from("orders")
      .select(
        `
      id,
      order_number,
      total_amount,
      sent_at,
      closed_at,
      label_customer_name,
      transport_id,
      customers!inner (
        id,
        full_name,
        transport_id,
        additional_names,
        customer_number
      )
    `
      )
      .in("id", chunk)
      .eq("status", "sent")
      .eq("payment_method", COD_PAYMENT_METHOD)
  );

  const candidates: CodCandidateOrder[] = [];
  const customerNumberByOrderId = new Map<string, string | null>();

  for (const raw of rawOrders) {
    const customer = unwrapCustomer(raw);
    const effective = resolveEffectiveSent(raw.sent_at, raw.closed_at);
    if (!effective) continue;
    if (effective.effectiveSentDate < RECONCILIATION_START_DATE) continue;
    const effectiveTransportId = raw.transport_id || customer?.transport_id || null;
    candidates.push({
      id: raw.id,
      orderNumber: raw.order_number,
      customerId: customer?.id ?? null,
      customerDisplayName: customer?.full_name?.trim() || null,
      customerNumber:
        customer?.customer_number != null && String(customer.customer_number).trim()
          ? String(customer.customer_number).trim()
          : null,
      labelCustomerName: raw.label_customer_name?.trim() || null,
      expectedAmount: Number(raw.total_amount) || 0,
      effectiveSentDate: effective.effectiveSentDate,
      sentDateOrigin: effective.sentDateOrigin as SentDateOrigin,
      effectiveTransportId,
      transportName: effectiveTransportId
        ? transportNames.get(effectiveTransportId) ?? null
        : null,
      identities: buildIdentities({
        labelCustomerName: raw.label_customer_name,
        titularFullName: customer?.full_name ?? null,
        additionalNames: customer?.additional_names ?? null,
      }),
    });
    customerNumberByOrderId.set(
      raw.id,
      customer?.customer_number != null ? String(customer.customer_number) : null
    );
  }

  return { candidates, customerNumberByOrderId };
}
