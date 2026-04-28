# 11 — Decisiones técnicas (FYL)

## A) Saneamiento de stock, pedidos y ventas

1. **No añadir** trigger-guard `BEFORE INSERT/UPDATE/DELETE` sobre `variant_size_warehouse_stock` — control vía RLS, scripts manuales, triggers 84/145, `rpc_reconcile_stock` y gate (detalle: `STOCK_GOVERNANCE.md` §2).
2. **No tocar a la ligera** los triggers **84** y **145** (sync derivadas); cualquier cambio requiere prueba y revisión de `vw_stock_audit_release_gate` ([[07-RELEASE-GATE-Y-AUDITORIA]]).
3. Mantener **coexistencia** de `order_items` en `missing` con **`admin_confirmed_missing`** (y flujos de “manual confirmado”) para compatibilidad de operación y de copy en dashboard ([[08-UI-CANONICA-Y-FALLBACKS]], [[03-FLUJO-PEDIDOS-Y-STOCK]]).
4. **Frontend de producto** no escribe `variant_size_warehouse_stock` directamente: usa RPCs batch / movimientos / pedido (política en [[02-MODELO-STOCK-ACTUAL]]).
5. **Checkout B2B** falla/s valida en cadena de dominio si `cart_items` carece de **`variant_id` válido**; el cliente repara o bloquea antes del RPC — ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] §11.
6. **Alternativas de producto** y lecturas con filtro de depósito: usar **`warehouse_id` UUID** resuelto desde `warehouses.code` — no asumir códigos string en filtros.
7. **Dashboard cliente:** feedback e inserción DOM post-checkout vía `safeInsertBefore` (no `insertBefore` con nodo de referencia fuera del padre) en `client/dashboard-instant.js` (ver `safeInsertBefore` y [[10-BUGS-RESUELTOS]]).
8. **Idempotencia operativa** en RPCs listadas: `p_operation_id` + `rpc_operations` según arquitectura 169+ ([[05-IDEMPOTENCIA-RPC-OPERATIONS]]).

**Referencias de sprint / doc de repo:** `docs/STOCK_GOVERNANCE.md`, `docs/RUNBOOK.md`, migraciones en `supabase/canonical/169_*.sql` en adelante. Índice del vault: [[00-INDICE]].

---

## B) Decisiones vigentes (catálogo, costos, hardening 2025–2026)

1. Stock con talle vive en `variant_size_warehouse_stock`.
2. `variant_sizes.stock_qty` es derivado/agregado y no canal primario de escritura.
3. Pedidos admin usan split `qty_from_general` / `qty_from_venta` cuando aplica.
4. `admin_confirmed_missing` no implica solo `status = missing`; participa con “picked” manual en lógica de admin.
5. Checkout cliente usa `rpc_checkout_cart(uuid,jsonb)` con `operation_id` e idempotencia fuerte.
6. Venta pública y anulación pasan por RPCs idempotentes (`rpc_create_public_sale`, `rpc_void_public_sale`).
7. Costos y márgenes: UI preferente solo `super_admin`; validar DB aparte.
8. La documentación viva se actualiza con cambios de lógica.
9. `cart_items.variant_id` no nulo para checkout fiable; reparo en `cart-persistent` + `dashboard-instant` ([[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] §11).
10. Infra UX/red admin y catálogo: `createScreenScope`, `wrapSupabase`, `preloadAuthState` en admin ([[21-CONTEXTO-AGENTE-HARDENING-2026-04]]).
11. Bloque superior del index: `#home-top-dynamic-slot`, loader local, no sustituir por loader bajo filtros.
12. Diagnóstico SQL: no asumir columna `sku` en `cart_items` si el esquema no la expone.

---

## C) Documentales (vault)

- Auditorías 14–19: referencia por módulo; [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]] riesgos transversales.
- [[13-RPCS-DEPLOY-STATE]]: versión de RPCs (si se mantiene al día).
- Mapas generales 01–08: si chocan con notas 01–11 *de este saneamiento*, **actualizar** el mapa o añadir nota de depósito.
- [[99-AUDITORIA-DOCUMENTACION]]: meta (calidad de la documentación del vault, histórica).

---

## Enlaces

- [[00-INDICE]] · [[00-INICIO]] · [[04-RPCS-CRITICAS]] · [[99-AUDITORIA-FINAL]] · [[99-AUDITORIA-DOCUMENTACION]]