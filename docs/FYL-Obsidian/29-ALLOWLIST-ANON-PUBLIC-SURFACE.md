# Allowlist Anon Public Surface

Fecha: 2026-05-13

Esta allowlist define qué objetos pueden permanecer accesibles con rol `anon`.
Todo objeto fuera de esta lista debe tratarse como exposición accidental hasta
revisión explícita.

## Público Necesario

- `catalog_public_view`: compatibilidad del catálogo público actual.
- `catalog_public_available_view`: catálogo público con disponibilidad.
- `get_meta_feed()`: feed público para Meta Commerce mientras no exista endpoint
  firmado/cacheado alternativo.
- `rpc_get_variant_size_reserved(uuid[])`: dependencia temporal de catálogo/PDP.

## Temporal Por Dependencia Del Catálogo

No revocar todavía hasta implementar `catalog_public_snapshot` y lectura dual:

- `products`
- `product_variants`
- `variant_warehouse_stock`
- `variant_size_warehouse_stock`

## Denylist Cerrada En Fase 2

- `vw_stock_*`
- `public_sales`
- `public_sale_items`

## Reglas Operativas

- Ninguna vista nueva debe recibir `anon` por defecto.
- Ninguna tabla operativa debe ser pública por grants directos; si el catálogo la
  necesita, debe migrarse a snapshot público mínimo.
- Los RPCs `SECURITY DEFINER` con `anon` requieren justificación documentada,
  firma estable, payload mínimo y verificación post-deploy.
- Después de cada migración de schema o deploy de Edge Function, ejecutar los
  checks read-only de auditoría y comparar contra esta allowlist.
