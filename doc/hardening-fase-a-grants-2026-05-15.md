# Bitácora técnica — Fase A grants (compras + publicación) y verificación PostgREST

**Proyecto Supabase:** `fyl-core` (`dtfznewwvsadkorxwzft`)  
**Fecha registro:** 2026-05-15  
**Relacionado:** nota Obsidian `docs/FYL-Obsidian/33-FASE-A-GRANTS-COMPRAS-PUBLICACION-2026-05-15.md`, `doc/hardening-supabase-2026-05-13.md`, `doc/phase-a-reporte-deploy-2026-05-15.md`

Este documento conserva **errores, limitaciones, reparaciones y artefactos** del hardening incremental sobre grants de tres vistas públicas mal expuestas a `anon`/`PUBLIC`. Complementa el reporte ejecutivo en `phase-a-reporte-deploy-2026-05-15.md`.

---

## 1. Contexto

- Auditoría previa (linter Supabase / arquitectura): vistas `purchase_order_line_fulfillment`, `purchase_spend_by_season`, `vw_publication_events_performance` con deriva respecto al canon (`181`, `192`): **grants a `anon`** y herencia vía **`PUBLIC`**, mientras el diseño pretendía solo **`authenticated`** + **`service_role`**.
- Objetivo **Fase A:** solo corregir esa deriva; **sin** tocar `catalog_public_available_view`, analytics `vw_stock_*`, RPCs, Edge ni revokes amplios a `authenticated`.

---

## 2. Migración aplicada (SQL canónico)

- Archivo: `supabase/canonical/214_phase_a_revoke_anon_purchase_publication_views.sql`
- Contenido efectivo: `REVOKE ALL ... FROM anon, PUBLIC` en las tres vistas; `GRANT SELECT ... TO authenticated, service_role`; guardas con `to_regclass`; `pg_notify('pgrst', 'reload schema')`.
- **Aplicación en producción:** ejecutada vía herramienta MCP `execute_sql` contra el proyecto vivo (aprobación explícita del operador en chat).

---

## 3. Errores y limitaciones operativas

### 3.1 Orden de evidencia BEFORE / AFTER

- **Problema:** la migración **214 se aplicó antes** de guardar en el repo una captura SQL “BEFORE” ni corridas HTTP “BEFORE” documentadas.
- **Impacto:** no hay diff histórico verificable en archivos para ese deploy concreto; la evidencia **POST** quedó en consultas SQL puntuales + JSON HTTP.
- **Mitigación futura:** en todo deploy de grants, orden obligatorio: (1) `scripts/phase-a-pre-grants-snapshot.sql` → guardar salida, (2) `node scripts/phase-a-verify-postgrest.mjs --report` con tokens si aplica, (3) aplicar SQL, (4) repetir snapshot + verify + report.

### 3.2 Node.js / TLS al verificar PostgREST desde Windows

- **Síntoma:** `TypeError: fetch failed` con causa `UNABLE_TO_VERIFY_LEAF_SIGNATURE` al llamar `https://dtfznewwvsadkorxwzft.supabase.co/rest/v1/...`.
- **Reparación usada en entorno de verificación:** `FYL_AUDIT_INSECURE_TLS=1` (equivale a desactivar verificación TLS en Node **solo para la prueba local**).
- **Riesgo:** debilita TLS; usar solo en máquina de diagnóstico, no en CI productivo sin CA correcta.
- **Alternativas:** instalar/actualizar cadena de confianza del SO, o ejecutar las mismas pruebas desde un entorno con certificados válidos.

### 3.3 Script `phase-a-verify-postgrest.mjs` (ESM)

- **Problema:** imports (`fs`, `path`, `url`) colocados **después** de `const` / lógica; en módulos ES inválido o frágil.
- **Reparación:** mover `import` inmediatamente tras el shebang; definir `__dirname` vía `import.meta.url`; flag `--report` escribe `scripts/outputs/phase-a-http-evidence.json`.

### 3.4 Pruebas HTTP admin / customer

- **Limitación:** sin variables `FYL_POSTGREST_ADMIN_ACCESS_TOKEN` ni `FYL_POSTGREST_CUSTOMER_ACCESS_TOKEN`, el script hace **SKIP** de esos bloques (no es fallo).
- **Pendiente:** correr en entorno controlado con JWT reales para evidencia completa.

