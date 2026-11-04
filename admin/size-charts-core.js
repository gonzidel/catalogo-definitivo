// admin/size-charts-core.js — Reglas puras de tablas de talles (sin DOM ni Supabase).
// Replican la normalización de supabase/canonical/378_size_charts.sql; la base
// vuelve a validar todo, esto solo adelanta los errores en pantalla.

export const MEASURE_TYPES = {
  largo_plantilla: "Largo de plantilla interna",
  largo_pie: "Largo del pie recomendado",
};

export const MAX_ROWS = 40;
export const MAX_NAME_LENGTH = 80;
export const MAX_NOTES_LENGTH = 500;
export const MAX_LABEL_LENGTH = 12;
export const MIN_CM = 5;
export const MAX_CM = 40;

/** "35 / 36" → "35/36"; colapsa espacios. */
export function normalizeSizeLabel(label) {
  return String(label ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    .trim();
}

/** Clave de duplicados: "35,5" = "35.5"; "35 / 36" = "35/36". */
export function sizeKey(label) {
  return normalizeSizeLabel(label).replace(/\s+/g, "").replace(/,/g, ".").toLowerCase();
}

export function normalizeChartName(name) {
  return String(name ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Centímetros escritos en pantalla → número. Acepta coma o punto decimal, hasta 2 decimales.
 * @returns {{ ok: true, value: number|null } | { ok: false, error: string }}
 */
export function parseCm(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: true, value: null };
  if (!/^\d{1,2}([.,]\d{1,2})?$/.test(raw)) {
    return { ok: false, error: "Usá un número con hasta 2 decimales (ej: 22,5)." };
  }
  const value = Number(raw.replace(",", "."));
  if (value < MIN_CM || value > MAX_CM) {
    return { ok: false, error: `La medida debe estar entre ${MIN_CM} y ${MAX_CM} cm.` };
  }
  return { ok: true, value };
}

/** 22.5 → "22,5"; null → "". */
export function formatCm(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 100) / 100).replace(".", ",");
}

/**
 * Talles de un rango, sin medidas. Simples: 35, 36… Dobles: 35/36, 37/38… mientras el primero ≤ hasta.
 * @returns {{ ok: true, labels: string[] } | { ok: false, error: string }}
 */
export function generateSizeRange(from, to, mode) {
  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
    return { ok: false, error: "Desde y hasta deben ser talles enteros." };
  }
  if (start > end) return { ok: false, error: "\"Desde\" no puede ser mayor que \"hasta\"." };
  const labels = [];
  if (mode === "double") {
    for (let n = start; n <= end; n += 2) labels.push(`${n}/${n + 1}`);
  } else {
    for (let n = start; n <= end; n += 1) labels.push(String(n));
  }
  if (labels.length > MAX_ROWS) return { ok: false, error: `Máximo ${MAX_ROWS} talles por tabla.` };
  return { ok: true, labels };
}

/** Agrega al final solo los talles que faltan (por clave), con la medida vacía. */
export function mergeGeneratedLabels(rows, labels) {
  const keys = new Set(rows.map((row) => sizeKey(row.size_label)));
  const added = [];
  for (const label of labels) {
    const key = sizeKey(label);
    if (keys.has(key)) continue;
    keys.add(key);
    added.push({ size_label: label, measure_text: "" });
  }
  return { rows: [...rows, ...added], addedCount: added.length };
}

/** Numéricos por valor (35 < 35,5 < 35/36 < 36), el resto alfabético. */
export function sortSizeRows(rows) {
  const numeric = (label) => {
    const match = normalizeSizeLabel(label).match(/^\d+([.,]\d+)?/);
    return match ? Number(match[0].replace(",", ".")) : NaN;
  };
  return [...rows].sort((a, b) => {
    const na = numeric(a.size_label);
    const nb = numeric(b.size_label);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return normalizeSizeLabel(a.size_label).localeCompare(normalizeSizeLabel(b.size_label), "es", {
      numeric: true,
    });
  });
}

