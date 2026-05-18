# Reporte Fase A — Grants compras / publicación (PostgREST)

**Bitácora técnica (errores, reparaciones, checklist):** `doc/hardening-fase-a-grants-2026-05-15.md`  
**Nota Obsidian:** `docs/FYL-Obsidian/33-FASE-A-GRANTS-COMPRAS-PUBLICACION-2026-05-15.md`

**Proyecto:** Supabase `fyl-core` (`dtfznewwvsadkorxwzft`)  
**Migración canónica:** `supabase/canonical/214_phase_a_revoke_anon_purchase_publication_views.sql`  
**Fecha evidencia HTTP:** 2026-05-15T01:41:01Z (UTC)

---

## 1. Alcance y límites de esta evidencia

| Tema | Estado |
|------|--------|
| Snapshot SQL “BEFORE” (pre-214) | **No disponible en este run.** La migración 214 ya se había aplicado en una sesión anterior; no hay captura guardada en repo del estado previo. Para el próximo hardening, ejecutar `scripts/phase-a-pre-grants-snapshot.sql` **antes** del `REVOKE`. |
| HTTP “BEFORE” | **No ejecutado** (misma razón). |
| HTTP “AFTER” (anon) | **Sí** — `node scripts/phase-a-verify-postgrest.mjs --report` (ver `scripts/outputs/phase-a-http-evidence.json`). |
| HTTP admin / customer JWT | **SKIP** en este run (variables `FYL_POSTGREST_ADMIN_ACCESS_TOKEN` / `FYL_POSTGREST_CUSTOMER_ACCESS_TOKEN` no definidas). Completar en tu entorno para evidencia completa. |

---

## 2. Qué corrige la Fase A (y qué no)

- **Sí:** elimina exposición **anon** y **PUBLIC** sobre las tres vistas; alinea `GRANT SELECT` explícito a **authenticated** y **service_role** con el diseño de `181` / `192`.
- **No:** no revoca `SELECT` del rol **authenticated** sobre vistas analíticas globales (`vw_stock_fast_sellers`, `vw_stock_tag_summary`, etc.); cualquier JWT de usuario autenticado puede seguir leyéndolas mientras exista ese grant (deuda documentada).
- **No:** no toca `catalog_public_available_view`, snapshot flow, RPCs, Edge ni Fase C.

---

## 3. Grants modificados (estado actual en Postgres)

**Objetos:** `purchase_order_line_fulfillment`, `purchase_spend_by_season`, `vw_publication_events_performance`

| Grantee | Privilegios observados (`information_schema.role_table_grants`) |
|---------|-------------------------------------------------------------------|
| `anon` | **Sin filas** (sin privilegios explícitos en estas vistas). |
| `PUBLIC` | Sin filas en el agregado consultado. |
| `authenticated` | `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE` (patrón heredado típico en objetos `public`; la migración reafirma al menos **SELECT** operativo). |
| `service_role` | Igual que `authenticated` en el catálogo de grants. |

**`has_table_privilege` (SELECT):**

| Vista | anon | authenticated | service_role |
|-------|------|----------------|--------------|
| `purchase_order_line_fulfillment` | no | sí | sí |
| `purchase_spend_by_season` | no | sí | sí |
| `vw_publication_events_performance` | no | sí | sí |

**Filas `role_table_grants` con `grantee = 'anon'`** en esas tres vistas: **0**.

**Catálogo público:** `has_table_privilege('anon', 'public.catalog_public_snapshot', 'SELECT')` = **true** (sin cambio esperado).

**`security_invoker`:** las tres vistas siguen con `reloptions` **null** (modo owner respecto al linter; Fase A no lo modifica).

---

## 4. Endpoints REST afectados

| Método | Ruta (PostgREST) | Rol anon (clave publicable) |
|--------|------------------|----------------------------|
| GET | `/rest/v1/purchase_spend_by_season?select=season_id&limit=1` | **401** — cuerpo: `permission denied for view purchase_spend_by_season` (`42501`) |
| GET | `/rest/v1/purchase_order_line_fulfillment?select=order_line_id&limit=1` | **401** — `42501` |
| GET | `/rest/v1/vw_publication_events_performance?select=id&limit=1` | **401** — `42501` |
| GET | `/rest/v1/catalog_public_snapshot?select=Articulo&limit=1` | **200** — regresión OK |

Evidencia cruda: `scripts/outputs/phase-a-http-evidence.json`.

**PostgREST / schema cache:** se ejecutó `SELECT pg_notify('pgrst', 'reload schema')` al aplicar 214; no se observaron errores de esquema en las pruebas GET anteriores.

---

## 5. Comparación BEFORE vs AFTER (honesta)

