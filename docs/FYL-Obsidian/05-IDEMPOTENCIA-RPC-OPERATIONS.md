# 05 — Idempotencia: `rpc_operations` y `operation_id`

> Implementación base: `supabase/canonical/169_rpc_operations_infra.sql`. Resumen alineado a comentarios en `174`, `STOCK_GOVERNANCE.md` §6.

## Tabla `public.rpc_operations`

- Registra operaciones lógicas con un **`operation_id` (UUID)** compartido entre cliente y servidor.
- Campos relevantes: `operation_kind`, `status`, `request_json`, `result_json`, `target_type`, `target_id`, `attempts`, tiempos.
- RLS: sin acceso directo desde roles típicos; la tabla es uso interno de funciones `SECURITY DEFINER`.

## Parámetros en el cliente

- **`p_operation_id`:** UUID **por intención de operación** (un click de “confirmar” = un id, reutilizar en reintentos del **mismo** click).
- **`p_request` (jsonb):** `source`, `action`, huellas (ej. `cart_fingerprint` en checkout). En `174` el backend añade `customer_id` al fingerprint lógico para no cruzar usuarios con el mismo id.

## Replay completado

- Si `rpc_operations_begin` detecta operación **ya en estado completed** con **mismo** `request` compatible, devuelve el **resultado previo** (replay) y el cliente recibe a menudo `idempotent_replay: true` en el JSON (según RPC).

## Errores frecuentes (mensajes en SQL / PostgREST)

| Código / texto | Significado | Acción típica |
|----------------|-------------|---------------|
| `conflict_in_progress` | Misma `operation_id` aún en curso. | Esperar, no duplicar; reconsultar pedido. |
| `operation_id_conflict` (o similar) | Mismo `operation_id` con **request distinto** (huella/cart cambió). | Nuevo `operation_id` o refrescar carrito. |
| Validación de null en `p_operation_id` | Cliente no envió UUID. | Corregir cliente. |

*Texto exacto depende de la función: ver cuerda `RAISE` / `errcode` en cada RPC.*

## Cómo debe llamar el frontend (patrón)

1. **Generar** un UUID (ej. `crypto.randomUUID()`) al **inicio** de la acción de usuario, no en cada reintento de *distinta* intención.
2. Reutilizar el **mismo** UUID en reintentos de red de **esa** acción.
3. Si el usuario modifica el carrito / payload, generar **nuevo** `operation_id`.
4. Incluir `p_request` con `source` y `action` estables para auditoría.

**Ejemplo (estilo checkout — ver `client/dashboard-instant.js` real):**

```js
// Esqueleto; el proyecto usa generateOperationId() y _checkoutOperationId
const operationId = _checkoutOperationId || crypto.randomUUID();
const { data, error } = await supabase.rpc("rpc_checkout_cart", {
  p_operation_id: operationId,
  p_request: { source: "dashboard", action: "checkout_cart", cart_fingerprint: "..." },
});
```

## Enlaces

- [[04-RPCS-CRITICAS]] · [[09-RUNBOOK-OPERATIVO]] (diagnóstico) · `supabase/canonical/169_rpc_operations_infra.sql`
