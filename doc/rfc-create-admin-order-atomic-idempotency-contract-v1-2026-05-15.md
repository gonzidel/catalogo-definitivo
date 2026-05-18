# Contrato de idempotencia v1 — `rpc_create_admin_order_atomic` (congelado)

**Estado:** decisión de arquitectura — **sin SQL**. Congela criterios antes de la primera migración.  
**Fecha:** 2026-05-15  
**Contexto:** `doc/rfc-rpc-create-admin-order-atomic-2026-05-15.md`, `doc/rfc-create-admin-order-atomic-concurrency-stress-2026-05-15.md`

---

## 1. Evaluación de las tres familias de estrategia

### 1.1 Dedupe solo al `COMMIT` (fila dedupe + pedido en un solo commit, sin fila previa)

- **Idea:** no escribir nada en dedupe hasta el final; `INSERT orders` + … + `INSERT dedupe` en el mismo commit.
- **Problema crítico:** dos sesiones con la **misma** `idempotency_key` pueden ejecutar en **paralelo** trabajo pesado (validación, locks VSW) hasta chocar muy tarde; la serialización por clave **no existe** hasta el final. Aumenta CPU, contención y ventana de error semántico (p. ej. mensajes distintos: uno `OPEN_ORDER_EXISTS`, otro éxito).
- **Veredicto v1:** **descartada** como estrategia principal.

### 1.2 Fila `pending` al inicio en **transacción distinta** (dos fases)

- **Idea:** `COMMIT` de dedupe `pending` antes del trabajo principal.
- **Problema:** si el proceso muere después, queda `pending` eterno → bloquea reintentos con la misma clave o exige **TTL + cron** y estado `FAILED` para desbloquear. Más operación y edge cases.
- **Veredicto v1:** **descartada** salvo futuro patrón “async job” fuera de esta RPC.

### 1.3 Híbrida transaccional (recomendada) — `pending` al inicio **dentro de la misma TX** que el pedido

- **Idea:** al abrir el trabajo de la RPC (una sola transacción servidor), insertar fila dedupe en estado **`pending`**; al finalizar con éxito, **`UPDATE`** a `success` rellenando `order_id`, `response_jsonb`, `payload_hash` confirmado; `COMMIT` único.
- **Abort / deadlock / error de negocio:** `ROLLBACK` elimina **también** la fila `pending` → **no hay huérfanos**, no hace falta cron de limpieza para integridad de reintentos.
- **Dos requests simultáneos misma clave:** el segundo **bloquea** en el `INSERT` de clave única hasta que el primero hace `COMMIT` o `ROLLBACK`; tras `COMMIT` del primero, el segundo recibe violación de unicidad → ramal **replay** (lectura de fila `success`). Tras `ROLLBACK` del primero, el segundo puede proseguir con su propio trabajo.
- **Veredicto v1:** **elegida**.

---

## 2. Objetivos operativos cubiertos

| Caso | Comportamiento con híbrida transaccional |
|------|-------------------------------------------|
| Timeout **post-**`COMMIT` | Pedido y fila `success` existen. Reintento con misma clave → **replay** con cuerpo almacenado (o equivalente estable). Sin segundo pedido. |
| Timeout **pre-**`COMMIT` | Rollback: sin pedido, sin fila dedupe. Reintento con misma clave → nuevo intento completo. Un solo pedido posible. |
| Retry automático | Misma clave: idempotente. Clave nueva: nuevo pedido (riesgo documentado en cliente). |
| Replay | `success` + `response_jsonb` devuelto tal cual (recomendado). |
| Doble click / refresh | Segundo request bloquea o choca en unique → replay. |
| Reconexión móvil | Indistinguible de timeout; depende de clave persistente en cliente hasta confirmación UX. |

---

## 3. Análisis punto por punto

### 3.1 Conexión muere **después** de `COMMIT`

- En servidor el resultado es **persistente**: `orders`, `order_items`, stock, fila dedupe `success` con `response_jsonb`.
- El cliente ve timeout o TCP reset. **Acción:** reintentar con la **misma** `idempotency_key` y el **mismo** payload → servidor devuelve **replay** (HTTP 200 con cuerpo idéntico al almacenado). UI = éxito.
- Sin reintento: el pedido existe; el operador puede verlo en listado (comportamiento aceptable).

### 3.2 Conexión muere **antes** de `COMMIT`

- Efecto servidor: rollback completo (incluye `pending`).
- **Acción:** reintento con misma clave = nuevo trabajo; debe resultar en **un** pedido si las reglas de negocio siguen permitiendo la creación.
- No queda basura dedupe que impida el reintento.

### 3.3 Dos requests simultáneos, **misma** key

