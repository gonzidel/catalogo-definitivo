# COD — Diseño fino pago complementario (2026-08-22)

**Estado:** IMPLEMENTADO EN REPO como migraciones canónicas **292–294**.  
**NO aplicado. No producción. No tocar A54946 real.**

Archivos implementados:

- `supabase/canonical/292_cod_complementary_payments_schema.sql`
- `supabase/canonical/293_rpc_cod_approve_complementary_payment.sql`
- `supabase/canonical/294_cod_complementary_payment_financial_flow.sql`
- `supabase/canonical/tests/cod_complementary_payments_fixtures.sql`
- `nj/lib/reconciliation/phase-complementary.selftest.ts`

El apply futuro debe tratar **292 → 293 → 294** como una sola ventana y ejecutar
fixtures/verificación antes de habilitar el flujo. Esta edición solo escribe repo.

Última migración COD en prod: **291** (`cod_rev_291_normalize_match_name`).  
Propuesta de numeración canónica nueva: **292 / 293 / 294** (no tocar 272–291 históricos).

---

## 1) Momento de confirmación — OPCIÓN 2 (elegida)

| | Opción 1 | Opción 2 (elegida) |
|---|---|---|
| Click “Aplicar al saldo” | Confirma ya la fila | Solo **aprueba** |
| Efecto financiero | Inmediato | Solo en **Confirmar rendición** |
| Coherencia módulo | Rompe APROBAR≠CONFIRMAR | Respeta el principio |
| Concurrencia | Más simple en 1 RPC | Requiere patch fuerte de 280/291 |
| Rollback operativo | Anular remesa o correct | Des-aprobar / unassigned antes de confirm |

**Elegida: OPCIÓN 2** — más segura conceptualmente y alineada al resto del módulo.

Flujo:

1. `rpc_cod_approve_complementary_payment` → `approved_pending_confirmation` + `assignment_role='supplementary'` + snapshots de **saldo** (no total pedido).
2. `rpc_cod_confirm_remittance` (291) reconoce `assignment_role` y aplica lógica de saldo / irreg atómicamente.

Nombre de la RPC de etapa 1: **`rpc_cod_approve_complementary_payment`**  
(evitar “apply” si no aplica plata; el nombre anterior de auditoría queda deprecado en el diseño).

---

## 2) Firma RPC etapa 1 (final)

```sql
rpc_cod_approve_complementary_payment(
  p_remittance_id uuid,
  p_row_id uuid,
  p_order_id uuid,
  p_reason text DEFAULT NULL   -- opcional V1; recomendado no vacío en UX
) RETURNS jsonb
```

- **Sin** `p_force` en V1 (exceso siempre rechazado).
- **Sin** `matched_name_*` en firma: validación de identidad **dentro** de la RPC (mismo patrón que ya-usado: nombre/transporte; si falla → `identity_not_compatible` / `transport_mismatch` con mensaje; no overload).
- SECURITY DEFINER, `search_path` fijo, `auth.uid()`, `has_permission(...,'conciliacion-reembolso','edit')`.
- REVOKE PUBLIC/anon; GRANT authenticated + service_role.
- **No** escribe `assignment_role` desde el cliente: solo esta RPC pone `supplementary`; 279/286/287/normal siguen en `primary` (DEFAULT).

Retornos típicos:

```json
{
  "ok": true,
  "row_id": "...",
  "order_id": "...",
  "assignment_role": "supplementary",
  "row_status": "approved_pending_confirmation",
  "expected_total": 160700,
  "active_reported_total": 144000,
  "remaining_balance_before": 16700,
  "this_payment": 16700,
  "projected_remaining_after_confirm": 0,
  "financial_effect": "none_until_confirm"
}
```

Errores: `remaining_balance_not_positive`, `payment_exceeds_remaining_balance`, `no_active_faltante_irregularity`, `order_not_partially_reconciled`, `row_not_eligible`, `remittance_not_analyzed`, etc.

---

## 3) Schema mínimo

