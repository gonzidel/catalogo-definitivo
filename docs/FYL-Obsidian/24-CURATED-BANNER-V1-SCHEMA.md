# 24 — Curated Banner v1.1 — Schema (Fase 1)

**Estado:** Fase 1 SQL en repo (220–222). **Fase 3 frontend validada en index** (2026-05-18) — ver [[37-CURATED-BANNER-FRONTEND-OPERATIVO-2026-05-18]]. Staging API OK. **Sin apply en producción** hasta aprobación.  
**Fecha:** 2026-05-17 (schema); 2026-05-18 (frontend operativo)  
**Relacionado:** RFC Curated Banner v1.1 (`product_variant_id`); legacy `custom-banner.js` carga **solo** si `FYL_CURATED_BANNER_V1 !== true` (`fyl-legacy-banner-loader.js`).

---

## Objetivo Fase 1

Estructura de datos para banners curados por **`product_variant_id`** (variante/color representativa), sin activar frontend ni reemplazar el matcher por tags.

---

## Convención de nombres: `variant_id` (no `VariantId`)

**Decisión (pre-staging):** la columna nueva en vista y snapshot se llama **`variant_id`** (snake_case, sin comillas).

| Criterio | `VariantId` (PascalCase) | `variant_id` (elegido) |
|----------|------------------------|-------------------------|
| Tablas FYL (`product_variants`, ítems banner) | No | **Sí** — mismo nombre lógico que `product_variant_id` |
| Supabase JS `.select()` / `.in()` | Requiere comillas: `"VariantId"` | **Nativo:** `variant_id` |
| PostgREST URL filters | `VariantId=in.(...)` (case-sensitive) | **`variant_id=in.(...)`** |
| Quoting SQL snapshot | `"VariantId" uuid` | **`variant_id uuid`** |
| Performance | Igual | Igual |
| Consistencia vista catálogo legacy | Igual que `Articulo`, `Color` | **Única columna snake** en vista (aceptable: API técnica nueva) |
| Curated banner aislado | Mezcla Pascal + snake en mismo flujo | **Un solo idioma** ítems → vista → JS |

**Motivo Pascal legacy (`Articulo`, …):** contrato histórico tipo planilla en `catalog_public_*`. El banner curado es contrato **nuevo** y alinea con el esquema relacional.

**Fase 3 (frontend):** `CATALOG_PUBLIC_SELECT` en `main-supabase.js` **no** se toca en Fase 1; al integrar curated se añadirá `variant_id` al select (sin comillas).

---

## Archivos en repo

| Archivo | Rol |
|---------|-----|
| `supabase/canonical/220_curated_product_banners_schema.sql` | Tabla ítems + evolución banners |
| `supabase/canonical/220_ROLLBACK_curated_product_banners_schema.sql` | Rollback 220 |
| `supabase/canonical/221_catalog_public_available_view_add_variant_id.sql` | Vista + columna snapshot `variant_id` |
| `supabase/canonical/221_ROLLBACK_catalog_public_available_view_add_variant_id.sql` | Rollback 221 |
| `supabase/canonical/222_snapshot_parity_detalles_similitud.sql` | **Paridad snapshot ↔ view** (orden, `DetallesSimilitud`, `variant_id`, `INSERT SELECT *`) |
| `supabase/canonical/222_ROLLBACK_snapshot_parity_detalles_similitud.sql` | Rollback 222 (restaura backup pre-222 si existe) |
| `supabase/canonical/193_catalog_public_available_view.sql` | Canónico sincronizado (incluye `variant_id`) |

---

## Modelo de datos

### `custom_product_banners` (evolución aditiva)

| Columna nueva | Tipo | Uso |
|---------------|------|-----|
| `title` | text | Título público (curated) |
| `slug` | text UNIQUE (parcial) | `#/banner/{slug}` (fase frontend) |
| `description` | text | Opcional |
| `cover_image` | text | URL opcional |
| `sort_order` | int default 0 | Orden entre banners (futuro) |

**Legacy intacto:** `name`, `tag_value` (NOT NULL), `tag_filter`, `enabled`.  
`custom-banner.js` sigue leyendo `tag_value` / `name`.

