-- 274_cod_reconciliation_revoke_extra_grants.sql
--
-- Complemento Fase 1: al crear tablas, Postgres deja privilegios por defecto
-- (TRUNCATE/REFERENCES/TRIGGER) a roles con USAGE. TRUNCATE no pasa por RLS,
-- así que se revoca todo excepto SELECT para authenticated.
-- Idempotente.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.cod_remittances FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.cod_remittance_rows FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.cod_irregularities FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.cod_reconciliation_events FROM authenticated;

REVOKE ALL ON TABLE public.cod_remittances FROM anon;
REVOKE ALL ON TABLE public.cod_remittance_rows FROM anon;
REVOKE ALL ON TABLE public.cod_irregularities FROM anon;
REVOKE ALL ON TABLE public.cod_reconciliation_events FROM anon;

GRANT SELECT ON TABLE public.cod_remittances TO authenticated;
GRANT SELECT ON TABLE public.cod_remittance_rows TO authenticated;
GRANT SELECT ON TABLE public.cod_irregularities TO authenticated;
GRANT SELECT ON TABLE public.cod_reconciliation_events TO authenticated;
