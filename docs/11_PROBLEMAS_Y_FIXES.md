# Problemas conocidos, contradicciones y defensas

Última revisión: 2026-09-23

## Estado de normalización

| Tema | Clasificación actual | Resultado documental |
|---|---|---|
| Mínimo web | CANÓNICA: 4 productos surtidos | Regla resuelta; copys de “4 pares/por modelo” siguen en código como contradicción pendiente |
| Mínimo de local físico | NEGOCIO CONFIRMADO: referencia de 3 pares | Separado de la web; no trasladar a software |
| Excepción de mínimo | NEGOCIO CONFIRMADO: solo `local_deferred_pickup` | Regla resuelta; acoplamiento técnico a ubicación sigue abierto |
| Estados `picked`/`waiting` | TÉCNICA VERIFICADA: estados de ítem/columnas derivadas | Contradicción documental resuelta |
| Plazo de retiro local | CANÓNICA: 36 horas desde la comunicación de “listo” | Regla resuelta; textos activos de 24/48 horas quedan como contradicción técnica |
| “Fábrica propia” | EN EVALUACIÓN | No confirmado; no usar en textos nuevos |
| `reserved_qty` | TÉCNICA VERIFICADA en código; semántica comercial EN EVALUACIÓN | No usar como definición de reserva comercial |
| Reserva y avisos | CANÓNICA: reserva normal de 7 días; recordatorios EN EVALUACIÓN | Plazo separado de cadencia de mensajes |
| Expreso Norte/Andreani | TÉCNICA VERIFICADA en software; política EN EVALUACIÓN | Defaults técnicos no equivalen a política comercial |
| “apartado/reservado” visible | NEGOCIO CONFIRMADO: preferir “reservado” cuando sea real | Regla resuelta; textos visibles con “apartado” requieren alineación |
| Faltantes y sustituciones | NEGOCIO CONFIRMADO | Resolver con el cliente; no sustituir automáticamente; detalles legales/operativos todavía abiertos |
| Secreto en documentación | HISTÓRICA, sanitizada | Valor sustituido por nombre de variable; infraestructura no modificada |

## Detalle de contradicciones y defensas

### Cálculo de stock vendible

Estado: Documentación histórica desactualizada  
Fuente: `docs/STOCK_GOVERNANCE.md` frente a migración 330  
Última revisión: 2026-09-23

`STOCK_GOVERNANCE.md` afirma que vendible resta `reserved_qty`. La definición SQL local más reciente suma stock físico de `general` y `venta-publico` sin restarlo. Hasta resolverlo, el SQL ejecutable más reciente es la evidencia técnica, pero debe verificarse contra producción.

### Reconciliación no es dry-run puro

Estado: Texto riesgoso/desactualizado  
Fuente: `STOCK_GOVERNANCE.md`, migraciones 146 y 176  
Última revisión: 2026-09-23

La documentación describe `rpc_reconcile_stock(false)` como dry-run. Las definiciones posteriores indican que `false` controla la reparación de `reserved_qty`, mientras otras capas derivadas pueden actualizarse. No ejecutar suponiendo que es solo lectura.

### Mapa de RPCs canónicas

Estado: Desactualizado  
Fuente: `supabase/canonical/RPC_CANONICAL_MAP.md` frente a migraciones posteriores  
Última revisión: 2026-09-23

El mapa señala checkout 124 y cierre 83, pero existen redefiniciones posteriores: checkout 335 más parches 336/337 y cierre local 351. Los guards basados en ese mapa pueden validar una versión antigua.

### Impresión QZ versus GZ Agent

Estado: Documentación de arquitectura desactualizada  
Fuente: `docs/FYL-Obsidian/01-ARQUITECTURA-GENERAL.md`, README de GZ y código Next  
Última revisión: 2026-09-23

La arquitectura histórica presenta QZ Tray como activo. La implementación y documentación nuevas indican que GZ Agent lo reemplazó. Los archivos QZ deben considerarse históricos hasta confirmación operativa.