```sql
ALTER TABLE public.cod_remittance_rows
  ADD COLUMN IF NOT EXISTS assignment_role text NOT NULL DEFAULT 'primary'
  CHECK (assignment_role IN ('primary', 'supplementary'));

-- Backfill implícito por DEFAULT para filas existentes = primary.

COMMENT ON COLUMN public.cod_remittance_rows.assignment_role IS
  'primary=conciliación inicial; supplementary=pago complementario de saldo. Solo RPC complementary escribe supplementary.';
```

Opcional V1 (útil auditoría, no obligatorio):

- `balance_before_snapshot numeric(12,2)` en la fila al aprobar complementary.
- `complements_irregularity_id uuid` → irreg operativa que se prevé cerrar/reducir.

Ampliar CHECKs:

**superseded_reason** agregar:

- `complementary_payment_partial`
- `complementary_payment_reopened` (si se supersede algo en void path; preferimos create-new, no reabrir resolved)

**event_type** agregar:

- `complementary_payment_approved` (etapa 1)
- `complementary_payment_applied` (etapa 2, en confirm)
- opcional: `complementary_balance_reopened` (void supplementary)

---

## 4) Helper de saldo (canónico)

```sql
CREATE OR REPLACE FUNCTION public._cod_load_order_cod_balance(p_order_id uuid)
RETURNS TABLE (
  expected_total numeric(12,2),
  active_reported_total numeric(12,2),
  remaining_balance numeric(12,2),
  primary_count int,
  supplementary_count int,
  active_payment_count int,
  primary_row_id uuid,
  primary_remittance_id uuid
)
...
-- REVOKE ALL FROM PUBLIC, anon, authenticated
-- NO GRANT a authenticated
```

Definición única:

```
expected_total = round(orders.total_amount, 2)

active_reported_total = SUM(rr.parsed_amount)
  FROM cod_remittance_rows rr
  JOIN cod_remittances r
    ON r.id = rr.remittance_id
   AND COALESCE(r.sheet_revision,1) = COALESCE(rr.sheet_revision,1)
  WHERE rr.matched_order_id = p_order_id
    AND rr.row_status IN ('confirmed_matched','confirmed_with_irregularity')
    AND r.status <> 'voided'

-- Incluye primary + supplementary.
-- NO incluye approved_pending_confirmation (aún no es plata).
-- NO incluye void.

remaining_balance = expected_total - active_reported_total
```

**Sobre redundancia:** filtrar `r.status <> 'voided'` **no** es totalmente redundante con `row_status`: void marca filas `void`, pero el join a revisión vigente evita filas de revisiones viejas si existieran inconsistencias. Mantener ambas.  
`assignment_role` no filtra el SUM (ambos cuentan).

Usado por: approve complementary, confirm 291, void 288, UI lookup, UI irreg, tests.  
TS puede llamar un wrapper read-only RPC público liviano **más adelante** (`rpc_cod_get_order_balance`) o calcular vía select admin; la **única** definición SQL es el helper.

---

## 5) Índices

Pre-check (prod hoy, lectura): todas las confirmed activas son 1:1 order (no hay supplementary aún) → reemplazar unique es seguro tras backfill `primary`.

```sql
DROP INDEX IF EXISTS public.uq_cod_rows_matched_order_active;

CREATE UNIQUE INDEX uq_cod_rows_matched_order_primary
  ON public.cod_remittance_rows (matched_order_id)
  WHERE row_status IN ('confirmed_matched','confirmed_with_irregularity')
    AND assignment_role = 'primary';

CREATE INDEX idx_cod_rows_matched_order_confirmed
  ON public.cod_remittance_rows (matched_order_id)
  WHERE row_status IN ('confirmed_matched','confirmed_with_irregularity');
```

**Partial UNIQUE de irreg open por order:** NO en V1.  
Hoy pueden coexistir edge cases; force en RPC “una sola faltante operativa”. Datos: pocos open faltantes; 0 open sobrantes al momento del diseño. Constraint global `open/in_review` por order bloquearía futuro sobrante + faltante o dos tipos.

