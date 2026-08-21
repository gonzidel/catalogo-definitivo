/**
 * Self-tests del motor matching COD (Fase 4).
 * Ejecutar: npx tsx nj/lib/reconciliation/matching.selftest.ts
 */
import {
  buildIdentities,
  classifyRowFromCandidates,
  matchRemittanceRows,
  rankCandidatesForRow,
  scoreAmount,
  scoreCandidateAgainstRow,
  scoreDate,
  scoreName,
  type CodCandidateOrder,
  type RemittanceMatchRow,
} from "./matching";
import { normalizeMatchName } from "./name-normalize";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${msg}`);
  }
}

function baseCandidate(over: Partial<CodCandidateOrder> & { id: string }): CodCandidateOrder {
  return {
    id: over.id,
    orderNumber: over.orderNumber ?? "A00001",
    customerId: over.customerId ?? "cust-1",
    expectedAmount: over.expectedAmount ?? 150000,
    effectiveSentDate: over.effectiveSentDate ?? "2026-07-20",
    sentDateOrigin: over.sentDateOrigin ?? "sent_at",
    effectiveTransportId: over.effectiveTransportId ?? "tr-1",
    transportName: over.transportName ?? "Transporte 1",
    identities: over.identities ?? buildIdentities({
      labelCustomerName: null,
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  };
}

function row(over: Partial<RemittanceMatchRow> = {}): RemittanceMatchRow {
  return {
    id: over.id ?? "row-1",
    rowIndex: over.rowIndex ?? 0,
    rawCustomerNameText: over.rawCustomerNameText ?? "ANA LOPEZ",
    parsedTransportDate: over.parsedTransportDate ?? "2026-07-20",
    parsedAmount: over.parsedAmount ?? 150000,
  };
}

console.log("\n=== matching.selftest ===\n");

// Nombre titular exacto
{
  const n = scoreName("ANA LOPEZ", buildIdentities({
    labelCustomerName: null,
    titularFullName: "ANA LOPEZ",
    additionalNames: null,
  }));
  assert(n.points === 35 && n.source === "titular", "nombre titular exacto → 35/titular");
}

// label exacto
{
  const n = scoreName("MARIA ELENA LOPEZ", buildIdentities({
    labelCustomerName: "MARIA ELENA LOPEZ",
    titularFullName: "OTRO NOMBRE",
    additionalNames: null,
  }));
  assert(n.points === 40 && n.source === "label", "label exacto → 40/label");
}

// sub-nombre exacto
{
  const n = scoreName("MARIA GOMEZ", buildIdentities({
    labelCustomerName: null,
    titularFullName: "ANA LOPEZ",
    additionalNames: [{ full_name: "MARIA GOMEZ" }],
  }));
  assert(n.points === 35 && n.source === "sub_name", "sub-nombre exacto → 35/sub_name");
}

// nombre invertido
{
  const n = scoreName("López María", buildIdentities({
    labelCustomerName: null,
    titularFullName: "MARIA LOPEZ",
    additionalNames: null,
  }));
  assert(
    n.points >= 25 && normalizeMatchName("López María") !== normalizeMatchName("x"),
    "nombre invertido → tokens ≥25"
  );
  assert(n.points === 25 || n.points === 35, `nombre invertido points=${n.points}`);
}

// nombre parcial
{
  const n = scoreName("Maria Elena Lopez", buildIdentities({
    labelCustomerName: null,
    titularFullName: "MARIA LOPEZ",
    additionalNames: null,
  }));
  assert(n.points === 25 || n.points === 12, `nombre parcial points=${n.points}`);
}

// fechas
assert(scoreDate("2026-07-20", "2026-07-20", "sent_at").points === 30, "misma fecha → 30");
assert(scoreDate("2026-07-21", "2026-07-20", "sent_at").points === 22, "fecha +1 → 22");
assert(scoreDate("2026-07-23", "2026-07-20", "sent_at").points === 12, "fecha +3 → 12");
assert(
  scoreDate("2026-07-20", "2026-07-20", "closed_at_fallback").points === 22,
  "closed_at_fallback exacta → 30-8=22"
);

// montos
assert(scoreAmount(150000, 150000).exact && scoreAmount(150000, 150000).points === 25, "monto exacto");
assert(scoreAmount(149000, 150000).points === 18, "monto -$1000 → 18");
assert(scoreAmount(145000, 150000).points === 8, "monto -$5000 → 8");

// transporte / etapas
{
  const c = baseCandidate({ id: "o1", identities: buildIdentities({
    labelCustomerName: "ANA LOPEZ",
    titularFullName: "ANA LOPEZ",
    additionalNames: null,
  })});
  const a = scoreCandidateAgainstRow(row(), c, "tr-1", "A");
  const b = scoreCandidateAgainstRow(row(), c, "tr-1", "B");
  assert(a.transport.points === 5, "Etapa A transporte +5");
  assert(b.transport.points === -15, "Etapa B transporte -15");
}

// auto_matched happy path
{
  const c = baseCandidate({
    id: "o-auto",
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const ranked = rankCandidatesForRow(row(), [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(row(), ranked, false);
  assert(result.rowStatus === "auto_matched", "score alto + monto exacto + Etapa A + nombre fuerte → auto_matched");
  assert(result.confidenceLabel === "alta", "confianza alta");
  assert(result.autoMatchReason === "strong_identity", "Vía A → strong_identity");
}

// score alto pero monto distinto → needs_review
{
  const c = baseCandidate({
    id: "o-amt",
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const r = row({ parsedAmount: 148000 });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false);
  assert(result.rowStatus === "needs_review", "score alto + monto distinto → needs_review");
  assert(result.willCreateIrregularity === true, "will_create_irregularity=true");
}

// score alto Etapa B → needs_review
{
  const c = baseCandidate({
    id: "o-b",
    effectiveTransportId: "tr-other",
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const ranked = rankCandidatesForRow(row(), [c], "tr-1", "B", new Map());
  const result = classifyRowFromCandidates(row(), ranked, true);
  assert(result.rowStatus === "needs_review", "score alto Etapa B → needs_review");
  assert(result.matchedViaBroadenedSearch === true, "matched_via_broadened_search");
}

// ambigüedad <10
{
  const c1 = baseCandidate({
    id: "o-amb1",
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const c2 = baseCandidate({
    id: "o-amb2",
    orderNumber: "A00002",
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const ranked = rankCandidatesForRow(row(), [c1, c2], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(row(), ranked, false);
  assert(result.rowStatus === "needs_review", "dos candidatos Δ<10 → needs_review");
  assert((result.matchBreakdown.ambiguous as boolean) === true, "ambiguous flag");
}

// sin candidato
{
  const result = classifyRowFromCandidates(row(), [], false);
  assert(result.rowStatus === "unassigned", "sin candidato → unassigned");
}

// transporte diferente (Etapa B score)
{
  const mediocreA = baseCandidate({
    id: "o-med",
    expectedAmount: 150000,
    identities: buildIdentities({
      labelCustomerName: null,
      titularFullName: "PEDRO PEREZ",
      additionalNames: null,
    }),
  });
  const betterB = baseCandidate({
    id: "o-best",
    effectiveTransportId: "tr-old",
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const out = matchRemittanceRows({
    remittanceTransportId: "tr-1",
    rows: [row()],
    poolA: [mediocreA],
    poolB: [mediocreA, betterB],
    approvedWarnings: new Map(),
  });
  assert(out.needsStageB === true, "transporte histórico: corre Etapa B");
  assert(out.results[0]!.matchedOrderId === "o-best", "elige candidato correcto de B");
  assert(out.results[0]!.rowStatus === "needs_review", "transporte distinto → needs_review");
}

// caso real sub-nombre
{
  const c = baseCandidate({
    id: "o-sub",
    identities: buildIdentities({
      labelCustomerName: null,
      titularFullName: "ANA LOPEZ",
      additionalNames: [{ full_name: "MARIA GOMEZ" }],
    }),
  });
  const r = row({ rawCustomerNameText: "MARIA GOMEZ" });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  assert(ranked[0]!.matchedNameSource === "sub_name", "caso real: match por sub_name");
  assert(classifyRowFromCandidates(r, ranked, false).rowStatus === "auto_matched", "sub-nombre exacto puede auto_match");
}

// mayo estimado
{
  const c = baseCandidate({
    id: "o-may",
    sentDateOrigin: "closed_at_fallback",
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const scored = scoreCandidateAgainstRow(row(), c, "tr-1", "A");
  assert(scored.date.originPenalty === 8, "mayo estimado: penalización closed_at");
  assert(scored.date.points === 22, "fecha exacta con fallback → 22");
}

// approved_pending_confirmation en otra rendición: sigue siendo candidato (no unassigned)
{
  const remittanceAId = "rem-a-0001";
  const orderId = "o-approved-elsewhere";
  const warnings = new Map<string, string>([
    [orderId, `También aprobado en otra rendición aún no confirmada (${remittanceAId}).`],
  ]);
  const c = baseCandidate({
    id: orderId,
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const r = row({ id: "row-b", rawCustomerNameText: "ANA LOPEZ" });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", warnings);
  assert(ranked[0]?.orderId === orderId, "approved_pending en A: sigue TOP 1 en B");
  assert(
    ranked[0]?.warningApprovedElsewhere?.includes(remittanceAId) === true,
    "approved_pending: advertencia con id de otra rendición"
  );
  const result = classifyRowFromCandidates(r, ranked, false);
  assert(result.rowStatus === "auto_matched", "approved_pending + match perfecto → auto_matched (no unassigned)");
  assert(result.matchedOrderId === orderId, "approved_pending: matched_order_id del candidato");
  assert(
    String(result.matchBreakdown.warningApprovedElsewhere || "").includes("no confirmada"),
    "approved_pending: warning en match_breakdown"
  );
  // El warning no cambia el score respecto al mismo candidato sin warning
  const rankedClean = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  assert(ranked[0]!.score === rankedClean[0]!.score, "approved_pending: no penaliza score");
}

// unassigned → matched_order_id null (aunque haya candidato débil en candidates)
{
  const weak = baseCandidate({
    id: "o-weak",
    expectedAmount: 999999,
    effectiveSentDate: "2026-01-01",
    identities: buildIdentities({
      labelCustomerName: null,
      titularFullName: "ZZZ NO MATCH",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "OTRO NOMBRE TOTALMENTE DISTINTO",
    parsedTransportDate: "2026-12-31",
    parsedAmount: 1000,
  });
  const ranked = rankCandidatesForRow(r, [weak], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false);
  assert(result.rowStatus === "unassigned", `candidato débil → unassigned (score=${ranked[0]?.score})`);
  assert(result.matchedOrderId === null, "unassigned ⇒ matched_order_id NULL");
}

// ─── Vía B — unique_financial_logistics ─────────────────────────────────────

// PRIETTO-like: name 12, monto/fecha/transporte exactos, triplete único, gap 29
{
  const prietto = baseCandidate({
    id: "o-prietto",
    orderNumber: "A55180",
    expectedAmount: 92300,
    effectiveSentDate: "2026-07-20",
    identities: buildIdentities({
      labelCustomerName: "YANINA ELIZABETH PRIETTO",
      titularFullName: "YANINA ELIZABETH PRIETTO",
      additionalNames: null,
    }),
  });
  const decoy = baseCandidate({
    id: "o-decoy",
    orderNumber: "A55177",
    expectedAmount: 96000, // distinto → no entra al triplete
    effectiveSentDate: "2026-07-20",
    identities: buildIdentities({
      labelCustomerName: "OTRO",
      titularFullName: "OTRO",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "PRIETTO YANNINA ELIZABETH",
    parsedTransportDate: "2026-07-20",
    parsedAmount: 92300,
  });
  const name = scoreName(r.rawCustomerNameText, prietto.identities);
  assert(name.points === 12 && name.quality === "partial", "PRIETTO: name 12/partial");
  const ranked = rankCandidatesForRow(r, [prietto, decoy], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false);
  assert(result.rowStatus === "auto_matched", "PRIETTO Vía B → auto_matched");
  assert(
    result.autoMatchReason === "unique_financial_logistics",
    "PRIETTO → unique_financial_logistics"
  );
  assert((result.matchBreakdown.autoMatchReason as string) === "unique_financial_logistics", "breakdown reason");
  const gap = Number(result.matchBreakdown.scoreGap);
  assert(gap >= 10, `PRIETTO gap>=10 (got ${gap})`);
}

// name=0 con triplete único → needs_review
{
  const c = baseCandidate({
    id: "o-noname",
    expectedAmount: 50000,
    effectiveSentDate: "2026-07-20",
    identities: buildIdentities({
      labelCustomerName: "ZZZ TOTALMENTE DISTINTO",
      titularFullName: "ZZZ TOTALMENTE DISTINTO",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "AAAA BBBB CCCC",
    parsedAmount: 50000,
    parsedTransportDate: "2026-07-20",
  });
  const name = scoreName(r.rawCustomerNameText, c.identities);
  assert(name.points === 0, "name=0 setup");
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false);
  assert(result.rowStatus === "needs_review", "name=0 + triplete único → needs_review");
  assert(result.autoMatchReason === null, "name=0 sin autoMatchReason");
}

// name>0 pero dos pedidos mismo triplete → needs_review
{
  const c1 = baseCandidate({
    id: "o-dup1",
    orderNumber: "A1",
    expectedAmount: 88000,
    effectiveSentDate: "2026-07-15",
    identities: buildIdentities({
      labelCustomerName: "LILIANA YOLANDA ROLIN",
      titularFullName: "LILIANA YOLANDA ROLIN",
      additionalNames: null,
    }),
  });
  const c2 = baseCandidate({
    id: "o-dup2",
    orderNumber: "A2",
    expectedAmount: 88000,
    effectiveSentDate: "2026-07-15",
    identities: buildIdentities({
      labelCustomerName: "OTRA PERSONA",
      titularFullName: "OTRA PERSONA",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "ROLIN LILIANA YOLANDA",
    parsedAmount: 88000,
    parsedTransportDate: "2026-07-15",
  });
  const ranked = rankCandidatesForRow(r, [c1, c2], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false);
  assert(result.rowStatus === "needs_review", "dos pedidos mismo triplete → needs_review");
}

// monto distinto → nunca Vía B
{
  const c = baseCandidate({
    id: "o-amt-b",
    expectedAmount: 92300,
    identities: buildIdentities({
      labelCustomerName: "YANINA ELIZABETH PRIETTO",
      titularFullName: "YANINA ELIZABETH PRIETTO",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "PRIETTO YANNINA ELIZABETH",
    parsedAmount: 90000,
    parsedTransportDate: "2026-07-20",
  });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false);
  assert(result.rowStatus !== "auto_matched" || result.autoMatchReason !== "unique_financial_logistics",
    "monto distinto → nunca Vía B");
  assert(result.rowStatus === "needs_review", "monto distinto → needs_review");
}

// fecha distinta → nunca Vía B
{
  const c = baseCandidate({
    id: "o-date-b",
    expectedAmount: 92300,
    effectiveSentDate: "2026-07-20",
    identities: buildIdentities({
      labelCustomerName: "YANINA ELIZABETH PRIETTO",
      titularFullName: "YANINA ELIZABETH PRIETTO",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "PRIETTO YANNINA ELIZABETH",
    parsedAmount: 92300,
    parsedTransportDate: "2026-07-21",
  });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false);
  assert(result.autoMatchReason !== "unique_financial_logistics", "fecha distinta → nunca Vía B");
  assert(result.rowStatus === "needs_review", "fecha distinta → needs_review");
}

// transporte distinto (Etapa B scoring) → nunca Vía B
{
  const c = baseCandidate({
    id: "o-tr-b",
    expectedAmount: 92300,
    effectiveTransportId: "tr-other",
    identities: buildIdentities({
      labelCustomerName: "YANINA ELIZABETH PRIETTO",
      titularFullName: "YANINA ELIZABETH PRIETTO",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "PRIETTO YANNINA ELIZABETH",
    parsedAmount: 92300,
    parsedTransportDate: "2026-07-20",
  });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "B", new Map());
  const result = classifyRowFromCandidates(r, ranked, false);
  assert(result.autoMatchReason !== "unique_financial_logistics", "transporte distinto → nunca Vía B");
}

// gap <10 → needs_review (dos candidatos score cercanos con name débil)
{
  const c1 = baseCandidate({
    id: "o-gap1",
    orderNumber: "G1",
    expectedAmount: 268000,
    effectiveSentDate: "2026-07-17",
    identities: buildIdentities({
      labelCustomerName: "ZZZ NO MATCH ONE",
      titularFullName: "ZZZ NO MATCH ONE",
      additionalNames: null,
    }),
  });
  const c2 = baseCandidate({
    id: "o-gap2",
    orderNumber: "G2",
    expectedAmount: 268000,
    effectiveSentDate: "2026-07-17",
    identities: buildIdentities({
      labelCustomerName: "ZZZ NO MATCH TWO",
      titularFullName: "ZZZ NO MATCH TWO",
      additionalNames: null,
    }),
  });
  // Same triplet → Via B blocked by count=2 anyway; also ensure gap path:
  // Use different amounts so only one is exact match but scores close via date+transport
  const cExact = baseCandidate({
    id: "o-gap-exact",
    orderNumber: "GX",
    expectedAmount: 97400,
    effectiveSentDate: "2026-07-17",
    identities: buildIdentities({
      labelCustomerName: "NO MATCH NAME XXX",
      titularFullName: "NO MATCH NAME XXX",
      additionalNames: null,
    }),
  });
  const cNear = baseCandidate({
    id: "o-gap-near",
    orderNumber: "GY",
    expectedAmount: 98000, // close amount → similar score without exact
    effectiveSentDate: "2026-07-17",
    identities: buildIdentities({
      labelCustomerName: "NO MATCH NAME YYY",
      titularFullName: "NO MATCH NAME YYY",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "HETER ROCIO",
    parsedAmount: 97400,
    parsedTransportDate: "2026-07-17",
  });
  // name=0 for both; if somehow unique triplet with name=0 still needs_review
  void c1; void c2;
  const ranked = rankCandidatesForRow(r, [cExact, cNear], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false);
  const gap = ranked.length > 1 ? ranked[0]!.score - ranked[1]!.score : 999;
  if (gap < 10) {
    assert(result.rowStatus === "needs_review", "gap <10 → needs_review");
    assert(result.autoMatchReason === null, "gap <10 sin Vía B");
  } else {
    // name=0 blocks Via B regardless
    assert(result.rowStatus === "needs_review", "name=0 bloquea Vía B aunque gap alto");
  }
}

// Etapa B / usedStageB → nunca Vía B
{
  const c = baseCandidate({
    id: "o-stageb",
    expectedAmount: 92300,
    identities: buildIdentities({
      labelCustomerName: "YANINA ELIZABETH PRIETTO",
      titularFullName: "YANINA ELIZABETH PRIETTO",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "PRIETTO YANNINA ELIZABETH",
    parsedAmount: 92300,
    parsedTransportDate: "2026-07-20",
  });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, true);
  assert(result.rowStatus === "needs_review", "usedStageB → nunca Vía B (needs_review)");
  assert(result.autoMatchReason === null, "usedStageB sin autoMatchReason");
}

// Vía A intacta: nombre fuerte sigue strong_identity (no Vía B)
{
  const c = baseCandidate({
    id: "o-via-a",
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const ranked = rankCandidatesForRow(row(), [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(row(), ranked, false);
  assert(result.rowStatus === "auto_matched", "Vía A intacta → auto_matched");
  assert(result.autoMatchReason === "strong_identity", "Vía A → strong_identity (no Vía B)");
}

console.log(`\nResultado: ${passed} ok, ${failed} fail\n`);
if (failed > 0) process.exit(1);
