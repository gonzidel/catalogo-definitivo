-- 365_ROLLBACK_color_offers_reprice_open_orders.sql
-- Quita trigger, cron y funciones. Las líneas ya repreciadas no vuelven al
-- precio anterior (no se guarda histórico); revisar con updated_at si hace falta.

DO $$
BEGIN
  PERFORM cron.unschedule('color-offers-reprice-open-orders');
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END $$;

DROP TRIGGER IF EXISTS trg_color_offers_reprice_open_orders ON public.color_price_offers;
DROP FUNCTION IF EXISTS public.trg_color_offers_reprice_open_orders();
DROP FUNCTION IF EXISTS public.fn_apply_color_offers_to_open_orders(uuid);
