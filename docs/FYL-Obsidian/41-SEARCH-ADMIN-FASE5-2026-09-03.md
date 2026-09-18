# Buscador FYL — Fase 5 admin de vocabulario (2026-09-03 / apply 2026-09-04)

**Estado:** aplicada en `fyl-core` (`dtfznewwvsadkorxwzft`). Hub vivo: [[59-NJ-BUSCADOR-SMART-SEARCH]]. Código: `doc/nj/smart-search.md`.

**Qué cambió:** el administrador puede gobernar keywords/aliases desde `/nj/admin/search` usando `search_events` como **sugerencia**, no como alta automática.

**Por qué:** Fases 1–4 dejaron resolver + ranking + analytics sin UI. El vocabulario no puede crecer a ciegas ni por script.

**No toca:** `tags`, checkout, stock, catálogo público (salvo invalidar caché del diccionario al guardar).

Regla: **analytics sugiere · administrador decide · buscador ejecuta.**

---

## A. Arquitectura

Mismo patrón que productos / conciliación:

- Page server `force-dynamic` + `getAdminContext()` + `hasPermission(ctx, "search", view|edit)`
- Queries en `nj/lib/admin/search-admin.ts` (no SQL en componentes)
- Mutaciones `"use server"` en `search-admin-actions.ts`
- Validación pura en `search-admin-validate.ts` (misma `normalizeText` que el resolver)
- Agregaciones en PostgreSQL (RPCs). El browser no descarga `search_events`
- Feedback: cajas error/info/aviso del admin (no `alert()`)
- Estilos: tokens de conciliación + `search-admin.module.css`

No es un mini-admin separado. No hay nav global en `/admin` (igual que productos): la entrada es la URL.

## B. Rutas

| Ruta | Uso |
|------|-----|
| `/admin/search` | Dashboard, oportunidades, listado, formularios |
| `/admin/search?days=7\|30\|90` | Ventana de agregados (default 30) |
| `/admin/search?alias=botita` | Prefill desde candidato |
| `/admin/search/[canonical]` | Detalle / edición |

URL pública con basePath: `/nj/admin/search`.

## C. Archivos

**Nuevos**

- `supabase/canonical/329_search_admin.sql`
- `supabase/canonical/329_ROLLBACK_search_admin.sql`
- `nj/lib/admin/search-admin.ts`
- `nj/lib/admin/search-admin-actions.ts`
- `nj/lib/admin/search-admin-validate.ts`
- `nj/lib/admin/search-admin-usage.ts`
- `nj/lib/admin/search-admin-constants.ts`
- `nj/lib/admin/search-admin.selftest.ts`
- `nj/app/admin/search/page.tsx`
- `nj/app/admin/search/[canonical]/page.tsx`
- `nj/app/admin/search/search-admin.module.css`
- `nj/components/admin-search/SearchAdminDashboard.tsx`
- `nj/components/admin-search/KeywordDetailAdmin.tsx`

**Modificados**

- `nj/lib/search/dictionary-store.ts` — `publishSearchDictionaryChange()`
- `nj/hooks/useSearchDictionary.ts` — escucha rev + storage + mutate
- `doc/nj/smart-search.md`

**No modificados:** tablas `tags`, vanilla `scripts/search-manager.js`.

## D. Tablas / views / RPCs

Aplicado:

1. `329_search_admin` — tabla + RPCs + RLS
2. `329_search_admin_anon_revoke` — REVOKE INSERT/UPDATE/DELETE de `anon` sobre `search_keywords` / `search_aliases` (el GRANT de 327 + default privileges dejaba INSERT de anon a nivel tabla; RLS ya bloqueaba, esto es defensa en profundidad). El SQL canónico 329 ya incluye esos REVOKE para un apply limpio.

| Objeto | Tipo | Rol |
|--------|------|-----|
| `search_ignored_terms` | tabla | Términos revisados que no se proponen como alias. UNIQUE `normalized_term`. Trigger usa `search_normalize_text()`. |
| `search_admin_require()` | fn | `RAISE` 42501 si no `is_admin()` |
| `search_admin_dashboard_stats()` | RPC jsonb | 7d, 30d, zero 30d, alias_used 30d, keywords/aliases activos (sin identidad) |
| `search_admin_grouped_queries(days, mode)` | RPC table | `zero` / `low` / `unresolved`, GROUP BY, límite 80, max 90 días |
| `search_admin_resolution_usage(days)` | RPC table | `jsonb_array_elements(resolutions)` |
| `search_admin_resolved_usage(days)` | RPC table | identity: `resolutions = []` |

