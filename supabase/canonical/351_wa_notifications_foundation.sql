-- 351_wa_notifications_foundation.sql
--
-- Base de datos para avisos automáticos de WhatsApp (YCloud) — Fase 1.
-- Solo crea tablas vacías + RLS. NO instala pg_net, NO agenda ningún cron,
-- NO abre conexión a internet: nada de esto puede enviar un mensaje todavía.
--
-- Contexto: doc plan de usuario (memoria de sesión "Plan YCloud/WhatsApp").
-- Primer canal a conectar: Fati (número usado hoy para casi todo). Ani después.
--
-- Rollback: 351_ROLLBACK_wa_notifications_foundation.sql
-- Tests: 351_wa_notifications_foundation_tests.sql
--
-- Antes de aplicar en producción: presentar SQL, riesgo, rollback y
-- verificación (regla FYL Supabase Production Safety).

-- =============================================================================
-- A) wa_settings — fila única, controla el interruptor general
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wa_settings (
  id boolean PRIMARY KEY DEFAULT true,
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'shadow', 'whitelist', 'live')),
  launch_cutoff_at timestamptz,
  daily_cap int NOT NULL DEFAULT 50 CHECK (daily_cap >= 0),
  whitelist_phones text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT wa_settings_singleton CHECK (id)
);

COMMENT ON TABLE public.wa_settings IS
  '351: interruptor único de avisos WhatsApp. mode=off no envía nada. '
  'launch_cutoff_at evita reenviar el historial de pedidos ya vencidos al encender.';

INSERT INTO public.wa_settings (id, mode) VALUES (true, 'off')
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- B) wa_channels — un canal por dueña (Ani / Fati)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wa_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key text NOT NULL UNIQUE CHECK (owner_key IN ('ani', 'fati')),
  display_name text NOT NULL,
  phone_e164 text,
  ycloud_channel_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'disconnected')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wa_channels IS
  '351: mapea customers.kanban_inbox_owner (ani|fati) al número/canal YCloud real. '
  'phone_e164 y ycloud_channel_id se completan a mano cuando se conecta cada número.';

INSERT INTO public.wa_channels (owner_key, display_name, is_default)
VALUES
  ('fati', 'Fati', true),
  ('ani', 'Ani', false)
ON CONFLICT (owner_key) DO NOTHING;

-- =============================================================================
-- C) wa_outbox — cola de avisos (encolados por 352, despachados en fase 2)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wa_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('order_expiring_soon', 'order_expired')),
  dismantle_at timestamptz NOT NULL,
  channel_owner text NOT NULL CHECK (channel_owner IN ('ani', 'fati')),
  to_phone_e164 text NOT NULL,
  customer_name text,
  order_number text,
  template_name text NOT NULL,
  template_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  preview_text text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  skip_reason text,
  ycloud_message_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotencia: un pedido puede prorrogarse (nuevo dismantle_at) y generar
  -- un aviso nuevo, pero nunca dos avisos del mismo tipo para el mismo plazo.
  UNIQUE (order_id, kind, dismantle_at)
);

COMMENT ON TABLE public.wa_outbox IS
  '351: cola de avisos de vencimiento. Fase 1 solo la llena (352); nada la '
  'despacha todavía — eso es la Edge Function wa-dispatch de una fase futura.';

CREATE INDEX IF NOT EXISTS idx_wa_outbox_queued
  ON public.wa_outbox (created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_wa_outbox_order
  ON public.wa_outbox (order_id);

-- =============================================================================
-- D) wa_webhook_events — eventos crudos que devuelva YCloud (fase 2 los llena)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wa_webhook_events (
  event_id text PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wa_webhook_events IS
  '351: log crudo de eventos del webhook de YCloud (estados de entrega, '
  'mensajes entrantes). Vacía hasta que exista el endpoint wa-webhook.';

-- =============================================================================
-- E) updated_at — reutiliza public.set_updated_at() (ya existe, ver customers.sql)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'wa_settings_set_updated_at'
  ) THEN
    CREATE TRIGGER wa_settings_set_updated_at
      BEFORE UPDATE ON public.wa_settings
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'wa_channels_set_updated_at'
  ) THEN
    CREATE TRIGGER wa_channels_set_updated_at
      BEFORE UPDATE ON public.wa_channels
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'wa_outbox_set_updated_at'
  ) THEN
    CREATE TRIGGER wa_outbox_set_updated_at
      BEFORE UPDATE ON public.wa_outbox
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- =============================================================================
-- F) RLS — solo admins ven esto. Escritura de outbox/webhook_events solo por
-- funciones SECURITY DEFINER o service_role (Edge Functions), nunca directo.
-- =============================================================================

ALTER TABLE public.wa_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_webhook_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'wa_settings'
      AND policyname = 'wa_settings_admin_all'
  ) THEN
    CREATE POLICY wa_settings_admin_all
      ON public.wa_settings
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'wa_channels'
      AND policyname = 'wa_channels_admin_all'
  ) THEN
    CREATE POLICY wa_channels_admin_all
      ON public.wa_channels
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'wa_outbox'
      AND policyname = 'wa_outbox_admin_select'
  ) THEN
    CREATE POLICY wa_outbox_admin_select
      ON public.wa_outbox
      FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'wa_webhook_events'
      AND policyname = 'wa_webhook_events_admin_select'
  ) THEN
    CREATE POLICY wa_webhook_events_admin_select
      ON public.wa_webhook_events
      FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;
END $$;

SELECT pg_notify('pgrst', 'reload schema');
