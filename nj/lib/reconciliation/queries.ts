import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COD_PAYMENT_METHOD,
  PENDING_PAGE_SIZE,
  RECONCILIATION_START_DATE,
} from "@/lib/reconciliation/constants";
import type {
  MonthOption,
  PendingCodRow,
  ReconciliationDashboardData,
  ReconciliationFiltersState,
  ReconciliationKpis,
  SentDateOrigin,
  TransportOption,
} from "@/lib/reconciliation/types";
import { countUnassignedConfirmedPayments } from "@/lib/reconciliation/unassigned-queries";

type OrderRow = {
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
        transport_id: string | null;
      }
    | {
        id: string;
        full_name: string | null;
        transport_id: string | null;
      }[]
    | null;
};

type ConfirmedRowMeta = {
  orderId: string;
  rowStatus: "confirmed_matched" | "confirmed_with_irregularity";
  irregularityStatus: "open" | "in_review" | "resolved" | "superseded" | null;
};

function unwrapCustomer(row: OrderRow) {
  const c = row.customers;
  if (!c) return null;
  return Array.isArray(c) ? c[0] ?? null : c;
}

function toNumber(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toDateOnlyIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    // Fallback: already a date-only string
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : value.slice(0, 10);
  }
  // Calendario operativo FYL = Argentina (alineado con comparaciones DATE en Postgres).
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function resolveEffectiveSent(
  sentAt: string | null,
  closedAt: string | null
): { effectiveSentDate: string; sentDateOrigin: SentDateOrigin } | null {
  if (sentAt) {
    const d = toDateOnlyIso(sentAt);
    if (!d) return null;
    return { effectiveSentDate: d, sentDateOrigin: "sent_at" };
  }
  if (closedAt) {
    const d = toDateOnlyIso(closedAt);
    if (!d) return null;
    return { effectiveSentDate: d, sentDateOrigin: "closed_at_fallback" };
  }
  return null;
}

