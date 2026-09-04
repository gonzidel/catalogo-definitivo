# FYL /nj — Carrito y Flujo de Pedidos

> Última actualización: 2026-08-28

> **Prórroga 24h + cancelar pedido (vencido):** ver [[43-NJ-DASHBOARD-PRORROGA-CANCELACION-2026-06-09]] y RPCs `234`/`235` en fyl-core.

## Conceptos clave

| Concepto | Descripción |
|----------|-------------|
| **Carrito** | Selección de productos antes de confirmar. Sin mínimo. Local (Zustand) + Supabase sync. |
| **Mi pedido** | El pedido ya confirmado. Mínimo 4 unidades para *cerrar* (resto del país). |
| **Enviar pedido** | Acción final del cliente. Requiere 4+ unidades y cero items faltantes (resto). |
| **Plazo zona local** | Resistencia, Barranqueras, Puerto Vilelas, Fontana: **36 h** tras el **primer apartado admin** (no al checkout). Regla día hábil **15:00 AR**. `expires_at` = 12 h antes. **Sin mínimo de 4** para cerrar. **Sin prórroga 24 h**. Migraciones `307`/`308`/`309`. |
| **Stock diferido (309)** | Checkout **no descuenta stock** → ítems `awaiting_apartado`, `dismantle_at` NULL. Admin en `/nj/admin/retiro` aparta → descuenta stock + arranca countdown. |

---

## Estado del carrito (Zustand)

**Store**: `store/cart.ts`
- Persiste en `localStorage` (Zustand `persist`)
- Campos por ítem: `variant_id`, `product_name`, `color`, `size`, `qty`, `price_snapshot`, `imagen`
- `cartId`: ID del carrito en Supabase (`carts.id`)

**Sync hook**: `hooks/useCart.ts`
- `ensureCart()` → crea o recupera `carts` row para el usuario
- `upsertCartItem()` → `INSERT OR UPDATE` en `cart_items` con `quantity`, `qty`, `status: "reserved"`
- `loadCartFromSupabase()` → carga al iniciar sesión
- `checkoutCart()` → llama `rpc_checkout_cart` con `p_operation_id` (UUID) y `p_request` (fingerprint)
- Guard: no sincroniza si `variant_id` está vacío o comienza con `"local_"`

### Firma de `rpc_checkout_cart`

```typescript
supabase.rpc("rpc_checkout_cart", {
  p_operation_id: generateOperationId(),   // UUID v4
  p_request: {
    source: "client_dashboard",
    action: "checkout",
    cart_fingerprint: buildCartFingerprint(items),  // djb2 hash
  }
})
```

> ⚠️ NO usar `p_cart_id`. La función identifica el carrito por la sesión del usuario.

---

## Flujo completo: Carrito → Pedido → Enviado

```
[CARRITO]
  └── Usuario agrega productos (cualquier cantidad)
  └── CartTab muestra items + stock en tiempo real (variant_sizes.stock_qty)
      ├── Probe de stock es advisory (no bloquea el CTA; con red lenta solo cambia el hint)
      ├── Stock 0: ítem marcado rojo, excluido del total
      └── Stock < cantidad: badge de advertencia "Stock limitado"
      └── Promos 2x1 / 2xMonto: fila agrupada (`PromoGroupRow`) vía RPC
          `get_active_promotions_for_variants` + `lib/cart/promo-groups.ts`
          ├── Solo pares completos dentro del banner; unidades sueltas afuera
          ├── Miniaturas superpuestas, título `promo 2x…` / `N promo 2x…`
          ├── Precio de promo en rojo (sin c/u); total del carrito promo-aware
          └── Expandir → cada ítem cubierto con −/+ y basura (sin precio unitario)
  └── Botón "Hacer pedido" → llama rpc_checkout_cart → crea order con status "active"
  └── Redirect automático a tab "Mi pedido"

[MI PEDIDO — active / closing_soon]
  └── ActiveOrderTab muestra items con status badges
  └── Zona local Chaco (309): ítems internos `awaiting_apartado`; en **Mi pedido** se ven igual que `reserved` (misma UX). Countdown 36 h solo post-apartado admin (`dismantle_at` null hasta entonces).
  └── Misma agrupación de promo 2x; al expandir: cantidad + basura (sin −/+)
  └── Mínimo 4 unidades para habilitar "Cerrar pedido" (zona local Chaco acotada: sin mínimo)
  └── Si hay items "missing" → botón bloqueado + aviso rojo
  └── Botón "Enviar pedido" → abre MODAL DE CONFIRMACIÓN
      └── "Sí, enviar" → UPDATE orders SET status = "closed"

[MI PEDIDO — closed, sin faltantes]
  └── Pantalla "📦 Tu pedido está en preparación"
      ├── Animación de puntos pulsantes (CSS keyframes pulse-dot)
      ├── Resumen: unidades + total
      ├── Lista de ítems (read-only con status badges)
      └── Link "Seguir eligiendo productos"

[MI PEDIDO — closed, con items "missing"]
  └── Vista EDITABLE completa (no la pantalla de preparación)
      ├── Banner rojo: "Tu pedido está siendo preparado pero hay X productos sin stock"
      ├── Items faltantes al tope (rojo, desaturado, precio tachado)
      │   ├── "Ver alternativas" → AlternativesPanel (busca en catalog_public_view)
      │   └── "Quitar" → rpc_cancel_order_item
      └── Botón "Confirmar pedido" habilitado cuando se resuelven todos los faltantes
          └── Reabre modal de confirmación → UPDATE status = "closed" (re-confirma)

[MI PEDIDO — sent]
  └── Pantalla "🚚 ¡Tu pedido fue enviado!"
      ├── Botón "Ver en historial" o × → dismiss
      └── Dismiss: guarda `fyl-order-sent-dismissed-{orderId}` en localStorage
          └── DashboardClient excluye el pedido de activeOrder
          └── Pedido aparece en tab "Historial"

[HISTORIAL]
  └── Todos los pedidos con status distinto de active/closing_soon/closed/sent-no-dismisseado
```

