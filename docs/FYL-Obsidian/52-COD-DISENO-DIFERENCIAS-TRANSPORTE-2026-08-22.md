# COD — Diseño: Diferencias / ajustes del transporte (2026-08-22)

**Estado:** AUDITORÍA + DISEÑO. **NO implementar. NO aplicar SQL. NO tocar MAIRA / A54945 real.**

**Canvas:** `cod-diferencias-transporte-diseno.canvas.tsx`

**Relacionado:** [[42-COD-FASE6A-IRREGULARIDADES-2026-08-21]], [[43-COD-FASE6B-UNASSIGNED-POST-CONFIRM-2026-08-21]], [[45-COD-FASE6D-VOID-REMITTANCE-2026-08-21]], [[49-COD-AUDITORIA-PAGO-COMPLEMENTARIO-2026-08-22]], [[50-COD-DISENO-PAGO-COMPLEMENTARIO-2026-08-22]], [[51-COD-APPLY-PAGO-COMPLEMENTARIO-292-294-2026-08-22]]

**Evidencia live (fyl-core):** A54945 = `Pagado` · $71.900 · ORTEGA MAIRA · `sent`.  
(En el brief se habló de “Transferencia”; en DB el método es **Pagado**. La UX debe mostrar el valor real.)

---

## 0) Veredicto

**Recomendación: Opción B (refinada)** — no ampliar `cod_irregularities` para créditos sin pedido COD.

| Concepto | Dónde vive |
|---|---|
| Faltante COD (transporte debe a FyL) | `cod_irregularities` existente (`amount_diff < 0`) |
| Sobrante COD clásico (mismo pedido COD rindió de más) | `cod_irregularities` (`amount_diff > 0`) — raro hoy |
| Crédito “a favor del transporte” (pago indebido / no COD / cliente ajeno) | **Nueva** `cod_transport_adjustments` |
| Neteo contable entre ambos | **Nueva** compensación + `remaining_amount` en ambos lados |
| Completar el **mismo** pedido COD | Complementary **292–294** (sigue separado) |

Lenguaje UI (nunca solo “positivo/negativo”):

- **A reclamar** (transporte debe a FyL)
- **A favor del transporte** (FyL recibió plata que no correspondía / crédito)

---

## 1) Qué puede reutilizarse de `cod_irregularities`

### Reutilizar tal cual

- Fórmula histórica: `amount_diff = reported_amount − expected_amount`
  - `< 0` → faltante → **A reclamar**
  - `> 0` → sobrante COD → **A favor del transporte** (informativo; hoy 0 casos activos)
- FK a `remittance_row` / `remittance` / `transport` / `order`
- Statuses `open | in_review | resolved | superseded`
- RPC `rpc_cod_update_irregularity_status` (285) para ciclo de reclamo humano
- Creación automática al confirmar/asignar/corregir (280 / 286 / 287 / 294)
- Void remesa → supersede open/in_review (`remittance_voided`) vía 288/294
- Índices por `transport_id`, `status`, `order_id`
- UI listado/detalle irregularidades como **detalle de reclamos COD**

### No forzar a reutilizar

- `order_id NOT NULL` — bloquea cliente ajeno / fila sin pedido
- Semántica “reclamo” + copy de 6A — no sirve para “pago no COD”
- Universo COD (Contra Reembolso) — A54945 Pagado queda fuera
- `resolved` — hoy cierra el reclamo **sin** asiento ni neteo; no es “compensado”
- Complementary 293 — exige faltante activa del **mismo** order COD

### Extensión mínima recomendada (sin romper histórico)

Agregar:

```text
remaining_amount numeric(12,2) NOT NULL
  -- backfill open/in_review: abs(amount_diff)
  -- resolved/superseded: 0 según política (ver §7)
CHECK (remaining_amount >= 0)
CHECK (remaining_amount <= abs(amount_diff) + 0.005)
```

