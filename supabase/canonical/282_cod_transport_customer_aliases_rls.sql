-- 282_cod_transport_customer_aliases_rls.sql
--
-- RLS aliases COD — mismo patrón que 273/274.
-- SELECT con conciliacion-reembolso/view; sin policies DML.

DO $$
DECLARE
  t text := 'cod_transport_customer_aliases';
  policy_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = t
  ) THEN
    RAISE EXCEPTION 'cod_transport_customer_aliases no existe — aplicar 281 primero';
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  EXECUTE format(
    'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM authenticated',
    t
  );
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);

  policy_name := t || '_select_permission';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t AND policyname = policy_name
  ) THEN
    EXECUTE format(
      $pol$
      CREATE POLICY %I
        ON public.%I
        FOR SELECT
        TO authenticated
        USING (
          public.has_permission(auth.uid(), 'conciliacion-reembolso', 'view')
        )
      $pol$,
      policy_name,
      t
    );
  END IF;
END $$;

DO $$
DECLARE
  write_policies int;
BEGIN
  SELECT count(*) INTO write_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'cod_transport_customer_aliases'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');

  IF write_policies > 0 THEN
    RAISE EXCEPTION
      'COD aliases RLS: % policies de escritura inesperadas',
      write_policies;
  END IF;
END $$;
