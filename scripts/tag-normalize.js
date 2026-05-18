// scripts/tag-normalize.js — Clave canónica de tags (mayúsculas, plurales, espacios)

/** Trim + espacios colapsados (sin tocar mayúsculas). */
export function normalizeTagDisplay(tag) {
  return String(tag ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Minúsculas sin acentos. */
export function normalizeTagBasic(tag) {
  let t = normalizeTagDisplay(tag).toLowerCase();
  try {
    t = t.normalize("NFD").replace(/\p{M}/gu, "");
  } catch {
    t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  return t;
}

/**
 * Clave única para agrupar/equivalencia: minúsculas, sin acentos, singular aproximado.
 * Ej.: "Frio", "frio", "frios", "FRIO" → "frio"
 */
export function canonicalTagKey(tag) {
  const t = normalizeTagBasic(tag);
  if (!t) return "";

  if (t.endsWith("es") && t.length > 4 && !t.endsWith("les") && !t.endsWith("nes")) {
    const stem = t.slice(0, -2);
    if (stem.length >= 3) return stem;
  }
  if (t.endsWith("s") && t.length > 3 && !t.endsWith("ss") && !t.endsWith("us")) {
    const stem = t.slice(0, -1);
    if (stem.length >= 3) return stem;
  }
  return t;
}

/** Clave canónica única para admin, banner, hash y matcher comercial. */
export function normalizeCommercialTag(tag) {
  return canonicalTagKey(tag);
}

/** Separadores de tags comerciales (cada tag es UNA unidad; nunca frases CSV compuestas). */
const COMMERCIAL_TAG_SPLIT = /[,;|]+/;

/**
 * Divide un valor DetallesSimilitud / tag_value en tags individuales.
 * No trata el string completo como un tag si contiene comas.
 * @returns {{ tags: string[], original: string, cleaned: string[], discarded: object[], duplicatesRemoved: string[] }}
 */
export function splitCommercialTags(raw, { context = "", sku = "", silent = false } = {}) {
  const original = Array.isArray(raw)
    ? raw.map((t) => String(t ?? "").trim()).filter(Boolean).join(", ")
    : String(raw ?? "").trim();

  if (!original) {
    return {
      tags: [],
      original: "",
      cleaned: [],
      discarded: [],
      duplicatesRemoved: [],
    };
  }

  const discarded = [];
  const duplicatesRemoved = [];
  const seen = new Set();
  const tags = [];

  const pieces = original.split(COMMERCIAL_TAG_SPLIT);

  for (let piece of pieces) {
    piece = normalizeTagDisplay(piece);
    if (!piece) {
      discarded.push({ piece: "", reason: "empty" });
      continue;
    }
    if (piece.length < 2) {
      discarded.push({ piece, reason: "too_short" });
      continue;
    }
    const basic = normalizeTagBasic(piece);
    if (TAG_STOPWORDS.has(basic)) {
      discarded.push({ piece, reason: "stopword" });
      continue;
    }
    const key = normalizeCommercialTag(piece);
    if (!key) {
      discarded.push({ piece, reason: "invalid_key" });
      continue;
    }
    if (COMMERCIAL_TAG_SPLIT.test(piece)) {
      discarded.push({ piece, reason: "nested_separator" });
      continue;
    }
    if (seen.has(key)) {
      duplicatesRemoved.push(piece);
      continue;
    }
    seen.add(key);
    tags.push(piece);
  }

  const cleaned = tags.map((t) => normalizeTagDisplay(t));
  const valueAfter = joinCommercialTags(tags);
  const changed =
    valueAfter !== original ||
    duplicatesRemoved.length > 0 ||
    discarded.length > 0;

  if (!silent && changed) {
    logCommercialTagsCleanup({
      context: context || "splitCommercialTags",
      sku: sku || undefined,
      tags_originales: original,
      tags_limpiados: cleaned,
      tags_descartados: discarded,
      duplicates_removed: duplicatesRemoved,
    });
  }

  return {
    tags: cleaned,
    original,
    cleaned,
    discarded,
    duplicatesRemoved,
  };
}

/** Serializa tags comerciales individuales a CSV canónico (dedupe por clave). */
export function joinCommercialTags(tags) {
  const groups = new Map();

  for (const raw of tags || []) {
    const display = normalizeTagDisplay(raw);
    if (!display) continue;
    const key = normalizeCommercialTag(display);
    if (!key) continue;
    const prev = groups.get(key);
    groups.set(key, prev ? preferDisplayLabel(prev, display) : display);
  }

  return Array.from(groups.values())
    .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }))
    .join(", ");
}

