# FYL /nj — Carrito y Flujo de Pedidos

> Última actualización: 2026-06-08

## Conceptos clave

| Concepto | Descripción |
|----------|-------------|
| **Carrito** | Selección de productos antes de confirmar. Sin mínimo. Local (Zustand) + Supabase sync. |
| **Mi pedido** | El pedido ya confirmado. Mínimo 4 unidades para *enviar*. |
| **Enviar pedido** | Acción final del cliente. Requiere 4+ unidades y cero items faltantes. |

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
      ├── Stock 0: ítem marcado rojo, excluido del total, botón bloqueado con aviso
      └── Stock < cantidad: badge de advertencia "Stock limitado"
  └── Botón "Hacer pedido" → llama rpc_checkout_cart → crea order con status "active"
  └── Redirect automático a tab "Mi pedido"

[MI PEDIDO — active / closing_soon]
  └── ActiveOrderTab muestra items con status badges
  └── Mínimo 4 unidades para habilitar "Enviar pedido"
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
| `cancelled` | Admin / Sistema | Tab "Historial" |
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
- `isExpired (daysLeft === 0)` → vista bloqueada:
  - Sólo muestra WhatsApp y, si tiene 4+ unidades, botón "Enviar pedido"
  - No permite quitar/agregar ítems

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

## Checklist de integración Supabase

- [ ] `carts` table: `id`, `customer_id`, `status`
- [ ] `cart_items` table: `cart_id`, `variant_id`, `quantity`, `qty`, `status` (default `"reserved"`)
- [ ] `orders` table: `id`, `customer_id`, `order_number`, `status`, `total_amount`, `created_at`, `dismantle_at`, `expires_at`
- [ ] `order_items` table: `id`, `order_id`, `variant_id`, `product_name`, `color`, `size`, `quantity`, `price_snapshot`, `status`, `imagen`
- [ ] RPC `rpc_checkout_cart(p_operation_id, p_request)`
- [ ] RPC `rpc_cancel_order_item(p_item_id)`
- [ ] RPC `rpc_mark_order_as_sent(p_order_id)` (usado por admin)
- [ ] Supabase Realtime habilitado en tablas `orders` y `order_items`
