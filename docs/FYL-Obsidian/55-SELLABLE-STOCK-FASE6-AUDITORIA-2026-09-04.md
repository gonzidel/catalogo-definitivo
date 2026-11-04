# 55 — Fase 6 auditoría legacy — 2026-09-04

Auditoría **sin apply**. No se tocó producción de forma destructiva.

Corte: 2026-09-04 ~18:30 UTC, proyecto fyl-core.

No se corrigió ColorHex (`suela`/`Suela`). No se tocaron 330–332, sellable, snapshot, PDP, CartTab, Home, 309.

---

## A. `product_variants.reserved_qty`

### ¿Gobierna disponibilidad? No, salvo vanilla

| Superficie | ¿Lee la columna? | Clase | Notas |
|---|---|---|---|
| `fn_sellable_qty` / `fn_sellable_stock_batch` | No | — | Confirmado en `prosrc` live |
| Vista 330 / snapshot 332 | No | — | |
| PDP / CartTab / Home / categorías / búsqueda / banners | No | — | `nj/lib/stock/*` |
| Gate `rpc_checkout_cart()` | No (331) | B write | Solo `reserved_qty = greatest(reserved_qty - qty, 0)` después del gate |
| 309 create / disponibilidad | No | B write al commit | `fn_commit_deferred_order_item_stock` decrementa al apartar |
| Vanilla `index.html` + `scripts/cart-persistent.js` | Sí | **D** | UI: `stock_qty - reserved_qty` |
| `get_meta_feed` | No | C | Alias local = OISS + `cart_items`, no la columna |
| `find_similar_products` | Columna ajena | muerto | `vws.reserved_qty`; `variant_warehouse_stock` no tiene esa columna |
| Admin stock-audit + `vw_stock_audit_reserved_qty_diff` | Sí | C | Reporting / reconcile |
| `admin/order-creator.js` | SELECT | C | Trae la columna al buscar productos |
| `admin/import-export.js` | INSERT 0 | B | Alta de variante |
| `nj/lib/products/variants.ts` | INSERT 0 | B | Alta admin Next |

Prueba read-only: variantes con `reserved_qty` 57–76 tienen `fn_sellable_qty` 7–42. Si restara reserved, el vendible sería 0.

**Clase A (autoridad de disponibilidad) en el stack Next/sellable/checkout/snapshot/309: 0 casos.**

### Writers live

- **Decrementan:** checkout 331, `fn_commit_deferred_order_item_stock` (309), `release_reserved_qty_for_order` + trigger 188 (`sent`/`expired`/`devolución`), `rpc_cancel_order_item`, `rpc_cancel_order_item_units`, `rpc_remove_order_item_restore_stock`, `rpc_admin_set_item_status`, `rpc_close_cart`.
- **Incrementan:** `rpc_apply_order_stock_deduction`, `rpc_admin_manual_inject_and_deduct`.
- **Muerto:** `rpc_reserve_item` (EXECUTE solo `service_role`).
- **Reescribe:** `rpc_reconcile_stock(true)` — la UI de stock-audit no pasa `true` por defecto.
- **No escribe (comentario):** `rpc_orders_daily_maintenance` (sacado en 260/266).

Checkout **no incrementa**. El decremento es un resto del modelo “reservar en carrito / liberar al convertir”. Vanilla/Next **ya no llaman** `rpc_reserve_item`. El valor no puede quedar negativo (`greatest(...,0)`). Hoy **no representa una reserva coherente**.

Reconcile **sí depende** de la columna para medir drift (`stored` vs OISS de pedidos no finales + `cart_items` reserved de carts `open`).

---

## B. Valores actuales

| Métrica | Valor |
|---|---|
| Variantes | 5369 |
| `reserved_qty > 0` | 1258 |
| Suma | 8221 |
| Negativos / null | 0 / 0 |
| Máximo | 102 (R2525 Var) |
| p90 / p99 entre >0 | 15 / 47 |
| OISS pedidos no finales | 6 u |
| `cart_items` con `variant_id` | 7 u |
| Reserva “real” (fórmula audit) | 13 |
| Drift inflated | 1254 variantes / 8208 u |
| Drift deflated | 0 |