/** Une dos campos DetallesSimilitud sin crear tags compuestos. */
export function mergeCommercialTagFieldValues(existing, incoming) {
  const a = splitCommercialTags(existing, { silent: true }).tags;
  const b = splitCommercialTags(incoming, { silent: true }).tags;
  return joinCommercialTags([...a, ...b]);
}

export function logCommercialTagsCleanup(payload) {
  console.log("[FYL Commercial Tags]", payload);
}

export function tagsAreEquivalent(tagA, tagB) {
  const ka = canonicalTagKey(tagA);
  const kb = canonicalTagKey(tagB);
  return Boolean(ka && kb && ka === kb);
}

const TAG_STOPWORDS = new Set([
  "el", "la", "los", "las", "de", "del", "para", "en", "y", "o",
  "con", "por", "un", "una", "al", "es", "son",
]);

/**
 * Tokens de un campo Filtro: partes por coma/punto y coma + palabras (ej. "Especiales para el frio" → frio).
 */
export function tokensFromFilterField(raw) {
  const seen = new Set();
  const out = [];

  const pushToken = (piece) => {
    const display = normalizeTagDisplay(piece);
    if (!display || display.length < 2) return;
    const basic = normalizeTagBasic(display);
    if (basic.length < 2 || TAG_STOPWORDS.has(basic)) return;
    const key = canonicalTagKey(display);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(display);
  };

  const text = normalizeTagDisplay(raw);
  if (!text) return out;

  pushToken(text);
  text.split(/[,;]+/).forEach((part) => {
    pushToken(part);
    part.split(/\s+/).forEach((word) => pushToken(word));
  });

  return out;
}

function preferDisplayLabel(current, candidate) {
  const key = canonicalTagKey(current);
  const candKey = canonicalTagKey(candidate);
  if (!key || key !== candKey) return current || candidate;

  const curBasic = normalizeTagBasic(current);
  const candBasic = normalizeTagBasic(candidate);

  if (curBasic === key && candBasic !== key) return current;
  if (candBasic === key && curBasic !== key) return candidate;

  if (current.length !== candidate.length) {
    return current.length <= candidate.length ? current : candidate;
  }

  return current.localeCompare(candidate, "es", { sensitivity: "base" }) <= 0
    ? current
    : candidate;
}

/** Tags de una fila catalog_public_view (Filtro1–3). */
export function extractTagsFromProductRow(row) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    for (const token of tokensFromFilterField(raw)) {
      const key = canonicalTagKey(token);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  };
  if (row?.Filtro1) push(row.Filtro1);
  if (row?.Filtro2) push(row.Filtro2);
  if (row?.Filtro3) push(row.Filtro3);
  return out;
}

/** ¿La fila tiene un tag equivalente al seleccionado? (todas las categorías). */
export function productRowMatchesTag(row, selectedTag) {
  const selectedKey = canonicalTagKey(selectedTag);
  if (!selectedKey) return false;

  for (const field of [row?.Filtro1, row?.Filtro2, row?.Filtro3]) {
    for (const token of tokensFromFilterField(field)) {
      if (canonicalTagKey(token) === selectedKey) return true;
    }
  }
  return false;
}

/**
 * Parsea tags del admin/banner: array, string con comas/punto y coma o pipe.
 * @param {string|string[]|null|undefined} raw
 * @returns {string[]}
 */
export function parseTagSelectorValues(raw) {
  if (Array.isArray(raw)) {
    const merged = [];
    for (const item of raw) {
      merged.push(...splitCommercialTags(item, { silent: true }).tags);
    }
    return splitCommercialTags(merged.join(", "), { silent: true }).tags;
  }
  return splitCommercialTags(raw, { silent: true }).tags;
}

