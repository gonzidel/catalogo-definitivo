# Modelo de negocio

Última revisión: 2026-09-23

## VERIFICADO EN CÓDIGO

### Venta mayorista B2B

Estado: Vigente  
Fuente: Código y configuración  
Última revisión: 2026-09-23

- El catálogo muestra productos, colores, talles, precios, ofertas y promociones.
- El flujo cliente no cobra en línea: carrito, pedido abierto y cierre son etapas distintas.
- El cliente puede seguir agregando productos a un pedido abierto antes de cerrarlo.
- La interfaz usa un mínimo general de 4 unidades para cerrar pedidos fuera de la zona de retiro especial.
- Hay entregas por transporte y retiro local. Algunos transportes se clasifican como contra reembolso.

### Precios y promociones

Estado: Vigente  
Fuente: Código y base de datos  
Última revisión: 2026-09-23

- El precio final de cada línea de checkout se vuelve a resolver en base de datos con `get_effective_price(variant_id)`; `cart_items.price_snapshot` no es autoridad de cobro.
- Existen ofertas por color (`color_price_offers`) y promociones `2x1` / `2xMonto` (`promotions`, `promotion_items`).
- El total del pedido se recalcula desde `order_items` no cancelados y descuentos activos.
- Productos o variantes con precio inválido/no positivo no deben considerarse comprables.

### Formas de operación

Estado: Vigente  
Fuente: Código  
Última revisión: 2026-09-23

- Pedidos de clientas autenticadas.
- Pedidos creados manualmente por administración.
- Venta pública/mostrador, con cajas y posibilidad explícita de vender sin stock registrado.
- Pedidos de retiro y pedidos locales, luego convertibles a venta pública.
- Facturación ARCA y respaldo de PDF en Google Drive.
- Conciliación de cobranzas contra reembolso por transporte.

## CONTEXTO CONFIRMADO POR EL NEGOCIO

Estado: Vigente  
Fuente: Contexto confirmado por responsable del negocio  
Última revisión: 2026-09-23

### Propuesta mayorista

- El canal web está orientado principalmente a revendedoras, emprendedoras y pequeños comercios.
- La propuesta diferencial es comprar productos surtidos sin exigir grandes cantidades de un único modelo.
- Existe venta al público en el local, pero no es el foco principal del sistema web.

### Mínimos

- **CANÓNICA:** compra web mayorista normal con mínimo de **4 productos surtidos**. Pueden ser productos, modelos, colores y talles diferentes; no significa 4 pares por modelo, 4 unidades del mismo producto ni 4 pares obligatoriamente.
- **NEGOCIO CONFIRMADO:** local físico con referencia operativa actual de **3 pares**. Esta regla pertenece al canal físico y no debe trasladarse a la web.
- **NEGOCIO CONFIRMADO:** si el pedido usa `local_deferred_pickup`, el mínimo general de 4 productos **no aplica**.

**TÉCNICA VERIFICADA:** Next.js usa `4` como mínimo normal y `1` para determinadas localidades de retiro corto. La ubicación puede decidir si la modalidad está disponible, pero no define la excepción comercial. El acoplamiento geográfico de `getOrderCloseMinimumUnits` está registrado en `11_PROBLEMAS_Y_FIXES.md`.

### Envíos y pagos conocidos

- SEDE y MyM: contra reembolso en efectivo, incluyendo pedido y envío.
- Via Cargo, Credifin y Snaider: transferencia previa del pedido.
- Correo Argentino: transferencia previa del pedido y del envío; el costo depende de peso/volumen.
- **TÉCNICA VERIFICADA:** el repositorio trata Expreso Norte como contra reembolso, pero esa condición no tiene confirmación comercial.
- **TÉCNICA VERIFICADA:** Andreani está contemplado y cae en defaults técnicos, pero su modalidad, costo y condiciones comerciales no están confirmados.

## INFERIDO

- La web funciona como herramienta de armado y preparación de pedidos, no como ecommerce con pago inmediato.
- La operación prioriza WhatsApp para coordinación comercial y posventa.
- La combinación de mínimo bajo y surtido libre busca reducir la barrera de entrada para revendedoras pequeñas.

## DESCONOCIDO

- Excepciones al mínimo fuera de `local_deferred_pickup` y quién puede autorizarlas.
- Política de precios, listas, descuentos, señas, crédito, sustituciones y devoluciones.
- Condiciones comerciales por transporte/provincia.
- Criterio empresarial para elegir proveedor, surtido y reposición.
- Política de publicación y despublicación de productos.
- Qué canales generan clientes y cómo se atribuye cada origen fuera de CTWA/YCloud.
- Modalidad de pago de Expreso Norte, Andreani y cualquier transporte no detallado por el negocio.
- Revisión comercial de la afirmación “fábrica propia” presente en textos públicos.

## Fuentes principales

- `docs/FYL-Obsidian/49-REGLAS-UX-FLUJO-COMPRA-CLIENTE-2026-08-10.md`
- `nj/lib/stock/catalog-availability.ts`
- `supabase/canonical/335_rpc_checkout_cart_effective_price.sql`
- `supabase/canonical/351_rpc_close_order_resolve_payment_by_transport.sql`
- `admin/public-sales.js`
- `backend/src/services/arcaService.ts`
