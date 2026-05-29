import { mapGoogleCategory } from "./google-category-map.ts";
import {
  canonicalTagKey,
  normalizeCommercialTag,
  normalizeRootCategoryKey,
  normalizeTagBasic,
  splitCommercialTags,
} from "./tag-normalize.ts";

const SEASON_TAG_KEYS = new Set([
  "invierno",
  "verano",
  "media_estacion",
  "frio",
  "calor",
]);

const SUMMER_FILTRO1 = new Set([
  "ojota",
  "sandalia",
  "chancleta",
  "hawaiana",
  "pantufla",
]);

const WINTER_FILTRO1 = new Set([
  "bota",
  "borcego",
  "texana",
  "botin",
]);

const COLLECTION_PRIORITY: { key: string; match: (keys: Set<string>, row: MetaRowSource) => boolean }[] = [
  {
    key: "liquidacion",
    match: (keys) => keys.has("liquidacion") || keys.has("liquida"),
  },
  {
    key: "oferta",
    match: (keys, row) => keys.has("oferta") || Boolean(row.oferta_activa),
  },
  {
    key: "fyl_originals",
    match: (keys, row) => {
      const sup = normalizeTagBasic(row.supplier_code);
      if (sup === "fyl") return true;
      return keys.has("fyl_originals") || keys.has("original") || keys.has("originals");
    },
  },
  {
    key: "premium",
    match: (keys) => keys.has("premium"),
  },
  {
    key: "destacados",
    match: (keys) => keys.has("destacado") || keys.has("destacados"),
  },
];

type MetaRowSource = {
  category?: unknown;
  filtro1?: unknown;
  filtro2?: unknown;
  filtro3?: unknown;
  detalles_similitud?: unknown;
  supplier_code?: unknown;
  oferta_activa?: unknown;
};

function collectTagKeys(row: MetaRowSource): Set<string> {
  const keys = new Set<string>();
  const addRaw = (raw: unknown) => {
    for (const tag of splitCommercialTags(String(raw ?? ""), { silent: true }).tags) {
      const key = normalizeCommercialTag(tag);
      if (key) keys.add(key);
    }
  };
  addRaw(row.filtro1);
  addRaw(row.filtro2);
  addRaw(row.filtro3);
  addRaw(row.detalles_similitud);
  const root = normalizeRootCategoryKey(String(row.category ?? ""));
  if (root) keys.add(root);
  return keys;
}

export function buildInternalLabel(row: MetaRowSource, extraKeys: string[] = [], max = 12): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const pushKey = (key: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  const root = normalizeRootCategoryKey(String(row.category ?? ""));
  if (root) pushKey(root);

  for (const raw of [
    row.filtro1,
    row.filtro2,
    row.filtro3,
    row.detalles_similitud,
  ]) {
    for (const tag of splitCommercialTags(String(raw ?? ""), { silent: true }).tags) {
      pushKey(normalizeCommercialTag(tag));
    }
  }

  const tagKeys = collectTagKeys(row);
  if (tagKeys.has("fyl") || normalizeTagBasic(String(row.supplier_code ?? "")) === "fyl") {
    pushKey("fyl_originals");
  }
  if (row.oferta_activa === true || row.oferta_activa === "true" || tagKeys.has("oferta")) {
    pushKey("oferta");
  }

  const season = detectSeasonKey(row, tagKeys);
  if (season) pushKey(season);

  for (const k of extraKeys) pushKey(k);

  return out.slice(0, max).join("|");
}

function detectSeasonKey(row: MetaRowSource, tagKeys: Set<string>): string {
  for (const k of tagKeys) {
    if (SEASON_TAG_KEYS.has(k)) {
      if (k === "frio") return "invierno";
      if (k === "calor") return "verano";
      if (k === "media_estacion") return "media_estacion";
      return k;
    }
  }
  const f1 = canonicalTagKey(String(row.filtro1 ?? ""));
  if (f1 && SUMMER_FILTRO1.has(f1)) return "verano";
  if (f1 && WINTER_FILTRO1.has(f1)) return "invierno";
  return "";
}

function pickCollectionLabel(row: MetaRowSource, tagKeys: Set<string>): string {
  for (const { key, match } of COLLECTION_PRIORITY) {
    if (match(tagKeys, row)) return key;
  }
  return "";
}

export function applyPhase2Enrichment(row: Record<string, unknown>): Record<string, unknown> {
  const src: MetaRowSource = {
    category: row.category,
    filtro1: row.filtro1,
    filtro2: row.filtro2,
    filtro3: row.filtro3,
    detalles_similitud: row.detalles_similitud,
    supplier_code: row.supplier_code,
    oferta_activa: row.oferta_activa,
  };

  const category = String(row.category ?? "");
  const filtro1 = String(row.filtro1 ?? "");
  const tagKeys = collectTagKeys(src);

  const custom_label_0 = canonicalTagKey(filtro1);
  const custom_label_1 = normalizeRootCategoryKey(category);
  const custom_label_2 = pickCollectionLabel(src, tagKeys);
  const custom_label_3 = detectSeasonKey(src, tagKeys);
  const custom_label_4 = "";

  const collectionKeys: string[] = [];
  if (custom_label_2) collectionKeys.push(custom_label_2);
  if (custom_label_3) collectionKeys.push(custom_label_3);

  const internal_label = buildInternalLabel(src, collectionKeys);

  return {
    ...row,
    google_product_category: mapGoogleCategory(category, filtro1),
    custom_label_0,
    custom_label_1,
    custom_label_2,
    custom_label_3,
    custom_label_4,
    internal_label,
  };
}