/** Tokens comerciales tokenizados — solo DetallesSimilitud (sin Filtro1–3 ni substring). */
export function extractCommercialTagTokensFromRow(row) {
  const seen = new Set();
  const tokens = [];
  for (const display of splitCommercialTags(row?.DetallesSimilitud, { silent: true }).tags) {
    const key = normalizeCommercialTag(display);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tokens.push({ display, key });
  }
  return tokens;
}

/**
 * Tokens y claves de Filtro3 para matcher comercial: separadores [,;|] (como Tags3 en vista)
 * más tokenización legacy (p. ej. "Especiales para el frio" sin comas).
 * Evita perder tags cuando hay varios Tags3 en una sola cadena.
 */
export function collectFiltro3CommercialMatchParts(raw) {
  const keyToDisplay = new Map();

  const addDisplay = (d) => {
    const disp = normalizeTagDisplay(d);
    if (!disp) return;
    const k = normalizeCommercialTag(disp);
    if (!k) return;
    const prev = keyToDisplay.get(k);
    if (!prev || disp.length < prev.length) keyToDisplay.set(k, disp);
  };

  if (raw == null || raw === "") {
    return { tokens: [], keys: [] };
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      addDisplay(String(item ?? ""));
    }
    return {
      tokens: [...keyToDisplay.values()],
      keys: [...keyToDisplay.keys()],
    };
  }

  const str = String(raw).trim();
  if (!str) return { tokens: [], keys: [] };

  for (const t of splitCommercialTags(str, { silent: true }).tags) {
    addDisplay(t);
  }
  for (const t of tokensFromFilterField(str)) {
    addDisplay(t);
  }

  return {
    tokens: [...keyToDisplay.values()],
    keys: [...keyToDisplay.keys()],
  };
}

/**
 * Evalúa match exacto por token: DetallesSimilitud y/o Filtro3 (Tags3 jerárquicos).
 * Misma clave canónica en ambos; sin substring ni Filtro1–2.
 */
export function evaluateCommercialTagExactMatch(row, selectedTag) {
  const selected_tag = normalizeTagDisplay(selectedTag);
  const normalized_selected_tag = normalizeCommercialTag(selectedTag);
  const product_tags_tokens = splitCommercialTags(row?.DetallesSimilitud, {
    silent: true,
  }).tags;
  const product_tag_keys = product_tags_tokens
    .map((t) => normalizeCommercialTag(t))
    .filter(Boolean);

  const f3Parts = collectFiltro3CommercialMatchParts(row?.Filtro3);
  const filtro3_tokens = f3Parts.tokens;
  const filtro3_keys = f3Parts.keys;

  let matched_exact = Boolean(
    normalized_selected_tag &&
      product_tag_keys.some((k) => k === normalized_selected_tag)
  );

  let match_via = "no_detalles";
  if (product_tags_tokens.length && !matched_exact) match_via = "no_match";
  if (matched_exact) match_via = "exact_token";

  if (!matched_exact && normalized_selected_tag) {
    if (filtro3_keys.some((k) => k === normalized_selected_tag)) {
      matched_exact = true;
      match_via = "filtro3_tags3";
    }
  }

  if (
    !matched_exact &&
    !product_tags_tokens.length &&
    !filtro3_tokens.length
  ) {
    match_via = "no_detalles_ni_filtro3";
  }

  return {
    selected_tag,
    normalized_selected_tag,
    product_tags_tokens,
    product_tag_keys,
    filtro3_tokens,
    filtro3_keys,
    matched_exact,
    match_via,
  };
}

export function logCommercialTagExactMatch(row, selectedTag, extra = {}) {
  const ev = evaluateCommercialTagExactMatch(row, selectedTag);
  console.log("[FYL Commercial Match]", {
    sku: row?.Articulo || "",
    ...ev,
    ...extra,
  });
  return ev;
}

