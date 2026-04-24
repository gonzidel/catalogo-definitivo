# 12 - Checklist para cambios futuros

Antes de merge/deploy, revisar el area afectada y actualizar Obsidian si cambia comportamiento real.

## Checklist por impacto

- [ ] Toca Products, costos, precio, imagenes, tags o variantes: revisar [[14-AUDITORIA-MODULO-PRODUCTS]], [[07-FLUJO-ADMIN-PRODUCTOS]], [[08-PERMISOS-Y-ROLES]].
- [ ] Toca Stock, depositos, talles o movimientos: revisar [[16-AUDITORIA-MODULO-STOCK]], [[04-FLUJO-STOCK]].
- [ ] Toca Orders, picking, cancelaciones o pedidos locales: revisar [[17-AUDITORIA-MODULO-ORDERS]], [[05-FLUJO-PEDIDOS]].
- [ ] Toca Public Sales, caja, anulaciones, pendientes, creditos o local orders: revisar [[18-AUDITORIA-MODULO-PUBLIC-SALES]].
- [ ] Toca Cliente/Carrito, checkout, `cart_items`, localStorage o dashboard cliente: revisar [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]], [[06-FLUJO-CATALOGO]].
- [ ] Toca RPCs o migraciones: actualizar [[03-MAPA-DE-RPCS]] y [[13-RPCS-DEPLOY-STATE]].
- [ ] Toca RLS, permisos o colaboradores: revisar [[08-PERMISOS-Y-ROLES]] y observaciones en [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]].
- [ ] Toca documentacion: verificar que los links entre mapas generales y auditorias 14-19 sigan vigentes.

## Regla para documentar

1. Si se modifica logica de negocio, actualizar la nota modular correspondiente.
2. Si se detecta riesgo transversal, agregarlo a [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]].
3. Si cambia una firma RPC o se crea/reemplaza una funcion, actualizar [[03-MAPA-DE-RPCS]] y [[13-RPCS-DEPLOY-STATE]].
4. Si se corrige un bug real, agregarlo a [[10-BUGS-RESUELTOS]].
5. Si se toma una decision tecnica nueva, agregarla a [[11-DECISIONES-TECNICAS]].

## Regla de prioridad

Si un mapa general contradice una auditoria modular, corregir el mapa general. Las auditorias 14-19 son las referencias mas recientes por modulo.

## Enlaces

- [[00-INICIO]]
- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
- [[99-AUDITORIA-DOCUMENTACION]]
