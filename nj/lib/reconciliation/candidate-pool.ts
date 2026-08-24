import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COD_PAYMENT_METHOD,
  RECONCILIATION_START_DATE,
} from "@/lib/reconciliation/constants";
import {
  buildIdentities,
  type CodCandidateOrder,
  type SentDateOrigin,
  type TransportAliasHit,
} from "@/lib/reconciliation/matching";
import { normalizeCodAliasName } from "@/lib/reconciliation/name-normalize";
import { resolveEffectiveSent } from "@/lib/reconciliation/queries";

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
        id: string;
        full_name: string | null;
        customer_number?: string | number | null;
        transport_id: string | null;
        additional_names: unknown;
      }
    | {
        id: string;
        full_name: string | null;
        customer_number?: string | number | null;
        transport_id: string | null;
        additional_names: unknown;
      }[]
    | null;
};

async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const pageSize = 1000;
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    out.push(...chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

function unwrapCustomer(row: RawOrder) {
  const c = row.customers;
  if (!c) return null;
  return Array.isArray(c) ? c[0] ?? null : c;
}

function toNumber(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Exclusiones del pool de matching COD.
 *
 * EXCLUIR del scoring:
 *   - local_orders.source_order_id
 *   - filas con row_status confirmed_matched | confirmed_with_irregularity
 *
 * NO excluir:
 *   - approved_pending_confirmation (sigue financieramente pendiente)
 *     → solo genera advertencia en match_breakdown
 */
export async function loadExcludedOrderIds(supabase: SupabaseClient): Promise<{
  localSourceIds: Set<string>;
  /** Solo confirmación financiera activa — NUNCA approved_pending_confirmation */
  confirmedIds: Set<string>;
  /** order_id → texto de advertencia (siguen en el pool) */
  approvedPendingWarnings: Map<string, string>;
}> {
  const [localRows, confirmedRows, approvedRows] = await Promise.all([
    fetchAllPages<{ source_order_id: string }>(async (from, to) => {
      const r = await supabase
        .from("local_orders")
        .select("source_order_id")
        .not("source_order_id", "is", null)
        .range(from, to);
      return { data: r.data, error: r.error };
    }),
    fetchAllPages<{ matched_order_id: string | null }>(async (from, to) => {
      const r = await supabase
        .from("cod_remittance_rows")
        .select("matched_order_id")
        .in("row_status", ["confirmed_matched", "confirmed_with_irregularity"])
        .not("matched_order_id", "is", null)
        .range(from, to);
      return { data: r.data, error: r.error };
    }),
    fetchAllPages<{ matched_order_id: string | null; remittance_id: string; sheet_revision?: number }>(
      async (from, to) => {
        const r = await supabase
          .from("cod_remittance_rows")
          .select(
            "matched_order_id, remittance_id, sheet_revision, cod_remittances!inner(sheet_revision, status)"
          )
          .eq("row_status", "approved_pending_confirmation")
          .not("matched_order_id", "is", null)
          .range(from, to);
        return { data: r.data as typeof r.data, error: r.error };
      }
    ),
  ]);

  const localSourceIds = new Set(localRows.map((r) => r.source_order_id).filter(Boolean));
  const confirmedIds = new Set(
    confirmedRows.map((r) => r.matched_order_id).filter((id): id is string => !!id)
  );
  const approvedPendingWarnings = new Map<string, string>();
  for (const r of approvedRows as Array<{
    matched_order_id: string | null;
    remittance_id: string;
    sheet_revision?: number;
    cod_remittances?:
      | { sheet_revision?: number; status?: string }
      | { sheet_revision?: number; status?: string }[]
      | null;
  }>) {
    if (!r.matched_order_id) continue;
    const rem = Array.isArray(r.cod_remittances) ? r.cod_remittances[0] : r.cod_remittances;
    const rowRev = Number(r.sheet_revision) || 1;
    const remRev = Number(rem?.sheet_revision) || 1;
    // Solo aprobaciones de la revisión operativa (históricas no advierten)
    if (rowRev !== remRev) continue;
    if (rem?.status === "voided") continue;
    approvedPendingWarnings.set(
      r.matched_order_id,
      `También aprobado en otra rendición aún no confirmada (${r.remittance_id}).`
    );
  }

  return { localSourceIds, confirmedIds, approvedPendingWarnings };
}

function mapOrderToCandidate(
  row: RawOrder,
  transportNames: Map<string, string>,
  startDate: string
): CodCandidateOrder | null {
  const customer = unwrapCustomer(row);
  const effective = resolveEffectiveSent(row.sent_at, row.closed_at);
  if (!effective) return null;
  if (effective.effectiveSentDate < startDate) return null;

  const effectiveTransportId = row.transport_id || customer?.transport_id || null;
  const titular = customer?.full_name?.trim() || null;
  const label = row.label_customer_name?.trim() || null;
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerId: customer?.id ?? null,
    customerDisplayName: titular,
    customerNumber:
      customer?.customer_number != null && String(customer.customer_number).trim()
        ? String(customer.customer_number).trim()
        : null,
    labelCustomerName: label,
    expectedAmount: toNumber(row.total_amount),
    effectiveSentDate: effective.effectiveSentDate,
    sentDateOrigin: effective.sentDateOrigin as SentDateOrigin,
    effectiveTransportId,
    transportName: effectiveTransportId
      ? transportNames.get(effectiveTransportId) ?? null
      : null,
    identities: buildIdentities({
      labelCustomerName: row.label_customer_name,
      titularFullName: customer?.full_name ?? null,
      additionalNames: customer?.additional_names ?? null,
    }),
  };
}

async function loadTransportNames(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("transports").select("id, name");
  if (error) throw new Error(error.message);
  const map = new Map<string, string>();
  for (const t of data ?? []) map.set(t.id, t.name);
  return map;
}

async function loadCodOrdersRaw(supabase: SupabaseClient): Promise<RawOrder[]> {
  return fetchAllPages<RawOrder>(async (from, to) => {
    const r = await supabase
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
          customer_number,
          transport_id,
          additional_names
        )
      `
      )
      .eq("status", "sent")
      .eq("payment_method", COD_PAYMENT_METHOD)
      .range(from, to);
    return { data: r.data as RawOrder[] | null, error: r.error };
  });
}

/**
 * Carga universo COD y construye pool A (mismo transporte) y pool completo (para B).
 * V1: 1 fetch de órdenes + exclusiones financieras confirmadas / local_orders.
 * approved_pending_confirmation NO se excluye (solo warning).
 * Etapa A/B = filtros en memoria sobre ese universo.
 * Aliases: 1 fetch adicional por transporte de la rendición (sin N+1).
 */
export async function loadMatchingPools(
  supabase: SupabaseClient,
  remittanceTransportId: string
): Promise<{
  poolA: CodCandidateOrder[];
  poolAll: CodCandidateOrder[];
  approvedWarnings: Map<string, string>;
  aliasesByNormalized: Map<string, TransportAliasHit>;
  timings: { fetchMs: number; mapMs: number; orderCount: number; aliasCount: number };
}> {
  const t0 = Date.now();
  const [rawOrders, excluded, transportNames, aliasRows] = await Promise.all([
    loadCodOrdersRaw(supabase),
    loadExcludedOrderIds(supabase),
    loadTransportNames(supabase),
    loadActiveTransportAliases(supabase, remittanceTransportId),
  ]);
  const fetchMs = Date.now() - t0;

  const t1 = Date.now();
  const poolAll: CodCandidateOrder[] = [];
  for (const row of rawOrders) {
    if (excluded.localSourceIds.has(row.id)) continue;
    if (excluded.confirmedIds.has(row.id)) continue;
    const cand = mapOrderToCandidate(row, transportNames, RECONCILIATION_START_DATE);
    if (cand) poolAll.push(cand);
  }
  const poolA = poolAll.filter((c) => c.effectiveTransportId === remittanceTransportId);
  const aliasesByNormalized = buildAliasMap(aliasRows);
  const mapMs = Date.now() - t1;

  return {
    poolA,
    poolAll,
    approvedWarnings: excluded.approvedPendingWarnings,
    aliasesByNormalized,
    timings: {
      fetchMs,
      mapMs,
      orderCount: poolAll.length,
      aliasCount: aliasesByNormalized.size,
    },
  };
}

type AliasRow = {
  id: string;
  customer_id: string;
  raw_alias: string;
  normalized_alias: string;
  is_active: boolean;
};

async function loadActiveTransportAliases(
  supabase: SupabaseClient,
  transportId: string
): Promise<AliasRow[]> {
  try {
    return await fetchAllPages<AliasRow>(async (from, to) => {
      const r = await supabase
        .from("cod_transport_customer_aliases")
        .select("id, customer_id, raw_alias, normalized_alias, is_active")
        .eq("transport_id", transportId)
        .eq("is_active", true)
        .range(from, to);
      return { data: r.data as AliasRow[] | null, error: r.error };
    });
  } catch {
    // Tabla aún no aplicada en el entorno: matching sigue sin Vía C.
    return [];
  }
}

export function buildAliasMap(rows: AliasRow[]): Map<string, TransportAliasHit> {
  const map = new Map<string, TransportAliasHit>();
  for (const r of rows) {
    if (!r.is_active) continue;
    const key = r.normalized_alias || normalizeCodAliasName(r.raw_alias);
    if (!key) continue;
    map.set(key, {
      aliasId: r.id,
      customerId: r.customer_id,
      rawAlias: r.raw_alias,
      normalizedAlias: key,
    });
  }
  return map;
}