function commercialMatchLogEnabled() {
  if (typeof window === "undefined") return false;
  if (window.FYL_COMMERCIAL_MATCH_LOG === true) return true;
  try {
    return /(?:^|[&?])debug=banner(?:&|$)/.test(window.location.search || "");
  } catch {
    return false;
  }
}

/** Comparación explícita quick-action vs producto (auditoría). */
export function buildCommercialTagMatchComparison(row, selectedTagsOrRaw) {
  const quickTags = parseTagSelectorValues(selectedTagsOrRaw).map((display) => ({
    display,
    key: normalizeCommercialTag(display),
  }));
  const productTokens = extractCommercialTagTokensFromRow(row);
  const comparisons = quickTags.map((qt) => {
    const ev = evaluateCommercialTagExactMatch(row, qt.display);
    return {
      quick_action_tag: qt.display,
      normalized_quick_action_tag: qt.key,
      product_tags_tokens: ev.product_tags_tokens,
      normalized_product_tags: ev.product_tag_keys,
      filtro3_tokens: ev.filtro3_tokens,
      matched_exact: ev.matched_exact,
      match_via: ev.match_via,
    };
  });
  return {
    sku: row?.Articulo || "",
    detalles: String(row?.DetallesSimilitud ?? "").trim(),
    comparisons,
    matched: comparisons.some((c) => c.matched_exact),
  };
}

/** OR: la fila coincide si matchea al menos uno de los tags configurados. */
export function productRowMatchesAnyTag(row, tagsOrRaw) {
  const tags = Array.isArray(tagsOrRaw)
    ? tagsOrRaw
    : parseTagSelectorValues(tagsOrRaw);
  if (!tags.length) return false;
  return tags.some((tag) => productRowMatchesTag(row, tag));
}

/** Producto agrupado (post-reduce) con Filtro1–3. */
export function groupedProductMatchesTag(producto, selectedTag) {
  return productRowMatchesTag(
    {
      Filtro1: producto?.Filtro1,
      Filtro2: producto?.Filtro2,
      Filtro3: producto?.Filtro3,
    },
    selectedTag
  );
}

/** OR sobre producto agrupado (Filtro1–3 ya fusionados entre variantes). */
export function groupedProductMatchesAnyTag(producto, tagsOrRaw) {
  const tags = Array.isArray(tagsOrRaw)
    ? tagsOrRaw
    : parseTagSelectorValues(tagsOrRaw);
  if (!tags.length) return false;
  return tags.some((tag) => groupedProductMatchesTag(producto, tag));
}

/** Une valores de un mismo FiltroN al agrupar variantes por artículo. */
export function mergeFilterFieldValues(existing, incoming) {
  const keys = new Set();
  const displays = [];

  for (const raw of [existing, incoming]) {
    for (const token of tokensFromFilterField(raw)) {
      const key = canonicalTagKey(token);
      if (!key || keys.has(key)) continue;
      keys.add(key);
      displays.push(token);
    }
  }

  return displays.join(", ");
}

/** Fusiona Filtro1–3 de una fila nueva en el acumulado del artículo agrupado. */
export function mergeProductRowFilterTags(target, row) {
  if (!target || !row) return target;
  target.Filtro1 = mergeFilterFieldValues(target.Filtro1, row.Filtro1);
  target.Filtro2 = mergeFilterFieldValues(target.Filtro2, row.Filtro2);
  target.Filtro3 = mergeFilterFieldValues(target.Filtro3, row.Filtro3);
  return target;
}

/**
 * Lista unificada para selects del admin: una entrada por clave canónica.
 * @param {Array<{Filtro1?: string, Filtro2?: string, Filtro3?: string}>} rows
 * @returns {string[]}
 */
export function collectUnifiedTagsFromCatalogRows(rows) {
  const groups = new Map();

  const addTag = (raw) => {
    const display = normalizeTagDisplay(raw);
    if (!display) return;
    const key = canonicalTagKey(display);
    if (!key) return;

    const entry = groups.get(key);
    if (!entry) {
      groups.set(key, { display, count: 1 });
    } else {
      entry.count += 1;
      entry.display = preferDisplayLabel(entry.display, display);
    }
  };

  (rows || []).forEach((item) => {
    for (const field of [item.Filtro1, item.Filtro2, item.Filtro3]) {
      for (const token of tokensFromFilterField(field)) {
        addTag(token);
      }
    }
  });

  return Array.from(groups.values())
    .sort((a, b) =>
      a.display.localeCompare(b.display, "es", { sensitivity: "base" })
    )
    .map((e) => e.display);
}

