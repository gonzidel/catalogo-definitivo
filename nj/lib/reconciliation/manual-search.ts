/**
 * Búsqueda manual de pedidos COD para asignación (Fase 5).
 * Universo asignable: sent + Contra Reembolso + desde 2026-05-01 + no local + no confirmed_*.
 *
 * Lookup exacto por Nº de pedido: encuentra el pedido aunque esté fuera del universo
 * (p. ej. Pagado) y lo muestra bloqueado con motivo — no lo oculta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COD_PAYMENT_METHOD,
  RECONCILIATION_START_DATE,
} from "@/lib/reconciliation/constants";
import { resolveEffectiveSent } from "@/lib/reconciliation/queries";
import { normalizeMatchName, tokenizeMatchName } from "@/lib/reconciliation/name-normalize";
import { loadOrderCodOccupancyMap } from "@/lib/reconciliation/already-used-loader";

export type ManualBlockReason =
  | "not_cod"
  | "wrong_status"
  | "too_old"
  | "local_order"
  | "already_confirmed"
  | "approved_pending"
  | null;

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
  customerNumber: string | null;
  paymentMethod: string | null;
  orderStatus: string | null;
  sameTransport: boolean;
  warnings: string[];
  /** Si true, no se puede asignar desde esta búsqueda. */
  assignmentBlocked: boolean;
  blockReason: ManualBlockReason;
  occupancy?: {
    kind: "confirmed_exact" | "confirmed_with_diff" | "approved_pending";
    otherRemittanceDate: string | null;
    otherTransportName: string | null;
    otherReportedAmount: number | null;
    irregularityStatus: string | null;
    amountDiff: number | null;
  } | null;
};

