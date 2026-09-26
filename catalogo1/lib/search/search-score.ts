import type { GroupedProduct } from "@/types/catalog";
import { normalizeText, tokenizeNormalized } from "@/lib/search/normalize";
import {
  classifyTokenMatch,
  QUALITY_FACTOR,
  type MatchQuality,
} from "@/lib/search/match-quality";
import { aliasesForCanonical } from "@/lib/search/dictionary";
import {
  EMPTY_SEARCH_DICTIONARY,
  type ResolvedSearchQuery,
  type SearchDictionary,
} from "@/lib/search/types";

export type SearchField =
  | "articulo"
  | "nombre"
  | "filtro1"
  | "filtro2"
  | "filtro3"
  | "color"
  | "categoria"
  | "details"
  | "descripcion";

export interface TokenMatchExplain {
  token: string;
  field: SearchField;
  quality: MatchQuality;
  score: number;
  matchedValue?: string;
}

export interface SearchBonusExplain {
  reason: string;
  score: number;
}

export interface SearchScoreBreakdown {
  score: number;
  matches: TokenMatchExplain[];
  bonuses: SearchBonusExplain[];
  tieStock: number;
  tieRecency: number;
}

/**
 * Escala: el exacto de un campo superior siempre gana a cualquier
 * cantidad realista de matches débiles del campo inferior.
 *
 * 10 × details fuzzy2 = 10 × 25 = 250  <<  articulo exact 2000
 * 3 × details exact  = 1080            <   nombre exact 1600
 * 1 × filtro1 exact  = 1000            >   2 × details exact 720
 * fuzzy1 de nombre   = 224             <<  prefix de nombre 1152
 */
export const FIELD_EXACT_SCORE: Record<SearchField, number> = {
  articulo: 2000,
  nombre: 1600,
  filtro1: 1000,
  filtro2: 720,
  filtro3: 620,
  color: 560,
  categoria: 420,
  details: 360,
  descripcion: 200,
};

const FIELD_PRIORITY: SearchField[] = [
  "articulo",
  "nombre",
  "filtro1",
  "filtro2",
  "filtro3",
  "color",
  "categoria",
  "details",
  "descripcion",
];

const PHRASE_IN_NOMBRE = 280;
const PHRASE_IN_ARTICULO = 180;
const ALL_TOKENS_IN_NOMBRE = 120;

/** Si quedan tokens de contenido, estas palabras no participan del AND. */
const STOPWORDS = new Set([
  "de",
  "la",
  "el",
  "en",
  "con",
  "para",
  "los",
  "las",
  "un",
  "una",
  "y",
  "o",
  "del",
  "al",
]);

/** Títulos reales: casi todos tienen ≤6 palabras. 8+ es copy de mochila/ojota. */
const NOMBRE_WORD_LIMIT = 6;
const NOMBRE_HEAD_TOKENS = 3;

export function compactSku(value: string): string {
  return normalizeText(value).replace(/\s+/g, "");
}