/** Tags comerciales de una fila: DetallesSimilitud (product_tag_details). */
export function extractCommercialTagsFromProductRow(row) {
  const detalles = String(row?.DetallesSimilitud ?? "").trim();
  if (!detalles) return [];
  return splitCommercialTags(detalles, { silent: true }).tags;
}

/** Matcher banner/catálogo: token exacto en DetallesSimilitud o Filtro3 (Tags3). */
export function productRowMatchesCommercialTag(row, selectedTag) {
  const ev = evaluateCommercialTagExactMatch(row, selectedTag);
  if (commercialMatchLogEnabled() && ev.matched_exact) {
    logCommercialTagExactMatch(row, selectedTag, { surface: "matcher" });
  }
  return ev.matched_exact;
}

export function productRowMatchesAnyCommercialTag(row, tagsOrRaw) {
  const tags = Array.isArray(tagsOrRaw)
    ? tagsOrRaw
    : parseTagSelectorValues(tagsOrRaw);
  if (!tags.length) return false;
  return tags.some((tag) => productRowMatchesCommercialTag(row, tag));
}

export function groupedProductMatchesCommercialTag(producto, selectedTag) {
  return productRowMatchesCommercialTag(
    {
      Articulo: producto?.Articulo,
      DetallesSimilitud: producto?.DetallesSimilitud,
      Filtro3: producto?.Filtro3,
    },
    selectedTag
  );
}

export function groupedProductMatchesAnyCommercialTag(producto, tagsOrRaw) {
  const tags = Array.isArray(tagsOrRaw)
    ? tagsOrRaw
    : parseTagSelectorValues(tagsOrRaw);
  if (!tags.length) return false;
  return tags.some((tag) => groupedProductMatchesCommercialTag(producto, tag));
}

/** Fusiona DetallesSimilitud al agrupar variantes por artículo. */
export function mergeProductRowCommercialTags(target, row) {
  if (!target || !row) return target;
  target.DetallesSimilitud = mergeCommercialTagFieldValues(
    target.DetallesSimilitud,
    row.DetallesSimilitud
  );
  const { value } = sanitizeDetallesSimilitudField(target.DetallesSimilitud, {
    context: "merge_grouped",
    sku: target.Articulo,
    silent: true,
  });
  target.DetallesSimilitud = value;
  return target;
}

/**
 * Lista unificada para admin/banner (solo detalles comerciales en filas enriquecidas).
 * @param {Array<{DetallesSimilitud?: string}>} rows
 */
export function collectUnifiedCommercialTagsFromRows(rows) {
  const groups = new Map();

  for (const row of rows || []) {
    const { tags } = splitCommercialTags(row?.DetallesSimilitud, { silent: true });
    for (const display of tags) {
      const key = normalizeCommercialTag(display);
      if (!key) continue;
      const entry = groups.get(key);
      if (!entry) {
        groups.set(key, { display, count: 1 });
      } else {
        entry.count += 1;
        entry.display = preferDisplayLabel(entry.display, display);
      }
    }
  }

  return Array.from(groups.values())
    .sort((a, b) =>
      a.display.localeCompare(b.display, "es", { sensitivity: "base" })
    )
    .map((e) => e.display);
}

/** Límite defensivo por fila de catálogo (observabilidad; no bloquea guardado en admin). */
export const DETALLES_SIMILITUD_MAX_CHARS = 128;

/** Aviso si hay muchos detalles seleccionados en admin. */
export const DETALLES_SIMILITUD_WARN_TAG_COUNT = 20;

export function logCommercialTagsWarning(event, detail = null) {
  if (detail != null) {
    console.warn("[FYL Commercial Tags Warning]", event, detail);
  } else {
    console.warn("[FYL Commercial Tags Warning]", event);
  }
}

