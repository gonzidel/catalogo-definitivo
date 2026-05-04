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

## D) Decisiones de negocio — 2026-05-04

Decisiones tomadas durante la auditoría de stock y saneamiento del vault. Fecha: 2026-05-04.

### D1 — Visibilidad de productos sin stock

**Decisión:** Los productos sin stock **no deben mostrarse en el catálogo**.

- Un producto desaparece del catálogo cuando `variant_sizes.stock_qty = 0` para todas sus variantes activas.
- No existe estado "próximamente" ni "reposición" visible para el cliente por el momento.
- Cuando vuelve el stock, el producto reaparece automáticamente (comportamiento actual de `catalog_public_view`).
- Esta regla es correcta en el sistema actual y no requiere cambio de código.

### D2 — Estado de reposición

**Decisión:** No hay estado de reposición visible para el cliente en esta etapa.

- Si no hay stock, el producto desaparece. Sin indicadores de "vuelve pronto" ni "agotado".
- Si en el futuro se necesita este estado, requiere una decisión técnica explícita y cambios en `catalog_public_view`.

### D3 — Productos discontinuados

**Decisión:** Un producto discontinuado queda fuera del catálogo mediante:

- `products.status != 'active'` → todo el producto desaparece (todas las variantes/colores).
- `product_variants.active = false` → solo esa variante/color desaparece; el producto sigue visible con las demás variantes activas.

No se crea un estado especial de "discontinuado". La combinación de `status` y `active` es suficiente para el flujo actual.

### D4 — Señales warning históricas (5884 detectadas el 2026-05-04)

**Decisión:** Las 5884 señales warning de `vw_stock_audit_reference_signals` se aceptan como **deuda histórica**.

- Son registros de trazabilidad incompleta creados antes de que el sistema de trazabilidad actual existiera.
- No representan stock roto en tiempo real.
- No se investigan individualmente ni se corrigen automáticamente por ahora.
- Se acepta que el gate puede reportarlas como warnings sin que eso bloquee operaciones.
- Esta decisión se revisará si en el futuro aparecen señales con `severity = 'critical'` o si el volumen de warnings aumenta significativamente.

### D5 — Ruta `client/cart.html`

**Decisión:** `client/cart.html` + `client/cart.js` **no debe mantenerse como checkout funcional separado**.

- La ruta tiene un checkout que solo marca `carts.status = pending` sin llamar `rpc_checkout_cart`, sin crear pedido, sin descontar stock.
- Debe redirigirse al dashboard o eliminarse en una fase posterior.
- Hasta que se implemente la corrección, la ruta sigue accesible pero no debe promoverse.
- Implementación exacta (redirección JS, HTTP redirect, o eliminación) se define en FASE 6 del roadmap.

### D6 — Permisos de reconciliación de stock

**Decisión:** `rpc_reconcile_stock(true)` (y cualquier operación correctiva de stock crítica) queda reservada a **super_admin**.

- Admins normales pueden ver las vistas de auditoría (`vw_stock_audit_*`) y ejecutar `rpc_reconcile_stock(false)` (que reconcilia derivadas pero no toca `reserved_qty`).
- Solo super_admin puede ejecutar `rpc_reconcile_stock(true)`.
- **Estado actual del sistema:** la RPC valida únicamente `EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid())`, sin distinción de rol. La validación granular de super_admin **aún no está implementada en DB**.
- Esta decisión debe traducirse en una migración SQL que agregue la validación interna. Pendiente para FASE 6/7 del roadmap.
- Mientras tanto, el acceso vía UI (`admin/stock-audit.js`) no pasa `p_fix_reserved_qty=true`, por lo que hay una protección de facto aunque no formal.

---

## C) Documentales (vault)

- Auditorías 14–19: referencia por módulo; [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]] riesgos transversales.
- [[13-RPCS-DEPLOY-STATE]]: versión de RPCs (si se mantiene al día).
- Mapas generales 01–08: si chocan con notas 01–11 *de este saneamiento*, **actualizar** el mapa o añadir nota de depósito.
- [[99-AUDITORIA-DOCUMENTACION]]: meta (calidad de la documentación del vault, histórica).

---

## Enlaces

- [[00-INDICE]] · [[00-INICIO]] · [[04-RPCS-CRITICAS]] · [[99-AUDITORIA-FINAL]] · [[99-AUDITORIA-DOCUMENTACION]]