-- ROLLBACK 377: vuelve trg_orders_total_exclude_missing a la versión de producción previa (2026-10-09)
-- y elimina las funciones auxiliares. Los totales ya corregidos no se revierten.

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_orders_total_exclude_missing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_sum_incl numeric := 0;
  v_sum_excl numeric := 0;
  v_missing numeric := 0;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NEW.total_amount IS NOT DISTINCT FROM OLD.total_amount THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_sum_incl
  FROM public.order_items oi
  WHERE oi.order_id = NEW.id
    AND lower(trim(coalesce(oi.status, ''))) <> 'cancelled';

  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_sum_excl
  FROM public.order_items oi
  WHERE oi.order_id = NEW.id
    AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'missing');

  v_missing := v_sum_incl - v_sum_excl;
  IF v_missing <= 0 THEN
    RETURN NEW;
  END IF;

  IF abs(coalesce(NEW.total_amount, 0) - v_sum_excl) < 0.02 THEN
    RETURN NEW;
  END IF;

  IF abs(coalesce(NEW.total_amount, 0) - v_sum_incl) < 0.02
     OR coalesce(NEW.total_amount, 0) > (v_sum_excl + 0.02) THEN
    NEW.total_amount := greatest(0, coalesce(NEW.total_amount, 0) - v_missing);
  END IF;

  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_order_canonical_total(uuid, text);
DROP FUNCTION IF EXISTS public.fn_order_promo_discount(uuid);

COMMIT;
