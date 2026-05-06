# 26 - Auditoria modulo Estadisticas (Dashboard Admin)

Estado: auditoria original + registro de evolucion del modulo Metrics v2 (RPCs nuevas, reposicion, compras).
Fecha inicio: 2026-05-05. Ultima actualizacion vault: 2026-05-05.
Modulo: Estadisticas / KPIs / series temporales.

## 1. Alcance

Archivos revisados:

- `admin/statistics.html` (estructura y definicion de secciones)
- `admin/statistics.js` (frontend: invocacion de RPCs, construccion de fechas, render de KPIs/graficos)
- `supabase/canonical/42_statistics_rpc.sql` (RPCs usadas por el dashboard)

RPCs usadas directamente por `admin/statistics.js`:

- `get_dashboard_kpis`
- `get_customer_kpis`
- `get_sales_timeseries`
- `get_customer_timeseries`
- `get_top_skus`
- `get_top_products`
- `get_top_categories`
- `get_order_source_breakdown`
- `get_customer_registration_methods`

## 2. Hallazgos clave (tecnicos)

### 2.1 Sobreconteo por joins (causa principal de KPIs inviables)

En `public.get_dashboard_kpis`:

- Para KPIs de envios/publico se hace `LEFT JOIN` entre `orders`/`public_sales` y sus `*_items`.
- Luego se calculan `sum(o.total_amount)` y `count(*)` al nivel del join.
- Si un pedido tiene N items, el pedido se replica N veces en el resultset, inflando:
  - pedidos (count)
  - ticket promedio (venta/pedidos)
  - revenue total
  - unidades/totales que dependan del mismo set

En `public.get_sales_timeseries` ocurre el mismo patron:

- se agrupa por dia/semana/mes, pero el conjunto proviene de joins con `order_items` / `public_sale_items`.
- cuando el revenue/pedidos se computan sobre ese nivel de join, el resultado queda multiplicado.

Tambien afecta KPIs de carritos:

- `carts_created` usa `LEFT JOIN cart_items` y `count(*)` -> un carrito con items cuenta multiple veces.

### 2.2 Problema sistematico de timezone y cortes diarios

En `admin/statistics.js`:

- el frontend construye `currentFrom/currentTo` agregando sufijo `Z` (UTC) a una fecha seleccionada por el usuario.
- backend `get_sales_timeseries` y `get_customer_timeseries` bucketizan usando:
  - `AT TIME ZONE 'America/Argentina/Cordoba'`
- si los limites enviados no representan correctamente el rango local, los dias/semana/mes del grafico y KPIs no coinciden con la percepcion del usuario.

### 2.3 Definicion operacional ambigua de “envios” vs “retiro/local”

El dashboard implementa el “canal” asi:

- `envios` = `orders` con `status = 'sent'` (y usualmente `sent_at is not null`)
- `publico` = `public_sales`

No existe una dimension explicita de:

- `delivery` vs `pickup` vs `retiro local`

Si el negocio necesita distinguirlo, debe modelarse (o inferirse de manera auditable desde columnas/relaciones reales), no solo por el origen de la tabla.

### 2.4 Clientes nuevos vs recurrentes: mezcla de universos y definicion incompleta

En `get_customer_kpis`:

- “clientes nuevos” se cuenta sobre `public.customers.created_at`
- “clientes que volvieron” se basa en primera compra minima combinando:
  - `orders` (sent)
  - `public_sales` (created_at)
- Esto puede fallar si:
  - no hay unificacion garantizada entre `customers` y `public_sales_customers`
  - o si el “link” existe pero no se usa para resolver una identidad canonica

Resultado: la interpretacion comercial puede ser correcta o no, pero no es fiable como “una sola métrica de adquisicion y retencion” sin unificar identidad.

## 3. Riesgos de negocio derivados

- Sobreconteo de pedidos -> decisiones de performance (tasa de conversión diaria, frecuencia, estacionalidad) quedan distorsionadas.
- Sobreconteo de revenue -> margen/ticket y comparaciones por periodo pierden validez.
- timezone -> al revisar “ayer/hoy” se reportan valores movidos entre dias.
- “envio vs retiro/local” no medible con precision operativa: se toman acciones sin saber el verdadero driver logístico.

## 4. Cambios propuestos (sin implementar en este documento)

### 4.1 Fix de SQL: separar agregaciones antes de unir items

Regla general para `orders` y `public_sales`:

- calcular revenue/pedidos al nivel de documento (`orders.id` o `public_sales.id`) SIN join que multiplique filas.
- calcular unidades/margen usando `order_items` / `public_sale_items`, pero:
  - agregando por `order_id` primero, o
  - sumando en CTEs separadas y luego combinando con `orders`/`public_sales` ya agregados.

