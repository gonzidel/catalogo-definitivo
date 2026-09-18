# 64 — Auditoría: cliente pudo agregar/comprar productos sin stock real (2026-09-14)

## Disparador

Reporte de un pedido real con ítems marcados "Sin stock" que el cliente logró agregar al carrito y pedir, a pesar de fixes previos de validación de stock. Caso concreto investigado: clienta Yamila Aguirre.

## Root cause (confirmado con evidencia en producción)

No fue un solo bug — fueron **dos capas** de un mismo problema: el ledger de stock (`variant_size_warehouse_stock`) puede quedar desincronizado de la realidad física, y el catálogo online confía ciegamente en ese ledger.

1. **Mecanismos operativos que venden sin descontar stock** (por diseño, para no bloquear ventas reales):
   - `admin/public-sales.js` → `rpc_create_public_sale` con `sell_without_stock` cuando el sistema ya mostraba 0/0 en ese talle (venta local igual se concreta).
   - Pedidos admin con `admin_confirmed_missing = true` (confirmación manual de que la unidad existe físicamente aunque el sistema la muestre en 0), vía `rpc_admin_manual_inject_and_deduct`.
   - Estos dos son **intencionales** (no bloquear ventas reales por un sistema que puede estar mal), pero generan una divergencia silenciosa entre "lo que dice el sistema" y "lo que hay físicamente".

2. **Bug real, la causa directa del incidente**: `rpc_remove_order_item_restore_stock` (antes de la migración 342). Cuando se removía un `order_item` que **no tenía `order_item_stock_sources`** (o sea, nunca se le descontó stock real — típicamente porque vino de uno de los mecanismos del punto 1) y no estaba en status `missing`, el fallback de esa función **restauraba +1 al depósito general igual**, asumiendo que la unidad física existía. Eso creó **crédito fantasma**: unidades que no existen quedaron visibles como stock disponible, y ese crédito fantasma fue el que terminó ofrecido —y comprado— por una clienta real.

## Qué se hizo

### Opción A — cerrar la brecha de reconciliación

- **`341_stock_audit_untracked_sales_watchlist.sql`** (aplicada en producción, `dtfznewwvsadkorxwzft`): dos vistas nuevas de solo lectura.
  - `vw_stock_audit_untracked_sales`: cada evento donde se vendió/apartó un talle sin descuento real (`public_sale_sin_stock`, `admin_order_confirmado_sin_verificar`).
  - `vw_stock_audit_untracked_sales_watchlist`: agregado por variante+talle de esos eventos en los últimos 30 días.
- **`342_fix_remove_order_item_no_blind_restore.sql`** (aplicada en producción): parchea `rpc_remove_order_item_restore_stock` — el fallback que restauraba stock a ciegas ahora **no muta `variant_size_warehouse_stock`**; solo deja un registro en `stock_history` (delta 0, motivo `no_restore_no_sources_review`) para revisión física manual. También extiende `vw_stock_audit_untracked_sales` con el source type `removido_sin_restaurar_pendiente_revision`.
- **Visibilidad en admin** (2026-09-14, esta sesión): nueva card "Talles vendidos sin descuento real de stock (30d)" en `admin/stock-audit.html` (bloque "Situaciones a revisar"), alimentada por la watchlist de arriba. Ver detalle en `admin/STOCK_OPERATIVA.md`.
- **Decisión explícita: no hay cron de reconciliación de conteo físico.** Un cron no puede reemplazar contar unidades a mano; la card visible cada vez que un admin abre `stock-audit.html` se consideró suficiente por ahora. Si se reabre esta discusión, evaluar entonces una tabla de "verificado" + escalamiento por antigüedad.
- Caso SKU `FYL-91-NEG` talle 38 (10+ confirmaciones manuales en 10 semanas, siempre en 0 en el sistema): **no es testing**, es un producto real de alta rotación que se vende por encargo sin conteo de stock online nunca confirmado. Con la 342 ya no genera crédito fantasma; se deja como está y se monitorea vía la watchlist.

### Opción B — reforzar el checkout con defensas client-side (cierra ventanas de caché/UX, no reemplaza al servidor)

Todos los cambios son client-side; la garantía final sigue siendo `rpc_checkout_cart` (`FOR UPDATE`) en el servidor.

- `client/dashboard-instant.js`: nueva `revalidateCartStockBeforeCheckout()` — refresca stock con `forceFresh: true` justo antes de llamar a `rpc_checkout_cart` (cierra el hueco de hasta 20s de caché de `fetchVariantInfo` en el momento más crítico). Si algo cambió, bloquea el envío y recarga el carrito.
- `scripts/main-supabase.js` (PDP): `available === null` (dato inconsistente/sin confirmar) ya no habilita cantidad "ilimitada" (999) — bloquea el chip de talle igual que "sin stock". Bug lateral corregido: `parseInt(dataset.max) || 999` trataba `max="0"` como *falsy* y caía a 999 igualmente.
- `scripts/ui/bottom-sheet.js`: mismo criterio — `available === null` ya no permite incrementar cantidad indefinidamente.
- `scripts/cart-persistent.js`: `syncCartWithSupabase({ mergeWithRemote: true })` (merge de carrito de invitado al loguearse) ahora revalida stock fresco antes de persistir cada línea; ajusta o descarta cantidades que ya no caben en el stock real.

