/**
 * Presentación humana de señales de matching COD (UI).
 * No cambia scores ni semántica financiera.
 */
import { formatPriceAr } from "@/lib/orders/domain";

export type NameMatchSourceUi = "label" | "titular" | "sub_name" | string | null | undefined;

export type CandidateDisplay = {
  orderId?: string;
  orderNumber?: string | null;
  score?: number | null;
  customerId?: string | null;
  /** Titular real del cliente (preferido en UI). */
  customerDisplayName?: string | null;
  customerNumber?: string | null;
  /** Label del pedido. */
  labelCustomerName?: string | null;
  expectedAmount?: number | null;
  effectiveSentDate?: string | null;
  transportName?: string | null;
  matchedNameSnapshot?: string | null;
  matchedNameSource?: NameMatchSourceUi;
  name?: { points?: number; source?: NameMatchSourceUi; quality?: string; matchedName?: string | null };
  date?: { points?: number; dayDiff?: number | null };
  amount?: { points?: number; exact?: boolean; amountDiff?: number | null };
  transport?: { points?: number; stage?: string; mismatch?: boolean };
  willCreateIrregularity?: boolean;
  warningApprovedElsewhere?: string | null;
};

export function formatDateArIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  if (!y || !m || !d) return String(iso);
  return `${d}/${m}/${y}`;
}

export function formatSignedPriceAr(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(Number(amount))) return "—";
  const n = Math.round(Number(amount) * 100) / 100;
  if (n > 0) return `+${formatPriceAr(n)}`;
  if (n < 0) return `−${formatPriceAr(Math.abs(n))}`;
  return formatPriceAr(0);
}

/** reported − expected */
export function amountDiffLabel(diff: number | null | undefined): {
  kind: "exact" | "faltante" | "sobrante" | "unknown";
  short: string;
  long: string;
} {
  if (diff == null || !Number.isFinite(Number(diff))) {
    return { kind: "unknown", short: "—", long: "Sin diferencia calculable." };
  }
  const n = Math.round(Number(diff) * 100) / 100;
  if (Math.abs(n) < 0.005) {
    return { kind: "exact", short: "Monto exacto", long: "✓ Monto exacto" };
  }
  if (n < 0) {
    return {
      kind: "faltante",
      short: `Faltante ${formatPriceAr(Math.abs(n))}`,
      long: `⚠ Faltante a reclamar: ${formatPriceAr(Math.abs(n))}`,
    };
  }
  return {
    kind: "sobrante",
    short: `Sobrante ${formatPriceAr(n)}`,
    long: `⚠ Sobrante informado: ${formatPriceAr(n)}`,
  };
}

export function nameSourceHuman(source: NameMatchSourceUi): string {
  switch (source) {
    case "label":
      return "nombre en el pedido (etiqueta)";
    case "titular":
      return "titular del cliente";
    case "sub_name":
      return "sub-nombre del cliente";
    default:
      return "nombre";
  }
}

export function signalName(points: number | null | undefined, source?: NameMatchSourceUi): string {
  if (points == null) return "Nombre: —";
  if (points >= 35) {
    if (source === "sub_name") return "✓ Nombre coincide por sub-nombre";
    if (source === "titular") return "✓ Nombre coincide con el titular";
    return "✓ Nombre coincide";
  }
  if (points >= 25) return "~ Nombre: mismos tokens (orden distinto o parcial)";
  if (points >= 12) return "~ Nombre: coincidencia parcial";
  if (points > 0) return "~ Nombre: señal débil";
  return "✕ El nombre informado no coincide con el cliente";
}

export function signalDate(points: number | null | undefined, dayDiff: number | null | undefined): string {
  if (points == null) return "Fecha: —";
  if (dayDiff === 0) return "✓ Fecha: exacta";
  if (dayDiff === 1) return "~ Fecha: ±1 día";
  if (dayDiff != null && dayDiff <= 3) return `~ Fecha: ±${dayDiff} días`;
  if (points > 0) return "~ Fecha: cercana";
  return "✕ Fecha: no coincide";
}

export function signalAmount(
  points: number | null | undefined,
  exact: boolean | null | undefined,
  amountDiff: number | null | undefined
): string {
  if (exact) return "✓ Monto: exacto";
  const lab = amountDiffLabel(amountDiff);
  if (lab.kind === "faltante" || lab.kind === "sobrante") {
    if ((points ?? 0) >= 8) return `~ Monto: ${lab.short}`;
    return `⚠ Monto: ${lab.short}`;
  }
  if ((points ?? 0) > 0) return "~ Monto: diferencia chica";
  return "✕ Monto: no coincide";
}

export function signalTransport(
  points: number | null | undefined,
  mismatch: boolean | null | undefined,
  transportName?: string | null
): string {
  const name = transportName?.trim() || "transporte";
  if (mismatch) return `⚠ Transporte distinto (${name})`;
  if ((points ?? 0) > 0) return `✓ Transporte: ${name}`;
  return `Transporte: ${name}`;
}

function normName(s: string | null | undefined): string {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

/**
 * Titular / display del cliente para cards TOP.
 * Nunca usar matchedNameSnapshot como sustituto del titular.
 */
export function candidatePrimaryName(c: CandidateDisplay): string {
  const titular = c.customerDisplayName?.trim();
  if (titular) return titular;
  const label = c.labelCustomerName?.trim();
  if (label) return label;
  const snap = c.matchedNameSnapshot?.trim() || c.name?.matchedName?.trim();
  if (snap) return snap;
  return "Cliente sin nombre";
}

/**
 * Línea opcional bajo el titular: identidad que produjo el match.
 */
export function candidateMatchByHint(
  c: CandidateDisplay,
  opts?: { transportName?: string | null; aliasRaw?: string | null }
): string | null {
  const source = c.matchedNameSource ?? c.name?.source ?? null;
  const snap = (c.matchedNameSnapshot ?? c.name?.matchedName)?.trim() || null;
  const primary = candidatePrimaryName(c);
  const transport = (opts?.transportName || c.transportName || "").trim() || "este transporte";

  if (source === "sub_name" && snap) {
    return `✓ Sub-nombre reconocido: ${snap}`;
  }

  if (opts?.aliasRaw?.trim()) {
    return `✓ Nombre reconocido para este cliente en ${transport}: ${opts.aliasRaw.trim()}`;
  }

  if (snap && normName(snap) !== normName(primary) && source) {
    return `Coincidencia por: ${snap}`;
  }

  return null;
}

export function candidateAmountDiff(
  c: CandidateDisplay,
  reportedAmount: number | null | undefined
): number | null {
  if (c.amount?.amountDiff != null && Number.isFinite(c.amount.amountDiff)) {
    return c.amount.amountDiff;
  }
  if (
    reportedAmount != null &&
    c.expectedAmount != null &&
    Number.isFinite(reportedAmount) &&
    Number.isFinite(c.expectedAmount)
  ) {
    return Math.round((reportedAmount - c.expectedAmount) * 100) / 100;
  }
  return null;
}
