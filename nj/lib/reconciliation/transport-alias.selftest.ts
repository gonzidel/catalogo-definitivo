/**
 * Self-tests Vía C (transport_alias) + normalización paridad SQL.
 * Ejecutar: npx tsx nj/lib/reconciliation/transport-alias.selftest.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildIdentities,
  classifyRowFromCandidates,
  matchRemittanceRows,
  rankCandidatesForRow,
  scoreName,
  type CodCandidateOrder,
  type RemittanceMatchRow,
  type TransportAliasHit,
} from "./matching";
import { normalizeCodAliasName } from "./name-normalize";
import { buildAliasMap } from "./candidate-pool";

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
  const identities =
    over.identities ??
    buildIdentities({
      labelCustomerName: null,
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    });
  const titular = identities.find((i) => i.source === "titular")?.raw ?? null;
  const label = identities.find((i) => i.source === "label")?.raw ?? null;
  return {
    id: over.id,
    orderNumber: over.orderNumber ?? "A00001",
    customerId: over.customerId ?? "cust-1",
    customerDisplayName: over.customerDisplayName ?? titular,
    customerNumber: over.customerNumber ?? null,
    labelCustomerName: over.labelCustomerName ?? label,
    expectedAmount: over.expectedAmount ?? 150000,
    effectiveSentDate: over.effectiveSentDate ?? "2026-07-20",
    sentDateOrigin: over.sentDateOrigin ?? "sent_at",
    effectiveTransportId: over.effectiveTransportId ?? "tr-1",
    transportName: over.transportName ?? "SEDE",
    identities,
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

const HETER_ALIAS: TransportAliasHit = {
  aliasId: "alias-heter",
  customerId: "cust-2194",
  rawAlias: "HETER ROCIO",
  normalizedAlias: normalizeCodAliasName("HETER ROCIO"),
};

console.log("\n=== transport-alias.selftest ===\n");

// ─── 19. Normalización TS ≡ SQL (_cod_normalize_match_name) ──────────────────
{
  assert(normalizeCodAliasName("HETER ROCIO") === "heter rocio", "HETER ROCIO");
  assert(normalizeCodAliasName(" heter   rocio ") === "heter rocio", "espacios dobles");
  assert(normalizeCodAliasName("HÉTER ROCÍO") === "heter rocio", "tildes");
  assert(normalizeCodAliasName("MIÑO JESICA") === "mino jesica", "Ñ → n (documentado)");
  assert(normalizeCodAliasName("ÑANDU") === "nandu", "Ñ inicial → n");
  assert(normalizeCodAliasName("A.B,C;D") === "a b c d", "puntuación → espacios");
  assert(
    normalizeCodAliasName("ROCIO HETER") === "rocio heter",
    "orden de tokens NO se altera"
  );
  assert(normalizeCodAliasName("HeTeR RoCiO") === "heter rocio", "mayúsculas/minúsculas");
}

// ─── 1. Alias + pedido único + fecha/monto exactos → transport_alias ─────────
{
  const c = baseCandidate({
    id: "o-heter",
    orderNumber: "A55117",
    customerId: "cust-2194",
    expectedAmount: 97400,
    effectiveSentDate: "2026-07-17",
    identities: buildIdentities({
      labelCustomerName: "ROCIO HERTER",
      titularFullName: "ROCIO HERTER",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "HETER ROCIO",
    parsedAmount: 97400,
    parsedTransportDate: "2026-07-17",
  });
  assert(scoreName(r.rawCustomerNameText, c.identities).points === 0, "sin alias name=0");
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false, HETER_ALIAS);
  assert(result.rowStatus === "auto_matched", "1: auto_matched");
  assert(result.autoMatchReason === "transport_alias", "1: transport_alias");
  assert(result.matchBreakdown.aliasId === "alias-heter", "1: aliasId metadata");
  assert(result.matchBreakdown.aliasCustomerId === "cust-2194", "1: aliasCustomerId");
  assert(result.matchedNameSnapshot === null, "1: snapshot no es el alias (RPC identities)");
  assert(result.matchedNameSource === null, "1: source null si name=0");
  assert(result.matchBreakdown.aliasRaw === "HETER ROCIO", "1: alias en breakdown");
}

// ─── 2. Alias + monto distinto → needs_review ────────────────────────────────
{
  const c = baseCandidate({
    id: "o-amt",
    customerId: "cust-2194",
    expectedAmount: 97400,
    effectiveSentDate: "2026-07-17",
    identities: buildIdentities({
      labelCustomerName: "ROCIO HERTER",
      titularFullName: "ROCIO HERTER",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "HETER ROCIO",
    parsedAmount: 90000,
    parsedTransportDate: "2026-07-17",
  });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false, HETER_ALIAS);
  assert(result.autoMatchReason !== "transport_alias", "2: monto distinto nunca Vía C");
  assert(result.rowStatus === "needs_review" || result.rowStatus === "unassigned", "2: no auto");
}

// ─── 3. Alias + fecha distinta → no auto por alias ───────────────────────────
{
  const c = baseCandidate({
    id: "o-date",
    customerId: "cust-2194",
    expectedAmount: 97400,
    effectiveSentDate: "2026-07-17",
    identities: buildIdentities({
      labelCustomerName: "ROCIO HERTER",
      titularFullName: "ROCIO HERTER",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "HETER ROCIO",
    parsedAmount: 97400,
    parsedTransportDate: "2026-07-20",
  });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false, HETER_ALIAS);
  assert(result.autoMatchReason !== "transport_alias", "3: fecha distinta nunca Vía C");
}

// ─── 4. Alias + 2 pedidos compatibles del customer → no elegir ───────────────
{
  const c1 = baseCandidate({
    id: "o-dup1",
    orderNumber: "A1",
    customerId: "cust-2194",
    expectedAmount: 97400,
    effectiveSentDate: "2026-07-17",
  });
  const c2 = baseCandidate({
    id: "o-dup2",
    orderNumber: "A2",
    customerId: "cust-2194",
    expectedAmount: 97400,
    effectiveSentDate: "2026-07-17",
  });
  const r = row({
    rawCustomerNameText: "HETER ROCIO",
    parsedAmount: 97400,
    parsedTransportDate: "2026-07-17",
  });
  const ranked = rankCandidatesForRow(r, [c1, c2], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false, HETER_ALIAS);
  assert(result.autoMatchReason !== "transport_alias", "4: 2 pedidos → no Vía C");
}

// ─── 5. Alias inexistente → comportamiento actual ────────────────────────────
{
  const c = baseCandidate({
    id: "o-noalias",
    customerId: "cust-2194",
    expectedAmount: 97400,
    effectiveSentDate: "2026-07-17",
    identities: buildIdentities({
      labelCustomerName: "ROCIO HERTER",
      titularFullName: "ROCIO HERTER",
      additionalNames: null,
    }),
  });
  const r = row({
    rawCustomerNameText: "HETER ROCIO",
    parsedAmount: 97400,
    parsedTransportDate: "2026-07-17",
  });
  const ranked = rankCandidatesForRow(r, [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false, null);
  assert(result.rowStatus === "needs_review", "5: sin alias → needs_review (name=0)");
  assert(result.autoMatchReason === null, "5: sin autoMatchReason");
}

// ─── 10. additional_names sigue igual ────────────────────────────────────────
{
  const c = baseCandidate({
    id: "o-sub",
    identities: buildIdentities({
      labelCustomerName: null,
      titularFullName: "TITULAR OTRO",
      additionalNames: [{ full_name: "MARIA GOMEZ" }],
    }),
  });
  const n = scoreName("MARIA GOMEZ", c.identities);
  assert(n.points === 35 && n.source === "sub_name", "10: additional_names intacto");
}

// ─── 11. Vía A strong_identity intacta ───────────────────────────────────────
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
  const result = classifyRowFromCandidates(row(), ranked, false, null);
  assert(result.autoMatchReason === "strong_identity", "11: Vía A intacta");
}

// ─── 12. Vía B unique_financial_logistics intacta ────────────────────────────
{
  const prietto = baseCandidate({
    id: "o-prietto",
    orderNumber: "A55180",
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
  });
  const ranked = rankCandidatesForRow(r, [prietto], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(r, ranked, false, null);
  assert(result.autoMatchReason === "unique_financial_logistics", "12: Vía B intacta");
}

// ─── Prioridad A > C: nombre fuerte gana aunque haya alias ───────────────────
{
  const c = baseCandidate({
    id: "o-prio",
    customerId: "cust-2194",
    expectedAmount: 150000,
    identities: buildIdentities({
      labelCustomerName: "ANA LOPEZ",
      titularFullName: "ANA LOPEZ",
      additionalNames: null,
    }),
  });
  const alias: TransportAliasHit = {
    aliasId: "a1",
    customerId: "cust-2194",
    rawAlias: "ANA LOPEZ",
    normalizedAlias: "ana lopez",
  };
  const ranked = rankCandidatesForRow(row(), [c], "tr-1", "A", new Map());
  const result = classifyRowFromCandidates(row(), ranked, false, alias);
  assert(result.autoMatchReason === "strong_identity", "prioridad A sobre C");
}

// ─── 9. Alias desactivado (no en mapa) → ignorado ────────────────────────────
{
  const map = buildAliasMap([
    {
      id: "x",
      customer_id: "cust-2194",
      raw_alias: "HETER ROCIO",
      normalized_alias: "heter rocio",
      is_active: false,
    },
  ]);
  assert(map.size === 0, "9: alias inactivo no entra al mapa");
}

// ─── 20. buildAliasMap sin N+1 (una estructura) ──────────────────────────────
{
  const map = buildAliasMap([
    {
      id: "a1",
      customer_id: "c1",
      raw_alias: "HETER ROCIO",
      normalized_alias: "heter rocio",
      is_active: true,
    },
    {
      id: "a2",
      customer_id: "c1",
      raw_alias: "ROCIO HETER",
      normalized_alias: "rocio heter",
      is_active: true,
    },
  ]);
  assert(map.size === 2, "20: múltiples aliases mismo customer OK");
  assert(map.get("heter rocio")?.customerId === "c1", "20: lookup O(1)");
}

// ─── matchRemittanceRows con aliasesByNormalized ─────────────────────────────
{
  const c = baseCandidate({
    id: "o-mino",
    orderNumber: "A55090",
    customerId: "cust-mino",
    expectedAmount: 268000,
    effectiveSentDate: "2026-07-17",
    identities: buildIdentities({
      labelCustomerName: "MINO JESSICA",
      titularFullName: "MIÑO, JESSICA",
      additionalNames: null,
    }),
  });
  const r = row({
    id: "row-mino",
    rawCustomerNameText: "MIÑO JESICA",
    parsedAmount: 268000,
    parsedTransportDate: "2026-07-17",
  });
  const aliasMap = new Map<string, TransportAliasHit>([
    [
      normalizeCodAliasName("MIÑO JESICA"),
      {
        aliasId: "alias-mino",
        customerId: "cust-mino",
        rawAlias: "MIÑO JESICA",
        normalizedAlias: normalizeCodAliasName("MIÑO JESICA"),
      },
    ],
  ]);
  const out = matchRemittanceRows({
    remittanceTransportId: "tr-1",
    rows: [r],
    poolA: [c],
    poolB: null,
    approvedWarnings: new Map(),
    aliasesByNormalized: aliasMap,
  });
  assert(out.autoMatched === 1, "MIÑO simulado → auto");
  assert(out.results[0]!.autoMatchReason === "transport_alias", "MIÑO → transport_alias");
  // Snapshot debe ser identidad del pedido (o null), nunca el texto alias de planilla
  const snap = out.results[0]!.matchedNameSnapshot;
  assert(
    snap === null ||
      snap === "MINO JESSICA" ||
      snap === "MIÑO, JESSICA",
    "MIÑO: snapshot ∈ identidades pedido, no alias planilla"
  );
  assert(out.results[0]!.matchedNameSnapshot !== "MIÑO JESICA", "MIÑO: no persistir raw alias");
}

// ─── SQL estático: migrations / RPC / no mutan orders ────────────────────────
{
  const root = resolve(__dirname, "../../../supabase/canonical");
  const sql281 = readFileSync(resolve(root, "281_cod_transport_customer_aliases_schema.sql"), "utf8");
  const sql283 = readFileSync(resolve(root, "283_rpc_cod_transport_customer_aliases.sql"), "utf8");
  const sql279 = readFileSync(resolve(root, "279_rpc_cod_approve_and_assign.sql"), "utf8");
  const sql280 = readFileSync(resolve(root, "280_rpc_cod_confirm_remittance.sql"), "utf8");

  assert(/alias_created/.test(sql281) && /alias_reassigned/.test(sql281), "event_type ampliado");
  assert(/UNIQUE \(transport_id, normalized_alias\)/.test(sql281), "UNIQUE transport+norm");
  assert(/rpc_cod_remember_transport_alias/.test(sql283), "remember RPC");
  assert(/rpc_cod_set_transport_alias_active/.test(sql283), "deactivate RPC");
  assert(/rpc_cod_reassign_transport_alias/.test(sql283), "reassign RPC");
  assert(/alias_conflict/.test(sql283), "13/14: conflict path");
  assert(/alias_reactivated/.test(sql283), "15: reactivate");
  assert(/previous_customer_id/.test(sql283) && /new_customer_id/.test(sql283), "16: reassign audit");
  assert(/source_row_not_found/.test(sql283), "17: source inválido");
  assert(/source_row_transport_mismatch/.test(sql283), "18: source transporte");
  assert(!/UPDATE\s+public\.orders/i.test(sql283), "22: aliases no mutan orders");
  assert(
    !/confirmed_matched|confirmed_with_irregularity|rpc_cod_confirm/i.test(sql283),
    "23: aliases no tocan estados financieros COD"
  );
  assert(!/cod_transport_customer_aliases/.test(sql279), "279 sin aliases");
  assert(!/cod_transport_customer_aliases/.test(sql280), "280 sin aliases");
  assert(/reason_required/.test(sql283), "reassign exige reason");
}

// ─── 21. Contrato assign+remember (documentado en actions) ───────────────────
{
  const actions = readFileSync(resolve(__dirname, "actions.ts"), "utf8");
  assert(/rememberAliasAfterAssign/.test(actions), "21: remember separado post-assign");
  assert(/assign_ok_alias_failed|no se pudo guardar el alias/i.test(actions), "21: mensaje parcial");
  assert(/rpc_cod_assign_row/.test(actions), "21: sigue usando 279");
}

console.log(`\nResultado: ${passed} ok, ${failed} fail\n`);
if (failed > 0) process.exit(1);
