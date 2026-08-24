/**
 * Motor de matching COD Fase 4 — puro y testeable.
 * Sin efectos financieros. Sin IA.
 */
import {
  levenshteinDistance,
  normalizeCodAliasName,
  normalizeMatchName,
  tokenizeMatchName,
  tokensAllPresent,
  tokensSameMultiset,
} from "@/lib/reconciliation/name-normalize";

export type NameMatchSource = "label" | "titular" | "sub_name";
export type SentDateOrigin = "sent_at" | "closed_at_fallback";
export type MatchStage = "A" | "B";
export type MatchRowStatus = "auto_matched" | "needs_review" | "unassigned";

/** Por qué una fila quedó auto_matched (explicabilidad UI / auditoría). */
export type AutoMatchReason =
  | "strong_identity"
  | "transport_alias"
  | "unique_financial_logistics";

/** Alias activo resuelto para (transport, texto planilla). */
export type TransportAliasHit = {
  aliasId: string;
  customerId: string;
  rawAlias: string;
  normalizedAlias: string;
};

export type NameIdentity = {
  raw: string;
  source: NameMatchSource;
};

export type CodCandidateOrder = {
  id: string;
  orderNumber: string | null;
  customerId: string | null;
  /** Titular del cliente (UX). No es snapshot financiero. */
  customerDisplayName: string | null;
  customerNumber: string | null;
  /** Label del pedido (UX). */
  labelCustomerName: string | null;
  expectedAmount: number;
  effectiveSentDate: string; // YYYY-MM-DD
  sentDateOrigin: SentDateOrigin;
  effectiveTransportId: string | null;
  transportName: string | null;
  identities: NameIdentity[];
};

export type RemittanceMatchRow = {
  id: string;
  rowIndex: number;
  rawCustomerNameText: string;
  parsedTransportDate: string | null; // YYYY-MM-DD
  parsedAmount: number | null;
};

export type NameScoreDetail = {
  points: number;
  max: 40;
  source: NameMatchSource | null;
  matchedName: string | null;
  quality: "exact_label" | "exact_titular" | "exact_sub" | "tokens" | "partial" | "none";
};

export type DateScoreDetail = {
  points: number;
  max: 30;
  dayDiff: number | null;
  originPenalty: number;
};

export type AmountScoreDetail = {
  points: number;
  max: 25;
  amountDiff: number | null;
  exact: boolean;
};

export type TransportScoreDetail = {
  points: number;
  stage: MatchStage;
  mismatch: boolean;
};

export type CandidateScore = {
  orderId: string;
  orderNumber: string | null;
  customerId: string | null;
  /** Titular real del cliente (metadata UX; no cambia scoring). */
  customerDisplayName: string | null;
  customerNumber: string | null;
  labelCustomerName: string | null;
  score: number;
  name: NameScoreDetail;
  date: DateScoreDetail;
  amount: AmountScoreDetail;
  transport: TransportScoreDetail;
  expectedAmount: number;
  effectiveSentDate: string;
  sentDateOrigin: SentDateOrigin;
  transportName: string | null;
  matchedNameSnapshot: string | null;
  matchedNameSource: NameMatchSource | null;
  willCreateIrregularity: boolean;
  warningApprovedElsewhere: string | null;
};

export type RowMatchResult = {
  rowId: string;
  rowIndex: number;
  rowStatus: MatchRowStatus;
  confidenceLabel: "alta" | "revision" | "baja" | "sin_candidato";
  /** Solo cuando rowStatus === auto_matched */
  autoMatchReason: AutoMatchReason | null;
  matchedOrderId: string | null;
  matchScore: number | null;
  matchBreakdown: Record<string, unknown>;
  matchCandidates: CandidateScore[];
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

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T12:00:00Z`);
  const b = Date.parse(`${bIso}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 999;
  return Math.abs(Math.round((a - b) / 86_400_000));
}

