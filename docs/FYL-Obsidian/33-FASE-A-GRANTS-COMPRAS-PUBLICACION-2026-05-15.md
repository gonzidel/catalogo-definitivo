# 33 — Fase A: grants compras + publicación (PostgREST)

**Fecha:** 2026-05-15  
**Tipo:** hardening incremental Supabase / superficie REST  
**Proyecto:** `fyl-core` (`dtfznewwvsadkorxwzft`)

## Resumen

Se corrigió la **deriva de grants** sobre tres vistas (`purchase_order_line_fulfillment`, `purchase_spend_by_season`, `vw_publication_events_performance`): se revocó acceso de **`anon`** y **`PUBLIC`** y se reafirmó **`SELECT`** para **`authenticated`** y **`service_role`**, alineado con el canon `181` / `192`.

**No** se tocó: catálogo `catalog_public_available_view`, flujo `catalog_public_snapshot`, vistas analíticas `vw_stock_*` globales, RPCs, Edge.

## Documentación en `doc/` (fuente detallada)

- **Bitácora técnica (errores, reparaciones, artefactos):** `doc/hardening-fase-a-grants-2026-05-15.md`
- **Reporte ejecutivo post-deploy:** `doc/phase-a-reporte-deploy-2026-05-15.md`
- **Registro histórico hardening mayo 2026:** `doc/hardening-supabase-2026-05-13.md` (sección añadida 2026-05-15)

## Contexto en el vault

- Auditoría Postgres / superficie: [[28-AUDITORIA-SUPABASE-POSTGRES-2026-05-13]]
- Allowlist anon: [[29-ALLOWLIST-ANON-PUBLIC-SURFACE]]
- Inventario SECURITY DEFINER (funciones; contexto relacionado): [[30-SECURITY-DEFINER-INVENTORY]]

## Deuda explícita (post–Fase A)

- Cualquier JWT **`authenticated`** puede seguir leyendo vistas con `GRANT SELECT` amplio (p. ej. `vw_stock_fast_sellers`, `vw_stock_tag_summary`). **Fase A no lo corrige**; ver bitácora en `doc/hardening-fase-a-grants-2026-05-15.md` §5 y checklist §7.

## SQL canónico

- `supabase/canonical/214_phase_a_revoke_anon_purchase_publication_views.sql`
- Rollback de emergencia (solo si hace falta revertir): `supabase/canonical/214_phase_a_ROLLBACK_revoke_anon_undo.sql`

## Scripts de verificación

- `scripts/phase-a-pre-grants-snapshot.sql`
- `scripts/phase-a-verify-post-migration.sql`
- `scripts/phase-a-verify-postgrest.mjs` (flag `--report` → `scripts/outputs/phase-a-http-evidence.json`)

## Lecciones operativas

1. Guardar evidencia **BEFORE** (SQL + HTTP) **antes** de aplicar migraciones de grants.
2. En Windows/Node, TLS puede requerir `FYL_AUDIT_INSECURE_TLS=1` solo para smoke local; preferir CA correcta en CI.
3. PostgREST puede mapear permiso denegado a **401** con código `42501` en JSON.