Para carritos:

- evitar `count(*)` sobre un join con `cart_items`; usar `count(distinct c.id)` o una query solo contra `carts`.

### 4.2 Contrato de timezone unico

Opciones recomendadas:

- backend recibe `p_from_local_date` y `p_to_local_date` como `date`, y convierte a `timestamptz` internamente de forma consistente con `America/Argentina/Cordoba`.
- o frontend envía `p_from/p_to` como timestamps UTC calculados con la misma conversion que espera el backend.

### 4.3 Modelado / dimension de fulfillment

Agregar campos (o usar existentes) para distinguir:

- delivery vs pickup vs retiro/local

Idealmente:

- un campo en `orders` (ej. `fulfillment_type`)
- y que el dashboard use esa dimension (no solo “tabla origen”).

### 4.4 Unificar identidad de cliente para KPIs de adquisicion/retencion

Definir una “identidad canonica”:

- o bien usar solo `customers` como verdad (si todo pedido B2B se asocia a `customers.id`)
- o bien una tabla puente / link consistente con `public_sales_customers`.

## 5. Evidencia tecnica (puntos de referencia)

- `admin/statistics.js`:
  - construccion de rango con `Z` (UTC) y render por RPCs
  - invocacion: `get_dashboard_kpis`, `get_customer_kpis`, `get_sales_timeseries`, `get_customer_timeseries`, etc.
- `supabase/canonical/42_statistics_rpc.sql`:
  - `get_dashboard_kpis`: joins con items + `count(*)/sum(total_amount)`
  - `get_sales_timeseries`: joins con items + agregaciones con bucket por dia/semana/mes
  - `get_customer_kpis` y `get_customer_timeseries`: definiciones de nuevos/recurrentes con mezcla de universos

## 6. Estado del vault

Al revisar el vault no se encontro un documento especifico para “Auditoria modulo Estadisticas” previo a este.

## 7. Actualizacion RPC metrics_dashboard (2026-05-05)

Se creo la RPC canónica `public.metrics_dashboard(p_from date, p_to date)` en:

- `supabase/canonical/200_metrics_dashboard_rpc.sql`

Objetivo:

- consolidar métricas de negocio/operacion/producto/comportamiento en backend
- evitar sobreconteos por joins
- unificar corte temporal con `America/Argentina/Cordoba`

### Ajustes aplicados sobre la primera version

1. **Apartado**
   - Se removio el uso de `closing_soon` como proxy.
   - Se paso a definición operacional real: pedido con items operacionales todos en `picked`, sin `reserved/waiting/missing`, y fuera de estados finales.

2. **Cancelado**
   - Se removio el uso de `expired` como cancelado.
   - Se usa `orders.status = 'cancelled'` cuando exista, y además pedidos con al menos un `order_items.status = 'cancelled'` (flujo operativo real FYL).

3. **Clientes nuevos**
   - `first_purchase` quedó calculado sobre **toda** la tabla `orders` con `status='sent'`.
   - Clasificación nuevo/recurrente se hace contra el rango analizado, pero con historia completa.

4. **Tiempo promedio de cierre**
   - Se cambio de `(closed_at - sent_at)` a `(sent_at - created_at)` en horas, según definición pedida.

5. **Estados del flujo FYL validados**
   - `active`, `picked` (apartado operacional), `closed`, `sent`, `devolución`, `stock_pending` y cancelación por ítem.

### Nota de consistencia funcional

La RPC mantiene estructura general (CTEs por bloque + resultado JSON único), pero corrige la lógica para alinear métricas con operación real del sistema FYL.

## 8. Evolucion dashboard v2 y alertas (2026-05-05)

### 8.1 Frontend nuevo de métricas (v2)

Se creó frontend limpio y desacoplado en:

- `admin/metrics_v2.html`
- `admin/metrics_v2.js`

Características base:

- consumo RPC backend (sin lógica de negocio en frontend)
- secciones: Negocio, Operación, Producto, Comportamiento
- filtros de fecha (`p_from`, `p_to`)
- cards KPI mobile-first + tablas simples

### 8.2 Mejoras UX + alertas base

Se incorporó en `metrics_v2`:

- KPI principal visual (`Ventas Netas`) con clase `primary`
- contexto de fecha visible (“Mostrando datos del DD/MM al DD/MM”)
- tabs horizontales para mobile (scroll x)
- skeleton loading
- mensajes vacíos más claros
- bloque de alertas `#metrics-alerts`

Alertas base iniciales:

- alta cancelación
- devoluciones elevadas
- sin ventas
- bajo volumen
- ticket bajo

### 8.3 RPC comparativa (sin tocar la canónica)