### `custom_product_banner_items` (nueva)

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | uuid PK | |
| `banner_id` | uuid FK → banners ON DELETE CASCADE | |
| `product_variant_id` | uuid FK → `product_variants` ON DELETE CASCADE | **FK principal curated** |
| `product_id` | uuid FK → `products` ON DELETE CASCADE | Denormalizado por trigger |
| `position` | int 1..20 | Orden de carrusel / ver todo |

**UNIQUE:**

- `(banner_id, product_variant_id)`
- `(banner_id, product_id)` — un solo color por producto por banner
- `(banner_id, position)`

**No hay columna `sku`** persistida.

### Triggers

| Función | Rol |
|---------|-----|
| `fyl_banner_item_sync_product_id()` | Rellena `product_id` desde `product_variants` |
| `fyl_enforce_banner_items_max_20()` | Máximo 20 filas por `banner_id` |

### RLS `custom_product_banner_items`

- **anon:** SELECT si banner `enabled = true`
- **authenticated:** SELECT todas
- **authenticated admin:** ALL (tabla `admins`)

---

## Vista pública — `variant_id`

Columna **añadida al final** de `catalog_public_available_view`:

- `variant_id` uuid = `product_variants.id`
- Grano de la vista: producto activo + variante-color con stock disponible (sin cambio)

**Snapshot:** la columna `variant_id` se declara en 221; el **relleno y el orden de columnas** los garantiza **222** (ver abajo). No usar solo `ALTER … ADD COLUMN` al final del snapshot si antes faltó `DetallesSimilitud` en la posición correcta.

---

## Estrategia oficial: paridad snapshot ↔ view (222)

**Problema:** `221` (y antes `219` solo con `ALTER` al final) puede dejar `catalog_public_snapshot` con las mismas columnas **en distinto orden** que `catalog_public_available_view`. Entonces:

- `INSERT INTO snapshot SELECT * FROM view` falla (tipos/orden).
- `rpc_refresh_catalog_public_snapshot()` (213) deja de ser seguro.
- PostgREST sigue leyendo snapshot con datos desalineados.

**Solución canónica:** `222_snapshot_parity_detalles_similitud.sql`

| Pieza | Rol |
|-------|-----|
| `fyl_catalog_snapshot_has_view_parity()` | Compara `information_schema.columns` (nombre, orden, tipo) vista vs tabla |
| `fyl_catalog_snapshot_insert_select_star_ok()` | Probe `INSERT … SELECT * … LIMIT 0` |
| `fyl_rebuild_catalog_public_snapshot_parity(true)` | Backup → `CREATE TABLE … LIKE view` → refresh desde vista → RLS/grants |
| `catalog_public_snapshot__pre_222_backup` | Tabla de rollback (solo si hubo rebuild) |

**Orden canónico de columnas** (27, alineado con 221 / 193):

`Categoria` … `Filtro3` → **`DetallesSimilitud`** → `OfertaActiva` … `SupplierCode` → **`variant_id`**

**Idempotencia:** si paridad + probe OK → no-op (no toca datos).

**Refresh seguro:** tras rebuild, datos vienen de la **vista viva** (fuente de verdad del grid público), no de un `ALTER` posicional.

**Legacy:** no cambia `custom-banner.js`, ni `tag_value`, ni contratos Pascal del catálogo; solo alinea la tabla snapshot con la vista que ya consume el front.

**Rollback 222:** restaura `catalog_public_snapshot__pre_222_backup` si existe; elimina funciones helper. No revierte 221/220.

**Verificación post-222:**

```sql
SELECT public.fyl_catalog_snapshot_has_view_parity();
SELECT public.fyl_catalog_snapshot_insert_select_star_ok();
SELECT count(*) AS view_rows FROM public.catalog_public_available_view;
SELECT count(*) AS snap_rows FROM public.catalog_public_snapshot;
```

---

## Contratos PostgREST / Supabase JS (fase 2+)

### Config + ítems (embed)

