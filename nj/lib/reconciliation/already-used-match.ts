/**
 * Pedidos excluidos del pool operativo (ya confirmados / en uso) que aún
 * coinciden fuerte con una fila de planilla — solo informativos, nunca seleccionables.
 */
import type { CandidateScore, CodCandidateOrder, RemittanceMatchRow } from "@/lib/reconciliation/matching";
import { scoreCandidateAgainstRow } from "@/lib/reconciliation/matching";

export type AlreadyUsedKind =
  | "confirmed_exact"
  | "confirmed_with_diff"
  | "approved_pending";

export type AlreadyUsedMatch = {
  kind: AlreadyUsedKind;
  orderId: string;
  orderNumber: string | null;
  customerName: string | null;
  customerNumber: string | null;
  orderSentDate: string | null;
  expectedAmount: number;
  transportName: string | null;
  nameSource: "label" | "titular" | "sub_name" | null;
  matchedNameSnapshot: string | null;
  namePoints: number;
  /** true si la vinculación es de la misma planilla que se está mirando */
  sameRemittance: boolean;
  otherRemittanceId: string;
  otherRemittanceDate: string | null;
  otherTransportName: string | null;
  otherReportedAmount: number | null;
  otherRowStatus: string;
  otherRowId: string | null;
  otherRowIndex: number | null;
  otherRawCustomerName: string | null;
  irregularityStatus: "open" | "in_review" | "resolved" | "superseded" | null;
  amountDiff: number | null;
  /** Saldo COD confirmado (primary + supplementary). Informativo para CTA. */
  expectedTotal: number | null;
  activeReportedTotal: number | null;
  remainingBalance: number | null;
};

/** Metadatos de ocupación COD de un pedido (fuera del pool seleccionable). */
export type OrderCodOccupancy = {
  orderId: string;
  kind: AlreadyUsedKind;
  otherRemittanceId: string;
  otherRemittanceDate: string | null;
  otherTransportName: string | null;
  otherReportedAmount: number | null;
  otherRowStatus: string;
  otherRowId: string | null;
  otherRowIndex: number | null;
  otherRawCustomerName: string | null;
  irregularityStatus: "open" | "in_review" | "resolved" | "superseded" | null;
  amountDiff: number | null;
  expectedAmountSnapshot: number | null;
  /** Total rendido confirmado del pedido (suma primary+supp) si se pudo calcular. */
  activeReportedTotal: number | null;
};

/**
 * Evidencia conservadora: nunca monto/fecha solos.
 * Los candidatos ya vienen filtrados al mismo transporte (etapa A).
 * - nombre ≥25 (tokens+) + fecha ≤3 días
 * - o nombre ≥35 (exacto) + fecha ≤7 días
 */
export function isStrongAlreadyUsedEvidence(input: {
  scored: CandidateScore;
}): boolean {
  const { scored } = input;
  if (scored.name.points < 25) return false;
  if (scored.transport.stage !== "A" || scored.transport.mismatch) return false;

  const dayDiff = scored.date.dayDiff;
  if (dayDiff == null) return false;

  if (scored.name.points >= 35 && dayDiff <= 7) return true;
  if (scored.name.points >= 25 && dayDiff <= 3) return true;
  return false;
}

export function rankAlreadyUsedCandidates(input: {
  row: RemittanceMatchRow;
  remittanceTransportId: string;
  candidates: CodCandidateOrder[];
}): CandidateScore[] {
  const scored = input.candidates
    .filter((c) => c.effectiveTransportId === input.remittanceTransportId)
    .map((c) =>
      scoreCandidateAgainstRow(input.row, c, input.remittanceTransportId, "A", null)
    )
    .filter((s) => isStrongAlreadyUsedEvidence({ scored: s }));
  scored.sort((a, b) => b.score - a.score || b.name.points - a.name.points);
  return scored;
}

