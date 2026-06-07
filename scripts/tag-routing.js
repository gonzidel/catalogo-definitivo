// scripts/tag-routing.js — Hash multi-tag, slugs y navegación sin loops

import {
  normalizeCommercialTag,
  normalizeTagDisplay,
  parseTagSelectorValues,
} from "./tag-normalize.js?v=m260607";

/** Slug para URL: minúsculas, sin acentos, espacios → guiones. */
export function tagToHashSlug(tag) {
  const basic = String(tag ?? "")
    .trim()
    .toLowerCase();
  if (!basic) return "";
  let t = basic;
  try {
    t = t.normalize("NFD").replace(/\p{M}/gu, "");
  } catch {
    t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  return t.replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Etiqueta legible desde slug de hash. */
export function hashSlugToTagLabel(slug) {
  const decoded = decodeURIComponent(String(slug ?? "")).trim();
  if (!decoded) return "";
  return normalizeTagDisplay(decoded.replace(/-/g, " "));
}

/** Sin duplicados por clave canónica. */
export function dedupeTagsByCanonical(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of tags || []) {
    const display = normalizeTagDisplay(raw);
    if (!display) continue;
    const key = normalizeCommercialTag(display);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out;
}

/**
 * Lee tags activos desde el hash.
 * Soporta `#/tags/a|b` y legacy `#/tag/x`.
 * @param {string|Location|undefined} hashOrLocation
 * @returns {string[]}
 */
export function parseHashTags(hashOrLocation) {
  let hash = "";
  if (typeof hashOrLocation === "string") {
    hash = hashOrLocation.startsWith("#") ? hashOrLocation : `#${hashOrLocation}`;
  } else if (hashOrLocation && typeof hashOrLocation.hash === "string") {
    hash = hashOrLocation.hash;
  } else if (typeof location !== "undefined") {
    hash = location.hash || "";
  }

  const multi = hash.match(/^#\/tags\/(.+)$/i);
  if (multi) {
    const parts = multi[1]
      .split("|")
      .map((p) => hashSlugToTagLabel(p.trim()))
      .filter(Boolean);
    return dedupeTagsByCanonical(parts);
  }

  const single = hash.match(/^#\/tag\/(.+)$/i);
  if (single) {
    return dedupeTagsByCanonical([hashSlugToTagLabel(single[1])]);
  }

  return [];
}

/** Clave estable para analytics (tags ordenados por canónico). */
export function buildTagComboAnalyticsKey(tags) {
  return dedupeTagsByCanonical(
    Array.isArray(tags) ? tags : parseTagSelectorValues(tags)
  )
    .map((t) => normalizeCommercialTag(t))
    .filter(Boolean)
    .sort()
    .join("|");
}

/**
 * Construye hash de navegación.
 * Un tag → `#/tag/slug` (compat). Varios → `#/tags/slug1|slug2`.
 */
export function buildTagsHash(tagsOrRaw) {
  const tags = dedupeTagsByCanonical(
    Array.isArray(tagsOrRaw) ? tagsOrRaw : parseTagSelectorValues(tagsOrRaw)
  );
  if (!tags.length) return "#/";

  const slugs = [...new Set(tags.map(tagToHashSlug).filter(Boolean))];
  if (!slugs.length) return "#/";

  if (slugs.length === 1) {
    return `#/tag/${encodeURIComponent(slugs[0])}`;
  }
  return `#/tags/${slugs.map((s) => encodeURIComponent(s)).join("|")}`;
}

let __hashNavLock = false;

export function isHashNavLocked() {
  return __hashNavLock;
}

/**
 * Navega al filtro multi-tag. Evita reasignar el mismo hash.
 * @param {string|string[]} tagsOrRaw
 * @param {{ replace?: boolean, source?: string }} [opts]
 */
export function navigateToTagsHash(tagsOrRaw, { replace = false, source = "" } = {}) {
  const target = buildTagsHash(tagsOrRaw);
  const current = typeof location !== "undefined" ? location.hash || "#/" : "#/";

  if (current === target) return;
  if (__hashNavLock) return;

  if (typeof window !== "undefined" && source) {
    window.__fylTagNavSource = source;
  }

  __hashNavLock = true;
  try {
    if (replace) {
      const u = new URL(location.href);
      u.hash = target;
      history.replaceState(history.state || {}, "", u);
      if (typeof window.__fylOnTagsHashNav === "function") {
        window.__fylOnTagsHashNav(parseHashTags(target), { pushHash: false });
      }
    } else {
      location.hash = target;
    }
  } finally {
    queueMicrotask(() => {
      __hashNavLock = false;
    });
  }
}

/** Analytics: apertura de filtro por tag(s). */
export function trackTagsFilterOpen(tags, { productCount = 0, source = "", surface = "catalog" } = {}) {
  const list = dedupeTagsByCanonical(Array.isArray(tags) ? tags : parseTagSelectorValues(tags));
  if (!list.length) return;
  try {
    if (window.fylAnalytics?.isReady?.()) {
      window.fylAnalytics.event("tags_filter_open", {
        tags: list.join(", "),
        tag_count: list.length,
        tag_combo_key: buildTagComboAnalyticsKey(list),
        product_count: Number(productCount) || 0,
        source: String(source || window.__fylTagNavSource || "unknown").slice(0, 64),
        surface,
      });
    }
  } catch (_e) {}
}

/** Analytics: click en “Ver todo” del banner. */
export function trackBannerVerTodoClick(tags, { banner = "custom_dynamic" } = {}) {
  const list = dedupeTagsByCanonical(Array.isArray(tags) ? tags : parseTagSelectorValues(tags));
  try {
    if (window.fylAnalytics?.isReady?.()) {
      window.fylAnalytics.event("banner_ver_todo_click", {
        banner,
        tags: list.join(", "),
        tag_count: list.length,
        tag_combo_key: buildTagComboAnalyticsKey(list),
      });
    }
  } catch (_e) {}
}

/** Analytics: conversión con filtro de tags activo. */
export function trackTagFilterConversion(extra = {}) {
  const list = Array.isArray(window.__fylActiveTagFilters)
    ? window.__fylActiveTagFilters
    : [];
  if (!list.length) return;
  try {
    if (window.fylAnalytics?.isReady?.()) {
      window.fylAnalytics.event("tag_filter_conversion", {
        tags: list.join(", "),
        tag_count: list.length,
        tag_combo_key: buildTagComboAnalyticsKey(list),
        ...extra,
      });
    }
  } catch (_e) {}
}

if (typeof window !== "undefined") {
  window.parseHashTags = parseHashTags;
  window.buildTagsHash = buildTagsHash;
  window.navigateToTagsHash = navigateToTagsHash;
  window.tagToHashSlug = tagToHashSlug;
}