## Hallazgo colateral: corrupción silenciosa en `client/dashboard-instant.js`

Durante la verificación de sintaxis (`node --check`) de los cambios de la Opción B se detectó que el archivo **ya estaba roto en el working tree** (de trabajo previo no commiteado en esta misma sesión): faltaban ~265 líneas al final, incluyendo el listener `DOMContentLoaded` que arranca `initDashboard()` — es decir, **el dashboard del cliente no iba a inicializar en absoluto**. Se reconstruyó empalmando el tramo faltante desde `HEAD` de git (sin tocar otras líneas) y se verificó con `node --check` en modo ESM. Se corrió el mismo chequeo sobre los 11 `.js` modificados en `admin/`, `scripts/` y `client/` (fuera de `nj/`): todos pasan sintaxis, ninguno muestra el patrón de deleción sospechosa (deleciones >> inserciones).

**Lección para agentes futuros:** correr `node --check` (modo `--input-type=module` si el archivo usa `import`/`export`) sobre cualquier archivo `.js` grande después de editarlo, antes de asumir que el cambio quedó bien aplicado.

### Opción C — trazabilidad explícita de "agregar sin stock" en venta local

Antes de esta migración, `sell_without_stock` no dejaba ningún rastro directo: la vista 341 lo detectaba solo por heurística (`qty_venta_publico=0 AND qty_general=0` con `qty>0`), sin motivo ni vendedor por línea (el modal de confirmación ya existía, pero era un solo click sin explicación).

- **`343_public_sale_sell_without_stock_reason.sql`** (aplicada en producción, `dtfznewwvsadkorxwzft`): puramente aditiva.
  - 2 columnas nuevas en `public_sale_items`: `sell_without_stock` (boolean, flag explícito) y `sell_without_stock_reason` (texto libre opcional).
  - `rpc_create_public_sale` (firma de 5 args, la vigente): se verificó el código exacto en producción vía `pg_get_functiondef` antes de escribir la migración, y se agregó **solo** la persistencia de esas 2 columnas por línea — ninguna validación ni cantidad de descuento/reposición de stock se tocó.
  - `vw_stock_audit_untracked_sales`: ahora usa `psi.sell_without_stock = true OR (heurística vieja)` (retrocompatible con ventas previas a la 343) y muestra el motivo real cuando existe (fallback al texto genérico de antes si no hay motivo).
  - `vw_stock_audit_untracked_sales_watchlist`: suma `last_admin_email` (join a `admins` por el vendedor del evento más reciente) y `last_reason`.
  - Rollback: `343_ROLLBACK_public_sale_sell_without_stock_reason.sql`.
- **Frontend**: `admin/public-sales.html` (+ `-caja2.html`, `-caja3.html`) — campo de motivo opcional (texto libre, máx. 200 caracteres) en el modal "sin stock". `admin/public-sales.js` captura y propaga el motivo en los 2 flujos principales de alta de venta nueva (búsqueda manual con color, grilla de talles de producto único) hasta el payload de `rpc_create_public_sale`.
- **Admin**: la card "Talles vendidos sin descuento real de stock (30d)" en `stock-audit.html` ahora muestra también **vendedor** y **motivo** del evento más reciente por variante+talle.
- **Alcance limitado a propósito**: el flujo de escaneo QR/SKU (nunca muestra modal, agrega en silencio) y la edición de "pedidos locales" (usa `rpc_update_local_order`, no `rpc_create_public_sale`) quedaron **fuera** de esta instrumentación — siguen funcionando exactamente igual que antes de la 343. Detalle completo en `admin/STOCK_OPERATIVA.md`.
- Verificado post-aplicación: columnas existen con el default correcto, la watchlist devuelve `last_admin_email`/`last_reason` poblados desde datos reales, y `get_advisors` no mostró ningún hallazgo nuevo (el único lint relacionado, `security_definer_view` sobre las 2 vistas, es preexistente desde la migración 341 — mismo patrón de permisos que las vistas de auditoría de 144).

## Verificación

- Vistas 341 confirmadas existentes y con datos reales en producción (`dtfznewwvsadkorxwzft`) vía `execute_sql` de solo lectura.
- `node --check` limpio en los 12 `.js` tocados (11 de la Opción B + `admin/stock-audit.js` de la card nueva) y en `admin/public-sales.js`/`admin/stock-audit.js` tras la Opción C.
- Migración 343 aplicada y verificada en producción (columnas, firma de función de 5 args intacta, datos reales en la watchlist).

## Estado final

Las 3 opciones (A, B, C) del audit quedaron completadas y aplicadas en producción en esta sesión.