---

## 6) Irregularidades — semántica

### Snapshot en fila supplementary (al aprobar)

- `expected_amount_snapshot` = **remaining_balance live** al aprobar (no `orders.total_amount`).
- `parsed_amount` = pago de la planilla (inmutable).
- Check en approve: `parsed_amount <= remaining` (V1 estricto).
- Check en confirm: recompute remaining **excluding this row**; `parsed_amount <= remaining_live`; comparar también vs `expected_amount_snapshot` con tolerancia de carrera → si saldo cambió: `balance_changed_since_approval`.

### Exacto (pago = saldo)

Al confirmar:

1. Fila → `confirmed_matched`, `assignment_role` queda `supplementary`.
2. Irreg open/in_review de faltante del pedido → `resolved`.
3. `resolution_note` = texto fijo + ids rendición/fila.
4. Evento `complementary_payment_applied` con `balance_before`, `payment`, `balance_after=0`.
5. **No** crear irreg nueva.

### Parcial (pago < saldo)

Ejemplo: expected 100000; primary 20000; saldo 80000; pago 30000.

1. Fila → `confirmed_with_irregularity` (diff vs **saldo**, no vs total pedido):  
   expected_snap 80000, reported 30000, amount_diff −50000.
2. Irreg anterior → `superseded`, `superseded_reason='complementary_payment_partial'`.
3. Nueva irreg `open` en **esta** fila supplementary:  
   `expected_amount=80000`, `reported_amount=30000`, `amount_diff=-50000`  
   (= −remaining_after).
4. Una sola operativa open/in_review de faltante (enforce RPC).

**Interpretación UI:**  
`amount_diff` de la irreg operativa = −saldo_pendiente_actual.  
`reported_amount` ≠ total rendido acumulado.  
Total rendido = helper `active_reported_total`.

### Exacto vs parcial — no mutar montos históricos de la irreg original

Resolved/superseded conservan expected/reported originales (160700/144000/−16700).

---

## 7) Exceso — decisión V1

**Rechazar siempre** si `parsed_amount > remaining_balance` (approve y confirm).

- Sin `p_force`.
- Código: `payment_exceeds_remaining_balance`
- Payload: balance, reported, excess.
- Motivo: V1 solo completa faltantes; no administra sobregiros.

---

## 8) Cambios 280 / 291 (confirm)

Hoy 291 **bloquea** cualquier otra confirmed del mismo order (`order_confirmed_elsewhere`). Eso impide supplementary.

Patch en archivo **nuevo** (REPLACE de función confirm), sin editar SQL histórico 280:

Para cada fila `approved_pending_confirmation`:

### Si `assignment_role = 'primary'` (default / comportamiento actual)

- Mantener: no debe existir otra confirmed del mismo order.
- `expected_amount_snapshot` vs `orders.total_amount`.
- Diff vs total pedido → irreg como hoy.

### Si `assignment_role = 'supplementary'`

1. Debe existir **exactamente un** primary confirmed activo del mismo order (helper).
2. Lock order + primary row + irreg open/in_review del order (FOR UPDATE, UUID ASC).
3. `bal := _cod_load_order_cod_balance(order)` — el SUM **no** incluye esta fila aún.
4. Si `bal.remaining_balance <= 0` → `balance_already_settled`.
5. Si `parsed_amount > remaining` → `payment_exceeds_remaining_balance`.
6. Si `|parsed_amount - expected_amount_snapshot| >= 0.005` **o** `|remaining - expected_amount_snapshot| >= 0.005` → `balance_changed_since_approval` (carrera).
7. Confirmar fila; aplicar patrón irreg exacto/parcial (§6).
8. Evento `complementary_payment_applied`.
9. **No** usar check `live_order_total vs expected_amount_snapshot` del primary path.

Orden de filas en confirm: procesar **primaries primero**, luego supplementary (o ORDER BY `assignment_role`, `row_index`) para saldo estable dentro de la misma remesa si ambos existieran (raro en V1).