```http
GET /rest/v1/custom_product_banners
  ?enabled=eq.true
  &select=id,title,slug,custom_product_banner_items(product_variant_id,position)
  &custom_product_banner_items.order=position.asc
  &limit=1
```

```javascript
// supabase-js — sin comillas en embed
const { data } = await supabase
  .from("custom_product_banners")
  .select("id, title, slug, custom_product_banner_items(product_variant_id, position)")
  .eq("enabled", true)
  .order("position", { foreignTable: "custom_product_banner_items", ascending: true })
  .limit(1)
  .maybeSingle();
```

### Resolver cards (fase 3)

```http
GET /rest/v1/catalog_public_available_view
  ?variant_id=in.(uuid1,uuid2)
  &select=variant_id,Articulo,Color,Precio,Imagen Principal,...
```

```javascript
const variantIds = items.map((i) => i.product_variant_id);
const { data: rows } = await supabase
  .from("catalog_public_available_view")
  .select('variant_id, Articulo, Color, Precio, "Imagen Principal", OfertaActiva, PrecioOferta')
  .in("variant_id", variantIds);

const byVariantId = new Map(rows.map((r) => [r.variant_id, r]));
```

**Nota:** columnas legacy del catálogo (`Articulo`, `Imagen Principal`, …) siguen requiriendo comillas en `.select()` donde tengan espacios o PascalCase; **`variant_id` no**.

### SKU para PDP (runtime, no persistido)

```javascript
const { data: variants } = await supabase
  .from("product_variants")
  .select("id, sku")
  .in("id", variantIds);

// openBannerProductPdp → abrirModalPorSKU(variant.sku)
```

---

## Decisiones técnicas

1. **Aditivo:** no se elimina `tag_value`; no se altera NOT NULL legacy.
2. **FK por variante**, no SKU string — evita duplicados por talle y fija color visual.
3. **`ON DELETE CASCADE`** en ítem si se borra variante — el banner pierde ese slot.
4. **Vista viva** para resolución futura (`catalog_public_available_view`), no snapshot obligatorio para curated.
5. **Columna al final** de la vista — compatibilidad con `SELECT *` y refresh snapshot (`INSERT SELECT *`).
6. **`variant_id` snake_case** — contrato curated + Supabase JS; no `VariantId`.

---

## Dependencias

- `public.products`, `public.product_variants` (existentes)
- `public.admins` + RLS patrón 14_*
- `public.set_updated_at` (trigger banners, ya en 14)
- `catalog_public_snapshot` + `rpc_refresh_catalog_public_snapshot` (213)

---

## Riesgos

| Riesgo | Severidad | Mitigación |
|--------|-----------|------------|
| `DROP VIEW` en 221 | Bajo | Ventana corta; PostgREST recarga schema |
| Snapshot sin refresh tras 221 | Medio | `variant_id` NULL en snapshot hasta refresh admin |
| `INSERT SELECT *` falla si snapshot sin columna u orden distinto | Alto | **Aplicar 222** tras 221; no confiar solo en `ALTER … ADD COLUMN` |
| Drift 219 (`DetallesSimilitud` al final del snapshot) | Alto | 222 rebuild; evidencia staging 2026-05-17 |
| Slug backfill colisión | Bajo | Sufijo `-{8 chars id}` en 220 |
| Tabla ítems vacía | Ninguno | Legacy banner no la usa |
| Mezcla Pascal + snake en una fila JS | Bajo | Documentado; solo curated usa `variant_id` al inicio |

---

## Compatibilidad legacy

| Componente | Tras Fase 3 (2026-05-18) |
|------------|--------------------------|
| `custom-banner.js` | Solo si flag OFF — loader condicional; matcher `tag_value` (excluye `__curated__` y `__curated_special__`) |
| `curated-banner.js` | Siempre cargado; activo en UI solo con `FYL_CURATED_BANNER_V1` |
| `admin/quick-actions.js` | Legacy tags + sección **Banner curado** (`curated-banner-admin.js`) |
| `main-supabase.js` | `fylLoadHomeProductBanner` → curated o legacy, no ambos |
| Filtros `#/tag/` | Sin cambios (legacy) |
| Ruta curated | `#/banner/{slug}` |
| PDP | `abrirPdpPorSkuIfPossible` / SKU desde `product_variants` |