`amount_diff` / `expected_amount` / `reported_amount` **inmutables**.

---

## 2) Arquitectura recomendada

### Opciones evaluadas

| Opción | Idea | Veredicto |
|---|---|---|
| **A** Ampliar `cod_irregularities` | `order_id` nullable + kinds | Rechazada: contamina reclamo COD; 280/286/287/293 asumen order |
| **B** Ajustes nuevos + ref a irreg | Créditos en tabla nueva; faltantes en irreg; compensación une | **Elegida** |
| **C** Ledger unificado | Una sola tabla de movimientos | Diferir a Fase 2; migrar/duplicar verdad es costoso |

### Por qué B

1. No duplica los faltantes COD: siguen siendo la irreg.
2. Encaja movimientos **sin** `order_id`.
3. No rompe unique primary / complementary / confirm.
4. Permite `remaining` operativo ≠ monto histórico.
5. Auditoría clara: reclamo vs crédito vs compensación.

### Diagrama conceptual

```text
                    ┌─────────────────────────┐
  Confirm COD       │  cod_irregularities     │  amount_diff histórico
  (280/286/287) ──► │  remaining_amount       │  A reclamar / sobrante COD
                    └───────────┬─────────────┘
                                │
                    compensación│(mismo transport_id)
                                │
                    ┌───────────▼─────────────┐
  Clasificar fila   │ cod_transport_adjustments│  crédito (V1) / deuda manual
  no-COD / ajeno ─► │ remaining_amount         │  A favor del transporte
                    └─────────────────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │ compensations + lines   │  auditoría; no borra orígenes
                    └─────────────────────────┘
```

---

## 3) Schema mínimo

### 3.1 `cod_transport_adjustments`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `transport_id` | uuid NOT NULL | FK transports |
| `direction` | text NOT NULL | `transport_credit` \| `transport_debt` (V1: solo credit desde UX) |
| `kind` | text NOT NULL | ver kinds |
| `original_amount` | numeric(12,2) NOT NULL | `> 0` |
| `remaining_amount` | numeric(12,2) NOT NULL | `0 ≤ remaining ≤ original` |
| `status` | text NOT NULL | `open` \| `partially_compensated` \| `compensated` \| `voided` |
| `remittance_id` | uuid NULL | Preferido presente si viene de fila |
| `remittance_row_id` | uuid NULL | Unique parcial: 1 ajuste activo por fila |
| `order_id` | uuid NULL | Link informativo (Maira) — **no** implica COD |
| `customer_id` | uuid NULL | |
| `raw_name_snapshot` | text NULL | Cliente ajeno |
| `remittance_date_snapshot` | date NULL | |
| `reported_amount_snapshot` | numeric(12,2) NULL | Monto de la fila |
| `observation` | text NULL | |
| `created_by` / `created_at` | | |
| `voided_by` / `voided_at` / `void_reason` | | |
| `updated_at` | | |

**Kinds V1:**

- `paid_other_method` — pedido Pagado / no Contra Rem.
- `non_applicable_payment` — pago que no corresponde
- `order_not_found` — no hallamos pedido
- `foreign_client` — cliente ajeno a FyL
- `transport_error` — error informado por transporte
- `other`

**Índices:** transport+status, remittance_row (unique where status ≠ voided), order_id.

### 3.2 Extensión `cod_irregularities`

- `remaining_amount` (arriba)
- Opcional V1.1: status derivado de remaining — o derivar en UI/vista

### 3.3 `cod_transport_compensations`

| Columna | Notas |
|---|---|
| `id` | PK |
| `transport_id` | NOT NULL — un solo transporte |
| `total_applied` | numeric > 0 |
| `note` | text |
| `status` | `applied` \| `voided` |
| `created_by` / `created_at` | |
| `voided_*` | |

### 3.4 `cod_transport_compensation_lines`

