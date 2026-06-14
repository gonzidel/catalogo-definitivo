# 43 — NJ Dashboard: prórroga 24h + cancelar pedido — 2026-06-09

## Resumen

En el dashboard Next (`/nj/dashboard`, tab **Mi pedido**), cuando un pedido **venció** (`now >= dismantle_at`) el cliente puede:

1. **Dame 24 hs más** — prórroga única por pedido (extiende `dismantle_at` +24h).
2. **Escribir por WhatsApp** — contacto manual (como vanilla).
3. **Cancelar pedido** — cancela todos los ítems operativos; el pedido desaparece del dashboard pero queda en admin.

También **Cancelar pedido** está en el menú ⋯ del header cuando el pedido sigue editable (`active` / `closing_soon`).

---

## Proyecto Supabase

| Entorno | Project ref | Nombre |
|---------|-------------|--------|
| **Producción NJ + catálogo actual** | `dtfznewwvsadkorxwzft` | fyl-core |

> ⚠️ La migración inicial se aplicó por error en `vwxmvllrpearrkwjgxqz` (fyl-catalogo). Las RPCs efectivas para `/nj` están en **fyl-core**.

Migraciones canónicas:

- `supabase/canonical/234_rpc_customer_order_lifecycle.sql` — RPCs iniciales
- `supabase/canonical/235_fix_rpc_customer_cancel_order.sql` — fix cancelación (ver bug abajo)

---

## RPCs nuevas

### `rpc_customer_request_order_extension_24h(p_order_id uuid)`

- Solo el **owner** del pedido (`customer_id = auth.uid()`).
- Solo si `status IN ('active','closing_soon')` y **`now >= dismantle_at`**.
- Una sola vez: guarda `customer_enable_24h_uses: 1` en `orders.notes` (JSON).
- Acción: `dismantle_at = now() + 24h`; si estaba `closing_soon` → `active`.
- Admin usa clave distinta: `admin_enable_24h_uses` en `admin/orders.js`.

### `rpc_customer_cancel_order(p_order_id uuid)`

Alineado con `client/dashboard-instant.js` → `cancelEntireOrder()` y con la pestaña **Cancelaciones** de `admin/orders.js` (filtro por `order_items.status = 'cancelled'`, no por `orders.status`).

Flujo:

1. Por cada ítem no `cancelled` → `rpc_cancel_order_item(item_id)`.
   - `reserved` / `waiting` → devuelve stock vía `order_item_stock_sources` o fallback depósito.
   - `picked` → marca `cancelled`, **notifica admin**, stock no vuelve solo (igual que vanilla).
2. Si hubo algún **picked** → `orders.status = 'closed'`.
3. Si no hubo picked → solo actualiza `updated_at` (pedido queda `active` con todos los ítems `cancelled`).

El cliente **no ve** pedidos sin ítems operativos (`reserved`, `picked`, `waiting`, `missing` con qty > 0) — ver filtro en `DashboardClient`.

---

## Bug resuelto — 400 al cancelar

**Síntoma:** POST a `rpc_customer_cancel_order` → **400 Bad Request**; UI: "No se pudo cancelar el pedido".

**Causa:** La v1 de la RPC hacía `UPDATE orders SET status = 'cancelled'`, pero **`cancelled` no está en `orders_status_check`** en fyl-core:

```sql
-- Valores permitidos (2026-06-09):
active, closing_soon, closed, sent, expired, devolución, stock_pending
```

En FYL, las cancelaciones de pedido se modelan por **ítems** `order_items.status = 'cancelled'`, no por `orders.status = 'cancelled'` (coherente con `admin/orders.js` filtro Cancelaciones).

**Fix:** migración `235` — eliminar `status = 'cancelled'`; usar lógica vanilla (picked → `closed`; resto → ítems cancelled).

---

## Frontend Next

| Archivo | Cambio |
|---------|--------|
| `nj/components/cart/ActiveOrderTab.tsx` | Aviso vencido: botones prórroga / WhatsApp / cancelar; modal confirmación; mensaje de error con detalle Supabase |
| `nj/app/dashboard/DashboardClient.tsx` | `orderHasOperationalItems()` — oculta pedidos sin ítems operativos en "Mi pedido"; fetch `orders.notes` |
| `nj/lib/order-notes.ts` | `hasCustomerUsedOrderExtension(notes)` lee `customer_enable_24h_uses` |
| `nj/app/dashboard/page.tsx` | Select incluye `notes` |

### UI aviso vencido

- Botón WhatsApp compacto (`minHeight: 40px`, `fontSize: 13`) — antes desproporcionado.
- Tras usar prórroga: aviso amarillo + solo WhatsApp (no segundo botón de prórroga).
- WhatsApp duplicado al pie de pantalla eliminado; queda solo "Enviar pedido" si cumple mínimo 4 u.

---

## Verificación

1. Pedido vencido con ítems `reserved` → Cancelar → ítems `cancelled`, stock restaurado, pedido invisible en Mi pedido, visible en admin → Cancelaciones.
2. Pedido con al menos un `picked` → Cancelar → `orders.status = closed`, notificación admin, pedido invisible en cliente (sin ítems operativos).
3. Prórroga → `dismantle_at` +24h, `notes.customer_enable_24h_uses = 1`, pedido editable de nuevo; segundo intento de prórroga → error RPC.
4. Proyecto correcto: requests a `dtfznewwvsadkorxwzft.supabase.co`.

---

## Riesgos / deuda

| Riesgo | Nivel | Nota |
|--------|-------|------|
| Ítems `picked` cancelados sin devolución automática de stock | Medio | Igual que vanilla; admin usa `rpc_remove_order_item_restore_stock` |
| Pedido `active` con todos ítems cancelled sigue en BD | Bajo | Admin lo ve en Cancelaciones; cliente filtrado |
| `orders.status = 'cancelled'` no existe en CHECK | — | No intentar usarlo sin migración de dominio |
| RPC duplicada en fyl-catalogo | Bajo | Inofensiva si ese proyecto no sirve NJ |

---

## Referencias

- Flujo carrito/pedido NJ: `doc/nj/cart-order-flow.md`
- Vanilla cancelación completa: `client/dashboard-instant.js` → `cancelEntireOrder()`
- Admin cancelaciones: `admin/orders.js` (filtro `order_items.status = cancelled`)
- Auditoría orders: [[17-AUDITORIA-MODULO-ORDERS]]
- Migración Next: [[41-MIGRACION-NEXTJS-NJ-2026-06-08]]

---

*Creado: 2026-06-09. Evidencia: error 404 (RPC en proyecto equivocado) → 400 (`orders_status_check`) → fix 235 en fyl-core.*
