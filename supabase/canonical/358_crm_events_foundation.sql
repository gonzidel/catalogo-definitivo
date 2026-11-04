-- 358_crm_events_foundation.sql
--
-- Fase 1 del CRM automático (YCloud): empuja eventos de negocio (por ahora,
-- solo "un cliente hizo un pedido") desde Supabase hacia el sistema de
-- Eventos Personalizados de YCloud (Custom Events API), para que sus propios
-- Journeys puedan segmentar contactos solos, sin que Ani/Fati etiqueten nada
-- a mano. Ver docs/FYL-Obsidian/68-CRM-AUTOMATICO-YCLOUD-2026-09-23.md.
--
-- 100% inerte al aplicar: crm_settings.mode arranca en 'off'. El trigger en
-- orders solo ENCOLA en crm_event_outbox (no llama a nadie); el despacho
-- real es un cron separado que no hace nada hasta setear
-- dispatch_function_url + mode='on' (mismo patrón que 353_wa_dispatch_cron.sql).
--
-- Rollback: 358_ROLLBACK_crm_events_foundation.sql
-- Tests: 358_crm_events_foundation_tests.sql

CREATE TABLE IF NOT EXISTS public.crm_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'on')),
  dispatch_function_url text,
  daily_cap int NOT NULL DEFAULT 500 CHECK (daily_cap >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

INSERT INTO public.crm_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.crm_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_settings_admin_all ON public.crm_settings
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));

COMMENT ON TABLE public.crm_settings IS
  '358: interruptor único del despacho de eventos CRM hacia YCloud. mode=off '
  'por defecto: el trigger de orders sigue encolando en crm_event_outbox, '
  'pero nada sale hacia YCloud hasta pasar a on.';

CREATE TABLE IF NOT EXISTS public.crm_event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name text NOT NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  contact_phone_e164 text,
  occur_time timestamptz NOT NULL DEFAULT now(),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  ycloud_response jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_name, order_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_event_outbox_status ON public.crm_event_outbox (status, created_at);

ALTER TABLE public.crm_event_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_event_outbox_admin_select ON public.crm_event_outbox
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));

COMMENT ON TABLE public.crm_event_outbox IS
  '358: cola de eventos personalizados para YCloud (Custom Events API). '
  'UNIQUE(event_name, order_id): un pedido genera como máximo un evento '
  'order_placed, sin duplicados aunque el trigger o el dispatch se reintenten.';

CREATE OR REPLACE FUNCTION public.trg_orders_enqueue_crm_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_phone_e164 text;
BEGIN
  SELECT public.fn_wa_phone_e164(c.phone) INTO v_phone_e164
  FROM public.customers c WHERE c.id = NEW.customer_id;

  INSERT INTO public.crm_event_outbox (
    event_name, order_id, customer_id, contact_phone_e164, occur_time, properties
  ) VALUES (
    'order_placed', NEW.id, NEW.customer_id, v_phone_e164, NEW.created_at,
    jsonb_build_object(
      'order_number', NEW.order_number,
      'total_amount', NEW.total_amount,
      'source', NEW.source
    )
  )
  ON CONFLICT (event_name, order_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.trg_orders_enqueue_crm_event() IS
  '358: encola order_placed en crm_event_outbox por cada pedido nuevo. Si el '
  'cliente no tiene teléfono válido (fn_wa_phone_e164 -> NULL), igual encola '
  '(contact_phone_e164 NULL) -> el dispatch lo marca skipped explícitamente, '
  'sin perder el registro.';

DROP TRIGGER IF EXISTS orders_after_insert_enqueue_crm_event ON public.orders;
CREATE TRIGGER orders_after_insert_enqueue_crm_event
  AFTER INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_orders_enqueue_crm_event();

-- =============================================================================
-- pg_net + cron para el despacho real hacia la Edge Function (crm-events-dispatch,
-- todavía no deployada en este punto de la migración). Mismo patrón que 353.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'crm_dispatch_cron_secret')
  INTO v_exists;

  IF NOT v_exists THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'crm_dispatch_cron_secret',
      'Secreto compartido entre rpc_crm_dispatch_trigger() (pg_cron) y la Edge '
      'Function crm-events-dispatch (header X-Cron-Secret). Copiar el mismo '
      'valor como secret CRM_DISPATCH_CRON_SECRET de la función en el '
      'dashboard de Supabase.'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_crm_dispatch_trigger()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'extensions', 'net', 'vault'
AS $function$
DECLARE
  v_url text;
  v_mode text;
  v_secret text;
BEGIN
  SELECT dispatch_function_url, mode INTO v_url, v_mode FROM public.crm_settings WHERE id = true;
  IF v_url IS NULL OR btrim(v_url) = '' OR v_mode = 'off' THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'crm_dispatch_cron_secret'
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

COMMENT ON FUNCTION public.rpc_crm_dispatch_trigger() IS
  '358: dispara crm-events-dispatch (fire-and-forget, pg_net). No-op mientras '
  'crm_settings.dispatch_function_url esté NULL o mode=off. Solo invocable '
  'por postgres/cron.';

REVOKE ALL ON FUNCTION public.rpc_crm_dispatch_trigger() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_crm_dispatch_trigger() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_crm_dispatch_trigger() FROM anon;

SELECT cron.schedule(
  'crm-events-dispatch',
  '*/15 * * * *',
  $$SELECT public.rpc_crm_dispatch_trigger();$$
);

SELECT pg_notify('pgrst', 'reload schema');