| Columna | Notas |
|---|---|
| `compensation_id` | FK |
| `side` | `claim` \| `credit` |
| `source_type` | `irregularity` \| `adjustment` |
| `source_id` | uuid |
| `amount_applied` | > 0 |
| `remaining_before` / `remaining_after` | snapshot audit |

CHECK: suma claims = suma credits = header.total_applied.

### 3.5 Eventos

Extender CHECK de `cod_reconciliation_events.event_type`:

- `transport_adjustment_registered`
- `transport_adjustment_voided`
- `transport_compensation_applied`
- `transport_compensation_voided`

### 3.6 RLS

Mismo patrón 273: SELECT con `view`; DML solo vía RPC `edit`.

---

## 4) Relación remittance_row / order / customer

| Escenario | remittance_row | order | customer | adjustment |
|---|---|---|---|---|
| Maira Pagado + plata SEDE | Sí (origen) | Opcional link A54945 | Opcional | credit `paid_other_method` |
| Cliente ajeno $50k | Sí | NULL | NULL | credit `foreign_client` + raw_name |
| Faltante COD | Ya en irreg | Obligatorio | vía order | **No** crear adjustment |
| Complementary mismo COD | supplementary row | Mismo order | — | **No**; flujo 292–294 |

**Prohibido al registrar incongruencia:**

- UPDATE `orders.payment_method`
- Marcar pedido como Contra Rem. / COD
- `confirmed_matched` / bajar pendientes COD
- Crear alias automático
- Tratar como complementary

**Fila remesa post-clasificación (V1):**

- Preferencia: dejar `unassigned` + FK desde adjustment + badge UI “Clasificada como diferencia”.
- Evitar inventar `row_status` nuevo en V1 (CHECK costoso); evaluar en V1.1.

---

## 5) Cálculo de saldo neto

Para un `transport_id`:

```text
claim_open = Σ remaining_amount
  FROM cod_irregularities
  WHERE transport_id = T
    AND status IN ('open','in_review')
    AND amount_diff < -0.004
  + Σ remaining_amount
  FROM cod_transport_adjustments
  WHERE transport_id = T
    AND status IN ('open','partially_compensated')
    AND direction = 'transport_debt'

credit_open = Σ remaining_amount
  FROM cod_irregularities
  WHERE … amount_diff > 0.004
  + Σ remaining_amount
  FROM adjustments
  WHERE direction = 'transport_credit'
    AND status IN ('open','partially_compensated')

net = claim_open - credit_open
```

Copy UI:

| net | Texto |
|---|---|
| `> 0` | A reclamar a {transporte}: $net |
| `< 0` | A favor de {transporte}: $abs(net) |
| `≈ 0` | Saldo compensado: $0 |

Vista sugerida: `cod_v_transport_difference_balances`.

---

## 6) Modelo de compensación

### Reglas

1. Mismo `transport_id` obligatorio.
2. Solo fuentes con `remaining_amount > 0`.
3. `amount_applied ≤ remaining` por línea (revalidar bajo lock).
4. Orígenes **no** se borran; `amount_diff` / `original_amount` intactos.
5. Exacta: remainings → 0; status adjustment → `compensated`.
6. Parcial: remainings ↓; status `partially_compensated`.
7. Atómico: `SELECT … FOR UPDATE` ordenado por id.
8. Actor = `auth.uid()`; permiso `conciliacion-reembolso/edit`.
9. Nota obligatoria en cierre neto 0:  
   “Diferencias compensadas internamente; sin saldo a reclamar al transporte.”

### Pseudocódigo

```text
rpc_cod_compensate_transport_differences(
  p_transport_id,
  p_claim_lines  jsonb,  -- [{source_type, source_id, amount}]
  p_credit_lines jsonb,
  p_note text
)
```

### No es complementary

| | Complementary | Compensación |
|---|---|---|
| Pedido | Mismo order COD | Distintos hechos |
| Efecto | Suma pagos al saldo COD del pedido | Netea cuenta transporte |
| RPC | 293/294 | Nueva |
| Cambia pending COD | Sí | No |

