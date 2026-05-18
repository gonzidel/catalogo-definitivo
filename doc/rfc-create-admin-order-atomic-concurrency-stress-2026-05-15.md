# Validación arquitectónica — concurrencia y fallos (`rpc_create_admin_order_atomic`)

**Estado:** revisión conceptual de producción — **sin implementación ni SQL**.  
**Fecha:** 2026-05-15  
**Audita:** `doc/rfc-rpc-create-admin-order-atomic-2026-05-15.md`  
**Supuesto:** una función PL/pgSQL única, una transacción implícita por llamada PostgREST, aislamiento por defecto **READ COMMITTED**, reutilización de la estrategia de bloqueo de `166_rpc_apply_order_stock_deduction` (orden determinístico de filas `variant_size_warehouse_stock`).

---

## 1. Método de auditoría

Se modela el sistema como **múltiples sesiones** concurrentes (admin móvil, segundo admin, checkout cliente, jobs) que compiten por:

- filas de **stock** (`variant_size_warehouse_stock`, etc. según `166`);
- reglas de negocio **un pedido abierto por cliente** (índice único parcial o equivalente);
- tabla de **deduplicación** por `idempotency_key` (única).

Criterio de éxito: **ningún estado parcial observable** tras `COMMIT` ajeno; **ningún duplicado de pedido** ante misma intención si la política de idempotencia se cumple; **retries seguros** solo bajo contrato claro de clave y orden de operaciones internas.

---

## 2. Matriz de escenarios (simulación)

Leyenda visibilidad: **RC** = otras sesiones en READ COMMITTED no ven filas no confirmadas. **Post-commit** = visible tras `COMMIT`.

