# Verificación crítica pre-apply — `rpc_create_admin_order_atomic` (215 / 216 / 217)

**Uso:** completar **antes** de ejecutar `215 → 216 → 217` en **staging**.  
**Producción:** no aplicar hasta gate explícito.  
**Referencias:** `supabase/canonical/217_rpc_create_admin_order_atomic.sql`, `216_…`, `215_…`, `doc/rfc-create-admin-order-atomic-idempotency-contract-v1-2026-05-15.md`.

---

## 1. Seguridad RPC (no depender solo del GRANT `authenticated`)

### 1.1 Hecho de PostgREST

- En Supabase, cualquier usuario con JWT válido entra al rol **`authenticated`** (salvo `anon`).
- Por tanto, **`GRANT EXECUTE … TO authenticated`** en una RPC pública **no** significa “solo admins del negocio”: significa “cualquier sesión autenticada **puede invocar** la función por HTTP si la API la expone”.

### 1.2 Defensa real (autorización en SQL)

La RPC **`public.rpc_create_admin_order_atomic`** es **`SECURITY DEFINER`** y valida **en este orden** (ver `217_…`):

1. `p_idempotency_key` no nulo.
2. `auth.uid()` no nulo (no anónimo).
3. **`exists (select 1 from public.admins a where a.user_id = v_uid)`** — misma familia de chequeo que **`166`** y **`179`** (`rpc_apply_order_stock_deduction`, `rpc_admin_manual_inject_and_deduct`).

**Conclusión:** la autorización **no** depende del GRANT; el GRANT solo define **quién puede intentar** llamar. Quien no esté en **`public.admins`** recibe error **antes** de insertar pedido, dedupe `success`, o tocar stock vía esta RPC.

### 1.3 `collaborator` y permisos “reales”

- La tabla **`public.admins`** incluye columna **`role`** (por defecto `'collaborator'` en migración `11_admins_and_permissions.sql`).
- Las RPC admin existentes (**179**, **166**, cancelaciones, etc.) usan **`exists (… admins where user_id = auth.uid())`**, **sin** filtrar `role` → un fila en `admins` (incluido collaborator) se considera operador del panel.
- **`217`** replica ese criterio: **no** es más permisiva que el resto del panel admin actual.

Si en el futuro se exige “solo `role = 'admin'`”, habría que alinear **217**, **166**, **179** y el resto en un cambio de producto explícito (fuera del alcance de esta verificación).

### 1.4 ¿Puede un “customer” `authenticated` crear pedidos admin?

- Un cliente B2B con sesión Supabase sigue siendo **`authenticated`**.
- Si **no** tiene fila en **`public.admins`**, la RPC falla en la comprobación de admin → **no** se crea pedido.
- **Defensa en profundidad:** aunque alguien manipule el cliente, **`179`** y **`166`** vuelven a exigir admin en la misma transacción.

### 1.5 `SECURITY DEFINER` y lectura de `admins`

- La función corre con privilegios del **owner** de la función (típicamente el rol de migraciones / `postgres`).
- La lectura de **`public.admins`** ocurre **dentro** de la función: no depende de que el caller tenga `SELECT` en `admins` vía RLS de rol `authenticated`.

### 1.6 Superficie deseada de grants (217)

- `REVOKE ALL … FROM public, anon, authenticated` y luego `GRANT EXECUTE … TO authenticated, service_role` es coherente con **179** (authenticated + service_role).
- **`anon`:** sin ejecución (correcto).

---

## 2. Idempotencia: hash `sha256(payload::text)` sobre `jsonb`

### 2.1 Implementación actual (`216` — `fyl_private.admin_order_payload_sha256`)

- Entrada: `p_payload jsonb`.
- Hash: `digest(convert_to(coalesce(p_payload::text, ''), 'UTF8'), 'sha256')` en hex.

### 2.2 ¿Es `jsonb::text` canónico y estable?

En PostgreSQL, **`jsonb`** almacena una forma **binaria normalizada** (orden de claves de objetos, eliminación de duplicados de clave en el mismo objeto, etc.). El cast **`::text`** genera una representación textual **determinista** para un mismo valor `jsonb` almacenado.

**Implicación:** dos cuerpos JSON que, una vez parseados a **`jsonb`**, son **iguales**, producen el **mismo** `::text` y el **mismo** hash. No depende del orden de claves en el string HTTP original **después** de que PostgREST / el servidor haya materializado el parámetro como `jsonb`.

### 2.3 Edge cases (riesgo de hash distinto con “mismo” negocio)

| Caso | Comportamiento típico | Riesgo replay / conflicto |
|------|------------------------|---------------------------|
| **Orden de keys en JSON crudo** | `jsonb` normaliza; mismo contenido → mismo hash | **Bajo** tras parseo a `jsonb`. |
| **`null` explícito vs clave ausente** | `{"a":null}` ≠ `{}` como `jsonb` → hash distinto | **Medio:** el cliente debe ser estable (siempre omitir o siempre enviar `null`). |
| **Arrays** | El orden de elementos importa; espacios en blanco no | **Bajo** si el orden de `items[]` es estable. |
| **Números** | `1` vs `1.0` en JSON suelen normalizarse a representación única en salida `::text` | **Bajo** en la práctica; vigilar clientes que manden floats ruidosos (`10.00` vs `10`). |
| **Campos opcionales** | Aparecer o no cambia el `jsonb` | **Medio:** mismo pedido lógico con/sin claves opcionales → **hash distinto** → primer 200 OK, segundo intento podría interpretarse como **IDEMPOTENCY_CONFLICT** si la clave es la misma y el cuerpo cambió. |
| **Strings Unicode NFC/NFD** | Si el byte string difiere, hash difiere | **Bajo** si todo es ASCII; tenerlo en mente para nombres con tildes. |

