# 60 — Auditoría: carga masiva de stock por QR — 2026-09-04

Auditoría **solo lectura**. No se implementó UI, no se creó RPC, no se tocó stock.

Proyecto: fyl-core (`dtfznewwvsadkorxwzft`).
Pantalla objetivo: `admin/stock.html`.

Canvas: `canvases/auditoria-carga-masiva-qr.canvas.tsx`.

## Veredicto

Se puede construir de forma segura **sin tabla nueva y sin QR nuevo**.

La infraestructura de identidad (QR) y de escritura (RPC absoluta batch) ya existe.

La pieza que falta es una **sesión de catálogo completo**: acumular lecturas localmente, revisar y confirmar una vez contra un solo warehouse.

El lector actual de stock **no se puede reutilizar tal cual**: está acotado a un producto/variante.

## Evidencia live QR

| Métrica | Valor |
|---|---|
| Filas `variant_sizes` | 16.664 |
| QR no nulos | 16.611 |
| QR distintos no vacíos | 16.611 |
| Duplicados | 0 |
| Vacíos | 0 |
| NULL | 53 |
| Formato | 100% numérico, 6 dígitos |
| Índice único | `ix_variant_sizes_qr_code_unique` WHERE `qr_code IS NOT NULL` |
| UNIQUE `(variant_id, size)` | sí |

**PASS:** 1 QR → exactamente 1 `variant_id + size`, por índice, no por convención.

NULL permitidos (índice parcial). 4 en productos `active`: NOW5 39, R1959 38/40, RC1585 Unico.

## Resolución

`variant_sizes.qr_code` → `variant_id` + `size` → `product_variants` (color, sku, product_id) → `products` (name, status).

El stock del depósito **no** está en el QR. Está en `variant_size_warehouse_stock`.

SKU ≠ QR. SKU es alfanumérico de variante/talle. El lector de stock busca **solo** `qr_code`.

## Lector actual

Archivo: `admin/stock.js`.

- Input `#mobile-stock-lector-input`
- `isCompleteMobileLectorCode` / `submitMobileLectorScan` / `processLectorQrCode`
- Enter + debounce 50 ms + cola serial + limpia input
- Compatible con lector USB HID
- Acumula local (`mobileWizardState.values`)
- Ámbito: producto/variante. QR ajeno = error
- Cache `preloadMobileLectorQrCache` solo del producto abierto
- Wizard / rearqueo: viewport ≤ 767

Mejor lookup catalog-wide ya existe en `admin/order-creator.js` (join `variant_sizes` + variante + producto por `qr_code`).

## Escritura

Camino vivo: `rpc_set_variant_size_stock_batch(p_items, p_source)`.

- Absoluto, no incremental
- Batch
- `SECURITY DEFINER`, exige fila en `public.admins`
- `GRANT EXECUTE` a `authenticated`
- Sources: `manual_edit`, `bulk_edit`, `import`, `complete_incomplete`, `initial_load`
- Escribe `variant_size_warehouse_stock`
- Historial en `stock_history` si cambia
- Import ya parte en 200 (`admin/import-export.js`)

`saveAll()` de stock **no** sirve tal cual: reescribe ambos warehouses del set cargado por búsqueda.

## Warehouses

Resolver por `warehouses.code`, no hardcodear UUID.

- `general` → Almacén General
- `venta-publico` → Venta al Público

## Recomendación de diseño (sin implementar)

1. Botón Carga masiva en stock.
2. Elegir depósito por `code`.
3. Precargar mapa `qr_code → variant_id + size + color + name`.
4. Escanear: +1 local.
5. Revisar.
6. Confirmar absoluto (`stock_qty = contado`) en lotes de 200, solo el warehouse elegido, `p_source = bulk_edit` o `initial_load`.

No escribir +1 por lectura. No usar RPC de pedidos.

## Implementado 2026-09-04

Sesión de catálogo completo en `admin/stock.html` + `admin/stock.js`.

- Botón **Carga masiva** (requiere `stock:edit`)
- Warehouses por `code` (`general` / `venta-publico`)
- Mapa QR precargado (páginas de 800)
- Acumulación local + localStorage `fyl.stock.bulkQr.v1`
- Escritura `rpc_set_variant_size_stock_batch` absoluta, un solo warehouse, lotes de 200, `p_source=initial_load`
- No se reutiliza `saveAll()` ni el filtro por producto de `processLectorQrCode`

## Merge recuentos 2026-09-05

Dos usuarios confirmaron `initial_load` en el mismo depósito (`general`). Corrección aplicada: suma del último recuento por usuario, solo General.

- 385 talles, +1930 unidades, `source=bulk_edit`
- D1990 General 7/13/13/7/7. Local 0.

## No tocar

QR existentes, schema, pedidos, 309, www, NJ, cutover, puesta a cero.
