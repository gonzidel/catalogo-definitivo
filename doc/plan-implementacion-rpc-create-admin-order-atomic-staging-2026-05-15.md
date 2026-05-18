# Plan técnico — implementación staging `rpc_create_admin_order_atomic`

**Estado:** preparación controlada — **no** sustituye `createNewOrder` productivo hasta gate explícito.  
**Fecha:** 2026-05-15  
**Congela diseño:** `doc/rfc-create-admin-order-atomic-idempotency-contract-v1-2026-05-15.md`, `doc/rfc-rpc-create-admin-order-atomic-2026-05-15.md`, `doc/rfc-create-admin-order-atomic-concurrency-stress-2026-05-15.md`  
**Verificación pre-apply (ejecutar antes de SQL en staging):** `doc/pre-apply-rpc-create-admin-order-atomic-verification-2026-05-15.md`  
**RPC existentes a mantener intactas (firmas y grants):** `public.rpc_apply_order_stock_deduction` (`166_…`), `public.rpc_admin_manual_inject_and_deduct` (`179_…`).

---

## 1. Principios de implementación

1. **Staging primero:** aplicar migraciones solo en proyecto Supabase de **staging** (o branch DB dedicado); **no** ejecutar en producción FYL sin aprobación explícita y runbook (reglas workspace).
2. **Una RPC nueva** que orquesta en **una transacción** lo acordado; **no** modificar el cuerpo de `166` / `179` en la primera entrega salvo **hallazgo crítico** (preferir llamadas anidadas en la misma TX).
3. **Frontend:** flag desactivado en prod; en staging permitir llamada paralela al legacy **solo para prueba**, sin reemplazar el flujo real de operadores hasta validación.
4. **Reconcile:** `rpc_reconcile_stock` y flujos de auditoría **sin cambios**; la nueva RPC solo reduce casos patológicos, no altera contrato de reconciliación.

---

## 2. Plan incremental (fases)

**Orden de aplicación en staging:** Fase **A** (`215`) → Fase **C** (`216` helpers) → Fase **B** (`217` RPC).

### Fase A — Esquema dedupe + RLS + grants tabla

**Objetivo:** persistencia idempotencia v1 sin función pública nueva.

- Crear tabla `admin_order_create_idempotency` (nombre final alineado al contrato §6 del doc de idempotencia).
- **PK / UNIQUE** en `idempotency_key`.
- Columnas: `admin_user_id`, `payload_hash`, `status` (`pending` | `success`), `order_id`, `response_jsonb`, `created_at`, `completed_at` (según contrato congelado).
- **Índice** auxiliar por `created_at` / `completed_at` para poda futura.
- **RLS:** políticas restrictivas; acceso directo desde PostgREST **no** requerido si solo la RPC `SECURITY DEFINER` escribe (patrón típico: `REVOKE ALL` a `anon`/`authenticated` en tabla, escritura solo vía función). Validar contra políticas existentes de `orders` / admins.
- **Sin** datos de negocio sensibles extra en dedupe salvo lo necesario para hash y replay.

**Entregable:** `supabase/canonical/215_admin_order_create_idempotency_and_fyl_private.sql` + `215_ROLLBACK_admin_order_create_idempotency_and_fyl_private.sql`.

### Fase B — Función pública `rpc_create_admin_order_atomic`

**Objetivo:** RPC única testeable vía PostgREST en staging.

- `SECURITY DEFINER`, `search_path` fijo (`public`, `pg_catalog`).
- Validación admin (`auth.uid()` ∈ `admins`), `p_idempotency_key` **NOT NULL** (staging puede forzar; prod mismo criterio).
- Secuencia lógica (misma TX):
  1. Ramal **replay** si ya existe fila `success` con misma key + validación `admin_user_id` + `payload_hash` → devolver `response_jsonb`.
  2. Ramal **conflict** si `success` y hash distinto → excepción mapeable a `IDEMPOTENCY_CONFLICT`.
  3. `INSERT` fila dedupe `pending` (bloqueo competencia por key).
  4. Validaciones negocio (cliente, pedido abierto, payload ítems).
  5. `INSERT orders` + `INSERT order_items` (ids para inject).
  6. Llamada **`rpc_admin_manual_inject_and_deduct(p_items_json, p_order_id)`** con payload ya construido como hoy `order-creator`.
  7. Construir `p_items` para **`rpc_apply_order_stock_deduction`** (mismo shape que hoy `updateStockBatch`).
  8. `UPDATE` dedupe → `success`, `order_id`, `response_jsonb` serializado **idéntico** al retorno exitoso.