| Comprobación | BEFORE (evidencia) | AFTER (esta corrida) |
|--------------|--------------------|------------------------|
| anon → 3 vistas | En auditoría previa, anon tenía acceso indebido. | **401** + `permission denied` en las tres. |
| anon → `catalog_public_snapshot` | 200 esperado. | **200**. |
| admin / customer HTTP | Sin captura en este documento. | Completar con JWT reales (`phase-a-verify-postgrest.mjs` sin SKIP). |

**Customer `authenticated`:** en esta fase puede seguir respondiendo **200** en las tres vistas si el rol `authenticated` conserva `SELECT` (esperado hasta fases de endurecimiento).

---

## 6. Validación estática admin (sin runtime browser)

- **`admin/compras-proveedores.js`:** usa `supabase.from("purchase_order_line_fulfillment")` y `from("purchase_spend_by_season")` con sesión **authenticated** del panel; no dependen del rol anon. **Sin cambios de código** requeridos por 214.
- **`admin/stock-audit.js`:** usa `from("vw_publication_events_performance")` igualmente con cliente autenticado. **Sin cambios de código** requeridos por 214.

Los errores en runtime solo aparecerían si el cliente admin perdiera sesión o si se revocara `SELECT` a `authenticated`; con el estado actual de grants, **no aplica**.

---

## 7. Riesgos pendientes

1. **JWT `authenticated` amplio:** usuarios no admin con sesión Supabase pueden seguir haciendo `GET` a las tres vistas (y a otras vistas “analytics” con `GRANT` similar).
2. **Privilegios extra en vistas:** el catálogo muestra paquetes amplios (`DELETE`, `UPDATE`, …) en vistas para `authenticated` / `service_role`; conviene una fase futura de **hardening de privilegios** (dejar solo `SELECT` donde aplique).
3. **`security_invoker`:** migraciones futuras con `DROP VIEW ... CASCADE` o `CREATE OR REPLACE VIEW` pueden **resetear** flags; checklist en `214` (comentarios) y en sección 10 de este documento.

---

## 8. Deuda técnica explícita (authenticated analytics exposure)

- Vistas como **`vw_stock_fast_sellers`** y **`vw_stock_tag_summary`** (y otras `vw_stock_*` analíticas) siguen con **`GRANT SELECT` a `authenticated`** en el diseño actual: **cualquier usuario con JWT válido** puede consultarlas vía PostgREST si conoce el nombre del recurso.
- La Fase A **no** reduce esa superficie; solo cierra **anon/PUBLIC** en compras + `vw_publication_events_performance`.

---

## 9. Fuera de alcance (confirmado)

- Fase C, RPC admin-only, Edge Functions adicionales.
- Revocar `SELECT` a `authenticated` en analytics.
- Cambios a `catalog_public_available_view` o al flujo de `catalog_public_snapshot`.

---

## 10. Checklist — futuras fases

- [ ] **Separar analytics admin:** rol o esquema no expuesto a PostgREST público, o consumo solo desde backend.
- [ ] **Mover métricas globales a RPC / Edge** con `is_admin()` / permisos de módulo (`proveedores`, etc.).
- [ ] **Eliminar `SELECT` directo** del rol `authenticated` sobre vistas analíticas; reemplazar por RPC o lectura con `service_role` en servidor de confianza.
- [ ] **Cerrar deriva de `security_invoker`:** tras cada `DROP CASCADE` / `CREATE OR REPLACE VIEW` en cadena stock-audit, re-ejecutar `ALTER VIEW ... SET (security_invoker = true)` o incluir la opción en el `CREATE VIEW`.
- [ ] **Próximo deploy incremental:** ejecutar `phase-a-pre-grants-snapshot.sql` **antes** de cualquier `REVOKE`/`GRANT`, guardar salida, aplicar migración, ejecutar `phase-a-verify-post-migration.sql` + `phase-a-verify-postgrest.mjs --report` con JWT admin y customer.

---

## 11. Comandos de reproducción

```powershell
# Snapshot (antes o después; guardar salida)
# Ejecutar en SQL Editor el contenido de scripts/phase-a-pre-grants-snapshot.sql

# HTTP + JSON (anon; TLS local si hace falta)
$env:FYL_AUDIT_INSECURE_TLS="1"   # solo si Node falla verificando certificado
$env:SUPABASE_ANON_KEY="<anon publicable>"
$env:FYL_POSTGREST_ADMIN_ACCESS_TOKEN="<access_token admin>"
$env:FYL_POSTGREST_CUSTOMER_ACCESS_TOKEN="<access_token cliente>"
node scripts/phase-a-verify-postgrest.mjs --report
```

Salida JSON: `scripts/outputs/phase-a-http-evidence.json`.