type RawOrder = {
  id: string;
  order_number: string | null;
  status: string | null;
  payment_method: string | null;
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
        customer_number?: string | number | null;
      }
    | {
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

/**
 * Detecta y normaliza Nº de pedido FYL (A54945 / 54945).
 * null = no parece un Nº de pedido.
 */
export function normalizeOrderNumberQuery(q: string): string | null {
  const t = q.trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return null;
  if (/^A\d{3,}$/.test(t)) return t;
  if (/^\d{4,}$/.test(t)) return `A${t}`;
  return null;
}

const ORDER_SELECT = `
  id,
  order_number,
  status,
  payment_method,
  total_amount,
  sent_at,
  closed_at,
  label_customer_name,
  transport_id,
  customers!inner (
    full_name,
    transport_id,
    additional_names,
    customer_number
  )
`;

type OccupancyMap = Map<
  string,
  NonNullable<ManualOrderHit["occupancy"]>
>;

function buildHit(input: {
  raw: RawOrder;
  remittanceTransportId: string;
  parsedDate: string | null;
  parsedAmount: number | null;
  transportNames: Map<string, string>;
  localIds: Set<string>;
  confirmed: Set<string>;
  occupancyByOrderId: OccupancyMap;
  /** true = lookup exacto: no filtrar fuera del universo, solo marcar bloqueo */
  exactLookup: boolean;
}): ManualOrderHit | null {
  const {
    raw,
    remittanceTransportId,
    parsedDate,
    parsedAmount,
    transportNames,
    localIds,
    confirmed,
    occupancyByOrderId,
    exactLookup,
  } = input;

  const customer = unwrapCustomer(raw);
  const effective = resolveEffectiveSent(raw.sent_at, raw.closed_at);
  const amount = toNumber(raw.total_amount);
  const label = String(raw.label_customer_name || "").trim();
  const titular = String(customer?.full_name || "").trim();
  const customerNumber =
    customer?.customer_number != null && String(customer.customer_number).trim()
      ? String(customer.customer_number).trim()
      : null;
  const paymentMethod = raw.payment_method ? String(raw.payment_method) : null;
  const orderStatus = raw.status ? String(raw.status) : null;
  const effTr = raw.transport_id || customer?.transport_id || null;
  const sameTransport = effTr === remittanceTransportId;
  const occupancy = occupancyByOrderId.get(raw.id) ?? null;

  let blockReason: ManualBlockReason = null;
  const warnings: string[] = [];

  if (orderStatus && orderStatus !== "sent") {
    blockReason = "wrong_status";
    warnings.push(`Estado del pedido: ${orderStatus} (se requiere enviado)`);
  } else if (paymentMethod !== COD_PAYMENT_METHOD) {
    blockReason = "not_cod";
    warnings.push(
      `No es Contra Reembolso (${paymentMethod || "sin método"}). No entra al universo COD.`
    );
  } else if (!effective) {
    blockReason = "too_old";
    warnings.push("Sin fecha efectiva de envío");
  } else if (effective.effectiveSentDate < RECONCILIATION_START_DATE) {
    blockReason = "too_old";
    warnings.push(`Anterior a ${RECONCILIATION_START_DATE}`);
  } else if (localIds.has(raw.id)) {
    blockReason = "local_order";
    warnings.push("Es un pedido local (excluido de COD)");
  } else if (occupancy?.kind === "approved_pending" || confirmed.has(raw.id)) {
    if (occupancy?.kind === "approved_pending") {
      blockReason = "approved_pending";
      warnings.push("Ya aprobado en otra rendición (pendiente de confirmar)");
    } else {
      blockReason = "already_confirmed";
      warnings.push("Ya conciliado en otra rendición");
    }
  }

  // Fuzzy COD path: omitir fuera de universo (no mostrar)
  if (!exactLookup && blockReason) return null;

  const fallbackDate = String(raw.sent_at || raw.closed_at || "").slice(0, 10);
  const effectiveSentDate = effective?.effectiveSentDate || fallbackDate || "—";
  const sentDateOrigin = effective?.sentDateOrigin ?? "sent_at";

  if (!blockReason) {
    if (!sameTransport) warnings.push("Transporte distinto");
    if (parsedDate && effective) {
      const d = daysBetween(parsedDate, effective.effectiveSentDate);
      if (d > 3) warnings.push(`Fecha alejada (${d} días)`);
    }
    if (parsedAmount != null && Math.abs(parsedAmount - amount) >= 0.005) {
      warnings.push("Monto distinto");
    }
  }

  return {
    id: raw.id,
    orderNumber: raw.order_number,
    expectedAmount: amount,
    effectiveSentDate,
    sentDateOrigin,
    effectiveTransportId: effTr,
    transportName: effTr ? transportNames.get(effTr) ?? null : null,
    labelName: label || null,
    titularName: titular || null,
    customerNumber,
    paymentMethod,
    orderStatus,
    sameTransport,
    warnings,
    assignmentBlocked: blockReason != null,
    blockReason,
    occupancy,
  };
}

async function fetchExactByOrderNumber(
  supabase: SupabaseClient,
  orderNumber: string
): Promise<RawOrder | null> {
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("order_number", orderNumber)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RawOrder | null) ?? null;
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
  const exactOrderNumber = normalizeOrderNumberQuery(q);

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

  let occupancyByOrderId: OccupancyMap = new Map();
  try {
    const full = await loadOrderCodOccupancyMap(supabase);
    for (const [id, o] of full) {
      occupancyByOrderId.set(id, {
        kind: o.kind,
        otherRemittanceDate: o.otherRemittanceDate,
        otherTransportName: o.otherTransportName,
        otherReportedAmount: o.otherReportedAmount,
        irregularityStatus: o.irregularityStatus,
        amountDiff: o.amountDiff,
      });
    }
  } catch (e) {
    console.error("[manual-search] already-used occupancy failed", e);
    occupancyByOrderId = new Map();
  }

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

  const hitOpts = {
    remittanceTransportId: input.remittanceTransportId,
    parsedDate: input.parsedDate,
    parsedAmount: input.parsedAmount,
    transportNames,
    localIds,
    confirmed,
    occupancyByOrderId,
  };

  const hits: ManualOrderHit[] = [];
  const seen = new Set<string>();

  // 1) Lookup exacto por Nº — siempre, aunque no sea COD
  if (exactOrderNumber) {
    const exact = await fetchExactByOrderNumber(supabase, exactOrderNumber);
    if (exact) {
      const hit = buildHit({ ...hitOpts, raw: exact, exactLookup: true });
      if (hit) {
        // Exacto: respetar filtro transporte solo como warning, no ocultar
        if (!input.allTransports && !hit.sameTransport && !hit.assignmentBlocked) {
          hit.warnings = [
            ...hit.warnings.filter((w) => w !== "Transporte distinto"),
            "Transporte distinto",
          ];
        }
        hits.push(hit);
        seen.add(hit.id);
      }
    }
  }

  // 2) Búsqueda fuzzy en universo COD reciente (nombre / Nº parcial)
  const { data: orders, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("status", "sent")
    .eq("payment_method", COD_PAYMENT_METHOD)
    .order("closed_at", { ascending: false })
    .limit(1500);

  if (error) throw new Error(error.message);

  const normQ = normalizeMatchName(q);
  const tokens = tokenizeMatchName(q);

  for (const raw of (orders ?? []) as RawOrder[]) {
    if (seen.has(raw.id)) continue;
    if (localIds.has(raw.id)) continue;
    const customer = unwrapCustomer(raw);
    const effective = resolveEffectiveSent(raw.sent_at, raw.closed_at);
    if (!effective || effective.effectiveSentDate < RECONCILIATION_START_DATE) continue;

    const effTr = raw.transport_id || customer?.transport_id || null;
    if (!input.allTransports && effTr !== input.remittanceTransportId) continue;

    const label = String(raw.label_customer_name || "").trim();
    const titular = String(customer?.full_name || "").trim();
    const names = [label, titular].filter(Boolean).map(normalizeMatchName);
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
    let nameScore = 0;
    if (normQ) {
      if (names.some((n) => n === normQ)) nameScore = 3;
      else if (tokens.length && names.some((n) => tokens.every((t) => n.includes(t))))
        nameScore = 2;
      else if (names.some((n) => n.includes(normQ) || normQ.includes(n))) nameScore = 1;
      else if (orderNum && orderNum.includes(normQ)) nameScore = 2;
      else continue;
    }

    const hit = buildHit({ ...hitOpts, raw, exactLookup: false });
    if (!hit) continue;
    if (nameScore <= 1 && normQ && !exactOrderNumber) {
      hit.warnings.push("Nombre con baja coincidencia");
    }
    hits.push(hit);
    seen.add(hit.id);
  }

  hits.sort((a, b) => {
    if (a.assignmentBlocked !== b.assignmentBlocked) return a.assignmentBlocked ? 1 : -1;
    if (a.sameTransport !== b.sameTransport) return a.sameTransport ? -1 : 1;
    const da = input.parsedDate ? daysBetween(input.parsedDate, a.effectiveSentDate) : 0;
    const db = input.parsedDate ? daysBetween(input.parsedDate, b.effectiveSentDate) : 0;
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