export function scoreName(reportedRaw: string, identities: NameIdentity[]): NameScoreDetail {
  const reported = normalizeMatchName(reportedRaw);
  const reportedTokens = tokenizeMatchName(reportedRaw);
  if (!reported) {
    return { points: 0, max: 40, source: null, matchedName: null, quality: "none" };
  }

  let best: NameScoreDetail = {
    points: 0,
    max: 40,
    source: null,
    matchedName: null,
    quality: "none",
  };

  for (const id of identities) {
    const cand = normalizeMatchName(id.raw);
    if (!cand) continue;
    const candTokens = tokenizeMatchName(id.raw);
    let points = 0;
    let quality: NameScoreDetail["quality"] = "none";

    if (cand === reported) {
      if (id.source === "label") {
        points = 40;
        quality = "exact_label";
      } else if (id.source === "titular") {
        points = 35;
        quality = "exact_titular";
      } else {
        points = 35;
        quality = "exact_sub";
      }
    } else if (
      tokensSameMultiset(reportedTokens, candTokens) ||
      tokensAllPresent(reportedTokens, candTokens)
    ) {
      points = 25;
      quality = "tokens";
    } else {
      const dist = levenshteinDistance(reported, cand);
      const maxLen = Math.max(reported.length, cand.length);
      const ratio = maxLen > 0 ? dist / maxLen : 1;
      const partialTokens =
        reportedTokens.length > 0 &&
        reportedTokens.filter((t) => candTokens.some((c) => c.includes(t) || t.includes(c)))
          .length >= Math.ceil(reportedTokens.length * 0.6);
      if ((maxLen >= 6 && ratio <= 0.25) || partialTokens) {
        points = 12;
        quality = "partial";
      }
    }

    if (points > best.points) {
      best = {
        points,
        max: 40,
        source: id.source,
        matchedName: id.raw,
        quality,
      };
    }
  }

  return best;
}

export function scoreDate(
  remittanceDate: string | null,
  effectiveSentDate: string,
  sentDateOrigin: SentDateOrigin
): DateScoreDetail {
  if (!remittanceDate) {
    return { points: 0, max: 30, dayDiff: null, originPenalty: 0 };
  }
  const dayDiff = daysBetween(remittanceDate, effectiveSentDate);
  let points = 0;
  if (dayDiff === 0) points = 30;
  else if (dayDiff === 1) points = 22;
  else if (dayDiff <= 3) points = 12;
  else points = 0;

  const originPenalty = sentDateOrigin === "closed_at_fallback" ? 8 : 0;
  points = Math.max(0, points - originPenalty);
  return { points, max: 30, dayDiff, originPenalty };
}

export function scoreAmount(reported: number | null, expected: number): AmountScoreDetail {
  if (reported == null || !Number.isFinite(reported) || !Number.isFinite(expected)) {
    return { points: 0, max: 25, amountDiff: null, exact: false };
  }
  const amountDiff = Math.round((reported - expected) * 100) / 100;
  const abs = Math.abs(amountDiff);
  const pct = expected !== 0 ? abs / Math.abs(expected) : abs > 0 ? 1 : 0;
  let points = 0;
  if (abs < 0.005) points = 25;
  else if (abs <= 1000 || pct <= 0.01) points = 18;
  else if (abs <= 5000 || pct <= 0.03) points = 8;
  else points = 0;
  return { points, max: 25, amountDiff, exact: abs < 0.005 };
}

export function scoreTransport(
  stage: MatchStage,
  remittanceTransportId: string,
  effectiveTransportId: string | null
): TransportScoreDetail {
  const mismatch =
    !!effectiveTransportId && effectiveTransportId !== remittanceTransportId;
  if (stage === "A") {
    return { points: 5, stage, mismatch: false };
  }
  return { points: -15, stage, mismatch };
}

