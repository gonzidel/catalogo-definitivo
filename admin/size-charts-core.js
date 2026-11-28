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

/**
 * A qué pie corresponde la medida de un calzado. Si la tabla es de plantilla se resta la holgura (reference.insole_to_foot_cm);
 * si es de largo del pie se usa tal cual. Devuelve el pie en cm (una décima) y el talle estándar argentino más cercano
 * (a menos de 0,4 cm), o null si no hay medida o referencia. Es una guía aproximada, no una medida exacta.
 * @param {number|null} measureCm
 * @param {string} measureType "largo_plantilla" | "largo_pie"
 * @param {{insole_to_foot_cm:number, standard:Array<{size:number, foot_cm:number}>}|null} reference
 */
export function describeFoot(measureCm, measureType, reference) {
  if (measureCm == null || !Number.isFinite(Number(measureCm)) || !reference) return null;
  const offset = measureType === "largo_plantilla" ? Number(reference.insole_to_foot_cm) || 0 : 0;
  const foot = Math.round((Number(measureCm) - offset) * 10) / 10;
  let best = null;
  for (const row of Array.isArray(reference.standard) ? reference.standard : []) {
    const diff = Math.abs(Number(row.foot_cm) - foot);
    if (!best || diff < best.diff) best = { size: row.size, diff };
  }
  return { foot, nearestSize: best && best.diff <= 0.4 ? best.size : null };
}

/** Texto corto para mostrar junto a la medida: "pie 23 cm ≈ talle 35". */
export function footHintText(info) {
  if (!info) return "";
  const cm = String(info.foot).replace(".", ",");
  return info.nearestSize != null ? `pie ${cm} cm ≈ talle ${info.nearestSize}` : `pie ${cm} cm`;
}

/**
 * Cómo se publica en Mercado Libre una tabla de talles (misma regla que mapFootToSizes de supabase/functions/meli-publish/copy.ts):
 * el talle de ML es el del PIE calculado (medida menos holgura si es de plantilla -> talle estándar más cercano), no el
 * número marcado en el calzado. Como los talles del calzado pueden avanzar distinto al estándar, se aplica UN corrimiento a
 * toda la tabla (mediana redondeada). Devuelve { ok, rows:[{label, foot, mlSize}], shift, maxDeviation } o { ok:false, error }.
 * @param {Array<{label:string, cm:number|null}>} rows filas con medida válida
 * @param {string} measureType "largo_plantilla" | "largo_pie"
 * @param {number} allowanceCm holgura (solo se resta en largo_plantilla)
 * @param {Array<{size:number, foot_cm:number}>} standard tabla estándar
 */
export function previewMlSizes(rows, measureType, allowanceCm, standard) {
  const list = (rows || []).filter((r) => r && r.cm != null && Number.isFinite(Number(r.cm)));
  if (!list.length) return { ok: false, error: "sin_medidas" };
  const off = measureType === "largo_plantilla" ? Number(allowanceCm) || 0 : 0;
  const parsed = [];
  for (const r of list) {
    const label = String(r.label ?? "").trim();
    if (!/^\d{1,2}$/.test(label)) return { ok: false, error: `talle_no_numerico:${label}` };
    const foot = Math.round((Number(r.cm) - off) * 10) / 10;
    if (!(foot > 0)) return { ok: false, error: `largo_de_pie_invalido:${label}` };
    let best = null;
    for (const s of standard || []) {
      const diff = Math.abs(Number(s.foot_cm) - foot);
      if (!best || diff < best.diff) best = { size: Number(s.size), diff };
    }
    if (!best || best.diff > 0.4) return { ok: false, error: `pie_fuera_de_referencia:${label}` };
    parsed.push({ label, n: Number(label), foot, want: best.size });
  }
  const deltas = parsed.map((r) => r.want - r.n).sort((a, b) => a - b);
  const mid = deltas.length >> 1;
  const median = deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
  // Solo se corre hacia ABAJO (calza más chico). Si calza más grande se mantienen los números marcados.
  const rawShift = Math.round(median);
  const shift = Math.min(rawShift, 0);
  const seen = new Set();
  const out = [];
  let maxDeviation = 0;
  for (const r of parsed) {
    const mlSize = r.n + shift;
    if (seen.has(mlSize)) return { ok: false, error: `talles_repetidos:${r.label}` };
    seen.add(mlSize);
    out.push({ label: r.label, foot: r.foot, mlSize });
    maxDeviation = Math.max(maxDeviation, Math.abs(r.want - r.n - shift));
  }
  return { ok: true, rows: out, shift, rawShift, maxDeviation };
}

/** Aviso visible sobre cómo se publica la tabla en Mercado Libre. kind: "warn" | "error" | "info" | null (sin aviso). */
export function mlSizeNotice(preview) {
  if (!preview) return null;
  if (!preview.ok) {
    const [code] = String(preview.error).split(":");
    if (code === "sin_medidas") return null;
    const text = {
      talle_no_numerico: "Para publicar en Mercado Libre los talles tienen que ser números enteros (35, 36…); un talle como «35/36» no se puede publicar.",
      largo_de_pie_invalido: "Hay una medida demasiado chica: el pie calculado queda en cero o negativo.",
      pie_fuera_de_referencia: "Hay una medida de pie que no corresponde a ningún talle de la referencia (21 a 46).",
      talles_repetidos: "Dos talles caen en el mismo talle de Mercado Libre.",
    }[code] || "No se puede calcular el talle de Mercado Libre con estas medidas.";
    return { kind: "warn", text };
  }
  if (preview.rawShift > 0) {
    const up = preview.rawShift;
    return {
      kind: "info",
      text: `Este calzado calza ${up} talle${up === 1 ? "" : "s"} más grande que su número. En Mercado Libre se publica con el número marcado (el 36 sigue siendo 36); no se corre hacia arriba. Revisá que las medidas sean correctas.`,
    };
  }
  if (preview.shift === 0 && preview.maxDeviation < 2) {
    return { kind: "info", text: "Los talles se publican en Mercado Libre con el mismo número que tiene el calzado." };
  }
  const abs = Math.abs(preview.shift);
  const examples = preview.rows.slice(0, 3).map((r) => `${r.label} → ${r.mlSize}`).join(", ");
  const parts = [];
  if (preview.shift !== 0) {
    parts.push(
      `ATENCIÓN: este calzado calza ${abs} talle${abs === 1 ? "" : "s"} más ${preview.shift < 0 ? "chico" : "grande"} que su número. ` +
        `En Mercado Libre se publica corrido: ${examples}${preview.rows.length > 3 ? "…" : ""}. ` +
        "El stock y los pedidos siguen siendo los del talle marcado en el calzado."
    );
  }
  if (preview.maxDeviation >= 2) {
    parts.push("Las medidas de esta tabla no avanzan parejo con el estándar: revisalas.");
  }
  return { kind: "warn", text: parts.join(" ") };
}
