# Sistema de Pedidos y Clientes - Resumen de Implementación

## Fecha de Implementación
Última actualización: Sistema completo de números únicos para clientes y pedidos con privacidad.

## Características Implementadas

### 1. Números Únicos de Cliente
- **Formato**: `0001`, `0002`, `0003`, etc. (4 dígitos)
- **Asignación**: Automática al crear perfil de cliente
- **Visualización**: Aparece antes del nombre en el panel admin (#0001 Gonzalo de la Fuente)
- **Tabla**: `public.customers` - columna `customer_number`
- **Función**: `generate_customer_number()` - genera siguiente número secuencial
- **Trigger**: `assign_customer_number_trigger` - asigna automáticamente

### 2. Números Únicos de Pedido
- **Formato**: `A50000`, `A50001`, `A50002`, etc. (Letra + 5 dígitos)
- **Privacidad**: Empieza en `A50000` (no revela volumen real)
- **Escalabilidad**: Hasta 2.6 millones de pedidos (A-Z, 00000-99999)
- **Secuencia**: Cuando A llega a 99999, continúa con B50000
- **Tabla**: `public.orders` - columna `order_number`
- **Función**: `generate_order_number()` - genera siguiente número secuencial
- **Trigger**: `assign_order_number_trigger` - asigna automáticamente
- **Configuración**: `get_order_number_config()` - permite ajustar base e incremento

### 3. Datos del Cliente en Panel Admin
- **Nombre completo**: `full_name`
- **DNI**: `dni` (formato: 🆔 DNI: 37262546)
- **Teléfono**: `phone` (formato: 📞 3624755101)
- **Email**: `email` (sincronizado desde auth.users)
- **Localidad**: `city` y `province` (formato: 📍 Resistencia - Chaco)
- **Número de cliente**: `customer_number` (formato: #0001)

### 4. Sincronización de Emails
- **Columna**: `customers.email` - sincronizada desde `auth.users`
- **Función**: `populate_existing_customer_emails()` - sincroniza emails existentes
- **JavaScript**: Actualiza email al crear/actualizar perfil de cliente
- **Admin Panel**: Muestra email directamente desde tabla `customers`

## Archivos Modificados

### SQL
1. **`supabase/canonical/01_customers.sql`**
   - Agregada columna `customer_number` (text unique)
   - Agregada columna `email` (text)
   - Función `generate_customer_number()` - genera números secuenciales
   - Función `assign_customer_number()` - trigger para asignar automáticamente
   - Función `populate_existing_customer_emails()` - sincroniza emails
   - Función `assign_customer_numbers_to_existing()` - asigna números a clientes existentes
   - Política RLS `customers_admin_select` - admins pueden ver todos los customers

2. **`supabase/canonical/10_checkout_flow.sql`**
   - Agregada columna `order_number` (text unique)
   - Función `get_order_number_config()` - configuración de privacidad
   - Función `generate_order_number()` - genera números secuenciales con privacidad
   - Función `assign_order_number()` - trigger para asignar automáticamente
   - Función `assign_order_numbers_to_existing()` - asigna números a pedidos existentes
   - Configuración: `base_number: 50000`, `increment_step: 1`

### JavaScript
1. **`admin/orders.js`**
   - Actualizado para obtener `customer_number` y `order_number`
   - Visualización de número de cliente antes del nombre
   - Visualización de número de pedido en lugar de UUID
   - Consultas actualizadas para incluir nuevos campos

2. **`scripts/cart-persistent.js`**
   - Actualizado para guardar `email` al crear perfil de cliente
   - Actualizado para actualizar `email` si cambia

3. **`admin/orders.html`**
   - CSS actualizado para mostrar detalles del cliente en línea horizontal
   - Estilos para número de cliente y número de pedido

## Configuración de Privacidad

### Números de Pedido
- **Base**: `50000` (empezar en A50000)
- **Incremento**: `1` (secuencial normal)
- **Ubicación**: Función `get_order_number_config()` en `10_checkout_flow.sql`

### Para Ajustar:
```sql
-- En la función get_order_number_config():
return query select 50000 as base_number, 1 as increment_step;
--                   ^^^^^                    ^
--                   base                    incremento
```

**Opciones**:
- Más privacidad: `select 75000 as base_number, 1 as increment_step;`
- Saltos: `select 50000 as base_number, 10 as increment_step;`
- Balance: `select 50000 as base_number, 1 as increment_step;` (recomendado)

## Funciones SQL Principales

### Clientes
- `generate_customer_number()` - Genera siguiente número de cliente (0001, 0002, etc.)
- `assign_customer_number()` - Trigger que asigna número automáticamente
- `populate_existing_customer_emails()` - Sincroniza emails desde auth.users
- `assign_customer_numbers_to_existing()` - Asigna números a clientes existentes

### Pedidos
- `get_order_number_config()` - Retorna configuración de privacidad
- `generate_order_number()` - Genera siguiente número de pedido (A50000, A50001, etc.)
- `assign_order_number()` - Trigger que asigna número automáticamente
- `assign_order_numbers_to_existing()` - Asigna números a pedidos existentes

## Políticas RLS

### Customers
- `customers_self_select` - Usuario puede ver su propio perfil
- `customers_self_insert` - Usuario puede crear su propio perfil
- `customers_self_update` - Usuario puede actualizar su propio perfil
- `customers_admin_select` - Admins pueden ver todos los customers

### Orders
- `orders_self_select` - Usuario puede ver sus propios pedidos
- `orders_admin_manage` - Admins pueden gestionar todos los pedidos

## Visualización en Panel Admin

### Orden de Información del Cliente:
1. Número de cliente: `#0001` (en color #CD844D)
2. Nombre completo: `Gonzalo de la Fuente`
3. DNI: `🆔 DNI: 37262546`
4. Teléfono: `📞 3624755101`
5. Email: `📧 email@ejemplo.com`
6. Localidad: `📍 Resistencia - Chaco`

### Orden de Información del Pedido:
1. Número de pedido: `Pedido #A50000`
2. Estado: `ACTIVO` (badge verde)
3. Información del cliente (ver arriba)
4. Productos del pedido
5. Total y acciones

## Próximos Pasos (Opcional)

1. **Mejoras de UI**: 
   - Filtros por número de pedido
   - Búsqueda por número de cliente
   - Exportar reportes

2. **Notificaciones**:
   - Notificar a cliente cuando su pedido esté listo
   - Notificar a admin cuando hay nuevo pedido

3. **Reportes**:
   - Estadísticas de pedidos por período
   - Clientes más frecuentes
   - Productos más vendidos

## Notas Importantes

- Los números se asignan automáticamente al crear registros
- Los números existentes se asignan retroactivamente al ejecutar el SQL
- La configuración de privacidad se puede ajustar en `get_order_number_config()`
- Los emails se sincronizan automáticamente desde `auth.users`
- El sistema es idempotente (se puede ejecutar múltiples veces sin problemas)

## Comandos SQL Ejecutados

1. `supabase/canonical/01_customers.sql` - Clientes y números únicos
2. `supabase/canonical/10_checkout_flow.sql` - Pedidos y números únicos
3. Política RLS `customers_admin_select` - Permite a admins ver todos los customers

## Estado Actual

✅ Sistema completo de números únicos para clientes
✅ Sistema completo de números únicos para pedidos
✅ Privacidad configurada (empezar en A50000)
✅ Emails sincronizados desde auth.users
✅ Datos completos del cliente en panel admin
✅ Visualización mejorada en panel admin
✅ Sistema escalable y robusto