SECURITY DEFINER + `search_path = public, pg_catalog` + `search_admin_require()`. EXECUTE solo `authenticated`. Anon revocado.

Índices nuevos: ninguno. Alcanza `search_events_type_created_idx` y unique de ignored.

## E. Permisos / RLS

| Superficie | Quién |
|------------|-------|
| UI view/edit | Super admin, o colaborador con `admin_permissions.permission_key = 'search'` |
| RPCs y writes | `public.is_admin()` (`admins.user_id = auth.uid()`) |
| `search_ignored_terms` | authenticated + `is_admin()`; anon sin SELECT |
| Diccionario público | anon SELECT filas **activas** vía vista / RLS |
| `search_events` SELECT | solo admin (Fase 4) |
| Anon INSERT/UPDATE/DELETE keywords/aliases | **false** (post-revoke) |

El frontend público no puede crear/editar/borrar ni leer analytics completos. No se duplicó autorización: UI `hasPermission`, DB `is_admin()`.

Collaborators sin la key `search` ven `AccessDenied` aunque estén en `admins`. El super admin entra directo.

## F. Pantalla principal

Cards (sin gráficos):

- Búsquedas 7d / 30d
- Zero-results 30d
- % de committed 30d con `resolutions <> []`
- Keywords activas
- Aliases activos (excluye identidad)

Secciones:

1. **Sin resultados** — `result_count = 0`, agrupado, orden por frecuencia. Filtro 7/30/90.
2. **Candidatos a alias** — `query_normalized = query_resolved` y `resolutions = []`, no ignorados, no son ya keyword/alias. Acciones: Agregar alias / Ignorar.
3. **Pocos resultados** — `result_count` 1–2, visualmente separado de zero-results.
4. Formularios: agregar alias (destino a mano), crear keyword.
5. Listado keywords: Keyword · Tipo · Aliases · Uso 30d · Estado · Editar / activar-desactivar. Filtro local.
6. Términos ignorados + Restaurar.

Vacío: “No hay búsquedas sin resultados…”, “No hay candidatos nuevos…”, etc.

Banner: eventos de prueba en live, no se borran desde la UI.

## G. Keyword detail

`/admin/search/pantubota`

- Canonical, display label, kind, activo
- Uso 30d: resoluciones JSON / query exacta (= canonical) / combinado
- Aliases más usados
- Tabla aliases (sin fila identidad): tipo, uso 30d, último uso, activar/desactivar, editar
- Impacto antes de desactivar (aviso + confirmar)
- Zero-results relacionados
- Formulario “agregar alias” con destino trabado a esa keyword

## H. Flujo zero-result → alias (ejemplo real)

Live: `xyzabc` · 1 búsqueda · 0 resultados · `resolutions = []`.

1. En Oportunidades / Candidatos: **Agregar alias** rellena `xyzabc`. **No** elige destino.
2. El admin elige keyword (el sistema no asume `xyzabc = bota`).
3. Al guardar, el término es alias → deja de ser candidato.
4. **Ignorar** lo manda a `search_ignored_terms`. Restaurar lo vuelve a mostrar si sigue cumpliendo condiciones.

`pantubotas` no es candidato: ya resolvió a `pantubota` con resolution plural.

## I. Conflictos / validaciones

Misma normalización que `search_normalize_text()`. Sin `force` silencioso.

| Caso | Código | Comportamiento |
|------|--------|----------------|
| Vacío post-normalize | `empty` | Error |
| > 80 chars normalizado | `too_long` | Error |
| Alias ya existe | `alias_exists` | Error (dueño visible) |
| Alias = canonical de otra keyword | `canonical_collision` | Error |
| Alias = canonical destino (identidad) | `identity_alias` | Error |
| Keyword ya existe | `keyword_exists` | Error |
| Keyword choca con alias ajeno | `keyword_is_alias` | Error |
| Sin destino | `missing_destination` | Error |
| `PÁNTUBOTAS` | — | Normaliza a `pantubotas` y choca |

