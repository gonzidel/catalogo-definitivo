/**
 * Selftest presentación titular vs matchedNameSnapshot (UX, sin scoring).
 */
import {
  candidateMatchByHint,
  candidatePrimaryName,
  type CandidateDisplay,
} from "@/lib/reconciliation/match-presentation";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log("\n=== match-presentation.selftest ===\n");

// ORTEGA case: name score 0 → matchedNameSnapshot null, pero titular existe
{
  const c: CandidateDisplay = {
    orderId: "4b159b71-42f8-43d5-95b1-e417e1b8d034",
    orderNumber: "A55083",
    customerId: "206c268e-75ba-411a-b0d7-78d93875e462",
    customerDisplayName: "BARRETO ROMINA",
    labelCustomerName: "BARRETO ROMINA",
    matchedNameSnapshot: null,
    matchedNameSource: null,
    name: { points: 0, matchedName: null, source: null },
    expectedAmount: 114300,
  };
  assert(candidatePrimaryName(c) === "BARRETO ROMINA", "ORTEGA/A55083 → titular");
  assert(candidateMatchByHint(c) === null, "sin match de nombre → sin hint");
}

// Preferir titular sobre matchedNameSnapshot (sub-nombre)
{
  const c: CandidateDisplay = {
    orderNumber: "A100",
    customerDisplayName: "MAIRA ORTEGA",
    matchedNameSnapshot: "ORTEGA MAIRA",
    matchedNameSource: "sub_name",
  };
  assert(candidatePrimaryName(c) === "MAIRA ORTEGA", "titular gana a snapshot");
  assert(
    candidateMatchByHint(c) === "✓ Sub-nombre reconocido: ORTEGA MAIRA",
    "hint sub-nombre"
  );
}

// Fallback label si no hay titular
{
  const c: CandidateDisplay = {
    labelCustomerName: "CANTERO CYNTIA",
    matchedNameSnapshot: null,
  };
  assert(candidatePrimaryName(c) === "CANTERO CYNTIA", "label fallback");
}

// Snapshot solo si no hay titular/label
{
  const c: CandidateDisplay = {
    matchedNameSnapshot: "SOLO SNAPSHOT",
    matchedNameSource: "label",
  };
  assert(candidatePrimaryName(c) === "SOLO SNAPSHOT", "snapshot último útil");
}

// Último recurso
{
  assert(candidatePrimaryName({}) === "Cliente sin nombre", "último recurso");
}

// Alias COD
{
  const c: CandidateDisplay = {
    customerDisplayName: "ROCIO HERTER",
    transportName: "SEDE",
    matchedNameSnapshot: null,
  };
  assert(
    candidateMatchByHint(c, { aliasRaw: "HETER ROCIO", transportName: "SEDE" }) ===
      "✓ Nombre reconocido para este cliente en SEDE: HETER ROCIO",
    "hint alias"
  );
}

console.log("match-presentation.selftest: OK\n");
