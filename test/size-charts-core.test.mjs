import test from "node:test";
import assert from "node:assert/strict";
import {
  chartMeasuresChanged,
  copyName,
  formatCm,
  generateSizeRange,
  isAssignable,
  isVersionConflict,
  mergeGeneratedLabels,
  normalizeSizeLabel,
  parseCm,
  sizeChartErrorMessage,
  sizeKey,
  sortSizeRows,
  validateChartForm,
} from "../admin/size-charts-core.js";

test("talles: normalización y clave igual que size_key de la 378", () => {
  assert.equal(normalizeSizeLabel("  35 / 36 "), "35/36");
  assert.equal(normalizeSizeLabel("XL   largo"), "XL largo");
  assert.equal(sizeKey("35,5"), sizeKey("35.5"));
  assert.equal(sizeKey("35 / 36"), sizeKey("35/36"));
  assert.equal(sizeKey("XL"), sizeKey("xl"));
  assert.notEqual(sizeKey("35"), sizeKey("35/36"));
});

test("centímetros: coma o punto, hasta 2 decimales, 5 a 40, vacío = null", () => {
  assert.deepEqual(parseCm("22,5"), { ok: true, value: 22.5 });
  assert.deepEqual(parseCm("22.5"), { ok: true, value: 22.5 });
  assert.deepEqual(parseCm("22"), { ok: true, value: 22 });
  assert.deepEqual(parseCm("22,75"), { ok: true, value: 22.75 });
  assert.deepEqual(parseCm("  "), { ok: true, value: null });
  for (const bad of ["22,555", "1.000", "22,5,1", "-3", "abc", "4,99", "40,01", "100"]) {
    assert.equal(parseCm(bad).ok, false, bad);
  }
  assert.equal(formatCm(22.5), "22,5");
  assert.equal(formatCm("23.00"), "23");
  assert.equal(formatCm(null), "");
});

test("rango: simples y dobles sin medidas inventadas", () => {
  assert.deepEqual(generateSizeRange(35, 40, "single"), {
    ok: true,
    labels: ["35", "36", "37", "38", "39", "40"],
  });
  assert.deepEqual(generateSizeRange(35, 40, "double"), { ok: true, labels: ["35/36", "37/38", "39/40"] });
  assert.deepEqual(generateSizeRange(35, 39, "double"), { ok: true, labels: ["35/36", "37/38", "39/40"] });
  assert.equal(generateSizeRange(40, 35, "single").ok, false);
  assert.equal(generateSizeRange(35.5, 40, "single").ok, false);
  assert.equal(generateSizeRange(1, 41, "single").ok, false);

  const existing = [{ size_label: "36", measure_text: "23" }];
  const merged = mergeGeneratedLabels(existing, ["35", "36", "37"]);
  assert.equal(merged.addedCount, 2);
  assert.deepEqual(merged.rows, [
    { size_label: "36", measure_text: "23" },
    { size_label: "35", measure_text: "" },
    { size_label: "37", measure_text: "" },
  ]);
});

test("ordenar por talle: numéricos por valor, dobles junto a su primer número", () => {
  const rows = ["37", "35/36", "35,5", "35", "XL", "36"].map((size_label) => ({ size_label }));
  assert.deepEqual(
    sortSizeRows(rows).map((r) => r.size_label),
    ["35", "35/36", "35,5", "36", "37", "XL"]
  );
});

test("validación del editor: borrador permitido, duplicados y errores por fila", () => {
  const draft = validateChartForm({
    name: "  Horma   normal ",
    measureType: "largo_plantilla",
    notes: "",
    rows: [
      { size_label: "35", measure_text: "22,5" },
      { size_label: "36", measure_text: "" },
      { size_label: "", measure_text: "" },
    ],
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.isComplete, false);
  assert.deepEqual(draft.payload, {
    name: "Horma normal",
    measureType: "largo_plantilla",
    notes: null,
    rows: [
      { size_label: "35", measure_cm: 22.5 },
      { size_label: "36", measure_cm: null },
    ],
  });

  const empty = validateChartForm({ name: "Vacía", measureType: "largo_pie", notes: "", rows: [] });
  assert.equal(empty.ok, true);
  assert.equal(empty.isComplete, false);

  const invalid = validateChartForm({
    name: "",
    measureType: "",
    notes: "",
    rows: [
      { size_label: "35,5", measure_text: "22" },
      { size_label: "35.5", measure_text: "4" },
      { size_label: "", measure_text: "23" },
    ],
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length, 5);
  assert.ok(invalid.errors.some((e) => e.includes("repetido")));
});

test("cambio de medidas: avisa por medidas, talles, orden o tipo; no por nombre o notas", () => {
  const original = {
    measure_type: "largo_plantilla",
    rows: [
      { size_label: "35", measure_cm: 22.5 },
      { size_label: "36", measure_cm: 23 },
    ],
  };
  const base = {
    name: "Otro nombre",
    measureType: "largo_plantilla",
    notes: "nota",
    rows: [
      { size_label: "35", measure_cm: 22.5 },
      { size_label: "36", measure_cm: 23 },
    ],
  };
  assert.equal(chartMeasuresChanged(original, base), false);
  assert.equal(chartMeasuresChanged(original, { ...base, measureType: "largo_pie" }), true);
  assert.equal(chartMeasuresChanged(original, { ...base, rows: [base.rows[1], base.rows[0]] }), true);
  assert.equal(
    chartMeasuresChanged(original, { ...base, rows: [base.rows[0], { size_label: "36", measure_cm: 23.5 }] }),
    true
  );
  assert.equal(chartMeasuresChanged(null, base), false);
});

test("asignable solo si está completa y activa", () => {
  assert.equal(isAssignable({ is_complete: true, archived_at: null }), true);
  assert.equal(isAssignable({ is_complete: false, archived_at: null }), false);
  assert.equal(isAssignable({ is_complete: true, archived_at: "2026-10-10T00:00:00Z" }), false);
});

test("errores de RPC traducidos", () => {
  assert.equal(
    sizeChartErrorMessage({ message: "SIZE_CHART_NOT_ASSIGNABLE: la tabla de talles está archivada." }),
    "La tabla de talles está archivada."
  );
  assert.equal(sizeChartErrorMessage({ code: "42501", message: "permission denied" }), "No tenés permiso para esta acción.");
  assert.match(sizeChartErrorMessage({ code: "PGRST202", message: "x" }), /todavía no están habilitadas/);
  assert.equal(isVersionConflict({ message: "SIZE_CHART_VERSION_CONFLICT: otra persona…" }), true);
  assert.equal(copyName("Horma normal"), "Horma normal (copia)");
  assert.equal(copyName("x".repeat(80)).length, 80);
});