- **Grants:** `REVOKE ALL … FROM PUBLIC, anon`; `GRANT EXECUTE` a `authenticated` (y `service_role` si scripts internos lo requieren), coherente con `166` / `179`.

**Entregable:** `supabase/canonical/217_rpc_create_admin_order_atomic.sql` + rollback `217_ROLLBACK_rpc_create_admin_order_atomic.sql`.

### Fase C (opcional en misma release staging) — Helpers internos **no** expuestos

**Objetivo:** reducir duplicación y superficie sin tocar contrato PostgREST de `166`/`179`.

- Funciones `public._…` o `private._…` (si el proyecto usa schema `private` con grants cero): p. ej. hash canónico de `jsonb`, validación de payload espejo JS, montaje del array `p_items` para `166`.
- **`REVOKE ALL` + no `GRANT`** a roles de aplicación sobre helpers.
- **Alternativa mínima v1:** mantener lógica embebida en la RPC atómica sin helpers; extraer en C+1 si el archivo supera umbral de revisión.

**Entregable:** `supabase/canonical/216_fyl_private_admin_order_atomic_helpers.sql` + `216_ROLLBACK_fyl_private_admin_order_atomic_helpers.sql`.

### Fase D — Frontend staging (feature flag)

**Objetivo:** probar desde panel sin afectar operación real.

- Flag: p. ej. `localStorage` clave `fyl_admin_atomic_order_create` o variable de entorno inyectada en build **staging** (`window.__FYL_STAGING_FLAGS` / `import.meta.env` si hubiera bundler; en HTML plano: query `?atomicOrder=1` solo en staging deshabilitado en prod por nginx/host).
- Comportamiento: si flag **on**, botón “Crear (beta)” o misma acción con confirmación extra que llama **solo** a `rpc_create_admin_order_atomic`; si **off**, `createNewOrder` legacy sin cambios.
- **Prod:** flag **false** por defecto; ausencia de env = legacy.

**Entregable:** PR separado o segundo commit tras verde SQL en staging (no bloquea pruebas vía `curl`/Supabase dashboard).

### Fase E — Pruebas automatizadas (opcional v1.1)

- Tests SQL en carpeta de tests del repo **o** script Node con service role **solo** contra staging.
- Cobertura mínima deseada: idempotencia, stock insuficiente, `OPEN_ORDER_EXISTS`.

---

## 3. Orden exacto de migraciones (recomendado)

**Estado en repo (SQL listo para aplicar en staging, en este orden):**

| Orden | Archivo `supabase/canonical/` | Contenido |
|-------|-------------------------------|-----------|
| 1 | `215_admin_order_create_idempotency_and_fyl_private.sql` | `pgcrypto`, schema `fyl_private`, tabla `admin_order_create_idempotency`, `REVOKE` tabla. Rollback: `215_ROLLBACK_…sql`. |
| 2 | `216_fyl_private_admin_order_atomic_helpers.sql` | Helpers `fyl_private.*` (talle, hash SHA-256, califica deducción), `GRANT USAGE` schema + `EXECUTE` solo `postgres`. Rollback: `216_ROLLBACK_…sql`. |
| 3 | `217_rpc_create_admin_order_atomic.sql` | `public.rpc_create_admin_order_atomic(jsonb, uuid)` delega en **179** y **166** sin modificarlos. Rollback: `217_ROLLBACK_…sql`. |

**Nota:** si el equipo prefiere un solo archivo para staging, fusionar 215+216 con comentarios de sección claros; separar antes de merge a `main` si el diff es grande.

**Referencias de idempotencia fuerte en repo (patrones):** `171_rpc_create_public_sale_strong_idempotency.sql`, `174_rpc_checkout_cart_strong_idempotency.sql` — solo como lectura de estilo, **no** copiar ciegamente (contexto distinto).

---

## 4. Orden de locks y deadlocks (implementación)

### 4.1 Orden dentro de `rpc_create_admin_order_atomic`

