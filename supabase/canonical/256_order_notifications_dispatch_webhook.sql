-- 256_order_notifications_dispatch_webhook.sql
--
-- Consumidor real para el outbox public.order_notifications. Hoy esa tabla
-- se llena (DAY_4, DAY_6, DAY_7, DAY_11, DAY_13, MIN_REACHED, MIN_MISSING,
-- EXPIRED — ver 123_order_expiry_and_notifications.sql) pero nada la lee:
-- evidencia en fyl-core: 127 filas, 0 con sent_at.
--
-- Este mecanismo despacha (best-effort, via pg_net) cada notificacion
-- pendiente a un webhook de n8n, que se encarga de armar y enviar el
-- mensaje real (WhatsApp u otro canal). La URL del webhook se guarda en
-- app_settings en vez de hardcodearse en la funcion, para poder
-- configurarla/rotarla sin una migracion nueva.
--
-- IMPORTANTE: hasta que se configure la URL real (ver paso final), la
-- funcion no hace nada (retorna 0) — no falla ni bloquea el cron.

CREATE EXTENSION IF NOT EXISTS pg_net;

-- =============================================================================
-- A) Tabla de configuracion simple (key/value), sin acceso publico.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
-- Sin policies definidas a proposito: anon/authenticated no tienen ningun
-- acceso (RLS deniega todo por default). Solo service_role o funciones
-- SECURITY DEFINER (como la de abajo) pueden leer/escribir.

INSERT INTO public.app_settings (key, value)
VALUES ('n8n_order_notifications_webhook_url', '')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- B) Funcion de despacho
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rpc_dispatch_pending_order_notifications()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, extensions, net
AS $$
DECLARE
  v_webhook_url text;
  v_row record;
  v_dispatched int := 0;
BEGIN
  SELECT value INTO v_webhook_url
  FROM public.app_settings
  WHERE key = 'n8n_order_notifications_webhook_url';

  IF v_webhook_url IS NULL OR btrim(v_webhook_url) = '' THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT
      n.id, n.order_id, n.customer_id, n.type, n.channel, n.payload,
      c.phone, c.full_name
    FROM public.order_notifications n
    LEFT JOIN public.customers c ON c.id = n.customer_id
    WHERE n.sent_at IS NULL
    ORDER BY n.created_at
    LIMIT 50
  LOOP
    PERFORM net.http_post(
      url := v_webhook_url,
      body := jsonb_build_object(
        'notification_id', v_row.id,
        'order_id', v_row.order_id,
        'customer_id', v_row.customer_id,
        'customer_phone', v_row.phone,
        'customer_name', v_row.full_name,
        'type', v_row.type,
        'channel', v_row.channel,
        'payload', v_row.payload
      )
    );

    -- Fire-and-forget: pg_net encola el request de forma asincronica, no
    -- hay respuesta sincronica para confirmar entrega. Se marca sent_at al
    -- encolar (evita reintentos infinitos si n8n tarda o el webhook está
    -- mal configurado). Si en el futuro se necesita confirmar entrega real,
    -- se puede leer net.http_response por request_id en un job aparte.
    UPDATE public.order_notifications SET sent_at = now() WHERE id = v_row.id;
    v_dispatched := v_dispatched + 1;
  END LOOP;

  RETURN v_dispatched;
END;
$$;

COMMENT ON FUNCTION public.rpc_dispatch_pending_order_notifications() IS
  'Despacha (pg_net, fire-and-forget) notificaciones pendientes de order_notifications a app_settings.n8n_order_notifications_webhook_url. No hace nada si la URL no esta configurada.';

-- =============================================================================
-- C) Cron: reintenta cada 5 minutos
-- =============================================================================
DO $$
BEGIN
  PERFORM cron.unschedule('order-notifications-dispatch');
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END $$;

SELECT cron.schedule(
  'order-notifications-dispatch',
  '*/5 * * * *',
  $$SELECT public.rpc_dispatch_pending_order_notifications();$$
);

SELECT pg_notify('pgrst', 'reload schema');

-- =============================================================================
-- D) Paso manual pendiente (fuera de esta migracion):
-- Cuando el webhook de n8n este creado, correr una sola vez:
--   UPDATE public.app_settings
--   SET value = 'https://<n8n-host>/webhook/order-notifications', updated_at = now()
--   WHERE key = 'n8n_order_notifications_webhook_url';
-- =============================================================================
