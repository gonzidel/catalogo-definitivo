/**
 * Búsqueda manual de pedidos COD para asignación (Fase 5).
 * Universo: sent + Contra Reembolso + desde 2026-05-01 + no local + no confirmed_*.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COD_PAYMENT_METHOD,
  RECONCILIATION_START_DATE,
} from "@/lib/reconciliation/constants";
import { resolveEffectiveSent } from "@/lib/reconciliation/queries";
import { normalizeMatchName, tokenizeMatchName } from "@/lib/reconciliation/name-normalize";

export type ManualOrderHit = {
  id: string;
  orderNumber: string | null;
  expectedAmount: number;
  effectiveSentDate: string;
  sentDateOrigin: "sent_at" | "closed_at_fallback";
  effectiveTransportId: string | null;
  transportName: string | null;
  labelName: string | null;
  titularName: string | null;
  sameTransport: boolean;
  warnings: string[];
};

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
        full_name: string | null;
        transport_id: string | null;
        additional_names: unknown;
      }
    | {
        full_name: string | null;
        transport_id: string | null;
        additional_names: unknown;
      }[]
    | null;
};

function unwrapCustomer(row: RawOrder) {
  const c = row.customers;
  if (!c) return null;
  return Array.isArray(c) ? c[0] ?? null : c;
}

function toNumber(v: number | string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function daysBetween(a: string, b: string): number {
  const x = Date.parse(`${a}T12:00:00Z`);
  const y = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 999;
  return Math.abs(Math.round((x - y) / 86_400_000));
}

export async function searchCodOrdersForManualAssign(
  supabase: SupabaseClient,
  input: {
    remittanceTransportId: string;
    query: string;
    parsedDate: string | null;
    parsedAmount: number | null;
    allTransports: boolean;
    limit?: number;
  }
): Promise<ManualOrderHit[]> {
  const q = input.query.trim();
  const limit = input.limit ?? 30;

  const confirmedRows = await supabase
    .from("cod_remittance_rows")
    .select("matched_order_id")
    .in("row_status", ["confirmed_matched", "confirmed_with_irregularity"])
    .not("matched_order_id", "is", null);
  const confirmed = new Set(
    (confirmedRows.data ?? [])
      .map((r) => r.matched_order_id)
      .filter((id): id is string => !!id)
  );

  const localRows = await supabase
    .from("local_orders")
    .select("source_order_id")
    .not("source_order_id", "is", null)
    .limit(20000);
  const localIds = new Set(
    (localRows.data ?? []).map((r) => r.source_order_id).filter(Boolean)
  );

  const { data: transports } = await supabase.from("transports").select("id, name");
  const transportNames = new Map((transports ?? []).map((t) => [t.id, t.name]));

  // Fetch recent COD sent (bounded). Filter in memory for name/amount/date.
  const { data: orders, error } = await supabase
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
        full_name,
        transport_id,
        additional_names
      )
    `
    )
    .eq("status", "sent")
    .eq("payment_method", COD_PAYMENT_METHOD)
    .order("closed_at", { ascending: false })
    .limit(1500);

  if (error) throw new Error(error.message);

  const normQ = normalizeMatchName(q);
  const tokens = tokenizeMatchName(q);
  const hits: ManualOrderHit[] = [];

  for (const raw of (orders ?? []) as RawOrder[]) {
    if (localIds.has(raw.id) || confirmed.has(raw.id)) continue;
    const customer = unwrapCustomer(raw);
    const effective = resolveEffectiveSent(raw.sent_at, raw.closed_at);
    if (!effective || effective.effectiveSentDate < RECONCILIATION_START_DATE) continue;

    const effTr = raw.transport_id || customer?.transport_id || null;
    if (!input.allTransports && effTr !== input.remittanceTransportId) continue;

    const label = String(raw.label_customer_name || "").trim();
    const titular = String(customer?.full_name || "").trim();
    const names = [label, titular].filter(Boolean).map(normalizeMatchName);
    // additional names lightly
    let additional: unknown = customer?.additional_names;
    if (typeof additional === "string") {
      try {
        additional = JSON.parse(additional);
      } catch {
        additional = [];
      }
    }
    if (Array.isArray(additional)) {
      for (const e of additional) {
        if (!e || typeof e !== "object") continue;
        const o = e as Record<string, unknown>;
        const full =
          String(o.full_name || "").trim() ||
          `${String(o.first_name || "").trim()} ${String(o.last_name || "").trim()}`.trim();
        if (full) names.push(normalizeMatchName(full));
      }
    }

    const orderNum = String(raw.order_number || "").toLowerCase();
    const amount = toNumber(raw.total_amount);

    let nameScore = 0;
    if (normQ) {
      if (names.some((n) => n === normQ)) nameScore = 3;
      else if (tokens.length && names.some((n) => tokens.every((t) => n.includes(t)))) nameScore = 2;
      else if (names.some((n) => n.includes(normQ) || normQ.includes(n))) nameScore = 1;
      else if (orderNum && orderNum.includes(normQ)) nameScore = 2;
      else continue; // query no matchea
    }

    const warnings: string[] = [];
    const sameTransport = effTr === input.remittanceTransportId;
    if (!sameTransport) warnings.push("Transporte distinto");
    if (input.parsedDate) {
      const d = daysBetween(input.parsedDate, effective.effectiveSentDate);
      if (d > 3) warnings.push(`Fecha alejada (${d} días)`);
    }
    if (input.parsedAmount != null && Math.abs(input.parsedAmount - amount) >= 0.005) {
      warnings.push("Monto distinto");
    }
    if (nameScore <= 1 && normQ) warnings.push("Nombre con baja coincidencia");

    hits.push({
      id: raw.id,
      orderNumber: raw.order_number,
      expectedAmount: amount,
      effectiveSentDate: effective.effectiveSentDate,
      sentDateOrigin: effective.sentDateOrigin,
      effectiveTransportId: effTr,
      transportName: effTr ? transportNames.get(effTr) ?? null : null,
      labelName: label || null,
      titularName: titular || null,
      sameTransport,
      warnings,
    });
  }

  hits.sort((a, b) => {
    // Priorizar mismo transporte, fecha cercana, monto parecido
    if (a.sameTransport !== b.sameTransport) return a.sameTransport ? -1 : 1;
    const da = input.parsedDate
      ? daysBetween(input.parsedDate, a.effectiveSentDate)
      : 0;
    const db = input.parsedDate
      ? daysBetween(input.parsedDate, b.effectiveSentDate)
      : 0;
    if (da !== db) return da - db;
    const aa =
      input.parsedAmount != null ? Math.abs(input.parsedAmount - a.expectedAmount) : 0;
    const ab =
      input.parsedAmount != null ? Math.abs(input.parsedAmount - b.expectedAmount) : 0;
    if (aa !== ab) return aa - ab;
    return (a.orderNumber || "").localeCompare(b.orderNumber || "");
  });

  return hits.slice(0, limit);
}