/**
 * Valida el formulario del editor y arma el payload de rpc_admin_save_size_chart.
 * @param {{ name: string, measureType: string, notes: string, rows: { size_label: string, measure_text: string }[] }} form
 * @returns {{ ok: true, payload: { name: string, measureType: string, notes: string|null, rows: { size_label: string, measure_cm: number|null }[] }, isComplete: boolean }
 *   | { ok: false, errors: string[] }}
 */
export function validateChartForm(form) {
  const errors = [];
  const name = normalizeChartName(form.name);
  if (!name) errors.push("El nombre es obligatorio.");
  else if (name.length > MAX_NAME_LENGTH) errors.push(`El nombre admite hasta ${MAX_NAME_LENGTH} caracteres.`);

  if (!Object.hasOwn(MEASURE_TYPES, form.measureType)) errors.push("Elegí qué representa la medida.");

  const notes = String(form.notes ?? "").trim();
  if (notes.length > MAX_NOTES_LENGTH) errors.push(`Las notas admiten hasta ${MAX_NOTES_LENGTH} caracteres.`);

  const sourceRows = (form.rows || []).filter(
    (row) => normalizeSizeLabel(row.size_label) || String(row.measure_text ?? "").trim()
  );
  if (sourceRows.length > MAX_ROWS) errors.push(`Máximo ${MAX_ROWS} talles por tabla.`);

  const seen = new Map();
  const rows = sourceRows.map((row, index) => {
    const label = normalizeSizeLabel(row.size_label);
    const position = index + 1;
    if (!label) {
      errors.push(`Fila ${position}: falta el talle.`);
    } else if (label.length > MAX_LABEL_LENGTH) {
      errors.push(`Fila ${position}: el talle admite hasta ${MAX_LABEL_LENGTH} caracteres.`);
    } else {
      const key = sizeKey(label);
      if (seen.has(key)) errors.push(`El talle ${label} está repetido (filas ${seen.get(key)} y ${position}).`);
      else seen.set(key, position);
    }
    const measure = parseCm(row.measure_text);
    if (!measure.ok) errors.push(`Talle ${label || position}: ${measure.error}`);
    return { size_label: label, measure_cm: measure.ok ? measure.value : null };
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    payload: { name, measureType: form.measureType, notes: notes || null, rows },
    isComplete: rows.length > 0 && rows.every((row) => row.measure_cm !== null),
  };
}

/** true si cambian talles, medidas, orden o tipo (lo que ven todos los productos asociados). */
export function chartMeasuresChanged(original, payload) {
  if (!original) return false;
  if (original.measure_type !== payload.measureType) return true;
  const before = (original.rows || []).map((r) => `${sizeKey(r.size_label)}=${r.measure_cm ?? ""}`);
  const after = payload.rows.map((r) => `${sizeKey(r.size_label)}=${r.measure_cm ?? ""}`);
  return before.join("|") !== after.join("|");
}

export function copyName(name) {
  const suffix = " (copia)";
  return `${normalizeChartName(name).slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
}

/** Estado visible de una fila de rpc_admin_size_charts_overview. */
export function chartStatus(chart) {
  if (chart.archived_at) return "archived";
  return chart.is_complete ? "complete" : "draft";
}

export const CHART_STATUS_LABELS = {
  archived: "Archivada",
  complete: "Completa",
  draft: "Borrador",
};

/** Una tabla se puede asignar a un producto solo si está completa y activa (lo exige el trigger). */
export function isAssignable(chart) {
  return chartStatus(chart) === "complete";
}

/**
 * Error de RPC / PostgREST → mensaje en español.
 * Las RPC 378 lanzan "SIZE_CHART_<CODIGO>: mensaje".
 */
export function sizeChartErrorMessage(error) {
  const message = String(error?.message ?? error ?? "");
  const match = message.match(/SIZE_CHART_[A-Z_]+:\s*(.+)$/s);
  if (match) {
    const text = match[1].trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  if (error?.code === "42501") return "No tenés permiso para esta acción.";
  if (error?.code === "PGRST202" || /could not find the function/i.test(message)) {
    return "Las tablas de talles todavía no están habilitadas en la base.";
  }
  return message || "Error desconocido.";
}

export function isVersionConflict(error) {
  return /SIZE_CHART_VERSION_CONFLICT/.test(String(error?.message ?? ""));
}