export function scoreCandidateAgainstRow(
  row: RemittanceMatchRow,
  candidate: CodCandidateOrder,
  remittanceTransportId: string,
  stage: MatchStage,
  warningApprovedElsewhere: string | null = null
): CandidateScore {
  const name = scoreName(row.rawCustomerNameText, candidate.identities);
  const date = scoreDate(row.parsedTransportDate, candidate.effectiveSentDate, candidate.sentDateOrigin);
  const amount = scoreAmount(row.parsedAmount, candidate.expectedAmount);
  const transport = scoreTransport(stage, remittanceTransportId, candidate.effectiveTransportId);
  const score = Math.round((name.points + date.points + amount.points + transport.points) * 100) / 100;

  return {
    orderId: candidate.id,
    orderNumber: candidate.orderNumber,
    customerId: candidate.customerId,
    customerDisplayName: candidate.customerDisplayName,
    customerNumber: candidate.customerNumber,
    labelCustomerName: candidate.labelCustomerName,
    score,
    name,
    date,
    amount,
    transport,
    expectedAmount: candidate.expectedAmount,
    effectiveSentDate: candidate.effectiveSentDate,
    sentDateOrigin: candidate.sentDateOrigin,
    transportName: candidate.transportName,
    matchedNameSnapshot: name.matchedName,
    matchedNameSource: name.source,
    willCreateIrregularity: !amount.exact,
    warningApprovedElsewhere,
  };
}

function nameQualityStrong(name: NameScoreDetail): boolean {
  return name.points >= 35;
}

/**
 * Identidad usable (parcial+) + fecha exacta + etapa A, con monto NO exacto.
 * Cubre score&lt;50 típico: name 12 + fecha 30 + monto 0 + transporte 5 = 47.
 * Con name≥25 el score ya sería ≥60 en etapa A; el rescate apunta al hueco parcial.
 * Nunca habilita auto_matched.
 */
export function isStrongIdentityWeakAmountReview(input: {
  best: CandidateScore | null;
  usedStageB: boolean;
}): boolean {
  const { best, usedStageB } = input;
  if (!best || usedStageB) return false;
  if (best.transport.stage !== "A") return false;
  if (best.transport.mismatch) return false;
  if (best.date.dayDiff !== 0) return false;
  if (best.name.points < 12) return false;
  if (best.amount.exact) return false;
  return true;
}

/**
 * Vía B — triplete logístico-financiero único (Etapa A únicamente).
 * No relajar: monto exacto, fecha exacta, mismo transporte, 1 solo pendiente
 * con esa combinación en el pool ranking, namePoints>0, TOP1=ese, gap≥10, no Etapa B.
 */
export function isUniqueFinancialLogisticsAuto(input: {
  best: CandidateScore;
  second: CandidateScore | null;
  rankedPool: CandidateScore[];
  usedStageB: boolean;
}): boolean {
  const { best, second, rankedPool, usedStageB } = input;
  if (usedStageB) return false;
  if (best.transport.stage !== "A") return false;
  if (best.transport.mismatch) return false;
  if (!best.amount.exact) return false;
  if (best.date.dayDiff !== 0) return false;
  if (best.name.points <= 0) return false;

  const gap = second ? best.score - second.score : 999;
  if (gap < 10) return false;

  const tripletPeers = rankedPool.filter(
    (c) =>
      c.amount.exact &&
      c.date.dayDiff === 0 &&
      c.transport.stage === "A" &&
      !c.transport.mismatch
  );
  if (tripletPeers.length !== 1) return false;
  if (tripletPeers[0]!.orderId !== best.orderId) return false;
  return true;
}

/**
 * Vía C — alias de transporte → customer_id + único pedido compatible.
 * No salta monto/fecha/transporte distintos. No elige si hay 0 o ≥2 pedidos.
 */
