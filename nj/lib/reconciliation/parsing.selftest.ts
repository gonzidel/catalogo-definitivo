/**
 * Self-test de parsing COD (Fase 3). Ejecutar:
 *   npx --yes tsx lib/reconciliation/parsing.selftest.ts
 * desde nj/
 */
import {
  buildCanonicalHashPayload,
  computeContentHash,
  parsePasteGrid,
  parseRemittanceAmount,
  parseRemittanceDate,
  totalDifference,
} from "./parsing";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertOkDate(raw: string, iso: string) {
  const r = parseRemittanceDate(raw);
  assert(r.ok && r.value === iso, `date ${raw} → expected ${iso}, got ${JSON.stringify(r)}`);
}

function assertBadDate(raw: string) {
  const r = parseRemittanceDate(raw);
  assert(!r.ok, `date ${raw} should fail`);
}

function assertOkAmount(raw: string, value: number) {
  const r = parseRemittanceAmount(raw);
  assert(r.ok && r.value === value, `amount ${raw} → expected ${value}, got ${JSON.stringify(r)}`);
}

function assertBadAmount(raw: string) {
  const r = parseRemittanceAmount(raw);
  assert(!r.ok, `amount ${raw} should fail`);
}

async function main() {
  assertOkDate("03/08/2026", "2026-08-03");
  assertOkDate("3/8/2026", "2026-08-03");
  assertOkDate("20/07/2026", "2026-07-20");
  assertOkDate("20-07-2026", "2026-07-20");
  assertOkDate("20 jul 2026", "2026-07-20");
  assertOkDate("20 JUL 2026", "2026-07-20");
  assertOkDate("20 julio 2026", "2026-07-20");
  assertOkDate("20 jul. 2026", "2026-07-20");
  assertOkDate("07/08/2026", "2026-08-07");

  assertBadDate("2026-07-20");
  assertBadDate("31 feb 2026");
  assertBadDate("32 jul 2026");
  assertBadDate("00 jul 2026");
  assertBadDate("jul 20 2026");
  assertBadDate("31/02/2026");
  assertBadDate("not-a-date");

  assertOkAmount("152000", 152000);
  assertOkAmount("152.000", 152000);
  assertOkAmount("$152.000", 152000);
  assertOkAmount("152.000,00", 152000);
  assertOkAmount("$152.000,00", 152000);
  assertBadAmount("abc");
  assertBadAmount("");
  assertBadAmount("12.34.56");

  const realPaste = [
    "20 jul 2026\tPRIETTO YANNINA ELIZABETH\t92300",
    "16 jul 2026\tLOAISO MARISA\t99600",
    "16 jul 2026\tMARTINEZ LUCIANA BELEN\t45300",
    "16 jul 2026\tBENITEZ MARIA\t69500",
    "16 jul 2026\tDIAZ GILDA\t236400",
  ].join("\n");
  const realGrid = parsePasteGrid(realPaste);
  assert(realGrid.validRows.length === 5, `real paste valid expected 5, got ${realGrid.validRows.length}`);
  assert(realGrid.invalidRows.length === 0, `real paste invalid expected 0, got ${realGrid.invalidRows.length}`);
  assert(realGrid.validRows[0]!.parsedTransportDate === "2026-07-20", "real paste first date");

  const paste70 = Array.from({ length: 70 }, (_, i) => {
    const d = String((i % 28) + 1).padStart(2, "0");
    return `${d}/08/2026\tCLIENTE ${i}\t${1000 + i}`;
  }).join("\n");
  const g70 = parsePasteGrid(paste70);
  assert(g70.validRows.length === 70, `70 rows expected, got ${g70.validRows.length}`);

  const paste200 = Array.from({ length: 200 }, (_, i) => `01/08/2026\tN${i}\t${i + 1}`).join(
    "\n"
  );
  assert(parsePasteGrid(paste200).validRows.length === 200, "200 rows");

  const paste500 = Array.from({ length: 500 }, (_, i) => `02/08/2026\tX${i}\t${i + 10}`).join(
    "\n"
  );
  assert(parsePasteGrid(paste500).validRows.length === 500, "500 rows");

  const ordered = parsePasteGrid(
    "03/08/2026\tGOMEZ MARIA\t152000\n04/08/2026\tANA LOPEZ\t87500"
  );
  const shuffled = parsePasteGrid(
    "04/08/2026\tANA LOPEZ\t87500\n03/08/2026\tGOMEZ MARIA\t152000"
  );
  const h1 = await computeContentHash(ordered.contentHashInput);
  const h2 = await computeContentHash(shuffled.contentHashInput);
  assert(h1 === h2, "reordered paste should same hash");
  assert(
    buildCanonicalHashPayload(["b", "a"]) === "a\nb",
    "canonical sort"
  );

  const dups = parsePasteGrid(
    "03/08/2026\tGOMEZ MARIA\t152000\n03/08/2026\tGOMEZ MARIA\t152000"
  );
  assert(dups.validRows.every((r) => r.isDuplicate), "internal duplicates flagged");

  assert(totalDifference(8402000, 8452000) === -50000, "diff negative");
  assert(totalDifference(8500000, 8452000) === 48000, "diff positive");
  assert(totalDifference(100, 100) === 0, "diff zero");

  const invalid = parsePasteGrid("bad\tname\txxx");
  assert(invalid.invalidRows.length === 1, "invalid row detected");

  console.log("parsing.selftest OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
