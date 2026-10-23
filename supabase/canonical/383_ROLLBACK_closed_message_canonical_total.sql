-- Rollback 383: vuelve el total del aviso a la suma de líneas sin promo 2x.

BEGIN;

DROP FUNCTION IF EXISTS public.rpc_closed_order_products_total(uuid);

CREATE OR REPLACE FUNCTION public.fn_compute_closed_order_products_total(p_order_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_subtotal numeric := 0;
  v_notes jsonb;
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras numeric := 0;
  v_extras_pct numeric := 0;
BEGIN
  SELECT coalesce(sum((coalesce(oi.quantity, 0)::numeric * coalesce(oi.price_snapshot, 0)::numeric)), 0)
    INTO v_subtotal
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id
     AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'missing');

  SELECT coalesce(o.notes::jsonb, '{}'::jsonb)
    INTO v_notes
    FROM public.orders o
   WHERE o.id = p_order_id;

  v_shipping := coalesce((v_notes->>'shipping')::numeric, (v_notes->>'shipping_cost')::numeric, 0);
  v_discount := coalesce((v_notes->>'discount')::numeric, 0);
  v_extras := coalesce((v_notes->>'extras_amount')::numeric, (v_notes->>'extras')::numeric, 0);
  v_extras_pct := coalesce((v_notes->>'extras_percentage')::numeric, 0);

  RETURN greatest(0,
    v_subtotal + v_shipping - v_discount + v_extras + (v_subtotal * v_extras_pct / 100)
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_compute_closed_order_products_total(uuid) IS
  'canonical:369 — total de productos para avisos de cierre; excluye cancelled y missing.';

COMMIT;