---

## Estados de orden (orders.status)

| Status | Quién lo setea | Qué ve el cliente |
|--------|---------------|-------------------|
| `active` | rpc_checkout_cart | Tab "Mi pedido" — vista editable normal |
| `closing_soon` | Admin / cron | Tab "Mi pedido" — aviso de plazo próximo |
| `closed` | Cliente (Enviar pedido) | Tab "Mi pedido" — "En preparación" o vista con faltantes |
| `sent` | Admin (`rpc_mark_order_as_sent`) | Tab "Mi pedido" — "¡Enviado!" con dismiss |
| `cancelled` | Admin / Sistema | **No usar en `orders.status`** (CHECK no lo admite en fyl-core). Cancelaciones = ítems `cancelled` |
| `waiting` | Sistema | Tab "Historial" |
| `stock_pending` | Sistema | Tab "Historial" |

## Estados de ítems (order_items.status)

| Status | Quién lo setea | Visual en cliente |
|--------|---------------|-------------------|
| `reserved` | rpc_checkout_cart | Badge celeste "Reservado" |
| `picked` | Admin (orders.html) | Badge verde "Apartado" |
| `missing` | Admin (orders.html) | Rojo + opción quitar/reemplazar |
| `waiting` | Admin | Badge amarillo "En espera" |
| `cancelled` | Admin / rpc_cancel_order_item | Oculto (filtrado) |

---

## Realtime subscriptions (DashboardClient)

Cuando hay un `activeOrder` con status `active`, `closing_soon` o `closed`:

```typescript
supabase.channel(`order-watch-${activeOrder.id}`)
  .on("postgres_changes", { table: "orders",      filter: `id=eq.${orderId}` },      refreshOrders)
  .on("postgres_changes", { table: "order_items", filter: `order_id=eq.${orderId}` }, refreshOrders)
  .subscribe()
```

Detecta en tiempo real:
- Cambio de status del pedido (ej: admin marca como `sent`)
- Cambio de status de ítems (ej: admin marca ítem como `missing` o `picked`)

---

## Regla de los 7 días

Lógica portada de `dashboard-instant.js`:

- `ORDER_DISMANTLE_DAYS = 7`
- Si `dismantle_at` existe → usa esa fecha; si no → `created_at + 7 días`
- `daysLeft === 1 || daysLeft === 2` → banner amarillo de advertencia
- `isExpired (now >= dismantle_at)` → vista bloqueada (solo lectura en ítems):
  - **Resto del país:** aviso con **Extender 24 h** (una vez; `rpc_customer_request_order_extension_24h`) + WhatsApp + cancelar
  - **Zona local (4 localidades Chaco):** sin prórroga; WhatsApp + cancelar; mensaje de plazo 36 h vencido
  - Si cumple mínimo (4 u resto / 1 u zona local) → botón **Cerrar pedido** (solo resto del país cuando aún no venció; vencido sin prórroga no aplica en zona local)

