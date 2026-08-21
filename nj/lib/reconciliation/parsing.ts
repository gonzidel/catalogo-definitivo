export type ParseOk<T> = { ok: true; value: T };
export type ParseErr = { ok: false; error: string };
export type ParseResult<T> = ParseOk<T> | ParseErr;

export type ParsedGridRow = {
  rowIndex: number;
  rawLine: string;
  rawTransportDateText: string;
  rawCustomerNameText: string;
  rawAmountText: string;
  parsedTransportDate: string | null;
  parsedAmount: number | null;
  errors: string[];
  isDuplicate: boolean;
};

export type PasteParseResult = {
  rows: ParsedGridRow[];
  validRows: ParsedGridRow[];
  invalidRows: ParsedGridRow[];
  emptyIgnored: number;
  calculatedTotal: number;
  contentHashInput: string[];
};

/** Nombre solo para detección de duplicados / hash — no reemplaza raw_*. */
export function normalizeNameForCompare(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DATE_PARSE_ERROR = "Fecha inválida. Ej.: 20/07/2026 o 20 jul 2026";

/** Meses ES (abreviado / completo). Siempre día/mes/año — nunca US. */
const MONTH_TOKEN_TO_NUM: Record<string, number> = {
  ene: 1,
  enero: 1,
  feb: 2,
  febrero: 2,
  mar: 3,
  marzo: 3,
  abr: 4,
  abril: 4,
  may: 5,
  mayo: 5,
  jun: 6,
  junio: 6,
  jul: 7,
  julio: 7,
  ago: 8,
  agosto: 8,
  sep: 9,
  sept: 9,
  septiembre: 9,
  oct: 10,
  octubre: 10,
  nov: 11,
  noviembre: 11,
  dic: 12,
  diciembre: 12,
};

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function buildIsoDate(day: number, month: number, year: number): ParseResult<string> {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) {
    return { ok: false, error: "Fecha fuera de rango" };
  }

  const dt = new Date(year, month - 1, day);
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day
  ) {
    return { ok: false, error: "Fecha inexistente" };
  }

  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { ok: true, value: iso };
}

/**
 * Fecha de planilla (siempre día/mes/año):
 * - 20/07/2026 | 20-07-2026 | 20/7/2026
 * - 20 jul 2026 | 20 JUL 2026 | 20 julio 2026 | 20 jul. 2026
 * Rechaza ISO (YYYY-MM-DD) y mes-primero (jul 20 2026).
 */
export function parseRemittanceDate(raw: string): ParseResult<string> {
  const text = String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "Fecha vacía" };

  // ISO / año primero → rechazo explícito (no US / no ambiguo).
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return { ok: false, error: DATE_PARSE_ERROR };
  }

  const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (numeric) {
    return buildIsoDate(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
  }

  const textual = text.match(/^(\d{1,2})\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ.]+)\s+(\d{4})$/u);
  if (textual) {
    const day = Number(textual[1]);
    const year = Number(textual[3]);
    const monthToken = stripDiacritics(textual[2])
      .toLowerCase()
      .replace(/\./g, "")
      .trim();
    const month = MONTH_TOKEN_TO_NUM[monthToken];
    if (!month) return { ok: false, error: DATE_PARSE_ERROR };
    return buildIsoDate(day, month, year);
  }

  return { ok: false, error: DATE_PARSE_ERROR };
}

/**
 * Monto AR: 152000 | 152.000 | $152.000 | 152.000,00
 * Nunca convierte basura en 0.
 */
export function parseRemittanceAmount(raw: string): ParseResult<number> {
  let s = String(raw || "").trim();
  if (!s) return { ok: false, error: "Monto vacío" };

  s = s.replace(/\s/g, "");
  if (s.startsWith("$")) s = s.slice(1);
  if (!s) return { ok: false, error: "Monto vacío" };

  if (/[^0-9.,]/.test(s)) {
    return { ok: false, error: "Monto inválido" };
  }

  let n: number;

  if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length !== 2) return { ok: false, error: "Monto inválido" };
    const intPart = parts[0].replace(/\./g, "");
    const decPart = parts[1];
    if (!/^\d+$/.test(intPart) || !/^\d{1,2}$/.test(decPart)) {
      return { ok: false, error: "Monto inválido" };
    }
    n = Number(`${intPart}.${decPart}`);
  } else if (s.includes(".")) {
    const parts = s.split(".");
    const thousandsStyle =
      parts.length >= 2 &&
      /^\d{1,3}$/.test(parts[0] || "") &&
      parts.slice(1).every((p) => /^\d{3}$/.test(p));
    if (thousandsStyle) {
      n = Number(parts.join(""));
    } else if (
      parts.length === 2 &&
      /^\d+$/.test(parts[0] || "") &&
      /^\d{1,2}$/.test(parts[1] || "")
    ) {
      // Decimal con punto (poco común en pegado AR); se acepta explícito.
      n = Number(`${parts[0]}.${parts[1]}`);
    } else {
      return { ok: false, error: "Monto inválido" };
    }
  } else {
    if (!/^\d+$/.test(s)) return { ok: false, error: "Monto inválido" };
    n = Number(s);
  }

  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: "Monto inválido" };
  }

  const rounded = Math.round(n * 100) / 100;
  return { ok: true, value: rounded };
}

