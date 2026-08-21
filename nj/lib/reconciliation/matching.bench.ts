/**
 * Bench matching in-memory 70 / 200 / 500 filas.
 * Ejecutar desde nj/: npx --yes tsx lib/reconciliation/matching.bench.ts
 */
import {
  buildIdentities,
  matchRemittanceRows,
  type CodCandidateOrder,
  type RemittanceMatchRow,
} from "./matching";

function makePool(size: number, transportId: string): CodCandidateOrder[] {
  const pool: CodCandidateOrder[] = [];
  for (let i = 0; i < size; i++) {
    const name = `CLIENTE PRUEBA ${String(i).padStart(4, "0")}`;
    pool.push({
      id: `ord-${i}`,
      orderNumber: `A${10000 + i}`,
      customerId: `cust-${i % 100}`,
      expectedAmount: 100000 + (i % 50) * 1000,
      effectiveSentDate: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
      sentDateOrigin: i % 5 === 0 ? "closed_at_fallback" : "sent_at",
      effectiveTransportId: i % 7 === 0 ? "tr-other" : transportId,
      transportName: "Bench Transport",
      identities: buildIdentities({
        labelCustomerName: i % 3 === 0 ? name : null,
        titularFullName: name,
        additionalNames: i % 11 === 0 ? [{ full_name: `ALIAS ${i}` }] : null,
      }),
    });
  }
  return pool;
}

function makeRows(n: number, pool: CodCandidateOrder[]): RemittanceMatchRow[] {
  const rows: RemittanceMatchRow[] = [];
  for (let i = 0; i < n; i++) {
    const c = pool[i % pool.length]!;
    const exact = i % 4 !== 3;
    rows.push({
      id: `row-${i}`,
      rowIndex: i,
      rawCustomerNameText: exact
        ? c.identities[0]?.raw ?? "DESCONOCIDO"
        : `NO MATCH ${i}`,
      parsedTransportDate: c.effectiveSentDate,
      parsedAmount: exact ? c.expectedAmount : c.expectedAmount - 2000,
    });
  }
  return rows;
}

function run(label: string, rowCount: number) {
  const poolAll = makePool(2500, "tr-1");
  const poolA = poolAll.filter((c) => c.effectiveTransportId === "tr-1");
  const rows = makeRows(rowCount, poolA);
  const poolBOnly = poolAll.filter((c) => c.effectiveTransportId !== "tr-1");
  const t0 = Date.now();
  const full = matchRemittanceRows({
    remittanceTransportId: "tr-1",
    rows,
    poolA,
    poolB: poolBOnly,
    approvedWarnings: new Map(),
  });
  const totalScoreMs = Date.now() - t0;
  console.log(
    JSON.stringify(
      {
        label,
        rowCount,
        poolA: poolA.length,
        poolB: poolBOnly.length,
        needsStageB: full.needsStageB,
        totalScoreMs,
        auto: full.autoMatched,
        review: full.needsReview,
        unassigned: full.unassigned,
      },
      null,
      0
    )
  );
}

console.log("=== matching.bench ===");
run("70", 70);
run("200", 200);
run("500", 500);
