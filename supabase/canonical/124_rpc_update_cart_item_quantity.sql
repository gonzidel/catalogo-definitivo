-- 124_rpc_update_cart_item_quantity.sql
-- RPC para actualizar cantidad de un ítem del carrito.
-- Verifica pertenencia con auth.uid() (sesión actual) o con p_customer_id si se envía (ej. custom auth).

CREATE OR REPLACE FUNCTION public.rpc_update_cart_item_quantity(
  p_item_id uuid,
  p_new_quantity int,
  p_customer_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cart_id uuid;
  v_owned int;
  v_customer uuid;
BEGIN
  IF p_new_quantity IS NULL OR p_new_quantity < 1 THEN
    RETURN false;
  END IF;

  -- Identidad: sesión actual o la pasada por el cliente
  v_customer := COALESCE(p_customer_id, auth.uid());
  IF v_customer IS NULL THEN
    RETURN false;
  END IF;

  -- Obtener el cart_id del ítem
  SELECT cart_id INTO v_cart_id
  FROM public.cart_items
  WHERE id = p_item_id;

  IF v_cart_id IS NULL THEN
    RETURN false;
  END IF;

  -- Verificar que el carrito pertenece al cliente
  SELECT 1 INTO v_owned
  FROM public.carts
  WHERE id = v_cart_id AND customer_id = v_customer AND status = 'open';

  IF v_owned IS NULL THEN
    RETURN false;
  END IF;

  -- Actualizar cantidad: qty siempre; quantity si existe (compatibilidad con esquemas flexibles)
  UPDATE public.cart_items
  SET
    qty = p_new_quantity,
    updated_at = now()
  WHERE id = p_item_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Sincronizar quantity si la columna existe (evita error en esquemas sin 08_cart_items_flexible)
  BEGIN
    UPDATE public.cart_items
    SET quantity = p_new_quantity
    WHERE id = p_item_id;
  EXCEPTION
    WHEN SQLSTATE '42703' THEN  -- undefined_column
      NULL;
  END;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.rpc_update_cart_item_quantity(uuid, int, uuid) IS
  'Actualiza la cantidad de un ítem del carrito. Usa auth.uid() o p_customer_id si se envía.';
