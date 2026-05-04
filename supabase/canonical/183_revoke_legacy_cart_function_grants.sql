-- 183_revoke_legacy_cart_function_grants.sql
-- Revoca grants de funciones legacy de carrito a roles públicos.
--
-- Contexto:
--   Detectado en FASE 4 de auditoría (2026-05-04):
--   8 funciones legacy de carrito tienen EXECUTE a PUBLIC, anon y authenticated.
--   La más crítica es clear_cart_items(): no valida ownership y borra cart_items
--   de cualquier carrito, callable por usuarios no autenticados (anon).
--
-- Qué hace esta migración:
--   Revoca EXECUTE de anon, authenticated y PUBLIC para las 8 funciones legacy.
--   Mantiene EXECUTE para postgres y service_role (uso operativo/mantenimiento).
--
-- Impacto:
--   Ningún impacto en el flujo vivo. Estas funciones no son llamadas por el
--   código principal (scripts/cart-persistent.js, client/dashboard-instant.js).
--   El flujo activo usa rpc_checkout_cart(uuid, jsonb) y direct writes a cart_items.
--
-- Safe to run: sí. No modifica datos, solo permisos de ejecución.


-- 1. clear_cart_items — CRÍTICO: borra cart_items sin validar ownership
REVOKE EXECUTE ON FUNCTION public.clear_cart_items(cart_uuid uuid)
  FROM anon, authenticated, PUBLIC;

-- 2. add_cart_item — agrega ítems a cualquier carrito
REVOKE EXECUTE ON FUNCTION public.add_cart_item(
  cart_uuid uuid,
  product_name_param text,
  color_param text,
  size_param text,
  quantity_param integer,
  price_param numeric,
  imagen_param text
) FROM anon, authenticated, PUBLIC;

-- 3. get_cart_items_simple — expone contenido de carritos por UUID
REVOKE EXECUTE ON FUNCTION public.get_cart_items_simple(cart_uuid uuid)
  FROM anon, authenticated, PUBLIC;

-- 4. get_user_cart — expone carrito de cualquier usuario por UUID
REVOKE EXECUTE ON FUNCTION public.get_user_cart(user_id uuid)
  FROM anon, authenticated, PUBLIC;

-- 5. rpc_get_or_create_cart — crea carritos fuera del flujo canónico
REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_cart()
  FROM anon, authenticated, PUBLIC;

-- 6. rpc_reserve_item — reserva stock sin flujo canónico
REVOKE EXECUTE ON FUNCTION public.rpc_reserve_item(variant uuid, qty integer)
  FROM anon, authenticated, PUBLIC;

-- 7. rpc_submit_cart — checkout alternativo legacy sin deducción correcta de stock
REVOKE EXECUTE ON FUNCTION public.rpc_submit_cart(cid uuid)
  FROM anon, authenticated, PUBLIC;

-- 8. rpc_update_cart_item_quantity — modifica cantidades sin validación
REVOKE EXECUTE ON FUNCTION public.rpc_update_cart_item_quantity(
  p_item_id uuid,
  p_new_quantity integer,
  p_customer_id uuid
) FROM anon, authenticated, PUBLIC;


-- Verificación post-ejecución:
-- Ejecutar el siguiente query para confirmar que los grants fueron revocados.
-- Si no retorna filas para anon/authenticated/PUBLIC, la migración fue exitosa.
--
-- SELECT routine_name, grantee, privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_schema = 'public'
--   AND routine_name IN (
--     'clear_cart_items', 'add_cart_item', 'get_cart_items_simple',
--     'get_user_cart', 'rpc_get_or_create_cart', 'rpc_reserve_item',
--     'rpc_submit_cart', 'rpc_update_cart_item_quantity'
--   )
--   AND grantee IN ('anon', 'authenticated', 'PUBLIC')
-- ORDER BY routine_name, grantee;