function ageDaysFrom(isoDate: string, todayIso: string): number {
  const a = Date.parse(`${isoDate}T12:00:00Z`);
  const b = Date.parse(`${todayIso}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const names = [
    "Enero",
    "Febrero",
    "Marzo",
    "Abril",
    "Mayo",
    "Junio",
    "Julio",
    "Agosto",
    "Septiembre",
    "Octubre",
    "Noviembre",
    "Diciembre",
  ];
  const name = names[(m ?? 1) - 1] ?? ym;
  return `${name} ${y}`;
}

function emptyKpis(): ReconciliationKpis {
  return {
    universeCount: 0,
    universeAmount: 0,
    pendingCount: 0,
    pendingAmount: 0,
    approvedWaitingCount: 0,
    approvedWaitingAmount: 0,
    reconciledTotalCount: 0,
    reconciledTotalAmount: 0,
    reconciledExactCount: 0,
    reconciledExactAmount: 0,
    reconciledOpenIrregularityCount: 0,
    reconciledOpenIrregularityAmount: 0,
    reconciledResolvedIrregularityCount: 0,
    reconciledResolvedIrregularityAmount: 0,
    openIrregularitiesCount: 0,
    openDiffNegative: 0,
    openDiffPositive: 0,
    unassignedPaymentsCount: 0,
    unassignedPaymentsAmount: 0,
  };
}

async function fetchAllPages<T>(
  fetchPage: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const pageSize = 1000;
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function loadLocalOrderSourceIds(supabase: SupabaseClient): Promise<Set<string>> {
  const rows = await fetchAllPages<{ source_order_id: string }>(async (from, to) => {
    const r = await supabase
      .from("local_orders")
      .select("source_order_id")
      .not("source_order_id", "is", null)
      .order("source_order_id", { ascending: true })
      .range(from, to);
    return { data: r.data, error: r.error };
  });
  return new Set(rows.map((r) => r.source_order_id).filter(Boolean));
}

async function loadConfirmedMeta(
  supabase: SupabaseClient
): Promise<Map<string, ConfirmedRowMeta>> {
  const rows = await fetchAllPages<{
    matched_order_id: string;
    row_status: string;
    id: string;
  }>(async (from, to) => {
    const r = await supabase
      .from("cod_remittance_rows")
      .select("id, matched_order_id, row_status, assignment_role")
      .in("row_status", ["confirmed_matched", "confirmed_with_irregularity"])
      .not("matched_order_id", "is", null)
      .order("id", { ascending: true })
      .range(from, to);
    if (r.error && /assignment_role/i.test(r.error.message)) {
      const fallback = await supabase
        .from("cod_remittance_rows")
        .select("id, matched_order_id, row_status")
        .in("row_status", ["confirmed_matched", "confirmed_with_irregularity"])
        .not("matched_order_id", "is", null)
        .order("id", { ascending: true })
        .range(from, to);
      return { data: fallback.data, error: fallback.error };
    }
    return { data: r.data, error: r.error };
  });

  const irregByRow = new Map<string, string>();
  if (rows.length > 0) {
    const rowIds = rows.map((r) => r.id);
    // Chunk in case of many rows later
    for (let i = 0; i < rowIds.length; i += 200) {
      const chunk = rowIds.slice(i, i + 200);
      const { data, error } = await supabase
        .from("cod_irregularities")
        .select("remittance_row_id, status")
        .in("remittance_row_id", chunk)
        .in("status", ["open", "in_review", "resolved"]);
      if (error) throw new Error(error.message);
      for (const ir of data ?? []) {
        // Prefer open/in_review over resolved if multiple (shouldn't happen often)
        const prev = irregByRow.get(ir.remittance_row_id);
        if (!prev || ir.status === "open" || ir.status === "in_review") {
          irregByRow.set(ir.remittance_row_id, ir.status);
        }
      }
    }
  }

  const map = new Map<string, ConfirmedRowMeta>();
  for (const r of rows) {
    const existing = map.get(r.matched_order_id);
    const role = String(
      (r as { assignment_role?: string | null }).assignment_role || "primary"
    );
    // Post-292: si hay primary + supplementary, el KPI del pedido usa la primary.
    if (existing && role === "supplementary") continue;
    if (existing && role === "primary") {
      // primary pisa cualquier entrada previa
    }
    map.set(r.matched_order_id, {
      orderId: r.matched_order_id,
      rowStatus: r.row_status as ConfirmedRowMeta["rowStatus"],
      irregularityStatus: (irregByRow.get(r.id) as ConfirmedRowMeta["irregularityStatus"]) ?? null,
    });
  }
  return map;
}

async function loadApprovedWaitingOrderIds(supabase: SupabaseClient): Promise<Set<string>> {
  const rows = await fetchAllPages<{ matched_order_id: string }>(async (from, to) => {
    const r = await supabase
      .from("cod_remittance_rows")
      .select("matched_order_id")
      .eq("row_status", "approved_pending_confirmation")
      .not("matched_order_id", "is", null)
      .order("id", { ascending: true })
      .range(from, to);
    return { data: r.data, error: r.error };
  });
  return new Set(rows.map((r) => r.matched_order_id));
}

async function loadOpenIrregularityDiffs(supabase: SupabaseClient): Promise<{
  count: number;
  negative: number;
  positive: number;
}> {
  const rows = await fetchAllPages<{ amount_diff: number | string }>(async (from, to) => {
    const r = await supabase
      .from("cod_irregularities")
      .select("amount_diff")
      .in("status", ["open", "in_review"])
      .order("id", { ascending: true })
      .range(from, to);
    return { data: r.data, error: r.error };
  });
  let negative = 0;
  let positive = 0;
  for (const r of rows) {
    const d = toNumber(r.amount_diff);
    if (d < 0) negative += d;
    else if (d > 0) positive += d;
  }
  return { count: rows.length, negative, positive };
}

async function loadUnassignedPayments(supabase: SupabaseClient): Promise<{
  count: number;
  amount: number;
}> {
  // Solo unassigned de rendiciones confirmed (excluye draft/analyzed/voided).
  return countUnassignedConfirmedPayments(supabase);
}

async function loadTransports(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("transports").select("id, name").order("name");
  if (error) throw new Error(error.message);
  const map = new Map<string, string>();
  for (const t of data ?? []) map.set(t.id, t.name);
  return map;
}

async function loadCodSentOrders(supabase: SupabaseClient): Promise<OrderRow[]> {
  return fetchAllPages<OrderRow>(async (from, to) => {
    // ORDER BY id obligatorio: sin orden estable, .range() puede devolver
    // el mismo pedido en dos páginas → React "two children with the same key".
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
          transport_id
        )
      `
      )
      .eq("status", "sent")
      .eq("payment_method", COD_PAYMENT_METHOD)
      .order("id", { ascending: true })
      .range(from, to);
    return { data: r.data as OrderRow[] | null, error: r.error };
  });
}

