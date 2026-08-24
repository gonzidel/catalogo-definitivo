import type { SupabaseClient } from "@supabase/supabase-js";

export type TransportDifferenceBalance = {
  transportId: string;
  transportName: string;
  claimOpen: number;
  creditOpen: number;
  netBalance: number;
};

export type DifferenceClaimItem = {
  id: string;
  transportId: string;
  orderId: string | null;
  amountDiff: number;
  remainingAmount: number;
  originalAmount: number;
  status: string;
  createdAt: string;
  remittanceId: string;
  side: "claim";
  /** Tracking */
  customerName: string | null;
  orderNumber: string | null;
  remittanceDate: string | null;
  orderSentDate: string | null;
  remittanceStatus: string | null;
};

export type DifferenceCreditItem = {
  id: string;
  transportId: string;
  kind: string;
  originalAmount: number;
  remainingAmount: number;
  status: string;
  createdAt: string;
  remittanceId: string;
  orderId: string | null;
  sourceType: "adjustment" | "irregularity";
  side: "credit";
  /** Tracking */
  customerName: string | null;
  orderNumber: string | null;
  remittanceDate: string | null;
  paymentDate: string | null;
  remittanceRowId: string | null;
  remittanceStatus: string | null;
  observation: string | null;
  rowIndex: number | null;
};

export type TransportDifferencesBundle = {
  balances: TransportDifferenceBalance[];
  claims: DifferenceClaimItem[];
  credits: DifferenceCreditItem[];
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function oneRelation<T>(v: unknown): T | null {
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] as T) ?? null;
  return v as T;
}

export async function loadTransportDifferences(
  supabase: SupabaseClient,
  transportId?: string | null
): Promise<TransportDifferencesBundle> {
  const { data, error } = await supabase.rpc("rpc_cod_list_transport_differences", {
    p_transport_id: transportId || null,
  });

  if (error) {
    console.error("loadTransportDifferences", error);
    return { balances: [], claims: [], credits: [] };
  }

  const payload = (data ?? {}) as {
    balances?: Array<Record<string, unknown>>;
    claims?: Array<Record<string, unknown>>;
    credits?: Array<Record<string, unknown>>;
  };

  const claimsBase: DifferenceClaimItem[] = (payload.claims ?? []).map((c) => ({
    id: String(c.id ?? ""),
    transportId: String(c.transport_id ?? ""),
    orderId: c.order_id ? String(c.order_id) : null,
    amountDiff: num(c.amount_diff),
    remainingAmount: num(c.remaining_amount),
    originalAmount: num(c.original_amount),
    status: String(c.status ?? ""),
    createdAt: String(c.created_at ?? ""),
    remittanceId: String(c.remittance_id ?? ""),
    side: "claim" as const,
    customerName: null,
    orderNumber: null,
    remittanceDate: null,
    orderSentDate: null,
    remittanceStatus: null,
  }));

  const creditsBase: DifferenceCreditItem[] = (payload.credits ?? []).map((c) => ({
    id: String(c.id ?? ""),
    transportId: String(c.transport_id ?? ""),
    kind: String(c.kind ?? ""),
    originalAmount: num(c.original_amount),
    remainingAmount: num(c.remaining_amount),
    status: String(c.status ?? ""),
    createdAt: String(c.created_at ?? ""),
    remittanceId: String(c.remittance_id ?? ""),
    orderId: c.order_id ? String(c.order_id) : null,
    sourceType: c.source_type === "irregularity" ? "irregularity" : "adjustment",
    side: "credit" as const,
    customerName: null,
    orderNumber: null,
    remittanceDate: null,
    paymentDate: null,
    remittanceRowId: null,
    remittanceStatus: null,
    observation: null,
    rowIndex: null,
  }));

  const [claims, credits] = await Promise.all([
    enrichClaims(supabase, claimsBase),
    enrichCredits(supabase, creditsBase),
  ]);

  return {
    balances: (payload.balances ?? []).map((b) => ({
      transportId: String(b.transport_id ?? ""),
      transportName: String(b.transport_name ?? ""),
      claimOpen: num(b.claim_open),
      creditOpen: num(b.credit_open),
      netBalance: num(b.net_balance),
    })),
    claims,
    credits,
  };
}