export function findUniqueTransportAliasMatch(input: {
  rankedPool: CandidateScore[];
  aliasHit: TransportAliasHit;
  usedStageB: boolean;
}): CandidateScore | null {
  const { rankedPool, aliasHit, usedStageB } = input;
  if (usedStageB) return null;

  const peers = rankedPool.filter(
    (c) =>
      c.customerId === aliasHit.customerId &&
      c.amount.exact &&
      c.date.dayDiff === 0 &&
      c.transport.stage === "A" &&
      !c.transport.mismatch
  );
  if (peers.length !== 1) return null;
  return peers[0]!;
}

export function classifyRowFromCandidates(
  row: RemittanceMatchRow,
  ranked: CandidateScore[],
  usedStageB: boolean,
  aliasHit: TransportAliasHit | null = null
): RowMatchResult {
  const top3 = ranked.slice(0, 3);
  const best = top3[0] ?? null;
  const second = top3[1] ?? null;

  if (!best || best.score < 50) {
    // Vía C puede rescatar aunque el TOP ranking sea débil / <50
    const aliasPick =
      aliasHit && !usedStageB
        ? findUniqueTransportAliasMatch({ rankedPool: ranked, aliasHit, usedStageB })
        : null;
    if (aliasPick) {
      return buildAutoMatchedResult({
        row,
        chosen: aliasPick,
        ranked,
        usedStageB,
        ambiguous: false,
        reason: "transport_alias",
        aliasHit,
      });
    }

    // Rescate conservador: identidad usable + fecha exacta + mismo transporte,
    // aunque el monto lejos deje el score < 50. Nunca auto-match (solo needs_review).
    if (isStrongIdentityWeakAmountReview({ best, usedStageB })) {
      return {
        rowId: row.id,
        rowIndex: row.rowIndex,
        rowStatus: "needs_review",
        confidenceLabel: "revision",
        autoMatchReason: null,
        matchedOrderId: best.orderId,
        matchScore: best.score,
        matchBreakdown: {
          ...buildBreakdown(best, second, "needs_review", usedStageB, false),
          rescueReason: "strong_identity_weak_amount",
          explanation:
            "Nombre y fecha fuertes con monto distinto — revisión obligatoria (posible pago parcial / error de digitación).",
        },
        matchCandidates: top3,
        matchedViaBroadenedSearch: usedStageB || best.transport.stage === "B",
        transportMismatch: best.transport.mismatch,
        willCreateIrregularity: !best.amount.exact,
        orderNumberSnapshot: best.orderNumber,
        matchedNameSnapshot: best.matchedNameSnapshot,
        matchedNameSource: best.matchedNameSource,
        transportNameSnapshot: best.transportName,
        orderSentDateSnapshot: best.effectiveSentDate,
        orderSentDateOrigin: best.sentDateOrigin,
        expectedAmountSnapshot: best.expectedAmount,
      };
    }

    return {
      rowId: row.id,
      rowIndex: row.rowIndex,
      rowStatus: "unassigned",
      confidenceLabel: best ? "baja" : "sin_candidato",
      autoMatchReason: null,
      matchedOrderId: null,
      matchScore: best?.score ?? null,
      matchBreakdown: buildBreakdown(best, second, "unassigned", usedStageB),
      matchCandidates: top3,
      matchedViaBroadenedSearch: usedStageB,
      transportMismatch: false,
      willCreateIrregularity: false,
      orderNumberSnapshot: null,
      matchedNameSnapshot: null,
      matchedNameSource: null,
      transportNameSnapshot: null,
      orderSentDateSnapshot: null,
      orderSentDateOrigin: null,
      expectedAmountSnapshot: null,
    };
  }

  const gap = second ? best.score - second.score : 999;
  const ambiguous = gap < 10;

  // Vía A — identidad fuerte (sin cambios)
  const viaA =
    best.score >= 80 &&
    nameQualityStrong(best.name) &&
    best.amount.exact &&
    best.transport.stage === "A" &&
    !ambiguous;

  if (viaA) {
    return buildAutoMatchedResult({
      row,
      chosen: best,
      ranked,
      usedStageB,
      ambiguous,
      reason: "strong_identity",
      aliasHit: null,
    });
  }

  // Vía C — transport_alias
  const aliasPick = aliasHit
    ? findUniqueTransportAliasMatch({ rankedPool: ranked, aliasHit, usedStageB })
    : null;
  if (aliasPick) {
    return buildAutoMatchedResult({
      row,
      chosen: aliasPick,
      ranked,
      usedStageB,
      ambiguous: false,
      reason: "transport_alias",
      aliasHit,
    });
  }

  // Vía B — triplete único
  const viaB = isUniqueFinancialLogisticsAuto({
    best,
    second,
    rankedPool: ranked,
    usedStageB,
  });

  if (viaB) {
    return buildAutoMatchedResult({
      row,
      chosen: best,
      ranked,
      usedStageB,
      ambiguous,
      reason: "unique_financial_logistics",
      aliasHit: null,
    });
  }

  return {
    rowId: row.id,
    rowIndex: row.rowIndex,
    rowStatus: "needs_review",
    confidenceLabel: "revision",
    autoMatchReason: null,
    matchedOrderId: best.orderId,
    matchScore: best.score,
    matchBreakdown: buildBreakdown(best, second, "needs_review", usedStageB, ambiguous),
    matchCandidates: top3,
    matchedViaBroadenedSearch: usedStageB || best.transport.stage === "B",
    transportMismatch: best.transport.mismatch,
    willCreateIrregularity: best.willCreateIrregularity,
    orderNumberSnapshot: best.orderNumber,
    matchedNameSnapshot: best.matchedNameSnapshot,
    matchedNameSource: best.matchedNameSource,
    transportNameSnapshot: best.transportName,
    orderSentDateSnapshot: best.effectiveSentDate,
    orderSentDateOrigin: best.sentDateOrigin,
    expectedAmountSnapshot: best.expectedAmount,
  };
}

