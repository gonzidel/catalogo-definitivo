# Plan 3 Runbook - Consolidación de RPC críticas

Este runbook operacionaliza el despliegue seguro de la consolidación de RPCs críticas:

- `public.rpc_checkout_cart()` => `canonical:124`
- `public.rpc_close_order(uuid, text)` => `canonical:83`
- `public.rpc_void_public_sale(uuid)` => `canonical:141`

## Artefactos de Plan 3

- `supabase/canonical/149_consolidate_critical_rpcs.sql`
- `supabase/canonical/150_guard_critical_rpc_versions.sql`
- `supabase/canonical/RPC_CANONICAL_MAP.md`
- `test/check-critical-rpc-whitelist.mjs`

## Secuencia de despliegue segura

1. **Precheck en staging**
   - Confirmar migraciones pendientes.
   - Tomar snapshot de definición actual:
     - `select pg_get_functiondef('public.rpc_checkout_cart()'::regprocedure);`
     - `select pg_get_functiondef('public.rpc_close_order(uuid,text)'::regprocedure);`
     - `select pg_get_functiondef('public.rpc_void_public_sale(uuid)'::regprocedure);`

2. **Aplicar consolidación**
   - Ejecutar `149_consolidate_critical_rpcs.sql`.
   - Verificar comentarios canónicos:
     - `select obj_description('public.rpc_checkout_cart()'::regprocedure, 'pg_proc');`
     - `select obj_description('public.rpc_close_order(uuid,text)'::regprocedure, 'pg_proc');`
     - `select obj_description('public.rpc_void_public_sale(uuid)'::regprocedure, 'pg_proc');`

3. **Aplicar guard**
   - Ejecutar `150_guard_critical_rpc_versions.sql`.
   - Resultado esperado: sin excepción.

4. **Smoke checks mínimos en staging**
   - `rpc_checkout_cart`: checkout genera `order_item_stock_sources`.
   - `rpc_close_order`: cierra pedido sin doble descuento.
   - `rpc_void_public_sale`: anula y restituye stock según trazabilidad.

5. **Promoción a producción**
   - Repetir pasos 2, 3 y 4 en ventana controlada.
   - Monitorear errores de RPC y anomalías de stock por al menos 1 hora.

## Verificaciones post-deploy

1. **Integridad canónica**
   - Los comentarios de función deben empezar con:
     - `canonical:124`
     - `canonical:83`
     - `canonical:141`
2. **Guard activo**
   - Re-ejecutar `150_guard_critical_rpc_versions.sql` manualmente: debe pasar.
3. **Whitelist CI**
   - Ejecutar `npm run test:critical-rpcs`: debe devolver OK.
4. **Verificación funcional**
   - Casos reales de checkout, close y void sin regresiones.

## Criterio de done verificable

Se considera completo cuando se cumplen simultáneamente:

1. En DB, las 3 RPC críticas tienen versión efectiva canónica (`124/83/141`).
2. El guard de `150` bloquea deriva de versión (falla ante desalineación).
3. El check de whitelist en CI/pipeline pasa sin redefiniciones no autorizadas.
4. Smoke tests en staging y producción pasan sin regresiones en checkout/cierre/anulación.
5. Mapa canónico (`RPC_CANONICAL_MAP.md`) y runbook quedan versionados en repo.