/**
 * Normaliza DetallesSimilitud: trim, espacios colapsados, dedupe por clave canónica,
 * tope de longitud. No fuerza minúsculas en display (solo canonical para dedupe).
 */
export function sanitizeDetallesSimilitudField(
  raw,
  {
    maxChars = DETALLES_SIMILITUD_MAX_CHARS,
    context = "",
    sku = "",
    silent = false,
  } = {}
) {
  const warnings = [];
  const input = String(raw ?? "").trim();
  if (!input) {
    return { value: "", warnings, changed: false };
  }

  const split = splitCommercialTags(input, {
    context: context || "sanitize",
    sku,
    silent,
  });

  if (split.duplicatesRemoved.length) {
    warnings.push({
      type: "dedupe",
      tokens: split.duplicatesRemoved,
    });
  }
  if (split.discarded.length) {
    warnings.push({ type: "discarded", items: split.discarded });
  }

  const displays = split.tags;
  let value = joinCommercialTags(displays);
  if (value.length > maxChars) {
    let truncated = "";
    for (const d of displays) {
      const next = truncated ? `${truncated}, ${d}` : d;
      if (next.length > maxChars) {
        warnings.push({
          type: "truncate",
          maxChars,
          beforeLen: value.length,
        });
        break;
      }
      truncated = next;
    }
    value = truncated || value.slice(0, maxChars);
  }

  const changed = value !== input;
  if (!silent && (changed || warnings.length)) {
    logCommercialTagsWarning(context || "sanitize", {
      sku: sku || undefined,
      beforeLen: input.length,
      afterLen: value.length,
      warnings,
    });
  }

  return { value, warnings, changed };
}

/** Aplica sanitización in-place si existe la columna. */
export function sanitizeRowDetallesSimilitud(row, context = "") {
  if (!row || !Object.prototype.hasOwnProperty.call(row, "DetallesSimilitud")) {
    return row;
  }
  const bulkContext =
    context === "catalog_enrich" ||
    context === "catalog_row" ||
    context === "bridge_build";
  const { value } = sanitizeDetallesSimilitudField(row.DetallesSimilitud, {
    context,
    sku: row.Articulo,
    silent: bulkContext,
  });
  row.DetallesSimilitud = value;
  return row;
}

/**
 * Observabilidad admin: avisa si la selección generaría un campo largo.
 * No bloquea guardado.
 */
export function warnDetallesSimilitudFromTagNames(
  tagNames,
  { context = "admin", sku = "", productId = "" } = {}
) {
  const names = [];
  for (const n of tagNames || []) {
    names.push(...splitCommercialTags(n, { silent: true }).tags);
  }
  const raw = joinCommercialTags(names);
  const { value, warnings } = sanitizeDetallesSimilitudField(raw, {
    context: `${context}_preview`,
    sku,
    silent: true,
  });

  const softLen = Math.floor(DETALLES_SIMILITUD_MAX_CHARS * 0.85);
  const truncated = warnings.some((w) => w.type === "truncate");
  const manyTags = names.length > DETALLES_SIMILITUD_WARN_TAG_COUNT;
  const nearLimit = value.length >= softLen;

  if (!truncated && !manyTags && !nearLimit) {
    return { warn: false, value, message: "" };
  }

  const message = truncated
    ? `Detalles comerciales superan ${DETALLES_SIMILITUD_MAX_CHARS} caracteres en catálogo (${value.length} tras recorte). Revisá la selección.`
    : manyTags
      ? `Muchos detalles comerciales (${names.length}). Máximo recomendado: ${DETALLES_SIMILITUD_WARN_TAG_COUNT}.`
      : `Detalles comerciales cerca del límite (${value.length}/${DETALLES_SIMILITUD_MAX_CHARS} caracteres).`;

  logCommercialTagsWarning("admin_selection", {
    productId: productId || undefined,
    sku: sku || undefined,
    tagCount: names.length,
    len: value.length,
    maxChars: DETALLES_SIMILITUD_MAX_CHARS,
    warnings,
  });

  return { warn: true, value, message };
}
