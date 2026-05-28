# Arquitectura general FYL (resumen operativo)

## Documentacion relacionada en `/doc`

| Tema | Archivo |
|------|---------|
| Registro de vulnerabilidades, fixes Supabase y evidencia post-hardening | `doc/hardening-supabase-2026-05-13.md` |
| Visibilidad del index, vista nueva, checklist, queries | `doc/catalogo/catalogo-visibilidad.md` |
| Auditoria LCP /catalogo (Clarity 2026-05-23) | `doc/catalogo/auditoria-lcp-2026-05-23.md` (canonica Obsidian: `docs/FYL-Obsidian/FYL-Product/Performance/2026-05-23-Auditoria-LCP-Catalogo-Clarity.md`) |
| Fuente canonica de stock, derivadas, riesgos | `doc/stock/stock-arquitectura.md` |
| Meta Catalog Feed (auditoria, spec 3 fases, mapa Google) | `doc/meta-feed/2026-05-23-meta-feed-enriquecimiento-spec.md` (Obsidian: `docs/FYL-Obsidian/38-META-FEED-ENRICHMENT-2026-05-23.md`) |
| Lista de envíos — fecha por finalización (`sent_at`, migración 227) | `doc/shipping-list-sent-at-deploy-2026-05-26.md` (Obsidian: `docs/FYL-Obsidian/39-LISTA-ENVIOS-SENT-AT-2026-05-26.md`) |
| PAU — panel móvil pedidos (WhatsApp, QR, borrador) | `doc/pau/README.md` (Obsidian: `docs/FYL-Obsidian/40-PAU-PANEL-ATENCION-UNIFICADO.md`) |
| Este resumen y flujo extremo a extremo | `doc/arquitectura-general.md` |

## Flujo de catalogo publico

Flujo correcto actual:

1. DB (stock canonico y reservas)
2. Snapshot publico preferido (`catalog_public_snapshot`) con fallback temporal a `catalog_public_available_view`
3. Frontend (`scripts/main-supabase.js`)
4. Enriquecimiento UI de stock por talle (`enrichProductsWithStock`)

## Punto clave

- `catalog_public_view` NO debe considerarse fuente valida de disponibilidad real.
- `catalog_public_snapshot` es la fuente publica preferida post-hardening.
- `catalog_public_available_view` queda como compatibilidad temporal basada en stock real.

## Reglas de negocio de publicacion (index)

- solo productos `active`
- solo variantes activas
- al menos un talle con disponible real > 0

## Riesgos y observabilidad

Riesgos a vigilar:

- desincronizacion entre tablas derivadas y tabla canonica
- drift de reservas (`reserved_qty` vs reservas reales por talle)
- consultas frontend que apunten por error a vistas no alineadas

Monitoreo recomendado:

- `vw_stock_audit_reserved_qty_diff`
- `vw_stock_audit_variant_sizes_diff`
- `vw_stock_audit_variant_warehouse_diff`

## Guia de debug rapido

1. Confirmar vista activa en frontend:
   - buscar `from("catalog_public_available_view")` en `scripts/main-supabase.js`
2. Verificar que un SKU/talle tenga disponible real:
   - stock fisico en `variant_size_warehouse_stock`
   - reserva activa por talle (orders + carts)
3. Comparar resultado contra presencia en index.

## Query de comparacion (vista vs real)

```sql
with real_stock as (
  select
    p.name as articulo,
    pv.color,
    sum(coalesce(vss.stock_qty, 0))::int as physical_qty
  from public.products p
  join public.product_variants pv on pv.product_id = p.id and pv.active is true
  left join public.variant_size_warehouse_stock vss on vss.variant_id = pv.id
  group by p.name, pv.color
)
select
  v."Articulo",
  v."Color",
  coalesce(r.physical_qty, 0) as physical_qty
from public.catalog_public_available_view v
left join real_stock r
  on lower(trim(r.articulo)) = lower(trim(v."Articulo"))
 and lower(trim(coalesce(r.color, ''))) = lower(trim(coalesce(v."Color", '')))
order by 1, 2;
```