### Prórroga 24h (cliente)

No disponible para clientes de **Resistencia, Barranqueras, Puerto Vilelas o Fontana** (Chaco). Migración `308` rechaza la RPC en servidor.

```typescript
supabase.rpc("rpc_customer_request_order_extension_24h", { p_order_id: order.id })
```

- Registra `customer_enable_24h_uses: 1` en `orders.notes` (JSON).
- Extiende `dismantle_at` +24h desde `now()`.
- Frontend: `nj/lib/order-notes.ts` → `hasCustomerUsedOrderExtension(notes)`.

### Cancelar pedido completo (cliente)

```typescript
supabase.rpc("rpc_customer_cancel_order", { p_order_id: order.id })
```

Alineado con `client/dashboard-instant.js` → `cancelEntireOrder()`:

| Caso | Efecto en BD | Vista cliente |
|------|----------------|---------------|
| Solo ítems `reserved`/`waiting`/`missing` | Ítems → `cancelled`, stock devuelto (reserved/waiting) | Desaparece de Mi pedido |
| Algún ítem `picked` | Ítems → `cancelled`, admin notificado, `orders.status = closed` | Desaparece de Mi pedido |
| Admin | Pedido + ítems cancelled en pestaña Cancelaciones | — |

**Importante:** `orders.status = 'cancelled'` **no es válido** en fyl-core (`orders_status_check`). Las cancelaciones se ven por `order_items.status`.

`DashboardClient` oculta pedidos sin ítems operativos (`orderHasOperationalItems`).

También disponible desde menú ⋯ en header del pedido (cuando no está en solo lectura).

---

## Modal de confirmación

Antes de enviar el pedido se muestra un bottom sheet:

```
📦 ¿Enviamos tu pedido?
Tu pedido tiene X unidades por un total de $XX.XXX.
Una vez enviado, lo prepararemos para el despacho.
[Sí, enviar pedido] [Cancelar]
```

Animación: `slide-up-modal` CSS keyframe (`translateY(100%) → 0`).

---

## Verificación de stock en carrito (CartTab)

Hook interno `useCartStock`:
- Consulta `variant_sizes` (`select stock_qty where variant_id IN (...)`)
- Ítems con `stock_qty === 0`: marcados rojo, excluidos del total, controles de cantidad ocultos
- Ítems con `stock_qty < qty`: badge "Solo X disponibles"
- Ítem con 0 stock: excluido del cálculo pero permanece visible (no desaparece)

---

## Verificación staging (zona local Resistencia)

1. Checkout 1 ítem → stock sin cambio; ítem `awaiting_apartado`; `dismantle_at` null.
2. Cliente: spinner + copy espera; sin chip de countdown.
3. Admin `/nj/admin/retiro` → Apartar → stock baja; ítem `picked`; `dismantle_at` ≈ +36 h hábil 15:00 AR.
4. Segundo ítem `awaiting_apartado` → apartar → timer **no** se reinicia.
5. Stock 0 antes de apartar → ítem `missing` visible para cliente.
6. Cliente resto del país: checkout sin cambios (stock al checkout, 7 d, min 4).

---

## Checklist de integración Supabase

- [ ] `carts` table: `id`, `customer_id`, `status`
- [ ] `cart_items` table: `cart_id`, `variant_id`, `quantity`, `qty`, `status` (default `"reserved"`)
- [ ] `orders` table: …, `local_deferred_pickup`, `pickup_timer_started_at`
- [ ] `order_items.status` incluye `awaiting_apartado`
- [ ] RPC `rpc_refresh_my_order_availability(p_order_id)` — migración 309
- [ ] `order_items` table: `id`, `order_id`, `variant_id`, `product_name`, `color`, `size`, `quantity`, `price_snapshot`, `status`, `imagen`
- [ ] RPC `rpc_checkout_cart(p_operation_id, p_request)`
- [ ] RPC `rpc_cancel_order_item(p_item_id)`
- [ ] RPC `rpc_customer_request_order_extension_24h(p_order_id)` — fyl-core, migración 234
- [ ] RPC `rpc_customer_cancel_order(p_order_id)` — fyl-core, migración 235 (fix CHECK status)
- [ ] RPC `rpc_mark_order_as_sent(p_order_id)` (usado por admin)
- [ ] Supabase Realtime habilitado en tablas `orders` y `order_items`
