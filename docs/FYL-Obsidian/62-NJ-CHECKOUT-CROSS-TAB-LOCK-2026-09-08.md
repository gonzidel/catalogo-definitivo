# 62 — Checkout cross-tab + consistencia carrito — 2026-09-08

Hardening frontend NJ de los races de mayor riesgo de la auditoría preventiva. **No se desplegó.** No se tocó `rpc_checkout_cart`, schema, sellable, reservas, reglas nacionales ni Retiro local.

Backend live: **fyl-core** (`dtfznewwvsadkorxwzft`). App NJ: `nj-gonzidel.vercel.app` (sin este código hasta un deploy futuro).

Complementa [[59-NJ-CHECKOUT-IDEMPOTENCY-ROOT-PREP-2026-09-04]].

---

## Qué cambió

### C1/C2 — checkout entre pestañas

- Estado durable de `operation_id` en **localStorage**, key `fyl-nj-checkout-op:{customerId}` (ya no `sessionStorage` global).
- Estados explícitos: `pending` / `completed` / `failed` + `createdAt`/`updatedAt`.
- Lock **por cliente** (`fyl-nj-checkout:{customerId}`): Web Locks si existe; fallback lease en localStorage (TTL 45s) + BroadcastChannel para despertar waiters.
- `runCustomerCheckout` serializa sync + RPC. Si `completed` + mismo fingerprint: no sync, no RPC. Si `pending` (refresh / tab huérfano): replay RPC con el mismo id; si el carrito está vacío, sync de recuperación y mismo id. Si `failed` (antes del RPC): la otra pestaña crea un id nuevo.

### P2 — locks intra-tab

`tryBeginExclusive` (ref síncrono) **antes del primer await** en:

- PDP `handleAddAllToCart`
- `ActiveOrderTab.handleSend`
- cancelación de unidades (`confirmQtyChange` y `handleConfirmRemoveProduct`)

### P3 — consistencia carrito

- Hydrate conserva qty local si `synced === false`.
- `removeItem` solo después de DELETE remoto OK.
- `ensureCart` / upsert UPDATE revisan error.
- INSERT 409/`23505` relee la fila existente y no bloquea el checkout.

### C3 — Retiro local (solo lectura, sin mutar DB)

Índice live:

```sql
CREATE UNIQUE INDEX orders_one_open_per_customer_idx ON public.orders (customer_id)
WHERE status IN ('active','closing_soon','closed')
  AND COALESCE(local_deferred_pickup, false) = false
  AND NOT (status = 'closed' AND notes contiene "local_pickup_fulfilled_at");
```

`local_deferred_pickup = true` queda **fuera**. En live había **3** clientes con 2+ pedidos diferidos en `active|closing_soon|closed`. RPC attach busca cualquier `active`/`closing_soon` (no filtra diferido). UI de diferido invita a sumar productos al mismo pedido; el banner de carrito “en preparación” solo cubre `closed`.

Propuesta (no hecha): gate UI si ya hay diferido abierto +, más adelante, unique parcial de un diferido abierto por cliente. Sin SQL ahora.

---

## Verificación

Desde `nj/`:

```
npx tsx lib/cart/checkout-operation.test.ts
npx tsx lib/cart/checkout-flow.test.ts
npx tsx lib/cart/intra-tab-lock.test.ts
npx tsx lib/cart/cart-hydrate.test.ts
npx tsx lib/cart/concurrency-audit.test.ts
npx tsx hooks/useCart.syncNow.race.test.ts
```

Rollback: revertir archivos NJ listados en el PR/commit. No hay migración SQL.

Riesgo residual: Web Locks no tienen steal por TTL (un tab colgado en el RPC retiene el lock hasta que se cierra); el lease de 45s podría solaparse con un RPC muy lento en fallback; `isCheckingOut` sigue sin persistir; no hay sync general de qty entre tabs.
