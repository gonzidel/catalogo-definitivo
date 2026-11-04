/**
 * Calidad de coincidencia token↔token.
 * Exact/prefix/substring se resuelven sin Levenshtein.
 * Fuzzy nunca iguala un exact o un prefix.
 */

export type MatchQuality =
  | "exact"
  | "prefix"
  | "substring"
  | "fuzzy1"
  | "fuzzy2"
  | "none";

export type MatchMode = "text" | "sku";

export function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (a === b) return 0;

  const prev = new Array<number>(lb + 1);
  const curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= lb; j++) prev[j] = curr[j];
  }
  return prev[lb];
}

/**
 * Reglas (justificadas con el catálogo ~640 artículos):
 * - 1–3 letras: solo exact/prefix. "eco" no debe matchear "escolar",
 *   "bot" no debe matchear "pantubota".
 * - 4 letras: exact/prefix + fuzzy1 si las longitudes son casi iguales.
 *   Substring bloqueado: "bota" ⊂ "pantubota" es un falso amigo real.
 * - 5–6: substring solo si el token es apenas más largo (≤3 extra) y
 *   el query no está enterrado (offset ≤ 1).
 * - 7+: fuzzy1; fuzzy2 si max(len) ≥ 8 (pantubota / pantubotaa).
 * - SKU: exact o prefix. Nunca fuzzy ni substring.
 */
export function classifyTokenMatch(
  haystackToken: string,
  queryToken: string,
  mode: MatchMode = "text"
): MatchQuality {
  if (!haystackToken || !queryToken) return "none";
  if (haystackToken === queryToken) return "exact";
  if (haystackToken.startsWith(queryToken)) return "prefix";

  if (mode === "sku") return "none";

  const qLen = queryToken.length;
  if (qLen <= 3) return "none";

  if (qLen >= 5 && haystackToken.includes(queryToken)) {
    const extra = haystackToken.length - qLen;
    const offset = haystackToken.indexOf(queryToken);
    if (extra <= 3 && offset <= 1) return "substring";
  }

  const hLen = haystackToken.length;
  const maxLen = Math.max(qLen, hLen);
  const lenDiff = Math.abs(qLen - hLen);

  if (qLen <= 6) {
    if (lenDiff <= 1 && maxLen >= 4) {
      const dist = levenshtein(haystackToken, queryToken);
      if (dist === 1) return "fuzzy1";
    }
    return "none";
  }

  const dist = levenshtein(haystackToken, queryToken);
  if (dist === 1) return "fuzzy1";
  if (dist === 2 && maxLen >= 8) return "fuzzy2";
  return "none";
}

export function tokenMatches(
  haystackToken: string,
  queryToken: string,
  mode: MatchMode = "text"
): boolean {
  return classifyTokenMatch(haystackToken, queryToken, mode) !== "none";
}

export const QUALITY_FACTOR: Record<MatchQuality, number> = {
  exact: 100,
  prefix: 72,
  substring: 38,
  fuzzy1: 14,
  fuzzy2: 7,
  none: 0,
};

export function qualityRank(quality: MatchQuality): number {
  return QUALITY_FACTOR[quality];
}