export function splitTagField(raw: string): string[] {
  return String(raw ?? "")
    .split(/[,;|/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

export function contentTokens(tokens: string[]): string[] {
  const longEnough = tokens.filter((t) => t.length >= 2);
  const meaningful = longEnough.filter((t) => !STOPWORDS.has(t));
  return meaningful.length > 0 ? meaningful : longEnough;
}

export function fieldMatchScore(field: SearchField, quality: MatchQuality): number {
  if (quality === "none") return 0;
  return Math.round((FIELD_EXACT_SCORE[field] * QUALITY_FACTOR[quality]) / 100);
}

export interface NormalizedSearchFields {
  articulo: string[];
  articuloCompact: string;
  nombreText: string;
  nombre: string[];
  descripcion: string[];
  filtro1: string[];
  filtro2: string[];
  filtro3: string[];
  color: string[];
  categoria: string[];
  details: string[];
  recency: number;
}

function tokensOf(raw: string): string[] {
  return tokenizeNormalized(normalizeText(raw)).filter((t) => t.length >= 2);
}

function tokensFromTags(raw: string): string[] {
  const out: string[] = [];
  for (const part of splitTagField(raw)) {
    const norm = normalizeText(part);
    if (norm.length >= 2) out.push(norm);
    for (const t of tokenizeNormalized(norm)) {
      if (t.length >= 2) out.push(t);
    }
  }
  return out;
}

export function normalizeProductFields(product: GroupedProduct): NormalizedSearchFields {
  const articuloNorm = normalizeText(product.Articulo ?? "");
  const articuloCompact = compactSku(product.Articulo ?? "");
  const articulo = [articuloNorm, articuloCompact].filter(Boolean);

  const descNorm = normalizeText(product.Descripcion ?? "");
  const descTokens = tokenizeNormalized(descNorm).filter((t) => t.length >= 2);
  const treatAsTitle = descTokens.length <= NOMBRE_WORD_LIMIT;
  const nombre = treatAsTitle ? descTokens : descTokens.slice(0, NOMBRE_HEAD_TOKENS);
  const descripcion = treatAsTitle ? [] : descTokens.slice(NOMBRE_HEAD_TOKENS);

  return {
    articulo,
    articuloCompact,
    nombreText: descNorm,
    nombre,
    descripcion,
    filtro1: tokensFromTags(product.Filtro1 ?? ""),
    filtro2: tokensFromTags(product.Filtro2 ?? ""),
    filtro3: tokensFromTags(product.Filtro3 ?? ""),
    color: (product.DetalleColor ?? [])
      .map((d) => normalizeText(d.color ?? ""))
      .filter((c) => c.length >= 2),
    categoria: tokensOf(product.Categoria ?? ""),
    details: tokensFromTags(product.DetallesSimilitud ?? ""),
    recency: parseRecency(product.FechaPublicacion, product.FechaIngreso),
  };
}

function parseRecency(publicacion?: string, ingreso?: string): number {
  const raw = String(publicacion || ingreso || "").trim();
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function tokenVariants(
  token: string,
  resolved: ResolvedSearchQuery,
  dict: SearchDictionary
): string[] {
  const variants = [token, ...aliasesForCanonical(dict, token)];
  for (const res of resolved.resolutions) {
    if (res.canonical !== token || res.input === token) continue;
    for (const part of tokenizeNormalized(res.input)) {
      if (part.length >= 2) variants.push(part);
    }
  }
  return uniqueStrings(variants);
}

function bestMatchForToken(
  token: string,
  fields: NormalizedSearchFields,
  variants: string[]
): TokenMatchExplain | null {
  let best: TokenMatchExplain | null = null;

  for (const field of FIELD_PRIORITY) {
    const cap = FIELD_EXACT_SCORE[field];
    if (best && cap <= best.score) continue;

    const mode = field === "articulo" ? "sku" : "text";
    const haystack = fields[field];
    if (!Array.isArray(haystack) || haystack.length === 0) continue;

    for (const ht of haystack) {
      for (const variant of variants) {
        const quality = classifyTokenMatch(ht, variant, mode);
        if (quality === "none") continue;
        const score = fieldMatchScore(field, quality);
        if (!best || score > best.score) {
          best = { token, field, quality, score, matchedValue: ht };
          if (quality === "exact" && cap === FIELD_EXACT_SCORE.articulo) {
            return best;
          }
        }
      }
    }
  }

  return best;
}

function phraseBonuses(
  fields: NormalizedSearchFields,
  resolved: ResolvedSearchQuery,
  tokens: string[]
): SearchBonusExplain[] {
  const bonuses: SearchBonusExplain[] = [];
  const phrases = uniqueStrings(
    [resolved.resolvedQuery, resolved.normalizedQuery].filter((p) => p.length >= 2)
  );

  const compactPhrases = uniqueStrings(phrases.map(compactSku).filter((p) => p.length >= 2));
  if (
    fields.articuloCompact &&
    compactPhrases.includes(fields.articuloCompact)
  ) {
    // El score de identidad SKU ya cubre este caso; no sumar otra vez.
  } else if (
    phrases.some((p) => fields.articulo.some((a) => a.includes(p)))
  ) {
    bonuses.push({ reason: "phrase_articulo", score: PHRASE_IN_ARTICULO });
  }

  const titleText = fields.nombre.join(" ");
  if (titleText && phrases.some((p) => titleText.includes(p))) {
    bonuses.push({ reason: "phrase_nombre", score: PHRASE_IN_NOMBRE });
  } else if (
    tokens.length >= 2 &&
    tokens.every((t) => fields.nombre.some((ht) => ht.includes(t) || t.includes(ht)))
  ) {
    bonuses.push({ reason: "all_tokens_nombre", score: ALL_TOKENS_IN_NOMBRE });
  }

  return bonuses;
}

export function stockTie(product: GroupedProduct): number {
  if (product.hasAnyStock === true) return 1;
  return 0;
}

function skuIdentity(
  fields: NormalizedSearchFields,
  resolved: ResolvedSearchQuery
): SearchScoreBreakdown | null {
  const compactQuery = compactSku(resolved.normalizedQuery);
  if (compactQuery.length < 2 || compactQuery !== fields.articuloCompact) {
    return null;
  }
  return {
    score: FIELD_EXACT_SCORE.articulo,
    matches: [
      {
        token: compactQuery,
        field: "articulo",
        quality: "exact",
        score: FIELD_EXACT_SCORE.articulo,
        matchedValue: fields.articuloCompact,
      },
    ],
    bonuses: [{ reason: "sku_exact", score: 0 }],
    tieStock: 0,
    tieRecency: fields.recency,
  };
}

/**
 * A. ¿Coincide? → null si falla el AND.
 * B. ¿Qué tan relevante? → breakdown con best-match por token.
 */
export function scoreProductSearch(
  product: GroupedProduct,
  resolved: ResolvedSearchQuery,
  fields?: NormalizedSearchFields,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): SearchScoreBreakdown | null {
  const norm = fields ?? normalizeProductFields(product);
  const identity = skuIdentity(norm, resolved);
  if (identity) {
    return { ...identity, tieStock: stockTie(product) };
  }

  const tokens = contentTokens(resolved.resolvedTokens);
  if (tokens.length === 0) return null;

  const matches: TokenMatchExplain[] = [];
  for (const token of tokens) {
    const best = bestMatchForToken(token, norm, tokenVariants(token, resolved, dict));
    if (!best) return null;
    matches.push(best);
  }

  const bonuses = phraseBonuses(norm, resolved, tokens);
  const score =
    matches.reduce((sum, m) => sum + m.score, 0) +
    bonuses.reduce((sum, b) => sum + b.score, 0);

  return {
    score,
    matches,
    bonuses,
    tieStock: stockTie(product),
    tieRecency: norm.recency,
  };
}

export interface ScoredSearchHit {
  product: GroupedProduct;
  breakdown: SearchScoreBreakdown;
}

export function compareSearchHits(a: ScoredSearchHit, b: ScoredSearchHit): number {
  if (b.breakdown.score !== a.breakdown.score) {
    return b.breakdown.score - a.breakdown.score;
  }
  if (b.breakdown.tieStock !== a.breakdown.tieStock) {
    return b.breakdown.tieStock - a.breakdown.tieStock;
  }
  if (b.breakdown.tieRecency !== a.breakdown.tieRecency) {
    return b.breakdown.tieRecency - a.breakdown.tieRecency;
  }
  return String(a.product.Articulo ?? "").localeCompare(
    String(b.product.Articulo ?? ""),
    "es"
  );
}

export function rankSearchProducts(
  products: GroupedProduct[],
  resolved: ResolvedSearchQuery,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): ScoredSearchHit[] {
  const hits: ScoredSearchHit[] = [];
  for (const product of products) {
    const fields = normalizeProductFields(product);
    const breakdown = scoreProductSearch(product, resolved, fields, dict);
    if (!breakdown) continue;
    hits.push({ product, breakdown });
  }
  hits.sort(compareSearchHits);
  return hits;
}
