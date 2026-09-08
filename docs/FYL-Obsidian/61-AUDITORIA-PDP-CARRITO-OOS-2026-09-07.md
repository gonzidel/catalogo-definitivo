# 61 — Auditoría PDP vs carrito “no disponible” — 2026-09-07

Auditoría **solo lectura**. Sin UPDATE/INSERT/migración ni cambio de frontend.

Síntoma reportado: clientas arman carrito desde el PDP y al llegar al carrito varios productos figuran no disponibles. Hipótesis inicial: el PDP muestra productos/talles inexistentes.

Proyecto: fyl-core (`dtfznewwvsadkorxwzft`). Superficie: `/nj` (PDP + CartTab). `/catalogo` no tiene carrito.

Canvas: `auditoria-pdp-carrito-oos.canvas.tsx`

---

## Veredicto

El PDP **no está vendiendo stock inventado** en el camino feliz. Talle comprable ⇔ `fn_sellable_qty > 0`. El carrito NJ usa la misma RPC (`fn_sellable_stock_batch`).

Lo que sí ocurre:

1. El PDP **lista todos los talles de `variant_sizes`**, no solo los sellable. Hoy hay **929 chips extra** (0 físico web). Los marca OOS cuando sellable está `ready`. Confirmado live en Art. L3.
2. **Agregar no reserva.** El carrito reconsulta sellable al abrir. Si el físico se movió (u el ítem quedó en `fyl-nj-cart`), varios renglones pueden pasar a “sin stock” juntos.
3. El catálogo se achicó de **661 → 326 arts** desde el 4/9. Eso multiplica carritos locales viejos contra un snapshot más chico.

No aplica, en este corte, “el snapshot publica variantes que la vista live ya no tiene” (0 drift de `variant_id` / `Numeracion`).

---

## Evidencia live (17:45 ART)

| Check | Valor |
|---|---|
| Vista live | 600 filas / 326 arts |
| Snapshot | 600 / 326 |
| Drift variant_id o Numeracion | 0 |
| `catalog_public_snapshot_meta` | dirty=true desde 20:45 UTC; last_success 20:35 UTC; rev 20127; last_error null |
| Talles snapshot en `variant_sizes` | 2432 |
| De esos, sellable > 0 | 1503 |
| `variant_sizes.stock_qty > 0` vs sellable > 0 | 1503 = 1503 |
| Variantes snapshot sin `variant_sizes` | 0 |
| Colisiones `fn_norm_size` (35 vs 35.5, etc.) | 0 |
| Warehouses | solo `general` (257938 u) y `venta-publico` (3 u) |

PDP live `https://www.fylmoda.com.ar/nj/producto/L3` (color Beige): chips 85 y 100 enabled; 90 y 95 `is-oos` + disabled. Mismo resultado que `fn_sellable_qty` en DB.

Pedidos 7d: **397 admin / 3 customer**. El self-checkout NJ casi no se usa; el síntoma igual puede verse en carritos locales antes de “Hacer pedido”.

---

## Contrato de código (NJ)

| Paso | Archivo | Regla |
|---|---|---|
| Ficha | `PdpLoader` | Existe si está en snapshot (o stub `products.status=active` + imagen) |
| Chips | `PdpSizePicker` | Fuente: `variant_sizes`. OOS si `ready` y `sellable_qty <= 0` |
| Agregar | `PdpInteractive.handleAddAllToCart` | `clampQtyToSellable`; no llama RPC de reserva |
| Carrito | `CartTab` | `lookupSellableQty`; `kind === "out"` → banner “sin stock disponible” |
| Checkout | `rpc_checkout_cart` 331 | Físico web del talle bajo `FOR UPDATE`. No gatea con `reserved_qty` |

Causa histórica del 4/9 (PDP físico vs carrito `total − reserved_qty`): **cerrada en NJ**. `reserved_qty` sigue inflado (240 variantes publicadas con reserved > sellable, 5163 u) y **vanilla** `dashboard-instant.js` todavía resta reserved. No es CartTab.

## Ventana de red al entrar al PDP (2026-09-07 noche)

Confirmado en live `/nj/producto/L3` con latencia ~2 s:

1. Primer paint de chips: **85/90/95/100 todos `disabled=false` y sin `is-oos`**, aunque 90 y 95 tienen sellable 0.
2. ~0.7–3.6 s después llegan las tachas correctas.
3. Tap en 90 durante esa ventana: **no queda seleccionado** (ni fila de cantidad). `handleSizeChange` no tiene `variantId` o `sellableFor` = 0.
4. Cambiar a Negro **después** de ready: 100 se tacha al toque. Sin segunda espera de red. 0 mismatches de color en snapshot.

Causa: `PdpInteractive` se monta cuando el producto del snapshot ya está, pero `variantSizes` todavía no. `PdpSizePicker` cae a `colorDetail.talles` (Numeracion). `sellableStatus` puede figurar `ready` con `stockMap` vacío → `verifyBlocked=false` y sin tacha. No hay CSS `:disabled` en `.pdp-size-chip`, así que se ven comprables.

No se demostró un add real de un talle en 0 por esta ventana. El hueco visual/táctil sí existe y en 3G no son milisegundos.

Fix propuesto (no aplicado): no marcar `ready` hasta `variantCatalogRows.length > 0 && byVariant`; y `verifyBlocked` si `sizesWithStock` está vacío. Estilar `:disabled`.

---

## Carritos en DB

364 `cart_items` en carts `open`: todos sellable 0, ninguno en snapshot. 361 variantes borradas. Productos `www` / `AAAA` / tests. Newest `2026-04-25`. 5 customer_id. **No es el tráfico de hoy.**

Clientas con pedido en 2d: 48. De esas, 0 tienen carrito open con ítems. El carrito NJ activo vive en `localStorage` (`fyl-nj-cart`) hasta el sync de checkout.

---

## Fixes aplicados 2026-09-07 (sin cambiar contrato de stock)

No se reserva al agregar. No se tocó `rpc_checkout_cart`, `reserved_qty` (ni su drift), snapshot, pedidos admin ni Retiro local.

Causa confirmada en Clarity 14:05 (visitor `e13uo8`): el **CartTab de producción (HEAD)** todavía calculaba `min(VSS talle, VWS − reserved_qty)`. PDP usaba físico web. Eso marcaba OOS falso en LDA7 Beige, 12 Negro, SICI Var y R2696 Morado (`reserved_qty` inflado; `vw_stock_audit_reserved_qty_diff` real = 0).

1. **Carrito:** `CartTab` ya no lee `reserved_qty` ni `variant_warehouse_stock`. Fuente única: `useSellableStock` / `fn_sellable_stock_batch`. `lookupSellableQty` distingue miss (`null` / unknown) de sellable confirmado `0` (out). El banner OOS no cuenta unknown. El precheck de “Hacer pedido” usa la misma RPC; checkout RPC sigue siendo la autoridad final.
2. **PDP add:** después de `requireProfileComplete()` se vuelve a pedir `fn_sellable_stock_batch` y se clampa con ese mapa. Query fallida o respuesta incompleta → no agrega (fail closed).
3. **PDP chips:** Numeracion del snapshot puede seguir en la grilla, pero **nunca** habilita compra. Comprable solo con sellable live confirmado `> 0`.

---

## Qué no tocar todavía

- `rpc_checkout_cart` / 331 / 309
- Reservar al agregar (cambio de contrato)
- Refresh forzado del snapshot
- Borrar los 364 zombies (irrelevante para el síntoma; se puede limpiar en otro bloque)

---

## Decisiones para el siguiente paso

1. ¿Ocultar talles en 0 o dejarlos tachados?
2. ¿Un color/producto sin ningún talle live debe abrir PDP?
3. ¿El copy del carrito debe decir “se agotó después de agregarlo” vs “no existe”?
4. ~~¿Cerrar el fallback snapshot-as-available aunque hoy tenga 0 casos?~~ Cerrado: snapshot ya no habilita chips.

Cuando haya un caso concreto (clienta + artículo + talle + horario), se puede cruzar `fn_sellable_qty` contra el `variant_id` persistido. Sin eso no hay prueba de un add que haya pasado el clamp con sellable 0.

Relacionado: [[51-SELLABLE-STOCK-FASE1-2026-09-04]], [[52-SELLABLE-STOCK-FASE3-2026-09-04]], [[53-SELLABLE-STOCK-FASE4-2026-09-04]], [[54-SELLABLE-STOCK-FASE5-2026-09-04]], [[56-FRONTENDS-CATALOGO-VS-NJ-2026-09-04]].
