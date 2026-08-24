/**
 * Selftest — pedido ya rendido / ya usado (informativo, no seleccionable).
 */
import {
  isStrongAlreadyUsedEvidence,
  pickBestAlreadyUsedMatch,
  type OrderCodOccupancy,
} from "./already-used-match";
import {
  buildIdentities,
  scoreCandidateAgainstRow,
  type CodCandidateOrder,
  type RemittanceMatchRow,
} from "./matching";

let ok = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    ok += 1;
    console.log(`  OK  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
  }
}

console.log("\n=== already-used-match.selftest ===\n");

function cand(over: Partial<CodCandidateOrder> & { id: string }): CodCandidateOrder {
  const identities =
    over.identities ??
    buildIdentities({
      labelCustomerName: "BENTANCURT MARIELA",
      titularFullName: "BENTANCURT MARIELA",
      additionalNames: null,
    });
  const titular = identities.find((i) => i.source === "titular")?.raw ?? null;
  const label = identities.find((i) => i.source === "label")?.raw ?? null;
  return {
    id: over.id,
    orderNumber: over.orderNumber ?? "A54946",
    customerId: over.customerId ?? "cust-2474",
    customerDisplayName: over.customerDisplayName ?? titular,
    customerNumber: over.customerNumber ?? "2474",
    labelCustomerName: over.labelCustomerName ?? label,
    expectedAmount: over.expectedAmount ?? 160700,
    effectiveSentDate: over.effectiveSentDate ?? "2026-07-13",
    sentDateOrigin: over.sentDateOrigin ?? "sent_at",
    effectiveTransportId: over.effectiveTransportId ?? "tr-sede",
    transportName: over.transportName ?? "SEDE",
    identities,
  };
}

const rowBentancurt: RemittanceMatchRow = {
  id: "row-b",
  rowIndex: 82,
  rawCustomerNameText: "BENTANCURT MARIELA",
  parsedTransportDate: "2026-07-13",
  parsedAmount: 16700,
};

{
  const c = cand({ id: "o-a54946" });
  const scored = scoreCandidateAgainstRow(rowBentancurt, c, "tr-sede", "A", null);
  assert(scored.name.points >= 35, "BENTANCURT: nombre fuerte");
  assert(scored.date.dayDiff === 0, "BENTANCURT: fecha exacta");
  assert(isStrongAlreadyUsedEvidence({ scored }), "BENTANCURT: evidencia ya usado");
}

{
  // Solo monto/fecha — NO
  const c = cand({
    id: "o-wrong-name",
    identities: buildIdentities({
      labelCustomerName: "OTRO CLIENTE",
      titularFullName: "OTRO CLIENTE",
      additionalNames: null,
    }),
  });
  const scored = scoreCandidateAgainstRow(rowBentancurt, c, "tr-sede", "A", null);
  assert(scored.name.points === 0, "nombre 0 setup");
  assert(!isStrongAlreadyUsedEvidence({ scored }), "sin nombre → no aviso ya usado");
}

{
  const occupancy: OrderCodOccupancy = {
    orderId: "o-a54946",
    kind: "confirmed_with_diff",
    otherRemittanceId: "rem-other",
    otherRemittanceDate: "2026-07-21",
    otherTransportName: "SEDE",
    otherReportedAmount: 144000,
    otherRowStatus: "confirmed_with_irregularity",
    otherRowId: "row-other-3",
    otherRowIndex: 3,
    otherRawCustomerName: "BENTANCURT MARIELA",
    irregularityStatus: "open",
    amountDiff: -16700,
    expectedAmountSnapshot: 160700,
    activeReportedTotal: 144000,
  };
  const hit = pickBestAlreadyUsedMatch({
    row: rowBentancurt,
    remittanceTransportId: "tr-sede",
    candidates: [cand({ id: "o-a54946" })],
    occupancyByOrderId: new Map([["o-a54946", occupancy]]),
    customerNumberByOrderId: new Map([["o-a54946", "2474"]]),
    currentRemittanceId: "rem-current-bentancurt",
  });
  assert(!!hit, "pickBest encuentra A54946");
  assert(hit?.orderNumber === "A54946", "order number");
  assert(hit?.kind === "confirmed_with_diff", "kind con diferencia");
  assert(hit?.customerNumber === "2474", "nº cliente");
  assert(hit?.irregularityStatus === "open", "reclamo abierto");
  assert(hit?.otherReportedAmount === 144000, "monto informado otra rendición");
  assert(hit?.sameRemittance === false, "otra planilla (no misma)");
  assert(hit?.remainingBalance === 16700, "saldo pendiente 16700");
}

{
  const occupancySame: OrderCodOccupancy = {
    orderId: "o-a54946",
    kind: "confirmed_with_diff",
    otherRemittanceId: "rem-same",
    otherRemittanceDate: "2026-07-21",
    otherTransportName: "SEDE",
    otherReportedAmount: 144000,
    otherRowStatus: "confirmed_with_irregularity",
    otherRowId: "row-28",
    otherRowIndex: 28,
    otherRawCustomerName: "BENTANCURT MARIELA",
    irregularityStatus: "open",
    amountDiff: -16700,
    expectedAmountSnapshot: 160700,
    activeReportedTotal: 144000,
  };
  const hitSame = pickBestAlreadyUsedMatch({
    row: rowBentancurt,
    remittanceTransportId: "tr-sede",
    candidates: [cand({ id: "o-a54946" })],
    occupancyByOrderId: new Map([["o-a54946", occupancySame]]),
    currentRemittanceId: "rem-same",
  });
  assert(hitSame?.sameRemittance === true, "misma planilla");
  assert(hitSame?.otherRowIndex === 28, "fila #28 de esta planilla");
}

{
  // Fecha lejos + nombre exacto pero >7 días → no
  const c = cand({ id: "o-far", effectiveSentDate: "2026-08-20" });
  const scored = scoreCandidateAgainstRow(rowBentancurt, c, "tr-sede", "A", null);
  assert((scored.date.dayDiff ?? 0) > 7, "fecha lejos");
  assert(!isStrongAlreadyUsedEvidence({ scored }), "fecha lejos → no aviso");
}

console.log(`\nResultado: ${ok} ok, ${fail} fail\n`);
if (fail > 0) process.exit(1);