### Catálogo vanilla versus Next

Estado: README raíz desactualizado o ambiguo  
Fuente: README y `firebase.json`  
Última revisión: 2026-09-23

El README raíz presenta el catálogo vanilla como actual, mientras Firebase redirige `/`, `/index.html`, `/catalogo*` y dashboard cliente a `www.fylmoda.com.ar/catalogo`, correspondiente a la superficie Next desplegada externamente.

### WhatsApp/CRM y producción

Estado: No verificable solo con el repo  
Fuente: docs locales 67/68, archivos sin seguimiento y ausencia de `crm-events-dispatch`  
Última revisión: 2026-09-23

Las notas recientes hablan de cambios productivos. Las migraciones/funciones están sin seguimiento Git y el despachador CRM mencionado no existe en el árbol. Hace falta contrastar Supabase, cron, secrets y YCloud.

### Mínimo mayorista: productos surtidos versus pares/modelo

Estado: Regla documental resuelta; contradicción de copy todavía abierta  
Fuente: Contexto confirmado por responsable frente a metadata/`llms.txt`  
Última revisión: 2026-09-23

La regla comercial confirmada es **4 productos surtidos** para la compra web normal. La UI Next habla de 4 unidades combinables, pero otros textos dicen "desde 4 pares" y `catalogo1/public/llms.txt` afirma "4 pares por modelo". Esta última formulación contradice directamente la propuesta de surtido libre y puede inducir a clientes o agentes a una regla equivocada.

### Excepción de mínimo en retiro diferido

Estado: Diferencia entre regla comercial e implementación  
Fuente: Contexto confirmado frente a `getOrderCloseMinimumUnits`  
Última revisión: 2026-09-23

El negocio define que el mínimo general no aplica cuando la modalidad es `local_deferred_pickup`. El frontend devuelve mínimo 1 según provincia/ciudad de retiro corto, sin recibir la modalidad como argumento. Hoy ambos criterios pueden coincidir en los casos previstos, pero la implementación está acoplada a geografía y no expresa la regla empresarial de forma directa.

### Mínimo normal controlado principalmente en frontend

Estado: Defensa incompleta a verificar  
Fuente: regla empresarial confirmada, `ActiveOrderTab.tsx` y `rpc_customer_request_close`  
Última revisión: 2026-09-23

La UI impide cerrar un pedido normal con menos de 4 unidades, pero la RPC de solicitud/cierre revisada no valida ese mínimo. El checkout permite crear/acumular un pedido con menos unidades, lo cual es coherente con el flujo; el riesgo está en que una llamada directa al cierre pueda omitir la regla comercial. No se corrige en esta tarea.

### Plazo visible de retiro local

Estado: Regla comercial resuelta; textos activos contradictorios  
Fuente: Contexto confirmado por responsable frente a código Next  
Última revisión: 2026-09-23

La regla **CANÓNICA** es de 36 horas desde que un pedido de retiro local se prepara y comunica como listo. Cumplido el plazo, puede desarmarse y los productos dejan de reservarse para ese cliente.

Contradicciones activas detectadas:

- `supabase/canonical/309_local_deferred_pickup_flow.sql`: inicia el timer al primer ítem `picked`; la regla comercial lo inicia cuando el pedido completo se confirma/comunica listo.
- `nj/components/cart/ActiveOrderTab.tsx`: guía visible “Tenés 24 horas para retirarlo” y estado final de retiro con 48 horas.
- `nj/lib/transport/shipping-helpers.ts`: dos mensajes de retiro con 48 horas.
- `nj/lib/orders/customer-status-message.ts`: fallback de retiro listo con 48 horas cuando no recibe fecha calculada.
- `docs/FYL-Obsidian/49-REGLAS-UX-FLUJO-COMPRA-CLIENTE-2026-08-10.md`: referencia histórica de 48 horas, ahora marcada como superada.