async function enrichClaims(
  supabase: SupabaseClient,
  claims: DifferenceClaimItem[]
): Promise<DifferenceClaimItem[]> {
  if (!claims.length) return claims;
  const ids = claims.map((c) => c.id);

  const { data, error } = await supabase
    .from("cod_irregularities")
    .select(
      `
      id,
      remittance_id,
      order_sent_date_snapshot,
      remittance_date_snapshot,
      orders ( order_number, customers ( full_name ) ),
      cod_remittances ( remittance_date, status )
    `
    )
    .in("id", ids);

  if (error || !data?.length) {
    if (error) console.error("enrichClaims", error.message);
    return claims;
  }

  const byId = new Map(data.map((r) => [String(r.id), r]));

  return claims.map((c) => {
    const row = byId.get(c.id) as
      | {
          order_sent_date_snapshot?: string | null;
          remittance_date_snapshot?: string | null;
          orders?: unknown;
          cod_remittances?: unknown;
        }
      | undefined;
    if (!row) return c;

    const order = oneRelation<{
      order_number?: string | null;
      customers?: unknown;
    }>(row.orders);
    const customer = oneRelation<{ full_name?: string | null }>(order?.customers);
    const rem = oneRelation<{
      remittance_date?: string | null;
      status?: string | null;
    }>(row.cod_remittances);

    return {
      ...c,
      customerName: customer?.full_name ? String(customer.full_name) : null,
      orderNumber: order?.order_number ? String(order.order_number) : null,
      remittanceDate:
        rem?.remittance_date != null
          ? String(rem.remittance_date).slice(0, 10)
          : row.remittance_date_snapshot
            ? String(row.remittance_date_snapshot).slice(0, 10)
            : null,
      orderSentDate: row.order_sent_date_snapshot
        ? String(row.order_sent_date_snapshot).slice(0, 10)
        : null,
      remittanceStatus: rem?.status ? String(rem.status) : null,
    };
  });
}

