import type { SupabaseClient } from "@supabase/supabase-js";

export type IrregularityStatus = "open" | "in_review" | "resolved" | "superseded";

export type IrregularityListItem = {
  id: string;
  status: IrregularityStatus;
  orderId: string;
  remittanceId: string;
  transportId: string;
  transportName: string | null;
  orderNumber: string | null;
  customerName: string | null;
  customerNumber: string | null;
  orderSentDate: string | null;
  remittanceDate: string | null;
  expectedAmount: number;
  reportedAmount: number;
  amountDiff: number;
  amountDiffPct: number | null;
  createdAt: string;
  ageDays: number;
  resolvedAt: string | null;
};

export type IrregularityEventItem = {
  id: string;
  eventType: string;
  occurredAt: string;
  reason: string | null;
  previousStatus: string | null;
  newStatus: string | null;
};

export type IrregularityDetail = IrregularityListItem & {
  remittanceRowId: string;
  observation: string | null;
  resolutionNote: string | null;
  createdBy: string | null;
  resolvedBy: string | null;
  supersededReason: string | null;
  supersededAt: string | null;
  updatedAt: string;
  events: IrregularityEventItem[];
};

export type IrregularityKpis = {
  openCount: number;
  inReviewCount: number;
  negativeSum: number;
  positiveSum: number;
  netSum: number;
};