Las prórrogas de 24 horas de pedidos normales y la gracia técnica posterior a `dismantle_at` son conceptos distintos y no contradicen por sí mismos el plazo de retiro local.

### `picked` y `waiting` como estados de pedido

Estado: Resuelta documentalmente; evidencia técnica conservada  
Fuente: Contexto confirmado frente a tipos y clasificación de código  
Última revisión: 2026-09-23

En la implementación actual son estados de ítem y/o columnas derivadas del Kanban, no valores canónicos de `orders.status`. La documentación de pedidos ya los separa; un agente no debe agregarlos al check de estado de pedido basándose en lenguaje operativo informal.

### Cadencia de avisos de vencimiento

Estado: Política no consolidada  
Fuente: Contexto confirmado, UI cliente y trabajo local YCloud  
Última revisión: 2026-09-23

El negocio contempló avisos a 3, 2 y 1 día y el día de vencimiento. La UI actual contiene avisos de 2/1 día, mientras el taxonomy YCloud reciente se concentra en plazo cumplido y desarme final con gracia. Falta decidir y verificar una cadencia única antes de documentarla como automatización vigente.

### Transportes con modalidad de pago no confirmada

Estado: Mapeo técnico más amplio que el contexto empresarial confirmado  
Fuente: contexto del responsable, `shipping-helpers.ts` y RPC de cierre 351  
Última revisión: 2026-09-23

El negocio confirmó contra reembolso para SEDE/MyM y transferencia para Via Cargo, Credifin, Snaider y Correo Argentino. El código también trata Expreso Norte como contra reembolso y usa transferencia/Pagado como fallback para el resto, lo que incluye Andreani. Esas condiciones adicionales deben confirmarse antes de presentarlas como política comercial.

### "Fábrica propia" no confirmada

Estado: Claim público pendiente de validación empresarial  
Fuente: metadata/copy frente a contexto confirmado  
Última revisión: 2026-09-23

El código público afirma "fábrica propia". El negocio confirma antecedentes familiares de fabricación, pero la operación actual funciona principalmente comprando a fábricas/proveedores. La característica “fábrica propia” no está confirmada y no debe reutilizarse hasta revisión comercial.

### Vocabulario interno visible al cliente

Estado: Política comercial resuelta; implementación pendiente de alinear  
Fuente: Contexto confirmado por responsable frente a textos actuales  
Última revisión: 2026-09-23

En mensajes visibles al cliente se prefiere **“reservado”** frente a **“apartado”**, siempre que exista una reserva real. En `local_deferred_pickup`, antes de preparar y comprometer stock deben usarse expresiones como “recibimos tu pedido”, “pendiente de preparación” o “estamos confirmando disponibilidad”. Después de la confirmación física sí puede comunicarse que los productos están reservados y listos.

`nj/lib/orders/customer-status-message.ts` y las migraciones 305, 307 y 315 contienen mensajes visibles con “apartados”, “apartar” o “ya apartamos”. El dashboard cliente legacy (`client/dashboard-instant.js`) también usa “si estaba apartado” al cancelar y “apartado por el administrador” en un diálogo. Se conservan sin cambios en esta etapa, pero contradicen la preferencia comercial para nuevos mensajes. Los términos “Apartados” del Kanban administrativo pueden seguir siendo lenguaje interno.

### Faltantes, cambios y sustituciones

Estado: Política principal confirmada; detalles legales y operativos pendientes  
Fuente: Contexto confirmado por responsable + flujo de alternativas en Next  
Última revisión: 2026-09-23

Ante un faltante, FyL debe contactar al cliente, identificar el producto afectado y acordar revisión, reintegro o reemplazo voluntario. No debe seleccionar una alternativa silenciosamente. Para un cambio voluntario, se quita el producto anterior y se agrega el nuevo elegido.