async function enrichCredits(
  supabase: SupabaseClient,
  credits: DifferenceCreditItem[]
): Promise<DifferenceCreditItem[]> {
  if (!credits.length) return credits;

  const adjIds = credits.filter((c) => c.sourceType === "adjustment").map((c) => c.id);
  const irregIds = credits
    .filter((c) => c.sourceType === "irregularity")
    .map((c) => c.id);

  const byAdj = new Map<string, Record<string, unknown>>();
  const byIrreg = new Map<string, Record<string, unknown>>();

  if (adjIds.length) {
    const { data, error } = await supabase
      .from("cod_transport_adjustments")
      .select(
        `
        id,
        raw_name_snapshot,
        remittance_date_snapshot,
        reported_amount_snapshot,
        observation,
        remittance_row_id,
        remittance_id,
        order_id,
        orders ( order_number, customers ( full_name ) ),
        cod_remittances ( remittance_date, status ),
        remittance_row:cod_remittance_rows!remittance_row_id (
          raw_customer_name_text,
          parsed_transport_date,
          row_index
        )
      `
      )
      .in("id", adjIds);

    if (error) console.error("enrichCredits adjustments", error.message);
    for (const row of data ?? []) {
      byAdj.set(String(row.id), row as Record<string, unknown>);
    }
  }

  if (irregIds.length) {
    const { data, error } = await supabase
      .from("cod_irregularities")
      .select(
        `
        id,
        remittance_id,
        remittance_date_snapshot,
        order_sent_date_snapshot,
        orders ( order_number, customers ( full_name ) ),
        cod_remittances ( remittance_date, status )
      `
      )
      .in("id", irregIds);

    if (error) console.error("enrichCredits surplus", error.message);
    for (const row of data ?? []) {
      byIrreg.set(String(row.id), row as Record<string, unknown>);
    }
  }

  return credits.map((c) => {
    if (c.sourceType === "adjustment") {
      const row = byAdj.get(c.id);
      if (!row) return c;

      const order = oneRelation<{
        order_number?: string | null;
        customers?: unknown;
      }>(row.orders);
      const customer = oneRelation<{ full_name?: string | null }>(order?.customers);
      const rem = oneRelation<{
        remittance_date?: string | null;
        status?: string | null;
      }>(row.cod_remittances);
      const remRow = oneRelation<{
        raw_customer_name_text?: string | null;
        parsed_transport_date?: string | null;
        row_index?: number | null;
      }>(row.remittance_row);

      const nameFromSnap = row.raw_name_snapshot
        ? String(row.raw_name_snapshot)
        : null;
      const nameFromRow = remRow?.raw_customer_name_text
        ? String(remRow.raw_customer_name_text)
        : null;

      return {
        ...c,
        customerName:
          nameFromSnap || nameFromRow || (customer?.full_name ? String(customer.full_name) : null),
        orderNumber: order?.order_number ? String(order.order_number) : null,
        remittanceDate:
          rem?.remittance_date != null
            ? String(rem.remittance_date).slice(0, 10)
            : row.remittance_date_snapshot
              ? String(row.remittance_date_snapshot).slice(0, 10)
              : null,
        paymentDate: remRow?.parsed_transport_date
          ? String(remRow.parsed_transport_date).slice(0, 10)
          : null,
        remittanceRowId: row.remittance_row_id ? String(row.remittance_row_id) : null,
        remittanceStatus: rem?.status ? String(rem.status) : null,
        observation: row.observation ? String(row.observation) : null,
        rowIndex:
          remRow?.row_index != null && Number.isFinite(Number(remRow.row_index))
            ? Number(remRow.row_index)
            : null,
      };
    }

    const row = byIrreg.get(c.id);
    if (!row) return c;
    const order = oneRelation<{
      order_number?: string | null;
      customers?: unknown;
    }>(row.orders);
    const customer = oneRelation<{ full_name?: string | null }>(order?.customers);
    const rem = oneRelation<{
      remittance_date?: string | null;
      status?: string | null;
    }>(row.cod_remittances);

    return {
      ...c,
      customerName: customer?.full_name ? String(customer.full_name) : null,
      orderNumber: order?.order_number ? String(order.order_number) : null,
      remittanceDate:
        rem?.remittance_date != null
          ? String(rem.remittance_date).slice(0, 10)
          : row.remittance_date_snapshot
            ? String(row.remittance_date_snapshot).slice(0, 10)
            : null,
      paymentDate: row.order_sent_date_snapshot
        ? String(row.order_sent_date_snapshot).slice(0, 10)
        : null,
      remittanceStatus: rem?.status ? String(rem.status) : null,
    };
  });
}

export async function loadActiveAdjustmentForRow(
  supabase: SupabaseClient,
  remittanceRowId: string
): Promise<{
  id: string;
  kind: string;
  originalAmount: number;
  remainingAmount: number;
  status: string;
  observation: string | null;
} | null> {
  const { data, error } = await supabase
    .from("cod_transport_adjustments")
    .select("id, kind, original_amount, remaining_amount, status, observation")
    .eq("remittance_row_id", remittanceRowId)
    .neq("status", "voided")
    .maybeSingle();

  if (error || !data) return null;
  return {
    id: String(data.id),
    kind: String(data.kind),
    originalAmount: num(data.original_amount),
    remainingAmount: num(data.remaining_amount),
    status: String(data.status),
    observation: data.observation ? String(data.observation) : null,
  };
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "paid_other_method":
      return "Pedido pagado por otro medio";
    case "non_applicable_payment":
      return "Pago que no corresponde";
    case "order_not_found":
      return "Cliente/pedido no encontrado";
    case "foreign_client":
      return "Cliente ajeno a FyL";
    case "transport_error":
      return "Error informado por transporte";
    case "cod_surplus":
      return "Sobrante COD";
    case "other":
      return "Otro";
    default:
      return kind;
  }
}

export function formatDiffDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y}`;
}
