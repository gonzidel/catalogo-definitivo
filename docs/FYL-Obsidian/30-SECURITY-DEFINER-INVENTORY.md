# Security Definer Inventory

Fecha: 2026-05-13

Baseline vivo antes de Fase 3:

- `SECURITY DEFINER` en `public`: 161 funciones.
- Ejecutables por `anon`: 140 funciones.
- Sin `search_path` seguro detectable: 49 funciones.

## Batch 1 Aplicado

Archivo: `supabase/canonical/212_security_definer_grants_batch1.sql`.

Alcance:

- RPCs de administración, métricas, ventas públicas internas, pedidos, stock,
  compras a proveedores, colaboradores y perfil autenticado.
- Se revoca `EXECUTE` de `anon` y `PUBLIC`.
- Se conserva `EXECUTE` para `authenticated` y `service_role`.
- Se fija `search_path = public, pg_catalog` con `ALTER FUNCTION`, sin reescribir
  cuerpos ni cambiar firmas.

## Allowlist No Tocada En Batch 1

- `rpc_get_variant_size_reserved(uuid[])`: dependencia temporal catálogo/PDP.
- `get_meta_feed()`: feed público Meta Commerce.
- Helpers públicos de catálogo, tags, ofertas e imágenes.

## Próximos Batches

- Triggers internos: revocar grants innecesarios y dejar ejecución solo por owner.
- Funciones legacy de carrito no usadas: mantener denylist y documentar remoción.
- Funciones públicas reales: convertir a contratos mínimos o mover a snapshot.
