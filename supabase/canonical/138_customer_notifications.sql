-- 138_customer_notifications.sql
-- Notificaciones para clientes (campana en index.html).
-- Idempotente + RLS + Realtime.

CREATE TABLE IF NOT EXISTS public.customer_notifications (
  id bigserial primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  order_id uuid null references public.orders(id) on delete cascade,
  type text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz null
);

CREATE INDEX IF NOT EXISTS idx_customer_notifications_customer_created
  ON public.customer_notifications (customer_id, created_at desc);

CREATE INDEX IF NOT EXISTS idx_customer_notifications_customer_unread
  ON public.customer_notifications (customer_id, created_at desc)
  WHERE read = false;

ALTER TABLE public.customer_notifications ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- Policies (idempotentes)
-- =============================================================================
DO $$
BEGIN
  -- Cliente: ver solo sus notificaciones
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'customer_notifications'
      AND policyname = 'customer_notifications_customer_select_own'
  ) THEN
    CREATE POLICY customer_notifications_customer_select_own
      ON public.customer_notifications
      FOR SELECT TO authenticated
      USING (customer_id = auth.uid());
  END IF;

  -- Cliente: marcar como leído solo sus notificaciones (no puede cambiar el customer_id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'customer_notifications'
      AND policyname = 'customer_notifications_customer_update_read_own'
  ) THEN
    CREATE POLICY customer_notifications_customer_update_read_own
      ON public.customer_notifications
      FOR UPDATE TO authenticated
      USING (customer_id = auth.uid())
      WITH CHECK (customer_id = auth.uid());
  END IF;

  -- Admin: CRUD total
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'customer_notifications'
      AND policyname = 'customer_notifications_admin_all'
  ) THEN
    CREATE POLICY customer_notifications_admin_all
      ON public.customer_notifications
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;
END $$;

-- =============================================================================
-- Realtime publication
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'customer_notifications'
      AND schemaname = 'public'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customer_notifications;
  END IF;
END $$;