- Primera TX: `INSERT pending` OK.
- Segunda TX: `INSERT` misma key → **espera** (bloqueo de unicidad) hasta fin de la primera.
- Primera hace `COMMIT` → dedupe `success`.
- Segunda: al reintentar insert (según implementación: `INSERT` falla) → capturar conflicto → `SELECT` por key → si `success` y `payload_hash` coincide → **replay**; si hash distinto → **IDEMPOTENCY_CONFLICT**.

### 3.4 Misma key + **distinto** payload

- Primera TX ya en `success` con hash H1.
- Segunda llega con hash H2: **no** crear pedido; respuesta **`IDEMPOTENCY_CONFLICT`** (código de negocio documentado). Cuerpo de error incluye `order_id` existente (opcional) para soporte.

### 3.5 Locks VSW + retries tras `40P01`

- Deadlock aborta **toda** la TX → desaparece `pending`.
- Reintento con **misma** clave: comportamiento idéntico a 3.2 → seguro.
- Cliente: backoff + jitter; no cambiar clave en reintentos por deadlock.

---

## 4. Patrón congelado (equivalente al esquema que pediste)

```text
BEGIN  (implícito en la función / request PostgREST)
  → validar admin + payload + idempotency_key obligatoria
  → calcular payload_hash_canonical
  → INSERT fila dedupe (status = pending, key, hash, admin_user_id, …)
       — si conflicto: manejar como “otra sesión” / replay / conflict (ver §6)
  → INSERT orders + order_items + inject + deduction
  → UPDATE dedupe SET status = success, order_id = …, response_jsonb = …, completed_at = now()
COMMIT
```

La fila **`pending` no es visible** a otras sesiones en READ COMMITTED hasta `COMMIT`; aun así, el **índice único** sobre `idempotency_key` serializa a los competidores por la misma clave. No se requiere “limpieza” de `pending` tras abort: el rollback lo borra.

---

## 5. Respuestas a las preguntas explícitas

| Pregunta | Respuesta v1 |
|----------|----------------|
| ¿`pending` en la misma TX evita cleanup huérfano? | **Sí.** Rollback borra `pending`. |
| ¿`ON CONFLICT` basta? | **Casi:** hace falta lógica explícita post-conflicto: **replay** si `success` + mismo hash; **conflict** si hash distinto; si la otra TX aún no commitió, el bloqueo ya ordenó la llegada. La implementación puede usar `ON CONFLICT` o `INSERT` + excepción `23505` + `SELECT` — decisión de codificación, no de arquitectura. |
| ¿Hace falta estado `FAILED`? | **No** para corrección de reintentos en v1 con una sola TX. Opcional **más adelante** solo para auditoría si se introduce logging fuera de transacción o jobs async. |
| ¿Hace falta TTL? | **No** para integridad de la RPC. **Sí recomendado** para retención/PII y tamaño de tabla (ver §7.4). |
| ¿Hace falta cron cleanup? | **No** para huérfanos `pending`. **Sí** para **poda** de filas `success` antiguas (operación, no corrección). |

---

## 6. Diseño final: tabla dedupe (conceptual)

**Nombre tentativo:** `admin_order_create_idempotency` (ajustable en implementación).

### 6.1 Columnas mínimas

| Campo (conceptual) | Rol |
|--------------------|-----|
| `idempotency_key` | UUID; **PK** o **UNIQUE** global. |
| `admin_user_id` | `auth.uid()` al crear; en **replay** debe coincidir con el solicitante (si no → `FORBIDDEN` o `IDEMPOTENCY_CONFLICT` según política; **recomendación:** exigir mismo admin). |
| `payload_hash` | Hash estable del payload canónico (ver §6.4). |
| `status` | `pending` \| `success` (enum/texto acotado). No `failed` en v1. |
| `order_id` | Nullable en `pending`; NOT NULL al pasar a `success`. |
| `response_jsonb` | Nullable en `pending`; NOT NULL al `success` si se adopta replay bit-a-bit (recomendado). |
| `created_at` | Inicio intento. |
| `completed_at` | Solo en `success`. |

### 6.2 Índices y restricciones

- **UNIQUE** (o PK) sobre **`idempotency_key`**.
- Índice por **`completed_at`** o **`created_at`** para **cron de poda** (rango por antigüedad).
- Opcional: índice `(admin_user_id, created_at)` para soporte / panel interno.

### 6.3 Estrategia `payload_hash`

- **Entrada:** `p_payload` JSONB en el orden que envía PostgREST.
- **Canonicaización antes de hash:** reglas fijas (documento de implementación futura): ordenar claves de objetos anidados de un solo nivel o profundidad acordada; normalizar strings (`trim`, NFC si aplica); números en formato decimal fijo para importes si hay ambigüedad JSON.
- **Algoritmo:** SHA-256 (o SHA-256 de bytes UTF-8 del texto canónico) → string hex fijo.
- **Objetivo:** dos payloads semánticamente iguales → mismo hash; cambio mínimo → hash distinto → `IDEMPOTENCY_CONFLICT` con misma key.