1. **Inserción dedupe** (`UNIQUE(idempotency_key)`) — serializa misma clave entre sesiones.
2. Locks implícitos en `INSERT orders` / FKs (cliente, etc.).
3. **`rpc_admin_manual_inject_and_deduct`:** según `179`, bucle en orden **`(variant_id, size_raw)`** y `SELECT … FOR UPDATE` por fila VSW tras posible `INSERT … 0` on conflict.
4. **`rpc_apply_order_stock_deduction`:** según `166`, agregación y orden **`(variant_id, size_norm, warehouse_id)`** luego `FOR UPDATE`.

### 4.2 Riesgo residual (documentar en PR)

- **179** y **166** no comparten el mismo `ORDER BY` de claves (179: sin `warehouse_id` en orden explícito del bucle; 166: con `warehouse_id`). Entre **sesiones distintas** que tocan el **mismo** subconjunto de filas VSW en orden distinto puede existir **deadlock teórico** (`40P01`). Mitigación operativa: reintentos idempotentes con backoff; mitigación estructural futura: extraer paso común “lock VSW keys sorted globalmente” compartido por checkout, 166, 179 y la RPC atómica.
- **Staging:** incluir prueba de carga ligera concurrente (admin + checkout de prueba) en checklist.

### 4.3 Manejo `40P01`

- La TX completa hace **rollback** (incluye `pending` dedupe).
- Respuesta PostgREST: error PostgreSQL; el **cliente** (y documentación admin) debe reintentar con **misma** `idempotency_key` (contrato §7.4 idempotencia).
- Opcional: capturar en función y `RAISE` con mensaje código `DEADLOCK_RETRY` (RFC §8.4) si se quiere homogeneizar cuerpo JSON.

---

## 5. Rollback automático y replay

- Cualquier excepción antes del `COMMIT` del request → rollback nativo; sin pedido persistido; sin fila dedupe `success`; sin `pending` residual (misma TX).
- **Replay bit-a-bit:** persistir `response_jsonb` en el `UPDATE` a `success` en la misma TX que el stock final coherente; ramal replay lee y devuelve ese JSON sin re-ejecutar `179`/`166`.

---

## 6. Compatibilidad `166`, `179`, `rpc_reconcile_stock`

| Componente | Acción v1 staging |
|------------|-------------------|
| `rpc_apply_order_stock_deduction` | **Sin cambio** de firma o semántica; llamada desde la nueva RPC en la misma sesión TX. |
| `rpc_admin_manual_inject_and_deduct` | **Sin cambio**; idem. |
| `rpc_reconcile_stock` | **Sin cambio**; smoke tras migración: ejecutar en staging sobre dataset de prueba si existe. |
| Triggers / `stock_history` | Verificar que la nueva ruta dispara las mismas cadenas que legacy (comparar una creación legacy vs atómica en staging). |

**Encapsulación futura (no bloqueante v1):** extraer `_internal_apply_order_stock_deduction` desde el cuerpo de `166` y hacer que `166` sea thin wrapper **solo** cuando haya consenso y pruebas de no regresión; **no** obligatorio para primera versión testeable.

---

## 7. Estrategia staging — pruebas manuales obligatorias

Ejecutar en entorno **staging** con usuario admin real o de prueba; sin operadores reales en prod.

| # | Caso | Criterio de éxito |
|---|------|-------------------|
| 1 | **Happy path** pedido chico | 200, `order_id`, fila dedupe `success`, stock y `order_items` coherentes con legacy. |
| 2 | **Doble click** misma key | Un pedido; segundo 200 `replay: true`, cuerpo igual al primero. |
| 3 | **Retry** tras error negocio (stock) | Misma key tras fallo: sin fila `success` previa; segundo intento con stock corregido crea **un** pedido. |
| 4 | **Timeout simulado** post-commit | Proxy/corte cliente después de latencia artificial: reintento misma key → replay, sin duplicado. |
| 5 | **Timeout** pre-commit | Sin fila en `orders`; reintento crea pedido una vez. |
| 6 | **Replay** explícito | Llamada duplicada con misma key + payload → solo replay. |
| 7 | **Stock insuficiente** | Error claro; sin `orders`; sin dedupe `success`. |
| 8 | **Conflicto hash** misma key payload distinto | `IDEMPOTENCY_CONFLICT`; pedido original inmutable. |
| 9 | **Deadlock** | Forzar con dos sesiones SQL si es viable; o logs `40P01`; reintento misma key sin duplicado. |
|10 | **Dos admins distinta key mismo cliente** | Segundo rechazado con regla pedido abierto (comportamiento actual). |

