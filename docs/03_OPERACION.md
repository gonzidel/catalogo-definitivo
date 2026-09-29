# Operación

Última revisión: 2026-09-23

## VERIFICADO EN CÓDIGO

### Superficies operativas

Estado: Vigente  
Fuente: Código  
Última revisión: 2026-09-23

El backoffice heredado de Firebase en `admin/` sigue concentrando la mayor cantidad de módulos:

- productos, variantes, imágenes, etiquetas y publicaciones;
- stock, movimientos, auditoría y productos incompletos;
- pedidos, pedidos cerrados, envíos, etiquetas e impresión;
- venta pública y pedidos locales;
- clientes, colaboradores y permisos;
- proveedores, compras y reglas de compra;
- métricas, estadísticas, ventas diarias y feed de Meta;
- feriados, acciones rápidas y PAU.

La aplicación Next.js `nj/` agrega o reemplaza parcialmente:

- catálogo y PDP;
- dashboard cliente y carrito;
- Kanban de pedidos de envío;
- tablero de retiro local;
- productos y búsqueda admin;
- conciliación de contra reembolso.

### Inventario

- Fuente canónica por talle y depósito: `variant_size_warehouse_stock`.
- Depósitos funcionales usados por venta web: `warehouses.code IN ('general', 'venta-publico')`.
- Operación de stock por RPC; las capas `variant_sizes` y `variant_warehouse_stock` son derivadas/compatibilidad.
- `stock_history`, `stock_movements` y `order_item_stock_sources` aportan trazabilidad.

### Pedidos y despacho

- El checkout crea o amplía un pedido operativo y descuenta stock.
- Administración aparta, divide, marca espera/falta, devuelve, cierra, envía o desarma.
- El tablero Next.js separa Activos, Apartados, Espera, Cerrados, Stock Pendiente, Cancelados y Vencido.
- GZ Agent (`gz-agent/`) reemplaza a QZ Tray para impresión local; archivos QZ permanecen como historia.

### Facturación y cobranza

- `backend/` expone un servidor Express para ARCA, protegido con JWT Supabase y validación en `admins`.
- Genera PDF, registra `invoices`/`invoice_items` y hace respaldo best-effort en Google Drive.
- El mutex de facturación es en memoria y solo protege una instancia del backend.
- `nj/admin/conciliacion-reembolso` gestiona remesas, diferencias, irregularidades, aliases y pagos complementarios COD.

### Integraciones

- Supabase: datos, Auth, RLS, RPC, Realtime, Edge Functions y cron.
- Cloudinary: imágenes de producto.
- Firebase Hosting: admin/legacy y redirecciones.
- Vercel/Next.js: superficies `nj` y catálogo bajo `/catalogo` según configuración y despliegue.
- Google Drive: respaldo de facturas.
- ARCA: facturación electrónica.
- Meta: feed de catálogo.
- GZ Agent: impresión en PCs locales.
- YCloud/WhatsApp: trabajo local y documentación reciente; ver `09_WHATSAPP_CRM.md`.

## CONTEXTO CONFIRMADO POR EL NEGOCIO

Estado: Vigente como contexto operativo; no usar como constante de software  
Fuente: Contexto confirmado por responsable del negocio  
Última revisión: 2026-09-23

- La operación se separa físicamente entre depósito general, local de venta al público y atención por WhatsApp.
- La dotación aproximada actual es de 2 personas en depósito, 2 en WhatsApp y 2 en el local. Estos números describen la operación y no deben condicionar permisos, capacidad ni lógica del sistema.
- **CANÓNICA:** un pedido normal conserva su reserva durante 7 días desde la creación. El momento técnico de vencimiento puede correrse por fin de semana o feriado según la lógica implementada.
- **HISTÓRICA:** se contemplaron avisos a 3, 2 y 1 día y el día del vencimiento.
- **EN EVALUACIÓN:** la cadencia oficial de recordatorios no está definida; debe verificarse en código e infraestructura y resolverse comercialmente antes de prometerla.

## INFERIDO

- La convivencia legacy/Next.js es una migración gradual, no dos productos independientes.
- El admin heredado continúa siendo crítico aun cuando pedidos/retiro tengan alternativa Next.js.

## DESCONOCIDO

- Qué pantallas usa cada rol diariamente y cuáles ya no deben usarse.
- Qué entorno Next.js es producción, test o pre-lanzamiento en cada hostname actual.
- Topología real del backend ARCA en producción y estrategia de backups/monitorización.
- Procedimiento operativo completo desde recepción de mercadería hasta publicación.
- Responsables nominales, reemplazos y autoridad para excepciones en cada área.

## Archivos clave

- `admin/index.html`
- `admin/STOCK_OPERATIVA.md`
- `nj/app/admin/`
- `nj/hooks/useOrders.ts`
- `backend/README.md`
- `gz-agent/README.md`
- `firebase.json`