### 3.5 PostgREST: código HTTP anon

- **Observado:** respuesta **401** con cuerpo JSON `code: "42501"` y mensaje `permission denied for view ...` (no siempre 403).
- **Criterio de éxito en script:** aceptar `401`, `403` o `404` como “cerrado” para anon.

### 3.6 Intento de `.gitkeep` en `scripts/outputs/`

- **Problema:** herramienta de escritura con contenido vacío falló en bucle; la carpeta quedó operativa por el propio `--report` que crea el directorio al escribir el JSON.

---

## 4. Reparaciones y verificaciones exitosas (POST)

### 4.1 Postgres (`has_table_privilege` / grants)

- `anon`: **sin** `SELECT` en las tres vistas.
- `authenticated` y `service_role`: **con** `SELECT`.
- `information_schema.role_table_grants`: **0** filas con `grantee = 'anon'` para esas vistas.
- `catalog_public_snapshot`: `anon` **sigue** con `SELECT` (regresión catálogo OK).

### 4.2 PostgREST (evidencia JSON)

- Archivo generado: `scripts/outputs/phase-a-http-evidence.json` (timestamp en `generatedAt`).
- Anon: tres endpoints → **401** + permiso denegado; snapshot → **200**.

### 4.3 Código admin (revisión estática)

- `admin/compras-proveedores.js` y `admin/stock-audit.js` consumen las vistas con cliente **autenticado**; no dependen del rol anon. No se requirió cambio de código para Fase A.

### 4.4 Schema cache

- Tras migración se ejecutó `pg_notify('pgrst', 'reload schema')`; sin incidencias reportadas en las pruebas GET realizadas.

---

## 5. Deuda explícita (no corregida por Fase A)

- **Rol `authenticated` amplio:** vistas analíticas globales (`vw_stock_fast_sellers`, `vw_stock_tag_summary`, etc.) siguen con `GRANT SELECT` a **cualquier** JWT autenticado; Fase A **no** lo reduce.
- **Privilegios extra en vistas:** el catálogo puede listar más que `SELECT` (`DELETE`, `UPDATE`, …) heredados; endurecimiento futuro opcional.
- **`security_invoker` en vistas:** las tres vistas de Fase A siguen con `reloptions` null (linter “definer-like”); no objeto de esta fase.
- **Vistas stock audit:** evaluación Fase B documentada en comentarios de `214` y en reporte deploy; **no aplicada** automáticamente.

---

## 6. Artefactos en el repo

| Ruta | Uso |
|------|-----|
| `supabase/canonical/214_phase_a_revoke_anon_purchase_publication_views.sql` | Migración idempotente |
| `supabase/canonical/214_phase_a_ROLLBACK_revoke_anon_undo.sql` | Solo emergencia (restaura anon; **inseguro**) |
| `scripts/phase-a-pre-grants-snapshot.sql` | Snapshot grants (antes **o** después como línea base) |
| `scripts/phase-a-verify-post-migration.sql` | Comprobaciones SQL post-deploy |
| `scripts/phase-a-verify-postgrest.mjs` | HTTP anon/admin/customer + `--report` |
| `scripts/phase-a-EXPECTED-GRANT-DIFF.txt` | Diff lógico esperado |
| `scripts/outputs/phase-a-http-evidence.json` | Evidencia HTTP (regenerable) |
| `scripts/audit-edge-public-surface.mjs` | Smoke anon ampliado (tres URLs Fase A) |
| `doc/phase-a-reporte-deploy-2026-05-15.md` | Reporte ejecutivo post-deploy |

---

## 7. Checklist — próximas fases (no iniciadas)

- [ ] Separar analytics admin (rol, esquema no expuesto, o solo backend).
- [ ] Métricas globales vía RPC/Edge con `is_admin()` / permisos de módulo.
- [ ] Revocar `SELECT` directo de `authenticated` sobre vistas analíticas sensibles.
- [ ] Tras cada `DROP VIEW ... CASCADE` / `CREATE OR REPLACE VIEW` en cadena stock-audit: revalidar `security_invoker=true` en `pg_class.reloptions`.
- [ ] Próximo cambio de grants: snapshot SQL + HTTP **antes** y **después** archivados.

---

## 8. Enlaces útiles

- Linter vistas: `https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view`
- Reporte resumido: `doc/phase-a-reporte-deploy-2026-05-15.md`