No hacer `UPDATE ... SET reserved_qty = 0` a ciegas: vanilla seguiría restando 0 (mostraría más stock) y el audit/reconcile cambiarían de golpe. Hace falta backup o dejar de leerlo primero.

---

## C. `cart_items`

**Qué es hoy:** staging técnico del checkout, no reserva física.

- Default `status = 'reserved'` — nombre legacy.
- Next: `useCart.ts` inserta/update/delete; `CartTab` hace `syncNow()` **antes** de `rpc_checkout_cart`.
- Checkout: exige filas en el cart; al éxito `DELETE FROM cart_items`; **no cierra** el cart (`status` sigue `open`).
- Vanilla/dashboard: mismo CRUD + interpretan reserved como stock restado.

Sin `order_id`. Edad solo por `updated_at`.

---

## D. Zombies (los 364)

Criterio:

- **Zombie seguro:** `status='reserved'` AND `updated_at > 90d` AND `variant_id IS NULL`.
- **Histórico ambiguo:** mismo + `variant_id IS NOT NULL` (Next los recargaría al login).
- **Activo:** `updated_at < 30d` — hoy 0.
- No borrar ambiguos.

| | n |
|---|---|
| Total / reserved / >90d | 364 / 364 / 364 |
| Sin variant_id (seguro) | **361** |
| Con variant_id (ambiguo) | **3** (AAAA, 332, MR21; marzo 2026; 2 clientes) |
| Carts con ítems | 202 |
| Open vacíos | 27 |
| Submitted | 4 |
| Clientes dueños de los 364 | 5 (2 con pedido histórico, 0 abierto) |

Los 3 ambiguos: `926b1596-…`, `a1dbde1f-…`, `ef76242e-…`.

---

## E. Causa

1. Vanilla insertaba sin `variant_id`.
2. Checkout borra ítems y deja `carts.status='open'` → carts vacíos residuales.
3. Abandono pre-checkout (última fila 2026-04-25).
4. Next actual sí escribe; los carts de 30 días (6) no tienen ítems porque el checkout los limpia.

No hace falta un cron destructivo. El hueco claro es **cerrar o marcar el cart en checkout exitoso**.

---

## F. Vanilla / legacy

`index.html` sigue publicando `scripts/main-supabase.js` + `scripts/cart-persistent.js`. Eso:

- lee `product_variants.reserved_qty` para pintar disponibilidad;
- escribe `cart_items.status='reserved'`.

Dashboard cliente (`client/dashboard-instant.js`, `cart.js`) igual.

RPCs legacy `add_cart_item` / `clear_cart_items` / `get_cart_items_simple` / `get_user_cart`: **sin EXECUTE** para anon/authenticated (ya revocado).

---

## G. Grants (resumen)

GRANT de tabla a anon/authenticated es ALL en VSS, warehouses, variants, carts, cart_items. RLS ON.

- VSS: anon/auth solo SELECT por policy; write authenticated solo si es admin. GRANT I/U/D es redundante y crítico en papel.
- `warehouses`: solo policies SELECT.
- **Agujero real:** `product_variants_all_access` — `ALL` a `{public}` si `auth.role() = 'authenticated'`.
- `carts`/`cart_items`: policies own + admin. **Necesarios** (Next browser).
- `rpc_get_variant_size_reserved`: EXECUTE anon+auth; nj no lo llama.
- No hay GRANT a `PUBLIC` en esas tablas.

---

## H. Qué eliminaría / conservaría

**Conservar**

- Columna `reserved_qty`.
- Tabla `cart_items` (staging Next).
- Grants de SELECT VSS/warehouses.
- EXECUTE sellable + checkout authenticated.
- Writes 309 / 188 / cancel hasta otra fase.
- Los 3 `cart_items` con `variant_id`.

