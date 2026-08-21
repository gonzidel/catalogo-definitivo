-- 273_cod_reconciliation_rls.sql
--
-- Fase 1 — RLS + grants para tablas COD de conciliación.
--
-- Modelo (alineado con 208_rls_hardening_*):
--   - ENABLE RLS en las 4 tablas.
--   - SELECT para authenticated SOLO si has_permission(..., 'conciliacion-reembolso', 'view').
--     super_admin pasa automáticamente por has_permission().
--   - SIN policies de INSERT/UPDATE/DELETE para authenticated (ni anon).
--     Mutaciones futuras: solo RPCs SECURITY DEFINER (fases 3+).
--   - REVOKE ALL from PUBLIC/anon; GRANT SELECT a authenticated; GRANT ALL a service_role.
--
-- Infraestructura del permission_key 'conciliacion-reembolso':
--   - No requiere DDL en admin_permissions (permission_key es text libre).
--   - super_admin ya tiene bypass vía is_super_admin() dentro de has_permission().
--   - Otorgar a colaboradores = INSERT/UPSERT en admin_permissions (mutación de datos;
--     NO se ejecuta en esta migración; requiere aprobación explícita aparte).
--
-- Idempotente.

-- =============================================================================
-- Helper: aplicar RLS + SELECT policy a una tabla COD
-- =============================================================================

DO $$
DECLARE
  t text;
  policy_name text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cod_remittances',
    'cod_remittance_rows',
    'cod_irregularities',
    'cod_reconciliation_events'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE '%: tabla no existe, omitiendo RLS', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);

    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);

    -- authenticated: solo SELECT (sin INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER).
    -- TRUNCATE no pasa por RLS en Postgres; hay que revocarlo explícitamente.
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM authenticated',
      t
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    -- Reafirmar SELECT tras el REVOKE amplio (por si el orden de grants importara)
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);

    policy_name := t || '_select_permission';

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = t
        AND policyname = policy_name
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

    RAISE NOTICE '%: RLS ON + policy SELECT has_permission(view)', t;
  END LOOP;
END $$;

-- =============================================================================
-- Defensa explícita: ninguna policy de escritura en estas tablas
-- (documentación + verificación; no se crean policies INSERT/UPDATE/DELETE)
-- =============================================================================

DO $$
DECLARE
  write_policies int;
BEGIN
  SELECT count(*) INTO write_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'cod_remittances',
      'cod_remittance_rows',
      'cod_irregularities',
      'cod_reconciliation_events'
    )
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');

  IF write_policies > 0 THEN
    RAISE EXCEPTION
      'COD reconciliation RLS: se detectaron % policies de escritura inesperadas',
      write_policies;
  END IF;

  RAISE NOTICE 'COD reconciliation RLS: OK — 0 policies de escritura';
END $$;