---

## 9) Cambios 287 (correct)

Al inicio, tras lock:

```
IF EXISTS (
  supplementary confirmed activas del old_order_id
) THEN
  RAISE order_has_supplementary_payments
```

Mensaje: *Este pedido tiene pagos complementarios. No puede corregirse la asignación directamente.*

Sin cascadas. Sin mover supplementary a B.

---

## 10) Cambios 288 (void)

### A) Void remesa que contiene PRIMARY con supplementary en **otras** remesas

→ `primary_has_active_supplementary_payments` — **bloquear**.

### B) Void remesa que contiene solo SUPPLEMENTARY (u otras filas no-primary de ese pedido)

1. Void filas como hoy + supersede irreg **de esas filas** open/in_review con `remittance_voided`.
2. Para cada `order_id` afectado: `bal := helper`.
3. Si `remaining_balance > 0` y no hay irreg faltante operativa open/in_review:
   - **Crear** nueva irreg `open` (no des-resolver resolved histórico).
   - Anclarla al **primary row** activo (remittance_row_id NOT NULL).
   - expected = expected_total, reported = active_reported_total, amount_diff = reported−expected (= −remaining).
   - Evento `complementary_balance_reopened` / reason en new_state.
4. Resolved históricos **intactos**.

### C) Misma remesa con PRIMARY + SUPPLEMENTARY juntos

Permitido: ambas → void; pedido sin confirmed activas → vuelve a pendientes (como void total actual). No crear irreg de “saldo reabierto” si ya no hay primary (pedido liberado al universo pending). Supersede irreg de esas filas con `remittance_voided` como hoy.

---

## 11) KPIs (queries.ts)

Hoy:

- Universo = pedidos COD.
- `loadConfirmedMeta`: Map **por `matched_order_id`** (última fila gana).
- `reconciledTotalCount` += 1 por pedido con alguna confirmed.
- `reconciledTotalAmount` += **`orders.total_amount`**, no suma de pagos.
- Pedido con primary confirmed **sale de pending**; faltante = irreg, no “pendiente de rendir”.

Con supplementary:

| KPI | Comportamiento deseado |
|---|---|
| Conciliados (count) | Distinct order con ≥1 confirmed (idealmente ≥1 **primary**) — ya casi Map; **preferir meta de primary** al construir el Map |
| Monto conciliado | Seguir con **expected del pedido** (total_amount), no sumar 144k+16.7k |
| Pending | Sin primary confirmed → pending; con primary → no pending aunque remaining>0 |
| Open irreg amount | Suma `amount_diff` de open/in_review (sigue siendo −saldo si irreg operativa es única) |

Ajuste TS mínimo: al cargar confirmed rows, si hay primary y supplementary para el mismo order, **quedarse con primary** para `rowStatus`/irreg link. Opcional: filtrar KPI count solo primary (equivalente si siempre hay primary).

---

## 12) UX

### Bloque ya vinculado

- Completo (`remaining<=0`): “Pedido completamente rendido” — sin CTA.
- Parcial: “Pedido parcialmente rendido”  
  Total / Ya rendido confirmado / Saldo / Esta fila informa / Proyección post-confirm / CTA **Aplicar al saldo pendiente**.
- Tras approve: badge “Complemento aprobado — pendiente de confirmar rendición”.
- Nunca “Elegir este” para ese order.

### Reclamos

Mostrar helper: total pedido, acumulado rendido, saldo.  
Historial: lista de pagos confirmed (fecha remesa, rol, monto).  
No usar solo `irregularity.reported_amount` como “total rendido”.

---

## 13) Migraciones propuestas (nuevas only)

| # | Contenido |
|---|---|
| **292** | `assignment_role` + backfill/default + drop/create índices + CHECK superseded_reason + event types |
| **293** | `_cod_load_order_cod_balance` + `rpc_cod_approve_complementary_payment` + grants |
| **294** | REPLACE `rpc_cod_confirm_remittance` (rama supplementary) + REPLACE 287 guard + REPLACE 288 void recalculo/guards |

