-- 362_rollout_experience_verify.sql
-- Consultas de verificación post-aplicación. Solo lectura.

-- 1) Objetos creados
SELECT c.relname, c.relrowsecurity AS rls,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('rollout_config', 'rollout_grants', 'rollout_daily_counter');
-- Esperado: 3 filas, rls = true, policies = 0.

-- 2) Privilegios de tablas (anon/authenticated no deben aparecer)
SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name LIKE 'rollout_%'
GROUP BY 1, 2 ORDER BY 1, 2;

-- 3) Privilegios de funciones (solo postgres/service_role con EXECUTE)
SELECT p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
       p.prosecdef AS security_definer,
       p.proconfig
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE '%rollout%'
ORDER BY 1;
-- Esperado: anon = false, authenticated = false, service_role = true,
-- security_definer = false, proconfig = {search_path=""}.

-- 4) Config
SELECT * FROM public.rollout_config;
-- Esperado tras aplicar: mode = paused, daily_quota = 15.

-- 5) Clasificación del seed (revisión individual)
SELECT g.source, a.role AS admin_role, u.email, c.full_name, g.grant_day
FROM public.rollout_grants g
JOIN auth.users u ON u.id = g.auth_user_id
LEFT JOIN public.admins a ON a.user_id = g.auth_user_id
LEFT JOIN public.customers c ON c.id = g.auth_user_id
WHERE g.note = 'seed:362'
ORDER BY g.source, u.email;

SELECT source, count(*) FROM public.rollout_grants WHERE note = 'seed:362' GROUP BY 1 ORDER BY 1;
-- Esperado al 2026-09-29: admin 1, staff 9, tester 41.

-- 6) Cuentas sin grant (debe ser 0 justo después del seed)
SELECT count(*) AS users_without_grant
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.rollout_grants g
                  WHERE g.auth_user_id = u.id AND g.revoked_at IS NULL);

-- 7) Contador vs grants quota (deben coincidir día por día)
SELECT d.day, d.granted AS counter,
       (SELECT count(*) FROM public.rollout_grants g
        WHERE g.source = 'quota' AND g.grant_day = d.day) AS quota_grants
FROM public.rollout_daily_counter d
ORDER BY d.day DESC
LIMIT 30;

-- 8) Cohorte cuota (Fase 2): seleccionadas → registro → carrito → pedido.
-- Excluye staff/testers por construcción (solo source = quota).
SELECT g.grant_day,
       count(*) AS selected,
       count(g.auth_user_id) AS registered,
       count(DISTINCT ca.customer_id) AS with_cart,
       count(DISTINCT o.customer_id) AS with_order
FROM public.rollout_grants g
LEFT JOIN public.carts ca ON ca.customer_id = g.auth_user_id
LEFT JOIN public.orders o ON o.customer_id = g.auth_user_id AND o.created_at >= g.granted_at
WHERE g.source = 'quota' AND g.revoked_at IS NULL
GROUP BY g.grant_day
ORDER BY g.grant_day DESC;
