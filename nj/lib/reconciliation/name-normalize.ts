/**
 * Normalización de nombres para matching COD (planilla ↔ pedido).
 * Reutiliza la base de customer-search y agrega limpieza de puntuación.
 */
import { normalizeCustomerSearchText } from "@/lib/orders/customer-search";

export function normalizeMatchName(value: string | null | undefined): string {
  return normalizeCustomerSearchText(value)
    .replace(/[.,;:/\\|_+\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalización de alias por transporte — DEBE ser paridad semántica con
 * public._cod_normalize_match_name (278 / SQL).
 *
 * Diferencias vs normalizeMatchName (fuzzy):
 * - Usa translate fijo (como SQL), no NFD genérico.
 * - Ñ/ñ → "n" (igual que SQL). Documentado: la eñe se pierde a "n".
 * - No reordena tokens.
 * - Vacío → "" (SQL usa NULL; el RPC trata ambos como inválidos).
 */
const COD_ALIAS_ACCENT_FROM =
  "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ";
const COD_ALIAS_ACCENT_TO =
  "aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc";

export function normalizeCodAliasName(value: string | null | undefined): string {
  let s = String(value ?? "")
    .trim()
    .toLowerCase();
  let out = "";
  for (const ch of s) {
    const i = COD_ALIAS_ACCENT_FROM.indexOf(ch);
    out += i >= 0 ? COD_ALIAS_ACCENT_TO[i]! : ch;
  }
  return out
    .replace(/[.,;:/\\|_+\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeMatchName(value: string | null | undefined): string[] {
  return normalizeMatchName(value)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Distancia Levenshtein (exportada para matching COD). */
export function levenshteinDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const prev = new Array<number>(lb + 1);
  const curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= lb; j++) prev[j] = curr[j]!;
  }
  return prev[lb]!;
}

export function tokensAllPresent(queryTokens: string[], candidateTokens: string[]): boolean {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return false;
  const set = new Set(candidateTokens);
  return queryTokens.every((t) => set.has(t));
}

export function tokensSameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const t of b) {
    const n = counts.get(t);
    if (!n) return false;
    if (n === 1) counts.delete(t);
    else counts.set(t, n - 1);
  }
  return counts.size === 0;
}