App TS/UI en PR separado **después** de apply controlado.

---

## 14) Fixtures BEGIN/ROLLBACK

| ID | Caso | Esperado |
|---|---|---|
| A | Exact 160700 / 144000+16700 | remaining 0; irreg resolved; 1 primary + 1 supp |
| B | Parcial 100k / 20k+30k | remaining 50k; old superseded; new open −50k |
| C | +50k tercero | remaining 0; resolve |
| D | Exceso 16700+20000 | reject approve y/o confirm |
| E | Dos approve+confirm concurrentes mismo saldo | uno OK; otro balance_already_settled / changed |
| F | 287 correct con supp | order_has_supplementary_payments |
| G | Void solo supp | remaining reabre; nueva open; resolved viejo intacto |
| H | Void primary con supp en otra remesa | primary_has_active_supplementary_payments |
| I | Void remesa con primary+supp juntos | OK; pedido a pending |
| J | Historia montos filas intacta | 144000 y 16700 visibles |
| K | KPI distinct | 1 pedido conciliado, no 2 |

Fixture BENTANCURT-like: clonar montos en pedidos/filas de prueba; **nunca** mutar A54946 real.

---

## 15) Riesgos

| Riesgo | Mitigación |
|---|---|
| Confirm viejo sin patch | No deploy 292/293 sin 294 |
| Dos approved_pending complementary | Confirm serializa con FOR UPDATE order; 2º falla |
| expected_snap = total pedido por bug 279 | Solo RPC complementary escribe supplementary + snap saldo |
| KPI Map sobrescribe primary | Prefer primary en loader |
| Void reopen irreg mal anclada | Anclar a primary row_id |
| 286 assign unassigned a order con primary | Debe seguir `order_confirmed_elsewhere` (no complementary path) |
| Operador “Elegir este” bypass | UI + RPC normal no setea supplementary |

---

## SQL esqueleto (NO APLICAR) — helper

```sql
-- ILLUSTRATIVE ONLY
CREATE OR REPLACE FUNCTION public._cod_load_order_cod_balance(p_order_id uuid)
RETURNS TABLE (
  expected_total numeric(12,2),
  active_reported_total numeric(12,2),
  remaining_balance numeric(12,2),
  primary_count int,
  supplementary_count int,
  active_payment_count int,
  primary_row_id uuid,
  primary_remittance_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_expected numeric(12,2);
BEGIN
  SELECT round(COALESCE(o.total_amount,0)::numeric, 2)
    INTO v_expected
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  RETURN QUERY
  WITH pay AS (
    SELECT
      rr.id,
      rr.remittance_id,
      rr.assignment_role,
      round(COALESCE(rr.parsed_amount,0)::numeric, 2) AS amt
    FROM public.cod_remittance_rows rr
    JOIN public.cod_remittances r
      ON r.id = rr.remittance_id
     AND COALESCE(r.sheet_revision,1) = COALESCE(rr.sheet_revision,1)
    WHERE rr.matched_order_id = p_order_id
      AND rr.row_status IN ('confirmed_matched','confirmed_with_irregularity')
      AND r.status <> 'voided'
  )
  SELECT
    v_expected,
    COALESCE(SUM(p.amt),0)::numeric(12,2),
    (v_expected - COALESCE(SUM(p.amt),0))::numeric(12,2),
    COUNT(*) FILTER (WHERE p.assignment_role = 'primary')::int,
    COUNT(*) FILTER (WHERE p.assignment_role = 'supplementary')::int,
    COUNT(*)::int,
    (SELECT p2.id FROM pay p2 WHERE p2.assignment_role = 'primary' LIMIT 1),
    (SELECT p2.remittance_id FROM pay p2 WHERE p2.assignment_role = 'primary' LIMIT 1)
  FROM pay p;
END;
$fn$;
```

---

**STOP.** Sin apply. Sin implementación app. Siguiente paso solo con OK explícito: escribir SQL canónico 292–294 + fixtures en transacción.
