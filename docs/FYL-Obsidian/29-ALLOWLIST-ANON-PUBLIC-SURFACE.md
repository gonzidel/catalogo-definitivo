# Allowlist Anon Public Surface

Fecha: 2026-05-13

Esta allowlist define qué objetos pueden permanecer accesibles con rol `anon`.
Todo objeto fuera de esta lista debe tratarse como exposición accidental hasta
revisión explícita.

## Público Necesario

- `catalog_public_view`: compatibilidad del catálogo público actual.
- `catalog_public_available_view`: catálogo público con disponibilidad.
- `fn_norm_size(text)`: normalización de talle (puro, sin tablas). SECURITY INVOKER.
- `fn_sellable_qty(uuid, text)`: stock vendible público por variante+talle. SECURITY INVOKER, solo SELECT de físico web.
- `fn_sellable_stock_batch(uuid[])`: batch de sellable (máx 500). No expone depósitos ni reservas.
- `get_meta_feed()`: feed público para Meta Commerce mientras no exista endpoint
  firmado/cacheado alternativo.
- `rpc_get_variant_size_reserved(uuid[])`: **temporal** — solo vanilla residual (`catalogo.html`). NJ y `/catalogo` Next no lo llaman. Revocar EXECUTE anon **durante/post cutover** a NJ full. 333C lo dejó a propósito.
- `search_dictionary_public`: diccionario activo del buscador `/nj` (vista `security_invoker`, solo `k.active AND a.active`).
- `search_keywords` / `search_aliases`: SELECT anon **solo filas activas** (RLS). Necesario para el resolver del catálogo. INSERT/UPDATE/DELETE de anon **revocados** (329).
- `search_events`: INSERT anon (analytics de búsqueda, sin PII). **Sin** SELECT anon.
- `search_normalize_text(text)`: función IMMUTABLE de normalización. Sin tablas.

**No públicos (admin only):** `search_ignored_terms`, `search_admin_*` RPCs, SELECT de `search_events`. Ver [[59-NJ-BUSCADOR-SMART-SEARCH]] y [[41-SEARCH-ADMIN-FASE5-2026-09-03]].

## Temporal Por Dependencia Del Catálogo

`catalog_public_snapshot` ya es la lectura canónica de listados. SELECT anon en estas tablas sigue haciendo falta para enrich PDP / sellable INVOKER / catalogo1:

- `products` — **SELECT only** (333C revocó I/U/D anon)
- `product_variants` — **SELECT only**
- `variant_warehouse_stock` — **SELECT only**
- `variant_size_warehouse_stock` — **SELECT only**

Writes de catálogo/stock: solo `authenticated` + policy admin (333C). Ver [[57-SELLABLE-STOCK-FASE6C-333C-2026-09-04]].

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