Se creó:

- `supabase/canonical/201_metrics_dashboard_compare_rpc.sql`

RPC:

- `public.metrics_dashboard_compare(p_from date, p_to date)`

Salida:

- `{ current: <metrics_dashboard>, previous: <metrics_dashboard> }`

Lógica:

- wrapper sobre `public.metrics_dashboard(...)` (reutiliza definición canónica)
- periodo previo calculado desde `p_from/p_to` (misma duración)

### 8.4 Alertas comparativas en frontend

Se actualizó `admin/metrics_v2.js`:

- nueva función `percentageChange(current, previous)`
- nueva función `generateComparativeAlerts(current, previous)`

Reglas:

- caída de ventas > 20%
- suba de cancelaciones > 30%
- caída de pedidos > 20%
- ticket en baja > 15%
- menos clientes nuevos > 20%
- crecimiento fuerte > 30%

Render:

- mezcla de alertas base + comparativas
- máximo 4
- orden por prioridad (críticas > advertencias > positivas)

### 8.5 RPC de alertas avanzadas de producto

Se creó:

- `supabase/canonical/202_metrics_product_alerts_rpc.sql`

RPC:

- `public.metrics_product_alerts(p_from date, p_to date)`

Salida JSON (estructura fija):

- `stock_critico`
- `talles_criticos`
- `productos_dominantes`
- `productos_lentos`
- `productos_tendencia`

### 8.6 Optimización profesional de alertas de producto

Se eliminó lógica arbitraria y se llevó a métricas de inventario accionables:

1. **Stock crítico**
   - `ventas_diarias = units / dias`
   - `cobertura = stock_total / ventas_diarias`
   - criterio: `cobertura < 3`

2. **Talles críticos**
   - misma lógica de cobertura pero por `variant + size`

3. **Productos lentos**
   - `rotacion = units / stock_total`
   - criterio: `rotacion < 0.1`

4. **Productos tendencia**
   - criterio de crecimiento real:
     - `prev > 50000`
     - `growth_percent > 30`

5. **Nuevo producto con tracción**
   - dentro de `productos_tendencia`:
     - `prev = 0`
     - `current > umbral` (definido en SQL)

6. **Campos agregados en listas de salida**
   - `stock_total`
   - `units`
   - `cobertura`
   - `rotacion`
   - `growth_percent`

### 8.7 Prioridad final de alertas en UI

`metrics_v2.js` quedó con prioridad:

1. alertas de producto
2. alertas comparativas
3. alertas básicas

Mostrando máximo 4 y ocultando bloque cuando no hay alertas.

## 9. Reposicion, efectividad y aprendizaje (metrics_replenishment)

### 9.1 RPC de reposicion

Archivo:

- `supabase/canonical/203_metrics_replenishment_rpc.sql`

RPC:

- `public.metrics_replenishment(p_from date, p_to date)`

Salida JSON (estructura fija):

- `reposicion_urgente`
- `reposicion_media`
- `sobrestock`

Notas de modelo (calibrado B2B calzado FYL):

- demanda diaria desde ventas `sent` en el rango, stock agregado por producto (variant_size + variant_warehouse)
- `lead_time_dias` dinamico segun `ventas_diarias`
- `safety_stock = ventas_diarias * sqrt(lead_time_dias)`
- `reorder_point` ajustado por factor de `replenishment_learning` (ver 9.3)
- campos utiles: `reorder_point`, `safety_stock`, `score_reposicion`, `sell_through`, `impacto_alto`, `factor_aplicado`

### 9.2 RPC de efectividad de reposicion

Archivo:

- `supabase/canonical/204_metrics_replenishment_effectiveness_rpc.sql`

RPC:

- `public.metrics_replenishment_effectiveness(p_from date, p_to date)`

Salida JSON (entre otros):

- `productos_repuestos`, `reposicion_efectiva`, `reposicion_ineficiente`, `quiebres_no_evitatados`
- `ajustes_modelo` (sugerencias de ajuste del modelo)

Persistencia de aprendizaje:

- inserta en `replenishment_learning` solo si hay robustez (p. ej. 2 eventos consecutivos del mismo tipo o cambio significativo > 20%), para limitar oscilaciones.

### 9.3 Tabla replenishment_learning

Archivo:

- `supabase/canonical/205_replenishment_learning_table.sql`

Tabla:

- `public.replenishment_learning`
- campos: `product_id`, `factor_ajuste`, `tipo_ajuste`, `motivo`, `created_at`, `activo`
- `metrics_replenishment` aplica el factor activo al `reorder_point` (con limites y suavizado definidos en SQL).

### 9.4 Frontend (insights de reposicion)

