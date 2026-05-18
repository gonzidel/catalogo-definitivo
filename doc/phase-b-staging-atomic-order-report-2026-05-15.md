# Reporte staging — `rpc_create_admin_order_atomic` (Fase B)

**Fecha:** 2026-05-15  
**Proyecto Supabase:** `dtfznewwvsadkorxwzft` (fyl-core, staging controlado)  
**Estado:** RPC + helpers + dedupe aplicados; hotfix **218** aplicado; **sin** cambios en frontend productivo.

---

## 1. Migraciones aplicadas (orden)

| Versión MCP | Nombre |
|-------------|--------|
| 20260515125641 | `admin_order_create_idempotency_and_fyl_private` (215) |
| 20260515125652 | `fyl_private_admin_order_atomic_helpers` (216) |
| 20260515125753 | `rpc_create_admin_order_atomic` (217) |
| 20260515125909 | `fix_admin_order_payload_sha256_extensions_digest` |
| 20260515130437 | **`fix_rpc_create_admin_order_atomic_staging` (218)** |

**218** corrige sintaxis `RAISE` (sin `message` duplicado; `IDEMPOTENCY_CONFLICT` / `CUSTOMER_NOT_FOUND` / `OPEN_ORDER_EXISTS` con un solo string + `using errcode = 'P0001'`).

---

## 2. Pruebas SQL (JWT simulado `request.jwt.claim.sub`)

| Caso | Admin UID | Resultado |
|------|-----------|-----------|
| **No admin** | `582a9dc5-…` | OK — `P0001: forbidden (solo admins)` |
| **IDEMPOTENCY_CONFLICT** | `f6d58fbc-…`, key `b0000003-…`, payload distinto (`total_amount` 99999) | OK — `P0001: … IDEMPOTENCY_CONFLICT …` |
| **OPEN_ORDER_EXISTS** | `f6d58fbc-…`, cliente `582a9dc5-…` con pedido `10b22db3-…` activo | OK — `P0001: … OPEN_ORDER_EXISTS …` |
| **Stock insuficiente** | `f6d58fbc-…`, cliente sin pedido abierto, `quantity=999`, `qty_from_general=999` (split válido `g+v=q`) | OK — rollback TX: `rpc_apply_order_stock_deduction: stock insuficiente … disponible=8, solicitado=999` |
| **Replay** misma key + payload | Reconstrucción desde `order_items` | **No reprodujo replay** — hash distinto → `IDEMPOTENCY_CONFLICT` (esperado: hash estricto sobre `jsonb` serializado). Replay OK en sesión previa con **mismo JSON** byte-a-byte. |

**Post-condición dedupe:** `pending_cnt = 0` tras todas las pruebas (incl. fallo de stock).

---

## 3. Grants / superficie

- `rpc_create_admin_order_atomic`: `EXECUTE` para `authenticated`, `service_role`, `postgres` (no `anon`).
- `fyl_private.*`: **0** grants a `authenticated`.
- Tabla `admin_order_create_idempotency`: sin grants directos a `authenticated`.

---

## 4. Deuda / hallazgos menores

1. **`OPEN_ORDER_EXISTS` — formato mensaje:** en 218 el patrón `(%s)` deja una `s` literal (`…9964s`). En PL/pgSQL usar `'%', v_open_order` (placeholder `%`, no `%s`). Cosmético; no bloquea gate.
2. **Pedido de prueba accidental `A52944`** (`1037d9ec-…`, cliente `000152b0-…`): creado en un intento de test de stock con split inválido (`qty_from_general=999`, `quantity=1` → sin deducción). **Pendiente cancelar** vía `rpc_cancel_order_full` en staging si molesta operación.
3. **PostgREST HTTP:** no ejecutado (falta `FYL_POSTGREST_ADMIN_ACCESS_TOKEN` en shell). Patrón: `scripts/phase-a-verify-postgrest.mjs` → evidencia en `scripts/outputs/phase-b-atomic-order-staging-evidence.json` (pendiente).
4. **Payload mínimo en tests:** `product_name` y `price_snapshot` son NOT NULL en `order_items`; el admin real siempre los envía (`order-creator.js`).

---

## 5. Qué NO se hizo (por diseño)

- Sin cambios en `admin/order-creator.js` / `createNewOrder`.
- Sin feature flag frontend.
- Sin deploy producción separado.
- Sin pruebas paralelas HTTP / timeout-retry documentadas en JSON.

---

## 6. Siguiente paso recomendado

1. Cancelar pedido prueba `A52944` (opcional) en staging.
2. Corregir placeholder `OPEN_ORDER_EXISTS` en canónico 217/218 si se desea mensaje limpio.
3. Ejecutar PostgREST con JWT admin staging y guardar evidencia JSON.
4. Gate explícito antes de flag en panel o producción.

**Referencias:** `doc/plan-implementacion-rpc-create-admin-order-atomic-staging-2026-05-15.md`, `docs/FYL-Obsidian/35-RFC-RPC-CREATE-ADMIN-ORDER-ATOMIC-2026-05-15.md`.