**Candidato a limpiar (con autorización)**

- 361 ítems sin `variant_id` → archive + delete.
- 27 carts open vacíos viejos (opcional, más ambiguo).
- Decremento de `reserved_qty` en checkout (333A) cuando vanilla no dependa.
- GRANT I/U/D redundantes + policy `product_variants_all_access` (333C) — **aplicado 2026-09-04**. Ver [[57-SELLABLE-STOCK-FASE6C-333C-2026-09-04]].

**No hacer**

- `UPDATE product_variants SET reserved_qty = 0`.
- DROP COLUMN.
- DELETE masivo de los 3 con variant.
- Cron destructivo.
- Tocar ColorHex.

---

## I. Riesgo por cambio

| Cambio | Riesgo | Por qué |
|---|---|---|
| Sacar write checkout | Medio | Vanilla mostraría más stock; 309/188 siguen escribiendo |
| Zerificar reserved_qty | Alto | Vanilla + audit + posible desfase vs incrementos admin |
| Borrar 361 sin archive | Medio | Irreversible; bajo impacto funcional |
| Borrar 3 con variant | Alto | Reaparecerían en el carrito Next de 2 clientes |
| Cerrar cart en checkout | Bajo | Evita vacíos; no toca stock |
| Revocar GRANT VSS I/U/D | Bajo si RLS se verifica | Recorta superficie; admin sigue por policy |
| Dropear `product_variants_all_access` | Medio | Puede romper un admin/script que actualice variantes sin policy admin |

---

## J. Migraciones propuestas (no escritas / no aplicadas)

### 333A — dejar de escribir en checkout

Solo si se acepta el efecto vanilla. Rollback: restaurar el `UPDATE reserved_qty`. No dropea columna. No toca 309.

### 333B — archive de zombies seguros

`cart_items_archive_20260904` + `INSERT…SELECT` + `DELETE…RETURNING` de las 361. Listado de IDs. Rollback = reinsertar desde archive. Opcional: carts open vacíos >90d en otra sentencia.

Prevención (mismo PR o 333B-bis): `UPDATE carts SET status='submitted' WHERE id = v_cart_id` al éxito de checkout. Eso **sí toca** el cuerpo de checkout; hace falta autorización aparte de 331.

### 333C — grants — APLICADO 2026-09-04

DROP `*_all_access` + policies admin mínimas en products/images. REVOKE I/U/D anon (y TRUNCATE authenticated) en catálogo/stock. REVOKE write warehouses a authenticated. **No** se revocó `rpc_get_variant_size_reserved` (vanilla residual ~2 días). Ver [[57-SELLABLE-STOCK-FASE6C-333C-2026-09-04]].

---

## Observabilidad (solo lectura)

```sql
SELECT count(*) FILTER (WHERE reserved_qty > 0) AS gt0,
       coalesce(sum(reserved_qty),0) AS sum_rq
FROM product_variants;

SELECT anomaly_type, count(*), sum(abs(delta))
FROM vw_stock_audit_reserved_qty_diff
GROUP BY 1;

SELECT status, count(*),
       count(*) FILTER (WHERE variant_id IS NULL) AS no_variant,
       min(updated_at), max(updated_at)
FROM cart_items
GROUP BY 1;

SELECT has_table_privilege('anon','public.variant_size_warehouse_stock','UPDATE');
```

---

## Condición de esta etapa

Sabemos:

- `reserved_qty` **puede** dejar de escribirse en checkout sin romper sellable/Next/309-disponibilidad; **no** se puede apagar todo el grafo de writes sin tocar 309/188/cancel; vanilla todavía lo lee.
- 361 `cart_items` son basura segura; 3 no.
- Quedaron por vanilla sin variant + checkout que no cierra el cart.
- Evitar que vuelvan: cerrar cart al checkout; no cron.
- Permisos retirables: GRANT I/U/D de stock + policy `product_variants_all_access` + EXECUTE anon de reserved-by-size.

**No se aplicó cleanup.**