En `admin/metrics_v2.js` / `admin/metrics_v2.html`:

- `generateReplenishmentInsights` + alertas mezcladas en `renderAlerts` (prioridad alta)
- bloque **Feedback de Reposicion** (`generateReplenishmentFeedback` + `metrics_replenishment_effectiveness`)
- bloque **Aprendizaje del sistema** (`generateLearningAdjustments` sobre `ajustes_modelo`)

## 10. Plan de compra semanal

### 10.1 RPC

Archivo:

- `supabase/canonical/206_metrics_weekly_purchase_plan_rpc.sql`

RPC:

- `public.metrics_weekly_purchase_plan(p_from date, p_to date)`

Base:

- llama internamente a `public.metrics_replenishment` (no duplica CTEs de reposicion)

Salida JSON:

- `compra_urgente`, `compra_recomendada`, `no_comprar`, `resumen`
- `resumen`: `total_unidades_a_comprar`, `cantidad_productos`, `top_5_productos_criticos`, `estimacion_inversion` (si hay `products.cost`), `estimacion_inversion_disponible`
- limites de lista: hasta 10 items por categoria accionable en SQL

### 10.2 Frontend

- bloque **Plan de compra semanal** en `metrics_v2.html` / `renderWeeklyPurchasePlan` en `metrics_v2.js`
- llamada RPC en paralelo con el resto del dashboard

## 11. Ordenes sugeridas por proveedor

### 11.1 Columna pack_size (MOQ)

Archivo:

- `supabase/canonical/207_metrics_purchase_by_supplier_rpc.sql` (incluye `DO` idempotente)

Comportamiento:

- si no existe, se agrega `public.products.pack_size` (integer nullable)
- default logico para redondeo: 6 unidades si `pack_size` es null o 0

### 11.2 RPC

RPC:

- `public.metrics_purchase_by_supplier(p_from date, p_to date)`

Base:

- `to_jsonb(metrics_weekly_purchase_plan(...))`; solo toma `compra_urgente` + `compra_recomendada`

Enriquecimiento:

- `products` (`supplier_id`, `cost`, `pack_size`)
- `suppliers.name` como `supplier_name`
- `cantidad_final = ceil(cantidad_comprar / pack_eff) * pack_eff` con `pack_eff = greatest(coalesce(nullif(pack_size,0),6),1)`

Salida JSON:

- `proveedores[]`: `supplier_id`, `supplier_name`, `productos[]`, `total_unidades`, `total_costo_estimado`, `prioridad` (`alta` si incluye lineas urgentes, si no `normal`)
- maximo 5 proveedores, orden: criticos primero, luego mas unidades

Producto en `productos`:

- `cantidad_comprar`, `pack_size`, `cantidad_final`, `origen` (`urgente`|`recomendada`), `costo_linea_estimado`

### 11.3 Frontend

- bloque **Ordenes de compra sugeridas** (`suggested-supplier-orders-section`) + `renderSuggestedSupplierOrders`
- RPC anadida al `Promise.all` de `loadMetrics`

### 11.4 Nota de rendimiento

En una misma carga, el frontend puede invocar `metrics_replenishment`, `metrics_weekly_purchase_plan` y `metrics_purchase_by_supplier`. Las dos ultimas encadenan internamente `metrics_replenishment` / `metrics_weekly_purchase_plan`, por lo que hay trabajo duplicado en base si se mantienen todas las llamadas. Mejora futura posible: una RPC agrupada que devuelva varios bloques en una sola ejecucion.

## 12. Inventario de archivos tocados (metrics v2)

| Archivo | Rol |
|---|---|
| `supabase/canonical/200_metrics_dashboard_rpc.sql` | KPIs canonicos |
| `supabase/canonical/201_metrics_dashboard_compare_rpc.sql` | Comparativa periodos |
| `supabase/canonical/202_metrics_product_alerts_rpc.sql` | Alertas producto / inventario |
| `supabase/canonical/203_metrics_replenishment_rpc.sql` | Reposicion |
| `supabase/canonical/204_metrics_replenishment_effectiveness_rpc.sql` | Efectividad + ajustes |
| `supabase/canonical/205_replenishment_learning_table.sql` | Tabla aprendizaje |
| `supabase/canonical/206_metrics_weekly_purchase_plan_rpc.sql` | Plan semanal |
| `supabase/canonical/207_metrics_purchase_by_supplier_rpc.sql` | Compras por proveedor + pack_size |
| `admin/metrics_v2.html` | UI dashboard v2 |
| `admin/metrics_v2.js` | Consumo RPC + alertas + bloques compra |

## Enlaces

- [[03-MAPA-DE-RPCS]]
- [[00-INICIO]]

