import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeText } from "@/lib/search/normalize";
import type { SearchAliasKind, SearchKeywordKind } from "@/lib/search/types";
import type { SearchAdminDays } from "@/lib/admin/search-admin-constants";
import {
  aliasUsageHits,
  buildKeywordUsageMap,
  type IdentityUsageRow,
  type ResolutionUsageRow,
} from "@/lib/admin/search-admin-usage";
import type { SearchVocabLookup } from "@/lib/admin/search-admin-validate";

export type SearchDashboardStats = {
  searches7d: number;
  searches30d: number;
  zeroResults30d: number;
  aliasUsedPct30d: number | null;
  keywordsActive: number;
  aliasesActive: number;
};

export type SearchKeywordListItem = {
  id: string;
  canonical: string;
  displayLabel: string;
  kind: SearchKeywordKind | null;
  active: boolean;
  aliasCount: number;
  usage30d: number;
};

export type SearchAliasListItem = {
  id: string;
  alias: string;
  aliasNormalized: string;
  kind: SearchAliasKind | null;
  active: boolean;
  isIdentity: boolean;
  usage30d: number;
  lastUsed: string | null;
};

export type RelatedKeyword = {
  canonical: string;
  displayLabel: string;
};

export type GroupedSearchQuery = {
  queryNormalized: string;
  queryResolved: string;
  searches: number;
  lastSeen: string;
  sampleOriginal: string;
  avgResultCount: number;
  related: RelatedKeyword | null;
};

export type IgnoredSearchTerm = {
  id: string;
  normalizedTerm: string;
  reason: string | null;
  createdAt: string;
};

export type KeywordDetails = {
  keyword: {
    id: string;
    canonical: string;
    displayLabel: string;
    kind: SearchKeywordKind | null;
    active: boolean;
  };
  aliases: SearchAliasListItem[];
  usage: {
    resolutionHits: number;
    exactResolvedHits: number;
    usage: number;
    lastSeen: string | null;
    topAliases: Array<{ alias: string; hits: number; lastSeen: string }>;
  };
  relatedZeroResults: GroupedSearchQuery[];
};

export type SearchAdminDashboard = {
  stats: SearchDashboardStats;
  keywords: SearchKeywordListItem[];
  zeroResults: GroupedSearchQuery[];
  lowResults: GroupedSearchQuery[];
  candidates: GroupedSearchQuery[];
  ignored: IgnoredSearchTerm[];
  lookup: SearchVocabLookup;
  days: SearchAdminDays;
};

type KeywordRow = {
  id: string;
  canonical: string;
  display_label: string;
  kind: string | null;
  active: boolean;
};

type AliasRow = {
  id: string;
  keyword_id: string;
  alias: string;
  alias_normalized: string;
  kind: string | null;
  active: boolean;
};

function asKeywordKind(value: string | null): SearchKeywordKind | null {
  if (
    value === "product_type" ||
    value === "color" ||
    value === "attribute" ||
    value === "commercial"
  ) {
    return value;
  }
  return null;
}

