export type ResolutionUsageRow = {
  canonical: string;
  aliasInput: string;
  hits: number;
  lastSeen: string;
};

export type IdentityUsageRow = {
  queryResolved: string;
  hits: number;
  lastSeen: string;
};

export type KeywordUsage = {
  canonical: string;
  /** Resoluciones JSON que terminaron en este canonical. */
  resolutionHits: number;
  /** Búsquedas identity: resolutions=[] y query_resolved === canonical. */
  exactResolvedHits: number;
  /** Número operativo para el listado (resoluciones + identity). */
  usage: number;
  lastSeen: string | null;
  topAliases: Array<{ alias: string; hits: number; lastSeen: string }>;
};

export function buildKeywordUsageMap(
  resolutions: ResolutionUsageRow[],
  identity: IdentityUsageRow[]
): Map<string, KeywordUsage> {
  const map = new Map<string, KeywordUsage>();

  function ensure(canonical: string): KeywordUsage {
    let row = map.get(canonical);
    if (!row) {
      row = {
        canonical,
        resolutionHits: 0,
        exactResolvedHits: 0,
        usage: 0,
        lastSeen: null,
        topAliases: [],
      };
      map.set(canonical, row);
    }
    return row;
  }

  function touchLastSeen(row: KeywordUsage, iso: string) {
    if (!row.lastSeen || iso > row.lastSeen) row.lastSeen = iso;
  }

  for (const r of resolutions) {
    if (!r.canonical) continue;
    const row = ensure(r.canonical);
    row.resolutionHits += r.hits;
    touchLastSeen(row, r.lastSeen);
    if (r.aliasInput && r.aliasInput !== r.canonical) {
      const existing = row.topAliases.find((a) => a.alias === r.aliasInput);
      if (existing) {
        existing.hits += r.hits;
        if (r.lastSeen > existing.lastSeen) existing.lastSeen = r.lastSeen;
      } else {
        row.topAliases.push({ alias: r.aliasInput, hits: r.hits, lastSeen: r.lastSeen });
      }
    }
  }

  for (const i of identity) {
    if (!i.queryResolved) continue;
    const row = ensure(i.queryResolved);
    row.exactResolvedHits += i.hits;
    touchLastSeen(row, i.lastSeen);
  }

  for (const row of map.values()) {
    row.usage = row.resolutionHits + row.exactResolvedHits;
    row.topAliases.sort((a, b) => b.hits - a.hits || b.lastSeen.localeCompare(a.lastSeen));
  }

  return map;
}

export function aliasUsageHits(
  aliasNormalized: string,
  resolutions: ResolutionUsageRow[]
): { hits: number; lastSeen: string | null } {
  let hits = 0;
  let lastSeen: string | null = null;
  for (const r of resolutions) {
    if (r.aliasInput !== aliasNormalized) continue;
    hits += r.hits;
    if (!lastSeen || r.lastSeen > lastSeen) lastSeen = r.lastSeen;
  }
  return { hits, lastSeen };
}

export function formatRelativeEs(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "hace instantes";
  if (min < 60) return `hace ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;
  return new Date(iso).toLocaleDateString("es-AR");
}
