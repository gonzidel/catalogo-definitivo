-- 377: total del pedido con promociones 2x en el servidor (para cualquier ruta que escriba total_amount)
--
-- Problema: solo rpc_checkout_cart descontaba promos 2x1/2xMonto. Editar pedido (rpc_admin_add_order_items_atomic),
-- reemplazo de faltante, cancelaciones y el ajuste por faltantes recalculaban sin promo y borraban el descuento
-- (A57569, A57610, A57624, A57638).
--
-- Regla (NEGOCIO CONFIRMADO 2026-10-09): pares completos por promo, el sobrante paga precio normal; una unidad
-- entra en una promo si se cargó al pedido (order_items.created_at, día AR) mientras la promo estaba vigente.
-- Si la promo termina después, el par conserva el descuento. Promo desactivada a mano (status inactive) deja de aplicar.
--
-- Cambio: trg_orders_total_exclude_missing (BEFORE UPDATE OF total_amount ON orders, ya existente) fija el total
-- canónico en pedidos active/closing_soon/closed. sent/cancelled/expired siguen con la lógica previa.
-- Evidencia previa: con la fórmula canónica, 243/243 pedidos active/closing_soon y 231/233 closed ya coinciden
-- con el total guardado (difieren A57638 por este bug y A56703, histórico; solo cambiaría si se edita).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_order_promo_discount(p_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH promo_variants AS (
    SELECT DISTINCT pr.id AS promotion_id, pr.promo_type, pr.fixed_amount, pr.start_date, pr.end_date,
           pv.id AS variant_id
    FROM public.promotions pr
    JOIN public.promotion_items pi ON pi.promotion_id = pr.id
    JOIN public.product_variants pv
      ON pi.variant_id = pv.id
      OR (pi.variant_id IS NULL AND pi.product_id = pv.product_id)
    WHERE pr.status = 'active'
  ),
  eligible AS (
    SELECT p.promotion_id, p.promo_type, p.fixed_amount,
           sum(oi.quantity)::numeric AS qty,
           sum(oi.quantity * oi.price_snapshot)::numeric AS list_price
    FROM public.order_items oi
    JOIN promo_variants p ON p.variant_id = oi.variant_id
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'expired', 'missing')
      AND coalesce(oi.price_snapshot, 0) > 0
      AND (oi.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
          BETWEEN p.start_date AND p.end_date
    GROUP BY p.promotion_id, p.promo_type, p.fixed_amount
  )
  SELECT coalesce(round(sum(
    CASE
      WHEN qty < 2 THEN 0
      WHEN promo_type = '2x1' THEN floor(qty / 2) * list_price / qty
      WHEN promo_type = '2xMonto' AND fixed_amount IS NOT NULL THEN
        list_price - (floor(qty / 2) * fixed_amount + (qty - floor(qty / 2) * 2) * list_price / qty)
      ELSE 0
    END
  ), 2), 0)
  FROM eligible;
$function$;

CREATE OR REPLACE FUNCTION public.fn_order_canonical_total(p_order_id uuid, p_notes text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_products numeric;
BEGIN
  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_products
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
    AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'expired', 'missing');

  v_products := v_products - public.fn_order_promo_discount(p_order_id);

  RETURN greatest(0, round(v_products + public.fn_order_notes_extras_total(p_notes, v_products), 2));
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_order_promo_discount(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_order_canonical_total(uuid, text) FROM PUBLIC, anon, authenticated;

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

  -- 377: pedidos abiertos/cerrados → total canónico (productos sin cancelados/faltantes − promos 2x + extras de notes).
  IF lower(trim(coalesce(NEW.status, ''))) IN ('active', 'closing_soon', 'closed') THEN
    NEW.total_amount := public.fn_order_canonical_total(NEW.id, NEW.notes);
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

COMMIT;