function asAliasKind(value: string | null): SearchAliasKind | null {
  if (
    value === "plural" ||
    value === "grammatical" ||
    value === "abbreviation" ||
    value === "commercial" ||
    value === "typo" ||
    value === "spacing" ||
    value === "legacy_tag"
  ) {
    return value;
  }
  return null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function loadVocabLookup(supabase: SupabaseClient): Promise<SearchVocabLookup> {
  const [{ data: keywords, error: kwErr }, { data: aliases, error: alErr }] = await Promise.all([
    supabase.from("search_keywords").select("id, canonical, display_label, kind, active"),
    supabase.from("search_aliases").select("id, keyword_id, alias, alias_normalized, kind, active"),
  ]);
  if (kwErr) throw new Error(kwErr.message);
  if (alErr) throw new Error(alErr.message);

  const kwRows = (keywords ?? []) as KeywordRow[];
  const alRows = (aliases ?? []) as AliasRow[];
  const byId = new Map(kwRows.map((k) => [k.id, k]));

  return {
    keywords: kwRows.map((k) => ({
      id: k.id,
      canonical: k.canonical,
      displayLabel: k.display_label,
    })),
    aliases: alRows.map((a) => ({
      id: a.id,
      aliasNormalized: a.alias_normalized,
      keywordId: a.keyword_id,
      canonical: byId.get(a.keyword_id)?.canonical ?? "",
    })),
  };
}

async function loadResolutionUsage(
  supabase: SupabaseClient,
  days: number
): Promise<ResolutionUsageRow[]> {
  const { data, error } = await supabase.rpc("search_admin_resolution_usage", {
    p_days: days,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{
    canonical: string;
    alias_input: string;
    hits: number;
    last_seen: string;
  }>).map((r) => ({
    canonical: r.canonical,
    aliasInput: r.alias_input,
    hits: num(r.hits),
    lastSeen: r.last_seen,
  }));
}

async function loadIdentityUsage(
  supabase: SupabaseClient,
  days: number
): Promise<IdentityUsageRow[]> {
  const { data, error } = await supabase.rpc("search_admin_resolved_usage", {
    p_days: days,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{
    query_resolved: string;
    hits: number;
    last_seen: string;
  }>).map((r) => ({
    queryResolved: r.query_resolved,
    hits: num(r.hits),
    lastSeen: r.last_seen,
  }));
}

async function loadGroupedQueries(
  supabase: SupabaseClient,
  days: number,
  mode: "zero" | "low" | "unresolved"
): Promise<GroupedSearchQuery[]> {
  const { data, error } = await supabase.rpc("search_admin_grouped_queries", {
    p_days: days,
    p_mode: mode,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{
    query_normalized: string;
    query_resolved: string;
    searches: number;
    last_seen: string;
    sample_original: string;
    avg_result_count: number;
  }>).map((r) => ({
    queryNormalized: r.query_normalized,
    queryResolved: r.query_resolved,
    searches: num(r.searches),
    lastSeen: r.last_seen,
    sampleOriginal: r.sample_original,
    avgResultCount: num(r.avg_result_count),
    related: null,
  }));
}

function findRelated(
  queryNormalized: string,
  queryResolved: string,
  lookup: SearchVocabLookup
): RelatedKeyword | null {
  const terms = [queryNormalized, queryResolved].filter(Boolean);
  for (const term of terms) {
    const kw = lookup.keywords.find((k) => k.canonical === term);
    if (kw) return { canonical: kw.canonical, displayLabel: kw.displayLabel };
    const alias = lookup.aliases.find((a) => a.aliasNormalized === term);
    if (alias) {
      const owner = lookup.keywords.find((k) => k.id === alias.keywordId);
      if (owner) return { canonical: owner.canonical, displayLabel: owner.displayLabel };
    }
  }
  return null;
}

function attachRelated(rows: GroupedSearchQuery[], lookup: SearchVocabLookup): GroupedSearchQuery[] {
  return rows.map((row) => ({
    ...row,
    related: findRelated(row.queryNormalized, row.queryResolved, lookup),
  }));
}

function knownTerms(lookup: SearchVocabLookup): Set<string> {
  const set = new Set<string>();
  for (const k of lookup.keywords) set.add(k.canonical);
  for (const a of lookup.aliases) set.add(a.aliasNormalized);
  return set;
}

export async function loadSearchAdminDashboard(
  supabase: SupabaseClient,
  days: SearchAdminDays
): Promise<SearchAdminDashboard> {
  const [
    statsRes,
    lookup,
    keywordsRes,
    aliasesRes,
    resolutions,
    identity,
    zeroRaw,
    lowRaw,
    unresolvedRaw,
    ignoredRes,
  ] = await Promise.all([
    supabase.rpc("search_admin_dashboard_stats"),
    loadVocabLookup(supabase),
    supabase.from("search_keywords").select("id, canonical, display_label, kind, active").order("display_label"),
    supabase.from("search_aliases").select("id, keyword_id, alias, alias_normalized, kind, active"),
    loadResolutionUsage(supabase, 30),
    loadIdentityUsage(supabase, 30),
    loadGroupedQueries(supabase, days, "zero"),
    loadGroupedQueries(supabase, days, "low"),
    loadGroupedQueries(supabase, days, "unresolved"),
    supabase
      .from("search_ignored_terms")
      .select("id, normalized_term, reason, created_at")
      .order("created_at", { ascending: false }),
  ]);

  if (statsRes.error) throw new Error(statsRes.error.message);
  if (keywordsRes.error) throw new Error(keywordsRes.error.message);
  if (aliasesRes.error) throw new Error(aliasesRes.error.message);
  if (ignoredRes.error) throw new Error(ignoredRes.error.message);

  const rawStats = (statsRes.data ?? {}) as Record<string, unknown>;
  const searches30d = num(rawStats.searches_30d);
  const aliasUsed = num(rawStats.alias_used_30d);
  const stats: SearchDashboardStats = {
    searches7d: num(rawStats.searches_7d),
    searches30d,
    zeroResults30d: num(rawStats.zero_results_30d),
    aliasUsedPct30d: searches30d > 0 ? Math.round((aliasUsed / searches30d) * 1000) / 10 : null,
    keywordsActive: num(rawStats.keywords_active),
    aliasesActive: num(rawStats.aliases_active),
  };

  const usageMap = buildKeywordUsageMap(resolutions, identity);
  const aliasRows = (aliasesRes.data ?? []) as AliasRow[];
  const aliasCountByKw = new Map<string, number>();
  for (const a of aliasRows) {
    const kw = lookup.keywords.find((k) => k.id === a.keyword_id);
    if (!kw || a.alias_normalized === kw.canonical) continue;
    aliasCountByKw.set(a.keyword_id, (aliasCountByKw.get(a.keyword_id) ?? 0) + 1);
  }

  const keywords: SearchKeywordListItem[] = ((keywordsRes.data ?? []) as KeywordRow[]).map((k) => ({
    id: k.id,
    canonical: k.canonical,
    displayLabel: k.display_label,
    kind: asKeywordKind(k.kind),
    active: k.active,
    aliasCount: aliasCountByKw.get(k.id) ?? 0,
    usage30d: usageMap.get(k.canonical)?.usage ?? 0,
  }));

  const ignored: IgnoredSearchTerm[] = ((ignoredRes.data ?? []) as Array<{
    id: string;
    normalized_term: string;
    reason: string | null;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    normalizedTerm: r.normalized_term,
    reason: r.reason,
    createdAt: r.created_at,
  }));

  const ignoredSet = new Set(ignored.map((i) => i.normalizedTerm));
  const dictTerms = knownTerms(lookup);
  const zeroResults = attachRelated(zeroRaw, lookup);
  const lowResults = attachRelated(lowRaw, lookup);
  const candidates = attachRelated(
    unresolvedRaw.filter(
      (row) => !ignoredSet.has(row.queryNormalized) && !dictTerms.has(row.queryNormalized)
    ),
    lookup
  );

  return {
    stats,
    keywords,
    zeroResults,
    lowResults,
    candidates,
    ignored,
    lookup,
    days,
  };
}

export async function loadKeywordDetails(
  supabase: SupabaseClient,
  canonical: string,
  days: SearchAdminDays
): Promise<KeywordDetails | null> {
  const normalized = normalizeText(canonical);
  const { data: keyword, error } = await supabase
    .from("search_keywords")
    .select("id, canonical, display_label, kind, active")
    .eq("canonical", normalized)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!keyword) return null;

  const kw = keyword as KeywordRow;
  const [{ data: aliases, error: alErr }, lookup, resolutions, identity, zeroRaw] = await Promise.all([
    supabase
      .from("search_aliases")
      .select("id, keyword_id, alias, alias_normalized, kind, active")
      .eq("keyword_id", kw.id)
      .order("alias_normalized"),
    loadVocabLookup(supabase),
    loadResolutionUsage(supabase, 30),
    loadIdentityUsage(supabase, 30),
    loadGroupedQueries(supabase, days, "zero"),
  ]);
  if (alErr) throw new Error(alErr.message);

  const usage = buildKeywordUsageMap(resolutions, identity).get(kw.canonical) ?? {
    canonical: kw.canonical,
    resolutionHits: 0,
    exactResolvedHits: 0,
    usage: 0,
    lastSeen: null,
    topAliases: [],
  };

  const aliasItems: SearchAliasListItem[] = ((aliases ?? []) as AliasRow[]).map((a) => {
    const isIdentity = a.alias_normalized === kw.canonical;
    const u = aliasUsageHits(a.alias_normalized, resolutions);
    return {
      id: a.id,
      alias: a.alias,
      aliasNormalized: a.alias_normalized,
      kind: asAliasKind(a.kind),
      active: a.active,
      isIdentity,
      usage30d: isIdentity ? usage.exactResolvedHits : u.hits,
      lastUsed: isIdentity ? usage.lastSeen : u.lastSeen,
    };
  });

  const relatedZeroResults = attachRelated(zeroRaw, lookup).filter((row) => {
    if (row.related?.canonical === kw.canonical) return true;
    if (row.queryResolved === kw.canonical || row.queryNormalized === kw.canonical) return true;
    return aliasItems.some(
      (a) => a.aliasNormalized === row.queryNormalized || a.aliasNormalized === row.queryResolved
    );
  });

  return {
    keyword: {
      id: kw.id,
      canonical: kw.canonical,
      displayLabel: kw.display_label,
      kind: asKeywordKind(kw.kind),
      active: kw.active,
    },
    aliases: aliasItems.filter((a) => !a.isIdentity),
    usage: {
      resolutionHits: usage.resolutionHits,
      exactResolvedHits: usage.exactResolvedHits,
      usage: usage.usage,
      lastSeen: usage.lastSeen,
      topAliases: usage.topAliases,
    },
    relatedZeroResults,
  };
}

export async function getKeywordImpact(
  supabase: SupabaseClient,
  keywordId: string
): Promise<{ activeAliases: number; usage30d: number; displayLabel: string; canonical: string }> {
  const { data: keyword, error } = await supabase
    .from("search_keywords")
    .select("id, canonical, display_label")
    .eq("id", keywordId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!keyword) throw new Error("Keyword no encontrada.");

  const [{ count, error: cErr }, resolutions, identity] = await Promise.all([
    supabase
      .from("search_aliases")
      .select("id", { count: "exact", head: true })
      .eq("keyword_id", keywordId)
      .eq("active", true)
      .neq("alias_normalized", keyword.canonical),
    loadResolutionUsage(supabase, 30),
    loadIdentityUsage(supabase, 30),
  ]);
  if (cErr) throw new Error(cErr.message);

  const usage = buildKeywordUsageMap(resolutions, identity).get(keyword.canonical)?.usage ?? 0;
  return {
    activeAliases: count ?? 0,
    usage30d: usage,
    displayLabel: keyword.display_label,
    canonical: keyword.canonical,
  };
}

export async function getAliasImpact(
  supabase: SupabaseClient,
  aliasId: string
): Promise<{ usage30d: number; aliasNormalized: string }> {
  const { data: alias, error } = await supabase
    .from("search_aliases")
    .select("id, alias_normalized")
    .eq("id", aliasId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!alias) throw new Error("Alias no encontrado.");
  const resolutions = await loadResolutionUsage(supabase, 30);
  const u = aliasUsageHits(alias.alias_normalized, resolutions);
  return { usage30d: u.hits, aliasNormalized: alias.alias_normalized };
}