**Operativa validada:** [[37-CURATED-BANNER-FRONTEND-OPERATIVO-2026-05-18]]

---

## Rollout staging (no prod)

### Orden de apply

1. `220_curated_product_banners_schema.sql`
2. `221_catalog_public_available_view_add_variant_id.sql`
3. **`222_snapshot_parity_detalles_similitud.sql`** (rebuild idempotente + refresh desde vista)
4. Verificar: `fyl_catalog_snapshot_has_view_parity()` y `fyl_catalog_snapshot_insert_select_star_ok()`
5. Opcional: `SELECT public.rpc_refresh_catalog_public_snapshot();` (JWT admin) — debe funcionar tras 222
6. `pg_notify` incluido en migraciones

**No aplicar en prod** sin aprobación explícita.

### Rollback staging (inverso)

1. `222_ROLLBACK_snapshot_parity_detalles_similitud.sql`
2. `221_ROLLBACK_catalog_public_available_view_add_variant_id.sql`
3. `220_ROLLBACK_curated_product_banners_schema.sql`
4. Refresh manual solo si el snapshot restaurado sigue alineado con la vista activa

---

## Checklist SQL post-migration (staging)

```sql
-- Tabla ítems existe
select to_regclass('public.custom_product_banner_items');

-- Columnas banners nuevas
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'custom_product_banners'
  and column_name in ('title','slug','description','cover_image','sort_order');

-- variant_id en vista
select variant_id, "Articulo", "Color"
from public.catalog_public_available_view
limit 3;

-- Paridad snapshot ↔ view (tras 222)
select public.fyl_catalog_snapshot_has_view_parity();
select public.fyl_catalog_snapshot_insert_select_star_ok();

-- variant_id en snapshot (tras 222)
select count(*) as total,
       count(variant_id) as con_variant_id
from public.catalog_public_snapshot;

select (select count(*) from public.catalog_public_available_view) as view_rows,
       (select count(*) from public.catalog_public_snapshot) as snap_rows;

-- UNIQUEs ítems
select indexname from pg_indexes
where tablename = 'custom_product_banner_items';

-- RLS policies ítems
select policyname, roles, cmd
from pg_policies
where tablename = 'custom_product_banner_items';

-- Legacy banner sigue legible
select id, name, tag_value, enabled from public.custom_product_banners limit 5;
```

---

## Fase 2 — Admin curated (implementado en repo)

| Archivo | Rol |
|---------|-----|
| `admin/curated-banner-admin.js` | CRUD banners, buscador, DnD, preview real |
| `admin/quick-actions.html` | Sección + estilos `.cba-*` |
| `admin/quick-actions.js` | `initCuratedBannerAdmin()` |

**Legacy:** banner por tags sigue en la misma página; placeholders curated no matchean catálogo por tags.

### Convención `tag_value` (curated)

| Valor | Uso |
|-------|-----|
| `__curated__` | Banner dinámico carrusel 2×2 (home NJ + admin preset `curated`) |
| `__curated_special__` | Banner especial tarjeta oscura 3 fotos (home NJ + admin preset `special`) |
| Otro valor | Banner legacy por tags comerciales (`custom-banner.js`) |

Detalle implementación 2026-06-09: [[42-HOME-BANNERS-FEED-NJ-2026-06-09]] §3.

**Preview:** `catalog_public_available_view` + clases `custom-banner-*` de `styles.css` (marco 430px).

## Próximas fases (fuera de Fase 1–2)

| Fase | Entregable |
|------|------------|
| 2 | ~~Admin selector por variante + persistencia ítems~~ (repo) |
| 3 | `curated-banner.js` + extender select con `variant_id` |
| 4 | QA staging |
| 5 | Swap producción |
| 6 | Eliminar legacy tag banner |

---

## Enlaces

- [[36-CATALOGO-SNAPSHOT-REFRESH-2026-05-15]]
- [[22-BANNER-FYL-ORIGINALS]]
- `doc/plan-catalogo-publico-snapshot-banner-2026-05-15.md`