export function parseFilters(input: {
  month?: string;
  transport?: string;
  q?: string;
  page?: string;
  bucket?: string;
}): ReconciliationFiltersState {
  const month = input.month && /^\d{4}-\d{2}$/.test(input.month) ? input.month : "all";
  const transportId = input.transport && input.transport !== "all" ? input.transport : "all";
  const q = (input.q ?? "").trim();
  const pageRaw = Number(input.page ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const bucketRaw = (input.bucket ?? "all").toLowerCase();
  const bucket =
    bucketRaw === "pending" || bucketRaw === "waiting" || bucketRaw === "reconciled"
      ? bucketRaw
      : "all";
  return { month, transportId, q, page, bucket };
}

/**
 * KPIs de Fase 2: agregación TypeScript sobre fetches paginados.
 * Aceptable con ~3k pedidos. Si el volumen crece mucho, mover agregaciones a SQL/RPC
 * (sin vistas todavía; ver aclaración post-Fase 2 en constants.ts).
 */
export async function loadReconciliationDashboard(
  supabase: SupabaseClient,
  rawFilters: {
    month?: string;
    transport?: string;
    q?: string;
    page?: string;
    bucket?: string;
  }
): Promise<ReconciliationDashboardData> {
  const filters = parseFilters(rawFilters);
  const startDate = RECONCILIATION_START_DATE;
  const todayIso = new Date().toISOString().slice(0, 10);

  const [
    localOrderIds,
    confirmedMeta,
    approvedWaitingIds,
    openIrregs,
    unassigned,
    transportNames,
    orders,
  ] = await Promise.all([
    loadLocalOrderSourceIds(supabase),
    loadConfirmedMeta(supabase),
    loadApprovedWaitingOrderIds(supabase),
    loadOpenIrregularityDiffs(supabase),
    loadUnassignedPayments(supabase),
    loadTransports(supabase),
    loadCodSentOrders(supabase),
  ]);

  type UniverseItem = {
    id: string;
    orderNumber: string | null;
    amount: number;
    effectiveSentDate: string;
    sentDateOrigin: SentDateOrigin;
    transportId: string | null;
    transportName: string | null;
    labelName: string | null;
    titularName: string | null;
    displayName: string;
    isApprovedWaiting: boolean;
    confirmed: ConfirmedRowMeta | null;
  };

  const universeById = new Map<string, UniverseItem>();
  const monthSet = new Set<string>();
  const transportCounts = new Map<string, { id: string; name: string; count: number }>();

  for (const o of orders) {
    if (localOrderIds.has(o.id)) continue;
    if (universeById.has(o.id)) continue; // defensa ante duplicados de paginación
    const resolved = resolveEffectiveSent(o.sent_at, o.closed_at);
    if (!resolved) continue;
    if (resolved.effectiveSentDate < startDate) continue;

    const customer = unwrapCustomer(o);
    const effectiveTransportId = o.transport_id ?? customer?.transport_id ?? null;
    const transportName = effectiveTransportId
      ? transportNames.get(effectiveTransportId) ?? null
      : null;

    const labelName = o.label_customer_name?.trim() || null;
    const titularName = customer?.full_name?.trim() || null;
    const displayName =
      labelName && titularName && labelName.toLowerCase() !== titularName.toLowerCase()
        ? `${labelName} (${titularName})`
        : labelName || titularName || "Sin nombre";

    const confirmed = confirmedMeta.get(o.id) ?? null;
    const isApprovedWaiting = !confirmed && approvedWaitingIds.has(o.id);

    universeById.set(o.id, {
      id: o.id,
      orderNumber: o.order_number,
      amount: toNumber(o.total_amount),
      effectiveSentDate: resolved.effectiveSentDate,
      sentDateOrigin: resolved.sentDateOrigin,
      transportId: effectiveTransportId,
      transportName,
      labelName,
      titularName,
      displayName,
      isApprovedWaiting,
      confirmed,
    });

    monthSet.add(monthKey(resolved.effectiveSentDate));
    if (effectiveTransportId) {
      const prev = transportCounts.get(effectiveTransportId);
      if (prev) prev.count += 1;
      else {
        transportCounts.set(effectiveTransportId, {
          id: effectiveTransportId,
          name: transportName ?? "Sin nombre",
          count: 1,
        });
      }
    }
  }

  const universe = [...universeById.values()];

  const filteredUniverse = universe.filter((u) => {
    if (filters.month !== "all" && monthKey(u.effectiveSentDate) !== filters.month) {
      return false;
    }
    if (filters.transportId !== "all" && u.transportId !== filters.transportId) {
      return false;
    }
    return true;
  });

  const kpis = emptyKpis();
  kpis.openIrregularitiesCount = openIrregs.count;
  kpis.openDiffNegative = openIrregs.negative;
  kpis.openDiffPositive = openIrregs.positive;
  kpis.unassignedPaymentsCount = unassigned.count;
  kpis.unassignedPaymentsAmount = unassigned.amount;

  const pendingPool: UniverseItem[] = [];

  for (const u of filteredUniverse) {
    kpis.universeCount += 1;
    kpis.universeAmount += u.amount;

    if (u.confirmed) {
      kpis.reconciledTotalCount += 1;
      kpis.reconciledTotalAmount += u.amount;
      if (u.confirmed.rowStatus === "confirmed_matched") {
        kpis.reconciledExactCount += 1;
        kpis.reconciledExactAmount += u.amount;
      } else {
        const st = u.confirmed.irregularityStatus;
        if (st === "open" || st === "in_review") {
          kpis.reconciledOpenIrregularityCount += 1;
          kpis.reconciledOpenIrregularityAmount += u.amount;
        } else {
          // resolved, superseded without open claim, or missing irreg row → treat as resolved/exact-ish
          // Plan: "Con irregularidad resuelta" = confirmed_with_irregularity + resolved
          // If superseded only, financial state follows current association — still in reconciled total
          kpis.reconciledResolvedIrregularityCount += 1;
          kpis.reconciledResolvedIrregularityAmount += u.amount;
        }
      }
    } else {
      kpis.pendingCount += 1;
      kpis.pendingAmount += u.amount;
      if (u.isApprovedWaiting) {
        kpis.approvedWaitingCount += 1;
        kpis.approvedWaitingAmount += u.amount;
      }
      pendingPool.push(u);
    }
  }

  const qNorm = filters.q.toLowerCase();
  let pendingFiltered = pendingPool;
  if (qNorm) {
    pendingFiltered = pendingPool.filter((u) => {
      const num = (u.orderNumber ?? "").toLowerCase();
      const name = u.displayName.toLowerCase();
      const titular = (u.titularName ?? "").toLowerCase();
      const label = (u.labelName ?? "").toLowerCase();
      return (
        num.includes(qNorm) ||
        name.includes(qNorm) ||
        titular.includes(qNorm) ||
        label.includes(qNorm)
      );
    });
  }

  // Filtro de listado solamente (KPIs ya calculados arriba, sin cambiar definición).
  if (filters.bucket === "waiting") {
    pendingFiltered = pendingFiltered.filter((u) => u.isApprovedWaiting);
  } else if (filters.bucket === "pending") {
    pendingFiltered = pendingFiltered.filter((u) => !u.isApprovedWaiting);
  } else if (filters.bucket === "reconciled") {
    pendingFiltered = [];
  }

  pendingFiltered.sort((a, b) => {
    if (a.effectiveSentDate !== b.effectiveSentDate) {
      return a.effectiveSentDate < b.effectiveSentDate ? -1 : 1;
    }
    return (a.orderNumber ?? a.id).localeCompare(b.orderNumber ?? b.id);
  });

  const pendingTotal = pendingFiltered.length;
  const pageSize = PENDING_PAGE_SIZE;
  const maxPage = Math.max(1, Math.ceil(pendingTotal / pageSize) || 1);
  const page = Math.min(filters.page, maxPage);
  const start = (page - 1) * pageSize;
  const pageRows = pendingFiltered.slice(start, start + pageSize);

  const pendingRows: PendingCodRow[] = pageRows.map((u) => ({
    id: u.id,
    orderNumber: u.orderNumber,
    displayName: u.displayName,
    titularName: u.titularName,
    labelName: u.labelName,
    effectiveSentDate: u.effectiveSentDate,
    sentDateOrigin: u.sentDateOrigin,
    isEstimatedDate: u.sentDateOrigin === "closed_at_fallback",
    transportId: u.transportId,
    transportName: u.transportName,
    amount: u.amount,
    ageDays: ageDaysFrom(u.effectiveSentDate, todayIso),
    isApprovedWaiting: u.isApprovedWaiting,
  }));

  const months: MonthOption[] = [
    { value: "all", label: "Todos" },
    ...[...monthSet]
      .sort()
      .map((ym) => ({ value: ym, label: monthLabel(ym) })),
  ];

  const transports: TransportOption[] = [
    ...[...transportCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  ].map((t) => ({ id: t.id, name: t.name }));

  return {
    kpis,
    pendingRows,
    pendingTotal,
    pendingPage: page,
    pendingPageSize: pageSize,
    transports,
    months,
    filters: { ...filters, page },
  };
}
