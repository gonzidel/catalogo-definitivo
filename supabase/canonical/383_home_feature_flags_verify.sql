-- 383_home_feature_flags_verify.sql
-- Verificación de SOLO LECTURA posterior a aplicar 383_home_feature_flags.sql.

-- 1) La fila semilla existe y está apagada (o en el estado que dejó el admin).
select key, enabled, updated_at from public.home_feature_flags order by key;

-- 2) RLS activo y políticas esperadas (read público + insert/update admin; sin delete).
select c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'home_feature_flags';

select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'home_feature_flags'
order by policyname;

-- 3) Grants: anon solo SELECT; authenticated SELECT/INSERT/UPDATE; sin DELETE/TRUNCATE.
select grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'home_feature_flags'
  and grantee in ('anon', 'authenticated', 'service_role')
group by grantee
order by grantee;

-- 4) Probe anónimo equivalente al del frontend (ejecutar con la anon key vía REST):
--    GET /rest/v1/home_feature_flags?key=eq.home_offers_banner&select=enabled
