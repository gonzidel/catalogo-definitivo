-- 320_order_deadlines_seven_days_unless_deferred.sql
--
-- Las 36 h de zona (307) aplican solo al retiro especial (local_deferred_pickup),
-- que arranca el timer al primer apartado (309). Retiro común y envío en
-- Resistencia/Barranqueras/etc. usan 7 días hábiles como el resto del país.
--
-- Riesgo: bajo en lógica nueva; backfill toca pedidos active/closing_soon.
-- Rollback: restaurar fn_order_deadlines_for_customer de 307 y revertir UPDATE.

CREATE OR REPLACE FUNCTION public.fn_order_deadlines_for_customer(
  p_customer_id uuid,
  p_anchor timestamptz DEFAULT now()
)
RETURNS TABLE(expires_at timestamptz, dismantle_at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_dismantle timestamptz;
  v_expires timestamptz;
BEGIN
  v_dismantle := public.fn_compute_order_deadline(p_anchor, 7);
  v_expires := v_dismantle - interval '2 days';
  RETURN QUERY SELECT v_expires, v_dismantle;
END;
$$;

COMMENT ON FUNCTION public.fn_order_deadlines_for_customer(uuid, timestamptz) IS
  '320: expires_at + dismantle_at (7 días hábiles) para checkout/envío/retiro común. 36h solo vía local_deferred_pickup.';

-- Corregir pedidos abiertos no diferidos con dismantle_at corto (herencia 307).
UPDATE public.orders o
SET
  dismantle_at = d.dismantle_at,
  expires_at = d.expires_at
FROM LATERAL public.fn_order_deadlines_for_customer(o.customer_id, o.created_at) d
WHERE coalesce(o.local_deferred_pickup, false) = false
  AND o.status IN ('active', 'closing_soon')
  AND o.dismantle_at IS NOT NULL
  AND o.dismantle_at < o.created_at + interval '6 days';
