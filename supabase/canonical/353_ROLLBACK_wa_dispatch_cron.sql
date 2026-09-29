-- 353_ROLLBACK_wa_dispatch_cron.sql
-- Revierte 353. Deja 351/352 intactos (rpc_wa_enqueue_expiry_events vuelve a
-- su versión de 352, sin depender de la función de cron que se dropea acá).

SELECT cron.unschedule('wa-notifications-dispatch');

DROP FUNCTION IF EXISTS public.rpc_wa_dispatch_trigger();

-- Restaura rpc_wa_enqueue_expiry_events a la versión de 352 (lógica inline,
-- sin delegar en rpc_wa_cron_enqueue_expiry_events).
CREATE OR REPLACE FUNCTION public.rpc_wa_enqueue_expiry_events()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_settings record;
  v_today_count int;
  v_remaining int;
  v_inserted int := 0;
  v_row record;
  v_template text;
  v_preview text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  SELECT * INTO v_settings FROM public.wa_settings WHERE id = true;

  IF v_settings.mode = 'off' THEN
    RETURN json_build_object('ok', true, 'mode', 'off', 'inserted', 0);
  END IF;

  SELECT count(*) INTO v_today_count
  FROM public.wa_outbox
  WHERE created_at >= date_trunc('day', now());

  v_remaining := greatest(0, v_settings.daily_cap - v_today_count);

  FOR v_row IN
    SELECT * FROM public.fn_wa_expiry_candidates() c WHERE c.skip_reason IS NULL
  LOOP
    EXIT WHEN v_remaining <= 0;

    IF v_settings.mode = 'whitelist' AND NOT EXISTS (
      SELECT 1 FROM unnest(v_settings.whitelist_phones) x
      WHERE public.normalize_phone_digits_for_match(x) = public.normalize_phone_digits_for_match(v_row.phone_e164)
    ) THEN
      CONTINUE;
    END IF;

    v_template := CASE v_row.kind
      WHEN 'order_expiring_soon' THEN 'pedido_por_vencer'
      ELSE 'pedido_vencido'
    END;

    v_preview := CASE v_row.kind
      WHEN 'order_expiring_soon' THEN
        'Hola 👋 Tu pedido ' || coalesce(v_row.order_number, '') || ' se vence mañana a las 17:00 hs.'
      ELSE
        'Hola 👋 Tu pedido ' || coalesce(v_row.order_number, '') || ' venció y el stock reservado se liberó.' || E'\n\n'
        || 'Cualquier consulta, respondé este mensaje 😊'
    END;

    INSERT INTO public.wa_outbox (
      order_id, kind, dismantle_at, channel_owner, to_phone_e164,
      customer_name, order_number, template_name, template_params,
      preview_text, status
    ) VALUES (
      v_row.order_id, v_row.kind, v_row.dismantle_at, v_row.channel_owner, v_row.phone_e164,
      v_row.customer_name, v_row.order_number, v_template,
      jsonb_build_array(coalesce(v_row.order_number, '')),
      v_preview, 'queued'
    )
    ON CONFLICT (order_id, kind, dismantle_at) DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
      v_remaining := v_remaining - 1;
    END IF;
  END LOOP;

  RETURN json_build_object(
    'ok', true,
    'mode', v_settings.mode,
    'inserted', v_inserted,
    'daily_cap_remaining', v_remaining
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_wa_enqueue_expiry_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_wa_enqueue_expiry_events() TO authenticated;

DROP FUNCTION IF EXISTS public.rpc_wa_cron_enqueue_expiry_events();

ALTER TABLE public.wa_settings DROP COLUMN IF EXISTS dispatch_function_url;

-- El secreto en Vault se deja (es un valor aleatorio sin uso, no hace daño
-- dejarlo). Borrar a mano solo si se quiere limpieza total:
--   DELETE FROM vault.secrets WHERE name = 'wa_dispatch_cron_secret';

-- DROP EXTENSION pg_net solo si nada más en el proyecto empezó a usarla
-- mientras tanto (verificar antes de descomentar):
-- DROP EXTENSION IF EXISTS pg_net;

SELECT pg_notify('pgrst', 'reload schema');