function buildAutoMatchedResult(input: {
  row: RemittanceMatchRow;
  chosen: CandidateScore;
  ranked: CandidateScore[];
  usedStageB: boolean;
  ambiguous: boolean;
  reason: AutoMatchReason;
  aliasHit: TransportAliasHit | null;
}): RowMatchResult {
  const { row, chosen, ranked, usedStageB, ambiguous, reason, aliasHit } = input;
  const others = ranked.filter((c) => c.orderId !== chosen.orderId);
  const top3 = [chosen, ...others].slice(0, 3);
  const second = top3[1] ?? null;
  return {
    rowId: row.id,
    rowIndex: row.rowIndex,
    rowStatus: "auto_matched",
    confidenceLabel: "alta",
    autoMatchReason: reason,
    matchedOrderId: chosen.orderId,
    matchScore: chosen.score,
    matchBreakdown: buildBreakdown(
      chosen,
      second,
      "auto_matched",
      usedStageB,
      ambiguous,
      reason,
      aliasHit
    ),
    matchCandidates: top3,
    matchedViaBroadenedSearch: false,
    transportMismatch: false,
    willCreateIrregularity: false,
    orderNumberSnapshot: chosen.orderNumber,
    // matched_name_* debe ser una identidad real del pedido (label/titular/sub_name).
    // El alias de transporte va en match_breakdown; no puede ir como snapshot
    // (rpc_cod_save_analysis → matched_name_not_in_order_identities).
    matchedNameSnapshot: chosen.matchedNameSnapshot,
    matchedNameSource: chosen.matchedNameSource,
    transportNameSnapshot: chosen.transportName,
    orderSentDateSnapshot: chosen.effectiveSentDate,
    orderSentDateOrigin: chosen.sentDateOrigin,
    expectedAmountSnapshot: chosen.expectedAmount,
  };
}