---

## 7) Estados

### Irregularidad (existente + remaining)

| status | remaining | Lectura operativa |
|---|---|---|
| open / in_review | > 0 | Abierta a reclamar / sobrante abierto |
| open / in_review | = 0 | Compensada operativamente (badge) |
| resolved | 0 | Cerrada por operador (sin compensación) |
| superseded | 0 | Invalidada por correct/void/complementary |

**Importante:** `resolved` (285) ≠ compensada.

### Adjustment

`open → partially_compensated → compensated`  
también `→ voided`

### Compensation

`applied | voided`

---

## 8) RPCs necesarias

| RPC | Permiso | Notas |
|---|---|---|
| `rpc_cod_register_transport_adjustment` | edit | Desde fila; prefill Maira; no muta orders |
| `rpc_cod_void_transport_adjustment` | edit | Solo si remaining = original (no compensado) V1 |
| `rpc_cod_compensate_transport_differences` | edit | Neteo atómico |
| `rpc_cod_list_transport_differences` | view | Saldo + movimientos |

**No modificar firmas** de: 278, 279, 280, 285, 286, 287, 288, 290, 291, 293, 294.

---

## 9) Anular rendición origen

### V1 (conservadora — recomendada)

Si existe adjustment **no voided** ligado a filas de la remesa:

- Si `remaining_amount < original_amount` → **rechazar void** (`adjustment_already_compensated`).
- Si remaining = original → void del adjustment en la misma TX del void remesa + evento.

Irregularities: comportamiento actual 288 (supersede open/in_review).

### V1.1

Reverse de compensaciones (diferir).

---

## 10) UX

### Fila needs_review / unassigned

1. Vincular a pedido (COD)
2. Aplicar al saldo pendiente — complementary
3. **Registrar incongruencia** — nuevo
4. Dejar sin identificar

### Modal Registrar incongruencia

Tipo · Dirección · Monto · Observación.  
Si pedido no COD: prefill + CTA **REGISTRAR A FAVOR DE {TRANSPORTE}**.

### Pantalla Diferencias del transporte

Saldo A reclamar / A favor / Neto + listado con Original vs Pendiente + CTA Compensar.

---

## 11) Migraciones propuestas

Numeración **después de 294**:

| # | Contenido |
|---|---|
| 295 | Schema adjustments + remaining irreg + RLS |
| 296 | compensations + lines + event types |
| 297 | RPCs register / void adjustment |
| 298 | RPC compensate + list/balance |
| 299 | Hook void remesa ↔ adjustments |

**Apply:** solo con aprobación explícita.

---

## 12) Tests (diseño)

1. Falta $20k + crédito $20k → net 0  
2. Falta $20k + crédito $15k → claim $5k  
3. N claims + M credits  
4. Cross-transport → rechazo  
5. Doble compensación concurrente  
6. amount > remaining → rechazo  
7. Pedido Pagado → credit; order intacto  
8. Cliente ajeno sin order_id  
9. Complementary no crea adjustment  
10. Void remesa no compensado → void adjustment  
11. Void remesa compensado → bloqueo V1  
12. Corrección kind/obs + auditoría  

---

## 13) Riesgos

| Riesgo | Mitigación |
|---|---|
| Confundir compensación con complementary | CTAs/eventos/tests separados |
| Mutar amount_diff para “cerrar” | Prohibido; solo remaining |
| Duplicar faltante en adjustments | COD faltante solo irreg |
| Void remesa con crédito compensado | Bloqueo V1 |
| Copy Transferencia vs Pagado live | Mostrar payment_method real |
| resolved 285 vs compensado | Badges distintos |

---

## Fuera de alcance

- Implementación SQL / RPC / NJ  
- Apply a producción  
- Clasificar A54945 real  
- Ledger unificado tipo C  

**DETENER.**