export type IrregularityFilters = {
  status: "open" | "in_review" | "resolved" | "all";
  transportId: string;
  fromDate: string;
  toDate: string;
};

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ageDaysFrom(iso: string, todayIso: string): number {
  const a = Date.parse(`${iso.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${todayIso}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function unwrapName(rel: unknown): string | null {
  if (!rel) return null;
  if (Array.isArray(rel)) {
    const first = rel[0] as { name?: string; full_name?: string } | undefined;
    return first?.name ?? first?.full_name ?? null;
  }
  const o = rel as { name?: string; full_name?: string };
  return o.name ?? o.full_name ?? null;
}

function unwrapOrderNumber(rel: unknown): string | null {
  if (!rel) return null;
  if (Array.isArray(rel)) {
    const first = rel[0] as { order_number?: string | null } | undefined;
    return first?.order_number ?? null;
  }
  return (rel as { order_number?: string | null }).order_number ?? null;
}

function unwrapCustomerFromOrder(rel: unknown): {
  name: string | null;
  number: string | null;
} {
  if (!rel) return { name: null, number: null };
  const order = Array.isArray(rel) ? rel[0] : rel;
  if (!order || typeof order !== "object") return { name: null, number: null };
  const customers = (order as { customers?: unknown }).customers;
  const c = Array.isArray(customers) ? customers[0] : customers;
  if (!c || typeof c !== "object") return { name: null, number: null };
  const o = c as { full_name?: string; customer_number?: string | number | null };
  return {
    name: o.full_name?.trim() || null,
    number: o.customer_number != null ? String(o.customer_number) : null,
  };
}

export function parseIrregularityFilters(input: {
  status?: string;
  transport?: string;
  from?: string;
  to?: string;
}): IrregularityFilters {
  const statusRaw = (input.status ?? "open").toLowerCase();
  const status =
    statusRaw === "in_review" || statusRaw === "resolved" || statusRaw === "all"
      ? statusRaw
      : "open";
  const transportId =
    input.transport && input.transport !== "all" ? input.transport : "all";
  const fromDate =
    input.from && /^\d{4}-\d{2}-\d{2}$/.test(input.from) ? input.from : "";
  const toDate = input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to) ? input.to : "";
  return { status, transportId, fromDate, toDate };
}

export async function loadIrregularityKpis(
  supabase: SupabaseClient
): Promise<IrregularityKpis> {
  const { data, error } = await supabase
    .from("cod_irregularities")
    .select("status, amount_diff")
    .in("status", ["open", "in_review"])
    .limit(5000);

  if (error) throw new Error(error.message);

  let openCount = 0;
  let inReviewCount = 0;
  let negativeSum = 0;
  let positiveSum = 0;

  for (const r of data ?? []) {
    const st = r.status as string;
    const d = toNumber(r.amount_diff);
    if (st === "open") openCount += 1;
    else if (st === "in_review") inReviewCount += 1;
    if (d < 0) negativeSum += d;
    else if (d > 0) positiveSum += d;
  }

  return {
    openCount,
    inReviewCount,
    negativeSum,
    positiveSum,
    netSum: Math.round((negativeSum + positiveSum) * 100) / 100,
  };
}

export async function listIrregularities(
  supabase: SupabaseClient,
  rawFilters: {
    status?: string;
    transport?: string;
    from?: string;
    to?: string;
  }
): Promise<{ items: IrregularityListItem[]; filters: IrregularityFilters; transports: { id: string; name: string }[] }> {
  const filters = parseIrregularityFilters(rawFilters);
  const todayIso = new Date().toISOString().slice(0, 10);

  let q = supabase
    .from("cod_irregularities")
    .select(
      `
      id,
      status,
      order_id,
      remittance_id,
      transport_id,
      order_sent_date_snapshot,
      remittance_date_snapshot,
      expected_amount,
      reported_amount,
      amount_diff,
      amount_diff_pct,
      created_at,
      resolved_at,
      transports ( name ),
      orders ( order_number, customers ( full_name, customer_number ) )
    `
    )
    .order("created_at", { ascending: true })
    .limit(500);

  if (filters.status === "open") q = q.eq("status", "open");
  else if (filters.status === "in_review") q = q.eq("status", "in_review");
  else if (filters.status === "resolved") q = q.eq("status", "resolved");
  // "all" = open + in_review + resolved + superseded (sin filtro)

  if (filters.transportId !== "all") q = q.eq("transport_id", filters.transportId);
  if (filters.fromDate) q = q.gte("created_at", `${filters.fromDate}T00:00:00`);
  if (filters.toDate) q = q.lte("created_at", `${filters.toDate}T23:59:59.999`);

  const [{ data, error }, transportsRes] = await Promise.all([
    q,
    supabase.from("transports").select("id, name").order("name"),
  ]);

  if (error) throw new Error(error.message);
  if (transportsRes.error) throw new Error(transportsRes.error.message);

  const items: IrregularityListItem[] = (data ?? []).map((r) => {
    const createdAt = r.created_at as string;
    const customer = unwrapCustomerFromOrder(r.orders);
    return {
      id: r.id as string,
      status: r.status as IrregularityStatus,
      orderId: r.order_id as string,
      remittanceId: r.remittance_id as string,
      transportId: r.transport_id as string,
      transportName: unwrapName(r.transports),
      orderNumber: unwrapOrderNumber(r.orders),
      customerName: customer.name,
      customerNumber: customer.number,
      orderSentDate: (r.order_sent_date_snapshot as string | null) ?? null,
      remittanceDate: (r.remittance_date_snapshot as string | null) ?? null,
      expectedAmount: toNumber(r.expected_amount),
      reportedAmount: toNumber(r.reported_amount),
      amountDiff: toNumber(r.amount_diff),
      amountDiffPct:
        r.amount_diff_pct == null ? null : toNumber(r.amount_diff_pct),
      createdAt,
      ageDays: ageDaysFrom(createdAt.slice(0, 10), todayIso),
      resolvedAt: (r.resolved_at as string | null) ?? null,
    };
  });

  return {
    items,
    filters,
    transports: (transportsRes.data ?? []).map((t) => ({
      id: t.id as string,
      name: t.name as string,
    })),
  };
}

export async function loadIrregularityDetail(
  supabase: SupabaseClient,
  id: string
): Promise<IrregularityDetail | null> {
  const todayIso = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("cod_irregularities")
    .select(
      `
      id,
      status,
      order_id,
      remittance_id,
      remittance_row_id,
      transport_id,
      order_sent_date_snapshot,
      remittance_date_snapshot,
      expected_amount,
      reported_amount,
      amount_diff,
      amount_diff_pct,
      observation,
      resolution_note,
      created_by,
      created_at,
      resolved_by,
      resolved_at,
      superseded_reason,
      superseded_at,
      updated_at,
      transports ( name ),
      orders ( order_number, customers ( full_name, customer_number ) )
    `
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const { data: events, error: evErr } = await supabase
    .from("cod_reconciliation_events")
    .select("id, event_type, occurred_at, reason, previous_state, new_state")
    .eq("irregularity_id", id)
    .order("occurred_at", { ascending: true })
    .limit(100);

  if (evErr) throw new Error(evErr.message);

  const createdAt = data.created_at as string;
  const customer = unwrapCustomerFromOrder(data.orders);

  return {
    id: data.id as string,
    status: data.status as IrregularityStatus,
    orderId: data.order_id as string,
    remittanceId: data.remittance_id as string,
    remittanceRowId: data.remittance_row_id as string,
    transportId: data.transport_id as string,
    transportName: unwrapName(data.transports),
    orderNumber: unwrapOrderNumber(data.orders),
    customerName: customer.name,
    customerNumber: customer.number,
    orderSentDate: (data.order_sent_date_snapshot as string | null) ?? null,
    remittanceDate: (data.remittance_date_snapshot as string | null) ?? null,
    expectedAmount: toNumber(data.expected_amount),
    reportedAmount: toNumber(data.reported_amount),
    amountDiff: toNumber(data.amount_diff),
    amountDiffPct:
      data.amount_diff_pct == null ? null : toNumber(data.amount_diff_pct),
    createdAt,
    ageDays: ageDaysFrom(createdAt.slice(0, 10), todayIso),
    resolvedAt: (data.resolved_at as string | null) ?? null,
    observation: (data.observation as string | null) ?? null,
    resolutionNote: (data.resolution_note as string | null) ?? null,
    createdBy: (data.created_by as string | null) ?? null,
    resolvedBy: (data.resolved_by as string | null) ?? null,
    supersededReason: (data.superseded_reason as string | null) ?? null,
    supersededAt: (data.superseded_at as string | null) ?? null,
    updatedAt: data.updated_at as string,
    events: (events ?? []).map((e) => {
      const prev = e.previous_state as { status?: string } | null;
      const next = e.new_state as { status?: string } | null;
      return {
        id: e.id as string,
        eventType: e.event_type as string,
        occurredAt: e.occurred_at as string,
        reason: (e.reason as string | null) ?? null,
        previousStatus: prev?.status ?? null,
        newStatus: next?.status ?? null,
      };
    }),
  };
}