function buildBreakdown(
  best: CandidateScore | null,
  second: CandidateScore | null,
  result: MatchRowStatus,
  usedStageB: boolean,
  ambiguous = false,
  autoMatchReason: AutoMatchReason | null = null,
  aliasHit: TransportAliasHit | null = null
): Record<string, unknown> {
  if (!best) {
    return {
      result,
      explanation: "Sin candidato razonable",
      usedStageB,
      autoMatchReason: null,
    };
  }
  const amountDiff = best.amount.amountDiff;
  return {
    result,
    confidence:
      result === "auto_matched" ? "alta" : result === "needs_review" ? "revision" : "baja",
    score: best.score,
    name: best.name,
    date: best.date,
    amount: best.amount,
    transport: best.transport,
    expectedAmount: best.expectedAmount,
    reportedVsExpected:
      amountDiff == null
        ? null
        : {
            expected: best.expectedAmount,
            difference: amountDiff,
          },
    secondScore: second?.score ?? null,
    scoreGap: second ? Math.round((best.score - second.score) * 100) / 100 : null,
    ambiguous,
    usedStageB,
    autoMatchReason,
    aliasId: aliasHit?.aliasId ?? null,
    aliasRaw: aliasHit?.rawAlias ?? null,
    aliasCustomerId: aliasHit?.customerId ?? null,
    warningApprovedElsewhere: best.warningApprovedElsewhere,
    reasons: collectReasons(best, second, result, ambiguous, autoMatchReason, aliasHit),
  };
}

function collectReasons(
  best: CandidateScore,
  second: CandidateScore | null,
  result: MatchRowStatus,
  ambiguous: boolean,
  autoMatchReason: AutoMatchReason | null,
  aliasHit: TransportAliasHit | null = null
): string[] {
  const reasons: string[] = [];
  if (result === "auto_matched") {
    if (autoMatchReason === "transport_alias") {
      reasons.push(
        `Nombre reconocido por alias de transporte («${aliasHit?.rawAlias ?? "—"}» → cliente ${aliasHit?.customerId ?? "—"})`
      );
    } else if (autoMatchReason === "unique_financial_logistics") {
      reasons.push(
        "Coincidencia segura (monto, fecha y transporte exactos · único pedido compatible)"
      );
    } else {
      reasons.push("Coincidencia segura (Etapa A, nombre fuerte, monto exacto)");
    }
  }
  if (ambiguous) reasons.push("Ambigüedad: diferencia con el 2º candidato < 10 puntos");
  if (!best.amount.exact) reasons.push("Monto no exacto — generará irregularidad si se confirma");
  if (best.transport.stage === "B") reasons.push("Mejor candidato encontrado fuera del transporte de la rendición");
  if (best.transport.mismatch) reasons.push("Transporte efectivo distinto al de la rendición");
  if (best.date.originPenalty > 0) reasons.push("Fecha estimada (closed_at, sin sent_at)");
  if (best.name.points < 35 && best.name.points > 0) reasons.push("Nombre parcial / débil");
  if (best.warningApprovedElsewhere) reasons.push(best.warningApprovedElsewhere);
  if (second) reasons.push(`Segundo candidato score ${second.score}`);
  return reasons;
}

export function rankCandidatesForRow(
  row: RemittanceMatchRow,
  pool: CodCandidateOrder[],
  remittanceTransportId: string,
  stage: MatchStage,
  approvedWarnings: Map<string, string>
): CandidateScore[] {
  const scored = pool.map((c) =>
    scoreCandidateAgainstRow(
      row,
      c,
      remittanceTransportId,
      stage,
      approvedWarnings.get(c.id) ?? null
    )
  );
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.orderId.localeCompare(b.orderId);
  });
  return scored;
}

/**
 * Ejecuta matching completo en memoria sobre pools A (y B si hace falta).
 * Máximo uso externo: 2 fetches de candidatos (A y opcionalmente B) + 1 mapa de aliases.
 */