**Herramientas:** PostgREST `POST /rpc/rpc_create_admin_order_atomic`, Supabase SQL editor, opcional `curl` con JWT admin staging.

---

## 8. Feature flag, rollout parcial, fallback

| Tema | Propuesta |
|------|-----------|
| **Flag** | Desactivado globalmente en prod; activado solo en hostname staging o query debug acordada **deshabilitada en build prod**. |
| **Rollout parcial** | Solo staff interno con flag; semanas sin tocar mayoría de usuarios admin. |
| **Fallback** | Flag off → `createNewOrder` legacy intacto; si se probó rama atómica y falla, toggle off sin redeploy (solo config) si el flag es runtime. |
| **Prod (futuro)** | Tras N pedidos beta sin incidente: opción “por defecto atómico” con flag de escape legacy durante una ventana. |

---

## 9. Checklist staging (pre-aplicar migración)

- [ ] Proyecto Supabase correcto (**staging**, no `fyl-core` prod sin checklist aprobación).
- [ ] Backup o punto restore del proyecto staging (export schema opcional).
- [ ] Revisión en PR del SQL por segundo par (locks, RLS, `search_path`).
- [ ] Contrato idempotencia v1 y RFC enlazados en descripción del PR.
- [ ] Verificación grants: `anon` sin `EXECUTE` en nueva RPC; `authenticated` admin sí.
- [ ] Smoke: una llamada RPC exitosa + una replay.
- [ ] Comparar una orden creada legacy vs atómica (stock_history, totales).

---

## 10. Checklist rollback (staging)

- [ ] `DROP FUNCTION IF EXISTS public.rpc_create_admin_order_atomic(…)` (firma exacta anotada en migración rollback).
- [ ] Opcional: `DROP` helpers `216`/`217` si existen.
- [ ] `DROP TABLE` dedupe solo si **no** hay dependencias y se acepta pérdida de filas de prueba; en staging suele ser aceptable.
- [ ] Re-ejecutar verificación de grants en `166`/`179` (no debieron mutar; si el PR los tocó por error, restaurar desde `git`).
- [ ] Confirmar PostgREST schema cache reload (Supabase redeploy / `notify pgrst` según práctica del proyecto).

**Archivo rollback en repo:** añadir `…_ROLLBACK_…sql` hermano del migración principal (patrón ya usado en Fase A grants).

---

## 11. Riesgos de implementación

| Riesgo | Severidad | Mitigación |
|--------|-----------|------------|
| Edición accidental de `166`/`179` | Alta | PR solo archivos nuevos + review explícito “no tocar 166/179”. |
| RLS dedupe mal configurado (fuga o bloqueo) | Media | Tabla solo vía SD; tests SELECT como `authenticated` vs como función. |
| Hash canónico distinto al futuro JS | Media | Especificar en PR algoritmo y tests golden vector cliente/servidor en staging. |
| Tamaño `response_jsonb` | Baja | Límite práctico pedido; truncar campos no esenciales en snapshot si hiciera falta (acordar). |
| Schema cache PostgREST desactualizado | Media | Tras `CREATE FUNCTION`, seguir runbook proyecto para reload. |
| Deadlock cruzado 179 vs 166 vs checkout | Media | Checklist §7.9 + backlog “unificar orden locks VSW”. |

---

## 12. Qué **no** hace este plan

- No despliega a **producción**.
- No reemplaza **`createNewOrder`** en el JS productivo.
- No altera **`rpc_reconcile_stock`** ni contratos de checkout cliente.

---

## 13. Próximo paso operativo

1. Abrir PR con **Fase A** (tabla + RLS) contra rama de trabajo; aplicar en **staging** únicamente.  
2. Tras verde checklist §9, PR **Fase B** (RPC).  
3. Paralelo: PR frontend flag **solo** si se desea UX de botón beta; hasta entonces basta PostgREST directo para QA.

**Referencias cruzadas:** actualizar `doc/rfc-rpc-create-admin-order-atomic-2026-05-15.md` §16 checklist con enlace a este plan cuando el PR exista.