### 2.4 Retries legítimos (misma intención, misma `idempotency_key`)

- **Retry correcto:** mismo cuerpo JSON que se serializa al **mismo** `jsonb` (mismas claves y valores) → **mismo hash** → **replay** 200, sin `IDEMPOTENCY_CONFLICT`.
- **Retry incorrecto:** mismo `idempotency_key` pero el cliente **reconstruye** el JSON (omite `null`, cambia orden de arrays, redondea decimales) → hash distinto → **`IDEMPOTENCY_CONFLICT`** (comportamiento **correcto** ante ambigüedad; no es “falso” en sentido de bug, sino contrato estricto).

### 2.5 Recomendación operativa (sin cambiar SQL ahora)

- En el cliente que llame a la RPC (cuando exista): **congelar** el objeto `payload` en memoria para reintentos (timeout / `40P01`) y no regenerarlo desde DOM.
- Opcional **fase 2:** hash de un **subconjunto canónico** armado en SQL (`customer_id`, `items` normalizados) para reducir sensibilidad a metadatos; eso sería una migración nueva y revisión de contrato.

---

## 3. Checklist pre-apply (staging)

### 3.1 Validaciones (lectura / estática)

- [ ] Revisar en `217` las tres capas: `auth.uid()`, `admins`, negocio (`customer_id`, pedido abierto, ítems).
- [ ] Confirmar que **`anon`** no tiene `EXECUTE` en `217` (y en `216` no hay grants a `authenticated`).
- [ ] Confirmar que **`fyl_private`** no está en esquemas expuestos de PostgREST (por defecto solo `public` + configuración explícita).
- [ ] Releer `215`: `REVOKE ALL` sobre `admin_order_create_idempotency` para `authenticated` / `anon`.

### 3.2 Smoke tests **en staging** (post-apply; JWT real)

**A. Usuario NO admin (`authenticated` con cuenta cliente sin fila en `admins`):**

- [ ] `POST /rpc/rpc_create_admin_order_atomic` → **error** (forbidden / mensaje SQL), **sin** fila nueva en `orders`.

**B. Usuario admin (fila en `admins`):**

- [ ] Llamada feliz con `p_idempotency_key` UUID + payload válido → `ok: true`, fila dedupe `success`, pedido e ítems coherentes.
- [ ] Segunda llamada **misma** clave + **mismo** JSON → `replay: true`, mismo `order_id`.
- [ ] Tercera llamada misma clave + JSON **distinto** (p. ej. distinto `total_amount`) → **`IDEMPOTENCY_CONFLICT`**, sin segundo pedido.

**C. Idempotencia + hash (opcional SQL en staging):**

```sql
select fyl_private.admin_order_payload_sha256('{"a":1,"b":2}'::jsonb)
     = fyl_private.admin_order_payload_sha256('{"b":2,"a":1}'::jsonb) as same_hash_keys_reordered;
```

- [ ] Resultado esperado: **`true`**.

### 3.3 Grants efectivos (consultas en staging post-apply)

```sql
select p.proname, array_agg(d.privilege_type order by d.privilege_type) as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join (
  select * from information_schema.routine_privileges
  where routine_schema = 'public' and routine_name = 'rpc_create_admin_order_atomic'
) d on true
where n.nspname = 'public' and p.proname = 'rpc_create_admin_order_atomic'
group by p.proname;
```

- [ ] `authenticated` con `EXECUTE`; `anon` sin `EXECUTE` (o lista vacía para `anon`).

Comprobar helpers:

```sql
select p.proname, n.nspname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'fyl_private'
order by 1;
```

- [ ] Sin privilegios para `authenticated` en funciones `fyl_private.*` (catálogo `information_schema.routine_privileges` o `has_function_privilege('authenticated', …)` = false).

### 3.4 Rollback inmediato (ensayo en staging)

- [ ] Tras smoke mínimo, probar orden **217 → 216 → 215** rollbacks en base de **prueba** (o clonar proyecto) y verificar que `rpc_create_admin_order_atomic` desaparece y la app legacy sigue operando.

### 3.5 Schema cache / PostgREST

- [ ] Tras `CREATE FUNCTION`, ejecutar recarga: ya incluido `select pg_notify('pgrst', 'reload schema');` al final de cada migración; si el entorno no lo aplica solo, forzar **Restart** del API en dashboard Supabase o equivalente.
- [ ] Verificar que `/rest/v1/` lista la RPC o que `POST` responde (no 404 de función inexistente).

---

## 4. Orden de aplicación (solo cuando el checklist §3 esté OK)

1. `215_admin_order_create_idempotency_and_fyl_private.sql`  
2. `216_fyl_private_admin_order_atomic_helpers.sql`  
3. `217_rpc_create_admin_order_atomic.sql`  

**No producción** hasta gate explícito y runbook FYL.

---

## 5. Enlace

Plan de implementación: `doc/plan-implementacion-rpc-create-admin-order-atomic-staging-2026-05-15.md`