export function matchRemittanceRows(input: {
  remittanceTransportId: string;
  rows: RemittanceMatchRow[];
  poolA: CodCandidateOrder[];
  poolB: CodCandidateOrder[] | null;
  approvedWarnings: Map<string, string>;
  /** Map normalizedAlias → hit (solo activos del transporte de la rendición) */
  aliasesByNormalized?: Map<string, TransportAliasHit>;
}): {
  results: RowMatchResult[];
  needsStageB: boolean;
  autoMatched: number;
  needsReview: number;
  unassigned: number;
} {
  const { remittanceTransportId, rows, poolA, approvedWarnings } = input;
  const aliasMap = input.aliasesByNormalized ?? new Map<string, TransportAliasHit>();

  function aliasForRow(row: RemittanceMatchRow): TransportAliasHit | null {
    const key = normalizeCodAliasName(row.rawCustomerNameText);
    if (!key) return null;
    return aliasMap.get(key) ?? null;
  }

  const placeholders: RowMatchResult[] = [];
  const needsB: Array<{ row: RemittanceMatchRow; rankedA: CandidateScore[] }> = [];

  for (const row of rows) {
    const rankedA = rankCandidatesForRow(row, poolA, remittanceTransportId, "A", approvedWarnings);
    const classified = classifyRowFromCandidates(row, rankedA, false, aliasForRow(row));
    if (classified.rowStatus === "auto_matched") {
      placeholders.push(classified);
    } else {
      needsB.push({ row, rankedA });
      placeholders.push(classified);
    }
  }

  const needsStageB = needsB.length > 0;
  const finalByRowId = new Map(placeholders.map((r) => [r.rowId, r]));

  if (needsStageB && input.poolB) {
    for (const { row, rankedA } of needsB) {
      const rankedB = rankCandidatesForRow(
        row,
        input.poolB,
        remittanceTransportId,
        "B",
        approvedWarnings
      );
      const byId = new Map<string, CandidateScore>();
      for (const c of [...rankedA, ...rankedB]) {
        const prev = byId.get(c.orderId);
        if (!prev || c.score > prev.score) byId.set(c.orderId, c);
      }
      const merged = [...byId.values()].sort(
        (a, b) => b.score - a.score || a.orderId.localeCompare(b.orderId)
      );
      // usedStageB=true ⇒ Vía C deshabilitada a propósito
      finalByRowId.set(row.id, classifyRowFromCandidates(row, merged, true, aliasForRow(row)));
    }
  }

  const results = rows.map((r) => finalByRowId.get(r.id)!);
  return {
    results,
    needsStageB,
    autoMatched: results.filter((r) => r.rowStatus === "auto_matched").length,
    needsReview: results.filter((r) => r.rowStatus === "needs_review").length,
    unassigned: results.filter((r) => r.rowStatus === "unassigned").length,
  };
}

export function parseAdditionalNames(raw: unknown): string[] {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const full =
      String(e.full_name || "").trim() ||
      `${String(e.first_name || "").trim()} ${String(e.last_name || "").trim()}`.trim() ||
      String(e.name || "").trim();
    if (full) out.push(full);
  }
  return out;
}

export function buildIdentities(input: {
  labelCustomerName: string | null;
  titularFullName: string | null;
  additionalNames: unknown;
}): NameIdentity[] {
  const identities: NameIdentity[] = [];
  const label = String(input.labelCustomerName || "").trim();
  const titular = String(input.titularFullName || "").trim();
  if (label) identities.push({ raw: label, source: "label" });
  if (titular) identities.push({ raw: titular, source: "titular" });
  for (const sub of parseAdditionalNames(input.additionalNames)) {
    if (normalizeMatchName(sub) === normalizeMatchName(titular)) continue;
    if (normalizeMatchName(sub) === normalizeMatchName(label)) continue;
    identities.push({ raw: sub, source: "sub_name" });
  }
  return identities;
}
