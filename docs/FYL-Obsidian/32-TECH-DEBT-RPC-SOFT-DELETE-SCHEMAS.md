# Tech Debt: RPC, Soft Delete Y Schemas

Fecha: 2026-05-13

## RPC Legacy

- Mantener `rpc_checkout_cart()` sin cambiar firma hasta que todos los clientes
  usen la firma canónica con `operation_id`.
- Objetivo canónico: `rpc_checkout_cart(uuid,jsonb)`.
- No eliminar firmas legacy sin una ventana de métricas y rollback.
- Todo RPC nuevo debe declarar: consumidor, rol permitido, si es
  `SECURITY DEFINER`, payload de respuesta y estrategia de idempotencia.

## Soft Delete

No cambiar cascades actuales en caliente. Diseño recomendado:

- `products.deleted_at`
- `customers.deleted_at`
- `orders.deleted_at`
- Policies y views deben filtrar `deleted_at is null`.
- Borrado físico solo por job interno posterior a retención definida.

## Separación Futura De Schemas

Objetivo:

- `public`: API pública intencional y mínima.
- `private`/`internal`: tablas operativas, helpers internos y funciones no
  expuestas por PostgREST.

Orden recomendado:

1. Completar `catalog_public_snapshot`.
2. Retirar dependencias `anon` de tablas operativas.
3. Mover funciones internas/trigger helpers fuera de `public`.
4. Revisar PostgREST exposed schemas antes de mover tablas críticas.

## Payload Mobile

Cambio inicial aplicado: el catálogo deja de pedir `select('*')` y usa una lista
explícita de columnas publicables en `scripts/main-supabase.js`.