export function buildAlreadyUsedMatch(
  scored: CandidateScore,
  occupancy: OrderCodOccupancy,
  customerNumber: string | null,
  currentRemittanceId: string | null | undefined
): AlreadyUsedMatch {
  const sameRemittance =
    !!currentRemittanceId &&
    occupancy.otherRemittanceId === currentRemittanceId;

  return {
    kind: occupancy.kind,
    orderId: scored.orderId,
    orderNumber: scored.orderNumber,
    customerName: scored.matchedNameSnapshot,
    customerNumber,
    orderSentDate: scored.effectiveSentDate,
    expectedAmount: scored.expectedAmount,
    transportName: scored.transportName,
    nameSource: scored.matchedNameSource,
    matchedNameSnapshot: scored.matchedNameSnapshot,
    namePoints: scored.name.points,
    sameRemittance,
    otherRemittanceId: occupancy.otherRemittanceId,
    otherRemittanceDate: occupancy.otherRemittanceDate,
    otherTransportName: occupancy.otherTransportName,
    otherReportedAmount: occupancy.otherReportedAmount,
    otherRowStatus: occupancy.otherRowStatus,
    otherRowId: occupancy.otherRowId,
    otherRowIndex: occupancy.otherRowIndex,
    otherRawCustomerName: occupancy.otherRawCustomerName,
    irregularityStatus: occupancy.irregularityStatus,
    amountDiff:
      occupancy.amountDiff != null
        ? occupancy.amountDiff
        : occupancy.otherReportedAmount != null
          ? Math.round((occupancy.otherReportedAmount - scored.expectedAmount) * 100) / 100
          : null,
    expectedTotal: scored.expectedAmount,
    activeReportedTotal:
      occupancy.activeReportedTotal ?? occupancy.otherReportedAmount,
    remainingBalance: (() => {
      const expected = scored.expectedAmount;
      const reported =
        occupancy.activeReportedTotal ?? occupancy.otherReportedAmount;
      if (reported == null || !Number.isFinite(expected)) return null;
      return Math.round((expected - reported) * 100) / 100;
    })(),
  };
}

export function pickBestAlreadyUsedMatch(input: {
  row: RemittanceMatchRow;
  remittanceTransportId: string;
  candidates: CodCandidateOrder[];
  occupancyByOrderId: Map<string, OrderCodOccupancy>;
  customerNumberByOrderId?: Map<string, string | null>;
  currentRemittanceId?: string | null;
  /** Evita auto-referencia si la fila actual ya tiene el pedido (caso raro). */
  currentRowId?: string | null;
}): AlreadyUsedMatch | null {
  const ranked = rankAlreadyUsedCandidates({
    row: input.row,
    remittanceTransportId: input.remittanceTransportId,
    candidates: input.candidates,
  });
  for (const scored of ranked) {
    const occ = input.occupancyByOrderId.get(scored.orderId);
    if (!occ) continue;
    if (input.currentRowId && occ.otherRowId === input.currentRowId) continue;
    return buildAlreadyUsedMatch(
      scored,
      occ,
      input.customerNumberByOrderId?.get(scored.orderId) ?? null,
      input.currentRemittanceId
    );
  }
  return null;
}

export function parseAlreadyUsedFromBreakdown(
  breakdown: Record<string, unknown> | null | undefined
): AlreadyUsedMatch | null {
  if (!breakdown) return null;
  const raw = breakdown.alreadyUsedOrder;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (
    kind !== "confirmed_exact" &&
    kind !== "confirmed_with_diff" &&
    kind !== "approved_pending"
  ) {
    return null;
  }
  if (typeof o.orderId !== "string" || !o.orderId) return null;
  return {
    kind,
    orderId: o.orderId,
    orderNumber: (o.orderNumber as string | null) ?? null,
    customerName: (o.customerName as string | null) ?? null,
    customerNumber: (o.customerNumber as string | null) ?? null,
    orderSentDate: (o.orderSentDate as string | null) ?? null,
    expectedAmount: Number(o.expectedAmount) || 0,
    transportName: (o.transportName as string | null) ?? null,
    nameSource:
      o.nameSource === "label" || o.nameSource === "titular" || o.nameSource === "sub_name"
        ? o.nameSource
        : null,
    matchedNameSnapshot: (o.matchedNameSnapshot as string | null) ?? null,
    namePoints: Number(o.namePoints) || 0,
    sameRemittance: Boolean(o.sameRemittance),
    otherRemittanceId: String(o.otherRemittanceId || ""),
    otherRemittanceDate: (o.otherRemittanceDate as string | null) ?? null,
    otherTransportName: (o.otherTransportName as string | null) ?? null,
    otherReportedAmount:
      o.otherReportedAmount == null ? null : Number(o.otherReportedAmount),
    otherRowStatus: String(o.otherRowStatus || ""),
    otherRowId: (o.otherRowId as string | null) ?? null,
    otherRowIndex:
      o.otherRowIndex == null || o.otherRowIndex === ""
        ? null
        : Number(o.otherRowIndex),
    otherRawCustomerName: (o.otherRawCustomerName as string | null) ?? null,
    irregularityStatus:
      o.irregularityStatus === "open" ||
      o.irregularityStatus === "in_review" ||
      o.irregularityStatus === "resolved" ||
      o.irregularityStatus === "superseded"
        ? o.irregularityStatus
        : null,
    amountDiff: o.amountDiff == null ? null : Number(o.amountDiff),
    expectedTotal:
      o.expectedTotal == null ? null : Number(o.expectedTotal),
    activeReportedTotal:
      o.activeReportedTotal == null ? null : Number(o.activeReportedTotal),
    remainingBalance:
      o.remainingBalance == null ? null : Number(o.remainingBalance),
  };
}