| # | Escenario | Resultado transacción | Visible a otros (RC) | Duplicado pedido | Retry / UX |
|---|-----------|------------------------|----------------------|------------------|------------|
| 1 | **Doble click** (dos POST casi simultáneos, **misma** `idempotency_key`) | Primera TX: insert dedupe + trabajo + commit. Segunda: espera o recibe violación única en dedupe → lee fila → **replay**. | Nada hasta commit del primero. | **No**, si dedupe se resuelve antes o bajo lock de clave. | Segunda respuesta: `replay: true` (idéntica a la primera). |
| 2 | **Doble click sin** `idempotency_key` | Dos TX independientes. | Cada una puede commit. | **Sí**, dos pedidos. | Retry “ciego” empeora. |
| 3 | **Refresh** tras enviar (navegador reenvía formulario) | Igual que doble click: depende de clave. | Igual. | Igual que #1 o #2. | Con clave estable en sesión: replay. |
| 4 | **Retry automático** (lib HTTP, backoff) **misma** clave | Idempotencia devuelve mismo `order_id`. | Ningún estado intermedio extra. | **No**. | UI debe tratar 200 + replay como éxito. |
| 5 | **Retry automático con clave nueva** (bug cliente) | Segunda TX crea **otro** pedido. | Dos pedidos válidos. | **Sí**. | **Peligroso**; documentar contrato: clave fija hasta confirmación en UI. |
| 6 | **Timeout después de COMMIT** | Pedido ya existe; cuerpo de respuesta puede no llegar. | Pedido visible. | Sin clave: usuario reintenta → **duplicado**. Con clave: replay → **no**. | Obligatorio persistir clave + “consultar resultado” o replay. |
| 7 | **Timeout antes de COMMIT** | Rollback total; sin pedido; **sin fila dedupe** si `pending` vive en la **misma** TX que el pedido (estrategia congelada en `doc/rfc-create-admin-order-atomic-idempotency-contract-v1-2026-05-15.md`). | Nada. | **No**. | Reintento con **misma** clave = intento limpio otra vez. |
| 8 | **Pérdida de conexión móvil** (mismo que #6/#7 según timing) | Indistinguible en cliente sin correlación. | Igual. | Mitigación = clave + replay o pantalla “mis pedidos recientes”. | UX: no generar nueva clave al reconectar si hay intento pendiente. |
| 9 | **Dos admins, mismo cliente**, dos intenciones distintas (distinta clave) | Primera TX commit pedido abierto. Segunda: violación **OPEN_ORDER_EXISTS** o `23505` en índice único. | Segunda falla limpio. | **No** (rechazo explícito). | Mensaje operativo claro. |
| 10 | **Dos admins, mismo cliente**, misma clave (comparten clipboard improbable) | Misma fila dedupe: segundo = replay del primero. | Un solo pedido. | **No**. | Raro; mismo resultado. |
| 11 | **Checkout cliente + admin** sobre mismas filas VSW | `FOR UPDATE` en `166` serializa: uno espera al otro. | Sin stock fantasma si validación+delta en misma TX. | N/A pedido admin. | Uno puede fallar por **STOCK_INSUFFICIENT** tras espera. |
| 12 | **Deadlock** (orden de locks distinto entre rutas) | Postgres aborta una TX (`40P01`). | Nada persistido en TX abortada. | **No** en TX abortada. | Retry **idempotente** con misma clave debe ser seguro. |
| 13 | **Fallo interno en inject** | Excepción → rollback orden + ítems + stock tocado en misma TX. | Nada. | **No**. | Mensaje `MANUAL_INJECT_FAILED`. |
| 14 | **Fallo interno en deduction** (después de inject OK) | Mismo rollback. | Nada. | **No**. | `STOCK_INSUFFICIENT` + detalle. |
| 15 | **Excepción después de insertar `order_items`** (cualquier paso posterior) | Rollback de **toda** la TX incluye `orders` e `order_items`. | En RC, otros no ven inserts no confirmados. | **No**. | Correcto si no hay subtransacciones con commit propio (las RPC actuales no deben autocommit al ser llamadas desde función). |
| 16 | **Replay misma `idempotency_key`, mismo payload** | `INSERT` dedupe conflict → `SELECT` → retorno almacenado. | Pedido ya existía. | **No**. | `replay: true`, cuerpo idéntico al éxito original (canon JSON). |
| 17 | **Replay misma clave, payload distinto** | Política estricta: **IDEMPOTENCY_CONFLICT** sin mutar pedido existente. | Pedido original intacto. | **No** segundo pedido. | Operador debe usar nueva clave o flujo explícito “duplicar pedido”. |

**Corrección / cierre:** la fila dedupe **`pending` en la misma transacción** que el pedido implica que un abort **no** deja huérfanos; reintento con misma clave no está bloqueado. Contrato definitivo: `doc/rfc-create-admin-order-atomic-idempotency-contract-v1-2026-05-15.md`.

---

## 3. Puntos de deadlock, locks y serialización

### 3.1 Deadlocks potenciales

- **Misma RPC, dos ítems, dos filas VSW:** mitigado si la deducción agrupa y ordena **siempre** igual que `166` (p. ej. `(variant_id, warehouse_id, size)` lexicográfico). La RPC atómica **no** debe introducir otro orden de `FOR UPDATE` distinto al de la subrutina compartida.
- **Cruce admin vs checkout:** ambos tocan subconjuntos de VSW; riesgo clásico A bloquea fila 1, B fila 2, luego cruce. Mitigación: **mismo criterio global** de ordenación de filas VSW en todo el producto que haga `FOR UPDATE` en multilinea; si checkout usa otro orden, hay riesgo residual documentado hasta alinearlo.
- **Dedupe + VSW:** si se hace `FOR UPDATE` de una fila `dedupe` y luego VSW en orden distinto a otra sesión que hace VSW luego dedupe, es posible ciclo pequeño. Mitigación: **acotar tiempo** de hold: dedupe lock muy corto, o usar **advisory xact lock** solo en `hashtextextended(idempotency_key)` **antes** de tocar VSW y liberar implícitamente al final (no sustituye orden VSW).

### 3.2 Locks “excesivos”

- **Advisory lock por `customer_id` en toda la TX:** serializa **todos** los alta-pedido de ese cliente; reduce contención de reglas de negocio pero puede **colar** innecesariamente si solo chocan en índice único. Útil si hay carreras frecuentes no capturadas por `23505`.
- **`FOR UPDATE` de muchas filas VSW** en pedido grande: bloquea checkout en esas variantes hasta commit; es **correcto** para integridad, coste aceptable si TX corta.

### 3.3 Retries peligrosos

- Retry con **nueva** `idempotency_key`.
- Retry tras **201** parcial si el cliente mal interpreta (no aplica si una sola RPC y cuerpo binario OK/error).
- Retry infinito sin backoff ante `STOCK_INSUFFICIENT` (tormenta al servidor).

### 3.4 Serialización innecesaria

- `SERIALIZABLE` en **toda** llamada de creación de pedido: suele ser **sobrekill** y aumenta aborts por serialización sin beneficio claro si la integridad ya la dan locks en VSW + unicidad dedupe.
- Reservar SERIALIZABLE solo para **fases experimentales** o subbloques muy acotados no recomendado en v1.

---

## 4. READ COMMITTED vs SERIALIZABLE

| Criterio | READ COMMITTED (por defecto) | SERIALIZABLE |
|----------|------------------------------|--------------|
| Estado parcial visible a otros | No para filas no commitadas. | Igual en cuanto a uncommitted. |
| Protección stock concurrente | Depende de `FOR UPDATE` / unicidad / checks en la misma TX. | Añade detección de anomalías de lectura; más **reintentos** `40001`. |
| Latencia / throughput | Mejor para mobile + picos. | Peor; más rollbacks. |
| Recomendación v1 | **Sí**, con locks explícitos alineados a `166`. | **No** como default de esta RPC. |

---

## 5. Advisory lock vs índice único parcial (un pedido abierto)

| Mecanismo | Ventaja | Inconveniente |
|-----------|---------|----------------|
| **Índice único parcial** (`WHERE status IN ('active', …)`) | Declarativo; fallo claro `23505` → mapear a `OPEN_ORDER_EXISTS`. | Dos TX concurrentes: una gana, otra error; puede ser ruidoso en métricas. |
| **Advisory `xact` por `customer_id`** | Ordena creaciones; reduce choque en INSERT orden. | Serialización artificial; hotspots si muchos operadores cargan el mismo cliente. |
| **Combinación** | Único parcial como verdad; advisory solo si métricas de deadlock/`23505` lo justifican. | Complejidad operativa. |

**Recomendación:** **índice único parcial** como línea base; advisory **solo** si tras pruebas de carga aparecen deadlocks o tormentas de error operativo.

---

## 6. `FOR UPDATE` en `166` y contención

- La contención es **por fila de stock** y **duración de la TX atómica**. Cuanto más largos inject + inserts + historial, más tiempo se mantienen locks en VSW.
- **Mitigación:** minimizar trabajo **entre** `FOR UPDATE` y actualización de stock; preparar datos en CPU antes de lockear; evitar llamadas externas obviamente.
- **Riesgo aceptable:** colas breves en picos (feria, cierre de día); peor que integridad rota.

---

## 7. Orden recomendado: ¿`orders` antes o después del lock de stock?

**Hecho:** inject y deduction actuales esperan `order_item_id` → hace falta tener filas `order_items` con ids reales **dentro de la misma TX**, típicamente **después** de `INSERT orders`.

**Opciones evaluadas:**

1. **INSERT `orders` + `order_items` → inject → `FOR UPDATE` VSW → deduction**  
   - Pros: encaja con contrato actual de RPC hijas.  
   - Contras: si falla muy tarde, rollback incluye todo; **no hay** estado parcial visible a otros en RC.  
   - **Recomendado para v1** siempre que las subrutinas no hagan commit implícito.

2. **Lock VSW primero (pre-validación fuerte), luego INSERT orden/ítems**  
   - Pros: menos trabajo “bajo” lock de pedido irrelevante para otros.  
   - Contras: mantener locks VSW mientras se insertan muchas filas de ítems **alarga** la ventana de bloqueo de stock frente a checkout.  
   - Útil solo si el cuello de botella es validación, no inserts.

3. **Tabla staging / ítems temporales**  
   - Evita FK a `orders` hasta el final pero añade modelo nuevo, triggers, visibilidad y limpieza. **No recomendado** para “primera RPC sin refactor masivo”.

**Conclusión:** **v1 = opción 1**, con TX lo más corta posible; documentar que “orden antes de lock VSW” no es obligatorio para integridad en RC, sí para compatibilidad con inject/deduct actuales.

---

## 8. ¿Inject como función interna no expuesta?

| Exponer `rpc_admin_manual_inject_and_deduct` solo vía wrapper | Sí como transición; el wrapper llama en misma TX. |
| Extraer **`_admin_manual_inject_core(order_id, …)`** `LANGUAGE plpgsql` sin PostgREST | **Preferible a medio plazo:** un solo punto de verdad, menos superficie `GRANT`, menos riesgo de llamada suelta fuera de TX atómica. |

**Recomendación RFC:** marcar inject como **candidato a core interno** en la misma migración o inmediatamente después, sin cambiar contrato admin público más de lo necesario.

---

## 9. Validación de propiedades deseadas

| Propiedad | ¿Se cumple con el diseño v1? | Condición |
|-----------|------------------------------|-----------|
| Ningún estado parcial **visible** (RC) | Sí | Un solo commit; sin autocommit en subrutinas. |
| Frontend sin rollback manual | Sí | Solo una RPC en el flujo feliz/error. |
| Retry seguro | Sí **si** `idempotency_key` estable y política dedupe correcta. | Ver §10. |
| Idempotencia determinística | Sí **si** respuesta replay es **byte-stable** o esquema versionado (`response_json` guardado en dedupe). | Hash payload + almacenar respuesta o `order_id` mínimo + recomputar respuesta de lectura solo si es determinístico. |

---

## 10. Idempotencia: clave obligatoria, dedupe y TTL

### 10.1 ¿`idempotency_key` obligatoria?

- **Recomendación producción:** **sí, obligatoria** (rechazar `NULL` con `VALIDATION_FAILED` o código dedicado).  
- Motivo: escenarios #6–#8 y #5; el costo de UUID en cliente es cero frente al costo de pedidos duplicados y soporte.

### 10.2 Estrategia exacta de dedupe (conceptual)

1. Al entrar, validar admin y payload.
2. **Primera escritura en dedupe:** debe participar en la misma transacción que el pedido **o** usar patrón “insert dedupe pending + commit separado” solo si se acepta complejidad de compensación (no recomendado v1).
3. Patrón v1 simple: **una TX** — al final, commit escribe pedido + fila dedupe con `order_id` + hash; si dos sesiones mismas clave, la segunda **bloquea** en unique hasta que la primera commit → luego **SELECT** y retorno replay.
4. **Hueco a cerrar en implementación futura:** si se inserta dedupe al **principio** y luego falla validación, hace falta transición `failed` o borrado en rollback para no bloquear reintentos legítimos con mismo payload. Alternativa: dedupe solo al **commit** vía constraint deferrable (concepto; sin SQL aquí).

### 10.3 Estructura mínima de tabla dedupe (campos conceptuales)

- `idempotency_key` (único)
- `admin_user_id` (quién inició; defensa ante robo de clave entre admins si se valida igualdad)
- `payload_hash` (normalizado: canonical JSON o hash estable)
- `order_id` (nullable hasta éxito, según patrón elegido)
- `created_at`, opcional `completed_at`
- Opcional: `response_jsonb` para replay **bit-identical** al cliente

### 10.4 TTL y limpieza

- Retención **90–180 días** para soporte y auditoría; job nocturno `DELETE` por antigüedad o partición por mes.
- Claves UUID nuevas por intento hacen que la tabla crezca acotada por volumen de creaciones reales, no por reintentos infinitos de la misma clave.

---

## 11. Inconsistencias de replay a vigilar

- **Respuesta recomputada** desde `order_id` vs snapshot: si el pedido fue **mutado después** por otro flujo, un “replay” que relee BD puede divergir del primer 200. **Mitigación:** guardar `response_jsonb` en commit del éxito o versionar `schema_version` en payload.
- **Misma clave, distinto admin:** si no se guarda `admin_user_id` y se valida, un replay malicioso podría… (riesgo bajo interno); igual conviene **validar** que `auth.uid()` coincide con fila dedupe en replay.

---

## 12. Flujo transaccional final recomendado (v1, conceptual)

```text
BEGIN (implícito)
  → assert admin
  → assert idempotency_key NOT NULL (recomendado)
  → si clave ya existe y hash igual → RETURN replay almacenado o reconstruido estable
  → si clave existe y hash distinto → IDEMPOTENCY_CONFLICT
  → validar cliente + reglas pedido abierto (índice / SELECT)
  → INSERT orders
  → INSERT order_items (RETURNING ids)
  → inject (core interno o RPC sin commit propio)
  → deduction con mismo orden FOR UPDATE que 166
  → registrar dedupe + payload_hash + order_id (+ response opcional)
COMMIT
```

Cualquier excepción en la cadena → **abort completo**; ningún commit parcial.

---

## 13. Cambios sugeridos al RFC (texto / contrato)

1. **§10:** sustituir “mismo resultado vacío” por la distinción **abort sin dedupe persistente** vs **replay tras commit**.
2. **§8.1:** valorar `p_idempotency_key` **sin default NULL** en contrato documental (“obligatorio en producción”).
3. **§9.1:** añadir subsección **“concurrencia misma clave”** (dos requests en vuelo) y patrón unique + segundo lee.
4. **§7:** fijar explícitamente **orden v1 = inserts antes de FOR UPDATE** por dependencia de `order_item_id`, y descartar staging en v1.
5. **§8.4:** código explícito para **`23505` open order** mapeado a `OPEN_ORDER_EXISTS` (ya sugerido; añadir deadlock `40P01` → mensaje “reintentá en unos segundos”).
6. **Nueva mini-sección:** “**Política de respuesta almacenada**” para replay determinístico.
7. **Inject:** una línea “**preferir core interno** en misma migración o siguiente”.

---

## 14. Riesgos residuales aceptables

| Riesgo | Por qué se acepta | Mitigación operativa |
|--------|-------------------|------------------------|
| Cola en VSW en picos | Integridad > velocidad absoluta | Monitoreo tiempos de RPC; pedidos razonablemente acotados. |
| Deadlock ocasional `40P01` | Cruce de rutas con distinto orden de locks si checkout no alineado | Reintento idempotente; alinear orden de locks en backlog. |
| Usuario pierde clave de idempotencia | No hay magia | UX: “pedido creado?” en listado reciente por cliente. |
| Replay relee estado mutado | Bajo si poco tiempo entre replay y edición | Snapshot en dedupe o TTL corto de “ventana de replay”. |

---

## 15. Checklist de confianza pre-producción (sin código)

- [ ] Prueba de estrés: N sesiones mismas variantes, medir `40P01` y p99 latencia.
- [ ] Prueba doble POST misma clave con herramienta tipo `k6` o Artillery (misma intención).
- [ ] Prueba timeout: proxy que corta respuesta tras commit simulado.
- [ ] Revisar orden `FOR UPDATE` en **todas** las rutas que tocan las mismas filas (checkout vs admin).
- [ ] Decisión explícita: **clave obligatoria** sí/no documentada para release.

---

**Relación:** este documento no reemplaza el RFC; lo **endurece** para implementación y pruebas. Próximo paso lógico: incorporar §13 al RFC principal y archivar esta revisión como evidencia de gate de arquitectura.
