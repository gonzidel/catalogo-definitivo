-- 208b_audit_public_rls_exposure.sql
--
-- Auditoría READ-ONLY: detecta exposición pública por RLS desactivado o por
-- grants amplios en el schema `public`. Devuelve filas accionables para que el
-- equipo decida tabla por tabla. No modifica nada.
--
-- Pegar en SQL Editor de Supabase y revisar cada bloque.

-- =============================================================================
-- A) Tablas en public con RLS DESACTIVADO
-- =============================================================================
-- Tablas reales (no vistas, no foreign tables) sin RLS habilitado.
-- Cualquier fila aquí es candidata a revisión inmediata.

SELECT
  c.oid::regclass        AS tabla,
  c.relrowsecurity       AS rls_enabled,
  c.relforcerowsecurity  AS rls_forced,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
  r.rolname              AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles     r ON r.oid = c.relowner
WHERE n.nspname = 'public'
  AND c.relkind = 'r'                 -- solo tablas
  AND NOT c.relrowsecurity            -- RLS OFF
ORDER BY c.relname;

-- =============================================================================
-- B) Tablas con RLS habilitado pero SIN policies
-- =============================================================================
-- Equivale a "todo bloqueado para anon/authenticated" (solo service_role pasa).
-- Puede ser intencional (staging/backup) o un olvido. Revisar contexto.

SELECT
  c.oid::regclass AS tabla,
  c.relrowsecurity AS rls,
  c.relforcerowsecurity AS forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity
  AND NOT EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = n.nspname
      AND p.tablename  = c.relname
  )
ORDER BY c.relname;

-- =============================================================================
-- C) Tablas con GRANTs a anon (lectura/escritura desde el frontend público)
-- =============================================================================
-- Resalta toda combinación tabla x privilegio dada al rol anon.
-- Solo deberían aparecer vistas/tablas explícitamente "lectura pública".

SELECT
  rtg.table_schema,
  rtg.table_name,
  rtg.privilege_type,
  c.relkind  AS kind,              -- r = table, v = view
  c.relrowsecurity AS rls_on_base
FROM information_schema.role_table_grants rtg
JOIN pg_class     c ON c.relname = rtg.table_name
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = rtg.table_schema
WHERE rtg.grantee = 'anon'
  AND rtg.table_schema = 'public'
ORDER BY rtg.table_name, rtg.privilege_type;

-- =============================================================================
-- D) Tablas con GRANTs amplios (INSERT/UPDATE/DELETE) a authenticated
-- =============================================================================
-- Sin RLS o con policies permisivas, esto permite a cualquier login normal
-- modificar datos. Cruzar con el listado A para detectar combinaciones
-- "RLS OFF + escritura abierta" (riesgo crítico).

SELECT
  rtg.table_name,
  rtg.privilege_type,
  c.relrowsecurity AS rls_on
FROM information_schema.role_table_grants rtg
JOIN pg_class     c ON c.relname = rtg.table_name
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = rtg.table_schema
WHERE rtg.grantee = 'authenticated'
  AND rtg.table_schema = 'public'
  AND rtg.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
ORDER BY rtg.table_name, rtg.privilege_type;

-- =============================================================================
-- E) Funciones SECURITY DEFINER con grant EXECUTE a anon
-- =============================================================================
-- Estas funciones, si no validan internamente al caller, escalan privilegios.

SELECT
  p.oid::regprocedure       AS function_signature,
  r.rolname                 AS owner,
  p.prosecdef               AS security_definer,
  has_function_privilege('anon', p.oid, 'EXECUTE')           AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE')  AS auth_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles     r ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.prosecdef = true
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.proname;

-- =============================================================================
-- F) Vistas SECURITY DEFINER pendientes (deben ser INVOKER post-151)
-- =============================================================================

SELECT
  c.relname AS vista,
  CASE
    WHEN c.reloptions @> ARRAY['security_invoker=true']  THEN 'INVOKER'
    WHEN c.reloptions @> ARRAY['security_invoker=false'] THEN 'DEFINER'
    ELSE 'DEFAULT (DEFINER)'
  END AS security_mode,
  pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
ORDER BY c.relname;

-- =============================================================================
-- G) Resumen ejecutivo: tablas RLS OFF cruzadas con grants
-- =============================================================================
-- "Riesgo combinado": tablas con RLS OFF Y grants reales a anon o authenticated.
-- Estas son las más urgentes.

WITH rls_off AS (
  SELECT c.relname AS tabla
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT c.relrowsecurity
),
grants_by_table AS (
  SELECT
    table_name,
    grantee,
    string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  GROUP BY table_name, grantee
)
SELECT
  ro.tabla,
  g.grantee,
  g.privs
FROM rls_off ro
LEFT JOIN grants_by_table g ON g.table_name = ro.tabla
ORDER BY ro.tabla, g.grantee;