/** Total informado (cabecera): mismos formatos que monto de fila. */
export function parseReportedTotal(raw: string): ParseResult<number> {
  return parseRemittanceAmount(raw);
}

function splitPasteLine(line: string): string[] | null {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed.trim()) return null;

  if (trimmed.includes("\t")) {
    return trimmed.split("\t").map((c) => c.trim());
  }

  // Fallback: 2+ espacios como separador (copias raras)
  const parts = trimmed.trim().split(/\s{2,}/).map((c) => c.trim());
  if (parts.length >= 3) return parts;
  return trimmed.split(/\t|,|;/).map((c) => c.trim());
}

export function parsePasteGrid(text: string): PasteParseResult {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\n/);
  const rows: ParsedGridRow[] = [];
  let emptyIgnored = 0;
  let rowIndex = 0;

  for (const line of lines) {
    if (!line.trim()) {
      emptyIgnored += 1;
      continue;
    }
    const cols = splitPasteLine(line);
    if (!cols || cols.every((c) => !c)) {
      emptyIgnored += 1;
      continue;
    }

    const dateText = cols[0] ?? "";
    const nameText = cols[1] ?? "";
    const amountText = cols.slice(2).join(" ").trim() || cols[2] || "";

    const errors: string[] = [];
    const dateParsed = parseRemittanceDate(dateText);
    const amountParsed = parseRemittanceAmount(amountText);
    if (!dateText.trim()) errors.push("Falta fecha");
    else if (!dateParsed.ok) errors.push(dateParsed.error);
    if (!nameText.trim()) errors.push("Falta nombre");
    if (!amountText.trim()) errors.push("Falta monto");
    else if (!amountParsed.ok) errors.push(amountParsed.error);

    rows.push({
      rowIndex,
      rawLine: line.replace(/\r$/, ""),
      rawTransportDateText: dateText,
      rawCustomerNameText: nameText,
      rawAmountText: amountText,
      parsedTransportDate: dateParsed.ok ? dateParsed.value : null,
      parsedAmount: amountParsed.ok ? amountParsed.value : null,
      errors,
      isDuplicate: false,
    });
    rowIndex += 1;
  }

  // Duplicados internos entre filas válidas
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (r.errors.length > 0) continue;
    const key = `${r.parsedTransportDate}|${normalizeNameForCompare(r.rawCustomerNameText)}|${Math.round((r.parsedAmount ?? 0) * 100)}`;
    const prev = seen.get(key);
    if (prev != null) {
      r.isDuplicate = true;
      rows[prev]!.isDuplicate = true;
    } else {
      seen.set(key, r.rowIndex);
    }
  }

  const validRows = rows.filter((r) => r.errors.length === 0);
  const invalidRows = rows.filter((r) => r.errors.length > 0);
  const calculatedTotal = validRows.reduce((s, r) => s + (r.parsedAmount ?? 0), 0);

  const contentHashInput = validRows.map((r) => {
    const cents = Math.round((r.parsedAmount ?? 0) * 100);
    return `${r.parsedTransportDate}\t${normalizeNameForCompare(r.rawCustomerNameText)}\t${cents}`;
  });

  return {
    rows,
    validRows,
    invalidRows,
    emptyIgnored,
    calculatedTotal: Math.round(calculatedTotal * 100) / 100,
    contentHashInput,
  };
}

/** Tuplas canónicas ordenadas → texto a hashear (SHA-256). */
export function buildCanonicalHashPayload(tuples: string[]): string {
  return [...tuples].sort((a, b) => a.localeCompare(b)).join("\n");
}

/**
 * SHA-256 hex via Web Crypto (browser + Node 18+).
 * No node:crypto — este módulo también se importa desde componentes "use client".
 */
export async function sha256Hex(payload: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) {
    throw new Error("Web Crypto subtle.digest no disponible para SHA-256");
  }
  const data = new TextEncoder().encode(payload);
  const buf = await subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeContentHash(tuples: string[]): Promise<string> {
  return sha256Hex(buildCanonicalHashPayload(tuples));
}

export function totalDifference(calculatedTotal: number, reportedTotal: number): number {
  return Math.round((calculatedTotal - reportedTotal) * 100) / 100;
}