### 6.4 Replay: respuesta exacta

- **Recomendación congelada:** al pasar a `success`, persistir **`response_jsonb`** con el **mismo** JSON que devolvería la RPC en el primer 200 OK.
- Replays posteriores: **devolver ese blob** sin releer pedido para armar respuesta (evita divergencia si hubo ediciones posteriores al pedido).
- Incluir en respuesta campos ya previstos en RFC: `ok`, `order_id`, `order_items`, `stock`, `idempotency.replay: true`.

---

## 7. Comportamiento exacto (contrato)

### 7.1 Replay determinístico

- Misma `idempotency_key`, mismo `payload_hash` que fila `success` → HTTP 200, cuerpo = `response_jsonb` almacenado + `idempotency.replay: true`.
- No se vuelve a ejecutar inject ni deduction.

### 7.2 Retry seguro

- Misma clave tras abort (timeout pre-commit, `40P01`, error de negocio): **nuevo** intento completo permitido.
- Misma clave tras éxito: **solo** replay.

### 7.3 Respuesta tras timeout post-commit

- Indistinguible en red de fallo; **único** mecanismo seguro: **reintento con misma clave** → replay 200.

### 7.4 `DEADLOCK_RETRY` / `40P01`

- Mapear a mensaje operativo acordado (RFC §8.4).
- Cliente: reintentar con **misma** clave, backoff, máximo N intentos; no regenerar UUID.

---

## 8. Decisión final recomendada (resumen ejecutivo)

**Adoptar la híbrida transaccional:** `INSERT pending` al inicio del cuerpo de la RPC, mismo `BEGIN`/`COMMIT` que el pedido y el stock; `UPDATE success` con `response_jsonb` antes del commit final.

**`p_idempotency_key`:** obligatoria en producción.

**Estado `FAILED` y dedupe al commit puro:** no necesarios en v1.

**TTL + cron:** recomendados para **retención** (p. ej. 180 días de filas `success`), no para corregir aborts.

---

## 9. Tradeoffs

| Ventaja | Coste |
|---------|--------|
| Serialización por clave sin trabajo duplicado | Segundo request espera hasta fin de la primera (aceptable). |
| Sin huérfanos `pending` | Longitud de TX incluye fila dedupe (despreciable frente a VSW). |
| Replay bit-a-bit | Almacenamiento extra en BD por creación; límite tamaño JSON respuesta. |
| Mismo admin en replay | Clave “robada” entre admins no replayea (comportamiento deseable). |

---

## 10. Riesgos residuales aceptables

- **Hash canónico defectuoso en v1:** dos payloads equivalentes con hash distinto → falso `IDEMPOTENCY_CONFLICT`; mitigación = pruebas de propiedad en payload real del admin.
- **Cliente pierde la clave:** no hay replay; operador usa listado; riesgo operativo UX.
- **Respuesta almacenada grande:** pedidos enormes → vigilar límite práctico PostgREST; opción futura: almacenar solo `order_id` + versión de esquema y reconstruir si se acepta riesgo de divergencia.

---

## 11. Contrato definitivo de idempotencia (para frontend y OpenAPI interno)

1. El cliente **debe** enviar `p_idempotency_key` (UUID v4 recomendado) **por intento de creación**; generada al confirmar (no en cada tecla).
2. El cliente **debe** conservar esa clave hasta recibir **200** con `ok: true` **o** error de negocio definitivo (`STOCK_INSUFFICIENT`, `OPEN_ORDER_EXISTS`, etc.); no rotar clave en reintentos por red o `40P01`.
3. El servidor **garantiza:** como máximo **un** pedido creado por par `(idempotency_key)` exitoso; replays devuelven el mismo resultado almacenado si el hash coincide.
4. El servidor **garantiza:** misma clave y distinto payload semántico → error `IDEMPOTENCY_CONFLICT`, sin mutar el pedido existente.
5. El servidor **garantiza:** tras cualquier fallo previo a commit, reintento con misma clave es equivalente a primer intento (sin estado dedupe residual).
6. PostgREST: respuestas de replay son **200** (no 409), con `replay: true` en cuerpo, salvo que en versión futura se opte por 409 en conflict de hash (no recomendado para UX admin móvil).

---

## 12. Relación con documentos previos

- Sustituye la ambigüedad del doc de estrés §10.2 (“dedupe al final vs inicio”) por la decisión **pending-in-TX**.
- El RFC principal debe tratarse como **alineado** a este contrato en §9; cualquier divergencia futura se resuelve a favor de **este** archivo para idempotencia v1.
- **Implementación controlada (staging):** `doc/plan-implementacion-rpc-create-admin-order-atomic-staging-2026-05-15.md`.
