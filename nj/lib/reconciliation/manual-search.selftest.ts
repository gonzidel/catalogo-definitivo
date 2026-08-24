/**
 * Selftest búsqueda manual / Nº de pedido (sin DB).
 */
import { normalizeOrderNumberQuery } from "@/lib/reconciliation/manual-search";
import { scoreAmount, scoreDate, scoreName, buildIdentities } from "@/lib/reconciliation/matching";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log("\n=== manual-search.selftest ===\n");

{
  assert(normalizeOrderNumberQuery("A54945") === "A54945", "A54945");
  assert(normalizeOrderNumberQuery("a54945") === "A54945", "lowercase");
  assert(normalizeOrderNumberQuery("54945") === "A54945", "sin A");
  assert(normalizeOrderNumberQuery("  A54945  ") === "A54945", "trim");
  assert(normalizeOrderNumberQuery("ORTEGA MAIRA") === null, "nombre ≠ Nº");
  assert(normalizeOrderNumberQuery("A12") === null, "demasiado corto");
}

// Hipotético: si A54945 fuera COD, score esperado (no entra al pool hoy por Pagado)
{
  const name = scoreName(
    "ORTEGA MAIRA",
    buildIdentities({
      labelCustomerName: "ORTEGA MAIRA",
      titularFullName: "ORTEGA MAIRA",
      additionalNames: null,
    })
  );
  assert(name.points === 40 && name.source === "label", "nombre exacto label 40");
  const date = scoreDate("2026-07-16", "2026-07-16", "sent_at");
  assert(date.points === 30 && date.dayDiff === 0, "fecha exacta 30");
  const amount = scoreAmount(75495, 71900);
  assert(amount.points === 8 && amount.amountDiff === 3595, "monto ±5k → 8 pts, diff +3595");
  const total = name.points + date.points + amount.points + 5;
  assert(total === 83, `score hipotético COD = 83 (got ${total})`);
}

console.log("manual-search.selftest: OK\n");
