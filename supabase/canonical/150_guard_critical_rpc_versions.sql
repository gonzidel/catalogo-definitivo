-- 150_guard_critical_rpc_versions.sql
-- Plan 3: guard de canonicalidad para RPCs críticas.
-- Objetivo: fallar explícitamente si una migración pisa una versión fuera del canon.

DO $$
DECLARE
  v_def text;
  v_comment text;
BEGIN
  -- rpc_checkout_cart()
  SELECT pg_get_functiondef('public.rpc_checkout_cart()'::regprocedure) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Guard RPC crítico: falta public.rpc_checkout_cart()';
  END IF;

  SELECT obj_description('public.rpc_checkout_cart()'::regprocedure, 'pg_proc') INTO v_comment;
  IF coalesce(v_comment, '') !~ '^canonical:124([[:space:]]|$)' THEN
    RAISE EXCEPTION
      'Guard RPC crítico: rpc_checkout_cart fuera de canon (esperado canonical:124, actual: %)',
      coalesce(v_comment, '<sin comentario>');
  END IF;

  IF position('Stock por talle insuficiente' in v_def) = 0
     OR position('order_item_stock_sources' in v_def) = 0
     OR position('venta-público = waiting' in v_def) = 0 THEN
    RAISE EXCEPTION 'Guard RPC crítico: rpc_checkout_cart no coincide con fingerprint canónico esperado';
  END IF;

  -- rpc_close_order(uuid, text)
  SELECT pg_get_functiondef('public.rpc_close_order(uuid,text)'::regprocedure) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Guard RPC crítico: falta public.rpc_close_order(uuid,text)';
  END IF;

  SELECT obj_description('public.rpc_close_order(uuid,text)'::regprocedure, 'pg_proc') INTO v_comment;
  IF coalesce(v_comment, '') !~ '^canonical:83([[:space:]]|$)' THEN
    RAISE EXCEPTION
      'Guard RPC crítico: rpc_close_order fuera de canon (esperado canonical:83, actual: %)',
      coalesce(v_comment, '<sin comentario>');
  END IF;

  IF position('stock ya se descontó en rpc_checkout_cart' in v_def) = 0
     OR position('status = ''closed''' in v_def) = 0 THEN
    RAISE EXCEPTION 'Guard RPC crítico: rpc_close_order no coincide con fingerprint canónico esperado';
  END IF;

  -- rpc_void_public_sale(uuid)
  SELECT pg_get_functiondef('public.rpc_void_public_sale(uuid)'::regprocedure) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Guard RPC crítico: falta public.rpc_void_public_sale(uuid)';
  END IF;

  SELECT obj_description('public.rpc_void_public_sale(uuid)'::regprocedure, 'pg_proc') INTO v_comment;
  IF coalesce(v_comment, '') !~ '^canonical:141([[:space:]]|$)' THEN
    RAISE EXCEPTION
      'Guard RPC crítico: rpc_void_public_sale fuera de canon (esperado canonical:141, actual: %)',
      coalesce(v_comment, '<sin comentario>');
  END IF;

  IF position('qty_venta_publico y qty_general deben ser ambas NULL o ambas NOT NULL' in v_def) = 0
     OR position('sold_size_normalized' in v_def) = 0
     OR position('No se puede anular línea legacy sin size.' in v_def) = 0 THEN
    RAISE EXCEPTION 'Guard RPC crítico: rpc_void_public_sale no coincide con fingerprint canónico esperado';
  END IF;
END $$;
