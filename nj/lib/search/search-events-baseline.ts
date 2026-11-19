/**
 * Lectura de línea base de search_events (Fase D, solo lectura).
 * Requiere sesión admin; el conector MCP puede estar caído — usar REST con JWT admin.
 *
 * Uso:
 *   npx tsx lib/search/search-events-baseline.ts
 * (imprime SQL sugerido si no hay SUPABASE_URL/SERVICE en env)
 */
export const SEARCH_EVENTS_BASELINE_SQL = `
-- Solo lectura. Correr en SQL editor como admin / service_role.
select
  count(*) filter (where event_type = 'search_committed' and result_count = 0) as zero_results,
  count(*) filter (where event_type = 'search_committed') as searches,
  count(*) filter (where event_type = 'result_click') as clicks
from public.search_events
where created_at > now() - interval '30 days';

select query_normalized, count(*) as n
from public.search_events
where event_type = 'search_committed'
  and created_at > now() - interval '30 days'
  and coalesce(result_count, 0) = 0
group by 1
order by n desc
limit 30;

select query_normalized, count(*) as n
from public.search_events
where event_type = 'search_committed'
  and created_at > now() - interval '30 days'
group by 1
order by n desc
limit 30;
`.trim();

export interface SearchEventsBaselineNote {
  status: "pending_admin_read" | "captured";
  reason: string;
  sql: string;
}

export function searchEventsBaselineStatus(): SearchEventsBaselineNote {
  return {
    status: "pending_admin_read",
    reason:
      "Supabase MCP caído / requiere JWT admin. SQL listo en SEARCH_EVENTS_BASELINE_SQL.",
    sql: SEARCH_EVENTS_BASELINE_SQL,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const note = searchEventsBaselineStatus();
  console.log(note.reason);
  console.log("\n" + note.sql);
}
