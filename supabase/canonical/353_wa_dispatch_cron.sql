-- 353_wa_dispatch_cron.sql
--
-- Fase 2: conecta la cola (wa_outbox) con las Edge Functions wa-dispatch /
-- wa-webhook vía pg_net + pg_cron. Sigue siendo seguro de aplicar con
-- wa_settings.mode='off': rpc_wa_cron_enqueue_expiry_events() no inserta
-- nada en ese modo, y rpc_wa_dispatch_trigger() no hace nada mientras
-- wa_settings.dispatch_function_url esté NULL (se completa a mano recién
-- cuando la Edge Function esté deployada y confirmada).
--
-- Deliberadamente NO se extiende el cron job 'orders-daily-maintenance'
-- (crítico, con historial de incidentes — ver docs 48/65). Se crea un job
-- nuevo y separado, mismo cadence (*/15 min), para aislar el radio de daño.
--
-- Corrige además un patrón de riesgo encontrado al diseñar esto: las
-- funciones que llama pg_cron no pueden depender de auth.uid() (no hay
-- sesión). rpc_wa_enqueue_expiry_events() (352) es admin-facing y se queda
-- así; para el cron se agrega una función interna separada
-- (rpc_wa_cron_enqueue_expiry_events) con la misma lógica pero sin el
-- chequeo de auth.uid(), con EXECUTE revocado explícitamente de
-- authenticated/anon (no solo de PUBLIC — ver hallazgo de 352b).
--
-- Rollback: 353_ROLLBACK_wa_dispatch_cron.sql
-- Tests: 353_wa_dispatch_cron_tests.sql

-- =============================================================================
-- A) pg_net
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

-- =============================================================================
-- B) wa_settings: URL de la función de despacho (se completa a mano en fase 2b,
-- cuando wa-dispatch esté deployada y confirmada por fuera de esta migración).
-- =============================================================================

ALTER TABLE public.wa_settings ADD COLUMN IF NOT EXISTS dispatch_function_url text;

-- =============================================================================
-- C) Secreto compartido cron -> wa-dispatch, en Supabase Vault (no en una
-- columna en texto plano). Generado una sola vez, idempotente.
-- =============================================================================

DO $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'wa_dispatch_cron_secret')
  INTO v_exists;

  IF NOT v_exists THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'wa_dispatch_cron_secret',
      'Secreto compartido entre rpc_wa_dispatch_trigger() (pg_cron) y la Edge '
      'Function wa-dispatch (header X-Cron-Secret). Copiar el mismo valor como '
      'secret WA_DISPATCH_CRON_SECRET de la función en el dashboard de Supabase. '
      'Rotar con vault.update_secret si se filtra.'
    );
  END IF;
END $$;

-- =============================================================================
-- D) rpc_wa_cron_enqueue_expiry_events — mismo trabajo que 352, sin chequeo de
-- auth.uid() (pg_cron no tiene sesión). Solo invocable por postgres/cron:
-- EXECUTE revocado explícitamente de authenticated y anon.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_wa_cron_enqueue_expiry_events()
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

COMMENT ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() IS
  '353: idéntica lógica a rpc_wa_enqueue_expiry_events (352), sin chequeo de '
  'admin — pensada solo para pg_cron. EXECUTE revocado de authenticated/anon.';

REVOKE ALL ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() FROM anon;

-- rpc_wa_enqueue_expiry_events (352, admin-facing) pasa a delegar acá para no
-- duplicar la lógica del loop en dos lugares.
CREATE OR REPLACE FUNCTION public.rpc_wa_enqueue_expiry_events()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  RETURN public.rpc_wa_cron_enqueue_expiry_events();
END;
$function$;

COMMENT ON FUNCTION public.rpc_wa_enqueue_expiry_events() IS
  '352/353: admin-only. Delega en rpc_wa_cron_enqueue_expiry_events() tras '
  'validar que quien llama es admin.';

REVOKE ALL ON FUNCTION public.rpc_wa_enqueue_expiry_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_wa_enqueue_expiry_events() TO authenticated;

-- =============================================================================
-- E) rpc_wa_dispatch_trigger — dispara wa-dispatch por HTTP (pg_net). No hace
-- nada mientras dispatch_function_url esté NULL o el secreto no exista.
-- Solo invocable por postgres/cron.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_wa_dispatch_trigger()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'extensions', 'net', 'vault'
AS $function$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT dispatch_function_url INTO v_url FROM public.wa_settings WHERE id = true;
  IF v_url IS NULL OR btrim(v_url) = '' THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'wa_dispatch_cron_secret'
  LIMIT 1;

  IF v_secret IS NULL THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    body := '{}'::jsonb
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_wa_dispatch_trigger() IS
  '353: dispara wa-dispatch (fire-and-forget, pg_net). No-op hasta que se '
  'setee wa_settings.dispatch_function_url y exista el secreto en Vault. '
  'Solo invocable por postgres/cron.';

REVOKE ALL ON FUNCTION public.rpc_wa_dispatch_trigger() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_wa_dispatch_trigger() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_wa_dispatch_trigger() FROM anon;

-- =============================================================================
-- F) Cron — job nuevo y separado de 'orders-daily-maintenance'.
-- =============================================================================

SELECT cron.schedule(
  'wa-notifications-dispatch',
  '*/15 * * * *',
  $$SELECT public.rpc_wa_cron_enqueue_expiry_events(); SELECT public.rpc_wa_dispatch_trigger();$$
);

SELECT pg_notify('pgrst', 'reload schema');
