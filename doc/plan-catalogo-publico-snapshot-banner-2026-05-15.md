# Plan definitivo: catálogo público, snapshot y banner (2026-05-15)

## Estado de aplicación (repo)

| Fase | Estado | Entregable |
|------|--------|------------|
| **A** | **Aplicada** | `admin/quick-actions.html` + `admin/quick-actions.js`: sección **Catálogo público**, botón **Actualizar catálogo público**, meta con `rpc('is_admin')`. |
| **B** | Pendiente (infra) | Cron / job: requiere decisión explícita; no se aplica SQL en prod desde este plan sin aprobación. |
| **C** | Lista | `scripts/verify-catalog-snapshot-parity.sql` (solo lectura). |
| **D** | Sin cambio | Override `localStorage` documentado más abajo. |

**Operativa diaria:** Admin → **Acciones rápidas** → **Actualizar catálogo público** (usuario en `public.admins`).

## Objetivo

Que **todo producto público nuevo o editado** aparezca en la **web** (grilla, PDP, banner por tags) sin depender del SQL Editor ni de pasos crípticos.

## Diagnóstico (causa raíz)

1. El catálogo del sitio usa por defecto **`catalog_public_snapshot`** (`scripts/catalog-source.js` → `getCatalogAvailableSource()`).
2. Esa tabla es una **copia materializada** de `catalog_public_available_view`, regenerada solo al ejecutar **`rpc_refresh_catalog_public_snapshot()`**.
3. Si el snapshot **no se refresca**, los artículos dados de alta después del último refresh **no existen para el cliente**: no pueden aparecer en el banner aunque los tags/SKU/stock estén bien en tablas operativas.
4. La RPC valida **`public.is_admin()`** (`auth.uid()` ∈ `public.admins`). En el SQL Editor sin JWT, `auth.uid()` es NULL → error esperado (“Solo administradores…”).

El banner **no debe duplicar una segunda fuente “viva”** solo para él: generaría catálogo vs banner inconsistente y más superficie de seguridad.

## Principios

| Principio | Detalle |
|-----------|---------|
| Una sola fuente para el público | Snapshot **o** vista viva para todo el catálogo; no mezclar por superficie (banner vs grid). |
| Frescura explícita | Tras altas masivas o cambios que deban verse ya, hay que **refrescar el snapshot** (manual con botón o automático con cron). |
| Admin real | Refresh solo con JWT de usuario listado en **`public.admins`** (no anon / no sesión postgres sin claims). |

## Fases del plan

### Fase A — Operación inmediata (**aplicada en código**)

- En **`admin/quick-actions.html`** + **`admin/quick-actions.js`**:
  - Bloque **“Catálogo público”** con texto operativo.
  - Botón **“Actualizar catálogo público”** que llama `rpc_refresh_catalog_public_snapshot` con la sesión Supabase del admin.
  - Lectura de **`catalog_public_snapshot_meta`** (fecha + filas) solo si `rpc('is_admin')` es verdadero.

**Procedimiento equipo:** después de cargar productos nuevos (o antes de revisar banner), entrar a Acciones rápidas → pulsar actualizar → recargar el catálogo público.

### Fase B — Automatización (recomendada; requiere decisión infra)

Opciones (elegir una):

1. **pg_cron** en Postgres que ejecute el refresh con contexto que cumpla `is_admin()` (p. ej. job técnico documentado), **o**
2. **Edge Function / cron externo** con **service_role** solo si la RPC se amplía para permitir ese rol (hoy solo comprueba `admins`; **no aplicar sin RFC + migración**).

Frecuencia sugerida: cada **1–6 h** según volumen de altas; siempre después de **imports masivos**.

### Fase C — Verificación

Archivo en repo: **`scripts/verify-catalog-snapshot-parity.sql`** (mismas consultas, solo lectura).

Paridad vista vs snapshot:

```sql
select
  (select count(*) from public.catalog_public_available_view) as view_rows,
  (select count(*) from public.catalog_public_snapshot) as snapshot_rows;
```

¿Un artículo ya está en la copia que lee la web?

```sql
select count(*) from public.catalog_public_snapshot where "Articulo" = 'CAPI';
```

### Fase D — Alternativa solo desarrollo / emergencia

Override en navegador (sin commit recomendado en prod):

- `localStorage.setItem('FYL_USE_CATALOG_SNAPSHOT', '0')` → usa **`catalog_public_available_view`** vía `catalog-source.js`.

Útil para debug; en prod puede aumentar carga y superficie REST según grants vigentes.

## Qué no hace este plan

- No cambia reglas del matcher del banner (tags / imagen / stock siguen igual).
- No sustituye **corregir datos** (producto inactivo, sin imagen, sin stock para la regla del banner).
- No ejecuta migraciones ni cron en producción sin aprobación explícita del equipo.

## Rollback / riesgo del refresh

- **Riesgo:** bajo; solo reescribe la tabla snapshot desde la vista disponible.
- **Rollback:** volver a ejecutar refresh tras corregir la vista o datos; mantener backups estándar del proyecto Supabase.

## Deuda registrada

- Superusuarios definidos solo por **`is_super_admin`** pero **no** presentes en **`public.admins`** no podrán ejecutar la RPC hasta estar en `admins` o hasta una política explícita futura.