La DB refuerza unique + triggers de 327.

## J. Cache invalidation

Tras mutación exitosa el client llama `publishSearchDictionaryChange()`:

1. `inflight = null` (no vacía el dict viejo → no hay flash vacío)
2. `localStorage fyl_search_dict_rev`
3. evento `fyl-search-dictionary-changed` (misma pestaña)
4. `mutate('fyl-search-dictionary', fetchSearchDictionary())`
5. otras pestañas: listener `storage`

No se espera el SWR de 60s. No hay versionado de infra extra.

## K. Tests (2026-09-04)

Selftest TS: `npx tsx lib/admin/search-admin.selftest.ts` → OK.

| Test | Resultado | Evidencia |
|------|-----------|-----------|
| Alias existente `pantubotas` | PASS | unique `search_aliases_normalized_uniq` |
| Colisión `zapatilla` → Pantubota | PASS | trigger: choca con keyword canónica |
| `PÁNTUBOTAS` | PASS | normaliza y unique |
| Nuevo `fyltestalias` + vista pública | PASS | row en `search_dictionary_public` |
| Desactivar alias | PASS | sale de la vista |
| Ignorar / restaurar | PASS | `FYLTESTIGNORE` → `fyltestignore`, luego DELETE |
| Anon no stats / no ignored / no insert dict | PASS | privileges false |
| Multi-palabra no atribuye query entero | PASS | selftest usage |
| Resolver Fase 2/3 intacto | PASS | `search-resolver.selftest.ts` |
| Tags tocados | PASS | 0 filas `tags` con fyltest |
| UI logueada en browser | **No verificado** | `/nj/admin/search` redirige a Google login |

`fyltestalias` quedó **inactivo** a propósito. No contamina el buscador.

## L. Visual

Estética admin actual (`#f6f3ec`, accent `#2b4a3e`): cards, tablas, pills 7d/30d/90d, cajas de conflicto. Desktop primero, responsive razonable. Sin gráficos. No es Google Analytics.

Para verla: sesión admin → `/nj/admin/search`.

## M. Riesgo / rollback / datos de prueba

**Riesgo:** bajo. Additive. No toca stock, checkout ni tags. Desactivar vocabulario es reversible. RPCs son read + `is_admin()`.

**Rollback conceptual:** `supabase/canonical/329_ROLLBACK_search_admin.sql`

- DROP RPCs + `search_ignored_terms`
- No toca 327/328
- No reabre writes de anon sobre el diccionario

**Eventos de desarrollo en live (no borrar sin avisar):**

| created_at UTC | tipo | original | resolved | count |
|----------------|------|----------|----------|-------|
| 2026-09-04 01:21 | committed | pantubotas | pantubota | 4 |
| 2026-09-04 01:22 | committed | xyzabc | xyzabc | 0 |
| 2026-09-04 01:23 | suggestion | pantu | pantu | — |
| 2026-09-04 01:23 | committed | Pantubota | pantubota | 4 |
| 2026-09-04 01:23 | result_click | Pantubota | pantubota | — |

Limpieza futura: `DELETE` por `query_normalized IN (...)` o por `created_at` anterior al go-live. No inventar environments.

## N. Deuda / próximo

No implementar en esta nota:

1. Limpieza de tags duplicados (Pantubota/Pantubotas, Zapatilla/Zapatillas)
2. Candidatos reales tras días de analytics (hoy el volumen es de prueba)
3. Ranking por clicks de `search_events`
4. Dashboard más avanzado

Pendiente operativo:

- Collaborators necesitan fila `admin_permissions` con `permission_key = 'search'`
- No hay link desde `/admin/products` (no hay nav global)
- Verificar la UI logueado (bloqueado por Google SSO en automatización)

## Enlaces

- [[59-NJ-BUSCADOR-SMART-SEARCH]]
- [[08-PERMISOS-Y-ROLES]]
- [[29-ALLOWLIST-ANON-PUBLIC-SURFACE]]
- [[03-MAPA-DE-RPCS]]
- [[02-MAPA-DE-TABLAS]]
- `doc/nj/smart-search.md`
