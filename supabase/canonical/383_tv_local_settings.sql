-- 383_tv_local_settings.sql
-- Configuración de la pantalla TV del local (playlist YouTube).
-- Lectura pública (anon) para la TV; escritura solo admins.
-- Idempotente.

CREATE TABLE IF NOT EXISTS public.tv_local_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  youtube_playlist_id text,
  youtube_playlist_url text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.tv_local_settings IS
  'Singleton (id=1): playlist de YouTube para la pantalla TV del local.';

INSERT INTO public.tv_local_settings (id, youtube_playlist_id, youtube_playlist_url)
VALUES (1, null, null)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.tv_local_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tv_local_settings'
      AND policyname = 'tv_local_settings_public_select'
  ) THEN
    CREATE POLICY tv_local_settings_public_select
      ON public.tv_local_settings
      FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tv_local_settings'
      AND policyname = 'tv_local_settings_admin_update'
  ) THEN
    CREATE POLICY tv_local_settings_admin_update
      ON public.tv_local_settings
      FOR UPDATE
      TO authenticated
      USING (public.is_admin())
      WITH CHECK (public.is_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tv_local_settings'
      AND policyname = 'tv_local_settings_admin_insert'
  ) THEN
    CREATE POLICY tv_local_settings_admin_insert
      ON public.tv_local_settings
      FOR INSERT
      TO authenticated
      WITH CHECK (public.is_admin());
  END IF;
END $$;

REVOKE ALL ON TABLE public.tv_local_settings FROM PUBLIC;
REVOKE ALL ON TABLE public.tv_local_settings FROM anon;
REVOKE ALL ON TABLE public.tv_local_settings FROM authenticated;
GRANT SELECT ON TABLE public.tv_local_settings TO anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tv_local_settings TO authenticated;
-- Sin DELETE: la fila singleton no debe borrarse desde el cliente.

SELECT pg_notify('pgrst', 'reload schema');