El código contiene `rpc_customer_replace_missing_item`: se ejecuta cuando la clienta toca una alternativa concreta en `AlternativesPanel`, reserva esa elección y cancela el faltante en una operación atómica. No se encontró un flujo que seleccione una alternativa automáticamente sin intervención del cliente. La selección se aplica directamente con ese toque y no muestra una segunda confirmación, por lo que cualquier revisión UX futura debe preservar que la elección sea inequívoca.

Contradicciones de comunicación: los mensajes actuales de faltantes son genéricos, algunos dicen “no pudimos apartar” y no siempre identifican el producto ni presentan todas las alternativas comerciales confirmadas.

### Permiso de mantenimiento diario

Estado: Riesgo señalado; confirmar en producción  
Fuente: auditoría local de WhatsApp y SQL de mantenimiento  
Última revisión: 2026-09-23

Hay indicios de que `rpc_orders_daily_maintenance` podría ser ejecutable por `authenticated` sin chequeo admin interno. Como la RPC vence pedidos y devuelve stock, hay que auditar grants efectivos y definición desplegada antes de considerarlo cerrado.

### Pruebas raíz no ejecutables o desactualizadas

Estado: Reproducido localmente  
Fuente: `npm test` y `npm run test:critical-rpcs`  
Última revisión: 2026-09-23

- `npm test` carga `test/check-config.js` con `require`, pero el paquete raíz declara `"type": "module"`; Node lo rechaza antes de ejecutar aserciones.
- El whitelist de RPCs críticas rechaza múltiples redefiniciones históricas y actuales, incluidas checkout 174/335 y cierre 351/354. El guard no representa la secuencia real del directorio canónico.

Estas fallas son independientes de los documentos creados y deben resolverse sin borrar las defensas que los tests intentan proteger.

### Documentación insegura sanitizada

Estado: Sanitizado en documentación; rotación no ejecutada  
Fuente: nota local sin seguimiento `docs/FYL-Obsidian/67-YCLOUD-WHATSAPP-AVISOS-VENCIMIENTO-2026-09-22.md`  
Última revisión: 2026-09-23

La nota contenía un valor literal identificado como secreto de webhook. Fue reemplazado por `YCLOUD_WEBHOOK_SECRET`. No se modificaron `.env`, Supabase, YCloud ni infraestructura; si la credencial seguía vigente, su rotación continúa como tarea separada.

## Incidentes y defensas que no deben retirarse

| Problema histórico | Defensa observada | Evidencia |
|---|---|---|
| Doble checkout por reintento/pestañas | Locks frontend + `operation_id` + `rpc_operations` + lock DB | Migración 174 y `nj/lib/cart` |
| Precio de carrito viejo o manipulado | `get_effective_price` en checkout | Migración 335 |
| Stock fantasma por devolución ciega | Devolver según `order_item_stock_sources` | Migración 342 y RPCs de cancelación |
| Drift de `reserved_qty` | Reconciliación y orden correcto de liberación | Migraciones 176, 246, 249, 260 |
| Pedido vencido invisible | Columna Vencido y clasificación explícita | `classification.ts` y auditorías |
| Total incorrecto por líneas/promos | Recalcular desde líneas válidas y promociones | Checkout y migraciones recientes |
| Alta admin parcial o duplicada | RPCs atómicas + idempotencia | Migración 347 y dominio admin |
| Pago queda Pendiente al cerrar | Resolución según transporte | Migración local 351 |
| Cierre vuelve a descontar stock | RPC de cierre sin descuento | Migración 83 y redefiniciones |

## Deuda de reproducibilidad

- La carpeta `supabase/canonical` contiene redefiniciones, rollbacks, pruebas y parches dinámicos; no está demostrado que pueda ejecutarse linealmente desde cero.
- `supabase/README.md` no enumera la línea completa reciente.
- `docs/CONTEXT_SUMMARY.md` y `docs/ORDER_SYSTEM_SUMMARY.md` son snapshots históricos, no autoridad vigente.
- El estado productivo debe obtenerse con dump de schema, funciones, grants, cron, Edge Functions y variables configuradas, sin exponer secretos.
