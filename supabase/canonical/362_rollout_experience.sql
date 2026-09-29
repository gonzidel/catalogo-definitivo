-- 362_rollout_experience.sql
-- Rollout de experiencia `full` / `catalog` en nj/ (Fase 0: preparado, NO aplicado).
--
-- Objetos nuevos (no toca tablas ni RPC existentes):
--   public.rollout_config         config de una fila (mode, daily_quota)
--   public.rollout_grants         asignaciones `full` persistentes (fuente de verdad)
--   public.rollout_daily_counter  contador atómico de grants `quota` por día ART
--   public.rpc_rollout_resolve    decide experiencia de un visitante (middleware)
--   public.rpc_rollout_link_user  vincula visitante ↔ cuenta al loguear (auth/callback)
--
-- Reglas:
--   * `catalog` NUNCA se persiste: sin fila = catalog. La cookie firmada vence al fin del día ART.
--   * Solo source='quota' consume rollout_daily_counter.
--   * Loguearse no concede full: rpc_rollout_link_user solo vincula o reconoce grants existentes
--     (excepciones: staff/admin verificado y mode='open_all', donde todos reciben full).
--   * mode='kill' no borra nada: devuelve catalog pero conserva grants y vínculos.
--   * Todo ejecutable solo por service_role (server-side). RLS activo, sin policies para anon/authenticated.
--
-- No toca: checkout, carrito, stock, sellable, reservas, pedidos, auth.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0) Precondición: las RPC son SECURITY INVOKER y leen public.admins como service_role
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT has_table_privilege('service_role', 'public.admins', 'SELECT') THEN
    RAISE EXCEPTION '362: service_role necesita SELECT en public.admins';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) rollout_config
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rollout_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode text NOT NULL DEFAULT 'paused'
    CHECK (mode IN ('paused', 'quota', 'open_all', 'kill')),
  daily_quota integer NOT NULL DEFAULT 15
    CHECK (daily_quota >= 0 AND daily_quota <= 10000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NULL,
  note text NULL
);

COMMENT ON TABLE public.rollout_config IS
  'Rollout full/catalog de nj/. Una fila. mode: paused|quota|open_all|kill. canonical:362.';

-- Arranca en paused: nadie nuevo entra por cuota hasta Fase 2.
INSERT INTO public.rollout_config (id, mode, daily_quota, updated_by, note)
VALUES (1, 'paused', 15, 'migration:362', 'Estado inicial Fase 0/1: sin admisiones por cuota')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) rollout_grants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rollout_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id uuid NULL,
  auth_user_id uuid NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  source text NOT NULL
    CHECK (source IN ('quota', 'tester', 'tester_link', 'staff', 'admin', 'open_all', 'manual')),
  grant_day date NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  linked_at timestamptz NULL,
  revoked_at timestamptz NULL,
  note text NULL,
  CONSTRAINT rollout_grants_identity_chk
    CHECK (visitor_id IS NOT NULL OR auth_user_id IS NOT NULL)
);

COMMENT ON TABLE public.rollout_grants IS
  'Asignaciones full persistentes. Sin fila activa = catalog. canonical:362.';
COMMENT ON COLUMN public.rollout_grants.grant_day IS
  'Día calendario America/Argentina/Buenos_Aires en que se concedió.';
COMMENT ON COLUMN public.rollout_grants.revoked_at IS
  'Revocación manual. mode=kill NO revoca: solo cambia la respuesta de resolve.';

-- Un grant activo por visitante y uno por cuenta.
CREATE UNIQUE INDEX IF NOT EXISTS rollout_grants_visitor_active_uq
  ON public.rollout_grants (visitor_id)
  WHERE visitor_id IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS rollout_grants_user_active_uq
  ON public.rollout_grants (auth_user_id)
  WHERE auth_user_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS rollout_grants_source_day_idx
  ON public.rollout_grants (source, grant_day);

-- ---------------------------------------------------------------------------
-- 3) rollout_daily_counter
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rollout_daily_counter (
  day date PRIMARY KEY,
  granted integer NOT NULL DEFAULT 0 CHECK (granted >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rollout_daily_counter IS
  'Grants source=quota por día ART. Incremento atómico en rpc_rollout_resolve. canonical:362.';

-- ---------------------------------------------------------------------------
-- 4) Seguridad: RLS + solo service_role
-- ---------------------------------------------------------------------------
ALTER TABLE public.rollout_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rollout_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rollout_daily_counter ENABLE ROW LEVEL SECURITY;

-- Hasta 2026-10-30 Supabase auto-otorga a anon/authenticated en tablas nuevas: revocar explícito.
REVOKE ALL ON TABLE public.rollout_config FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rollout_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rollout_daily_counter FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rollout_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rollout_grants TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rollout_daily_counter TO service_role;

-- ---------------------------------------------------------------------------
-- 5) Helpers internos
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_rollout_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
$$;

COMMENT ON FUNCTION public.fn_rollout_today() IS
  'Día calendario ART usado por el rollout. canonical:362.';

-- Staff según public.admins: super_admin → admin; cualquier otro rol → staff; no admin → NULL.
CREATE OR REPLACE FUNCTION public.fn_rollout_staff_source(p_auth_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN bool_or(a.role = 'super_admin') THEN 'admin'
    WHEN count(*) > 0 THEN 'staff'
    ELSE NULL
  END
  FROM public.admins a
  WHERE p_auth_user_id IS NOT NULL
    AND a.user_id = p_auth_user_id;
$$;

COMMENT ON FUNCTION public.fn_rollout_staff_source(uuid) IS
  'admin|staff|NULL según public.admins. canonical:362.';

CREATE OR REPLACE FUNCTION public.fn_rollout_result(
  p_experience text,
  p_reason text,
  p_grant public.rollout_grants,
  p_day date
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'experience', p_experience,
    'reason', p_reason,
    'has_grant', (p_grant).id IS NOT NULL,
    'source', (p_grant).source,
    'grant_id', (p_grant).id,
    'day', p_day
  );
$$;

-- ---------------------------------------------------------------------------
-- 6) rpc_rollout_resolve
-- ---------------------------------------------------------------------------
-- p_visitor_id    cookie fyl_vid (uuid generado server-side)
-- p_auth_user_id  solo si el servidor verificó la sesión (getUser); si no, NULL
-- p_source_hint   'tester_link' cuando la visita entra por /nj; si no, NULL
--
-- Orden de decisión:
--   1. grant activo (por visitante o por cuenta) → full (o catalog si kill; el grant se conserva)
--   2. kill → catalog
--   3. staff/admin verificado → grant admin|staff → full
--   4. tester_link → grant tester_link → full
--   5. open_all → grant open_all → full
--   6. quota con cupo → grant quota + contador → full
--   7. si no → catalog (no se persiste)
CREATE OR REPLACE FUNCTION public.rpc_rollout_resolve(
  p_visitor_id uuid,
  p_auth_user_id uuid DEFAULT NULL,
  p_source_hint text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_day date := public.fn_rollout_today();
  v_mode text;
  v_quota integer;
  v_grant public.rollout_grants;
  v_staff text;
  v_counter integer;
BEGIN
  IF p_visitor_id IS NULL THEN
    RAISE EXCEPTION 'p_visitor_id requerido' USING ERRCODE = '22023';
  END IF;
  IF p_source_hint IS NOT NULL AND p_source_hint <> 'tester_link' THEN
    RAISE EXCEPTION 'p_source_hint inválido: %', p_source_hint USING ERRCODE = '22023';
  END IF;

  SELECT c.mode, c.daily_quota INTO v_mode, v_quota
  FROM public.rollout_config c
  WHERE c.id = 1;
  v_mode := coalesce(v_mode, 'paused');
  v_quota := coalesce(v_quota, 0);

  -- Serializa por cuenta y por visitante (siempre en este orden, igual que link_user).
  IF p_auth_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('rollout:u:' || p_auth_user_id::text, 0));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rollout:v:' || p_visitor_id::text, 0));

  SELECT g.* INTO v_grant
  FROM public.rollout_grants g
  WHERE g.revoked_at IS NULL
    AND (g.visitor_id = p_visitor_id
         OR (p_auth_user_id IS NOT NULL AND g.auth_user_id = p_auth_user_id))
  ORDER BY (g.visitor_id = p_visitor_id) DESC NULLS LAST, g.granted_at ASC
  LIMIT 1;

  IF v_grant.id IS NOT NULL THEN
    -- Grant de visitante sin cuenta + sesión verificada: vincular (no consume cupo).
    IF v_grant.auth_user_id IS NULL
       AND p_auth_user_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.rollout_grants g2
         WHERE g2.auth_user_id = p_auth_user_id AND g2.revoked_at IS NULL
       )
    THEN
      UPDATE public.rollout_grants
      SET auth_user_id = p_auth_user_id, linked_at = now()
      WHERE id = v_grant.id
      RETURNING * INTO v_grant;
    END IF;

    IF v_mode = 'kill' THEN
      RETURN public.fn_rollout_result('catalog', 'kill', v_grant, v_day);
    END IF;
    RETURN public.fn_rollout_result('full', 'existing_grant', v_grant, v_day);
  END IF;

  IF v_mode = 'kill' THEN
    RETURN public.fn_rollout_result('catalog', 'kill', NULL, v_day);
  END IF;

  v_staff := public.fn_rollout_staff_source(p_auth_user_id);
  IF v_staff IS NOT NULL THEN
    INSERT INTO public.rollout_grants (visitor_id, auth_user_id, source, grant_day, linked_at, note)
    VALUES (p_visitor_id, p_auth_user_id, v_staff, v_day, now(), 'resolve: staff verificado')
    RETURNING * INTO v_grant;
    RETURN public.fn_rollout_result('full', 'staff', v_grant, v_day);
  END IF;

  IF p_source_hint = 'tester_link' THEN
    INSERT INTO public.rollout_grants (visitor_id, auth_user_id, source, grant_day, linked_at)
    VALUES (
      p_visitor_id, p_auth_user_id, 'tester_link', v_day,
      CASE WHEN p_auth_user_id IS NOT NULL THEN now() END
    )
    RETURNING * INTO v_grant;
    RETURN public.fn_rollout_result('full', 'tester_link', v_grant, v_day);
  END IF;

  IF v_mode = 'open_all' THEN
    INSERT INTO public.rollout_grants (visitor_id, auth_user_id, source, grant_day, linked_at)
    VALUES (
      p_visitor_id, p_auth_user_id, 'open_all', v_day,
      CASE WHEN p_auth_user_id IS NOT NULL THEN now() END
    )
    RETURNING * INTO v_grant;
    RETURN public.fn_rollout_result('full', 'open_all', v_grant, v_day);
  END IF;

  IF v_mode = 'quota' AND v_quota > 0 THEN
    -- Consumo atómico: el UPDATE del ON CONFLICT toma lock de fila y reevalúa
    -- `granted < v_quota` sobre la versión confirmada más reciente. Si no hay
    -- cupo no devuelve fila. Si el INSERT del grant falla, la transacción
    -- entera (incluido este incremento) se revierte.
    INSERT INTO public.rollout_daily_counter AS c (day, granted, updated_at)
    VALUES (v_day, 1, now())
    ON CONFLICT (day) DO UPDATE
      SET granted = c.granted + 1,
          updated_at = now()
      WHERE c.granted < v_quota
    RETURNING c.granted INTO v_counter;

    IF v_counter IS NOT NULL THEN
      INSERT INTO public.rollout_grants (visitor_id, auth_user_id, source, grant_day, linked_at)
      VALUES (
        p_visitor_id, p_auth_user_id, 'quota', v_day,
        CASE WHEN p_auth_user_id IS NOT NULL THEN now() END
      )
      RETURNING * INTO v_grant;
      RETURN public.fn_rollout_result('full', 'quota', v_grant, v_day);
    END IF;

    RETURN public.fn_rollout_result('catalog', 'quota_full', NULL, v_day);
  END IF;

  RETURN public.fn_rollout_result('catalog', v_mode, NULL, v_day);
END;
$$;

COMMENT ON FUNCTION public.rpc_rollout_resolve(uuid, uuid, text) IS
  'Decide full/catalog para un visitante. Solo service_role (middleware nj). canonical:362.';

-- ---------------------------------------------------------------------------
-- 7) rpc_rollout_link_user
-- ---------------------------------------------------------------------------
-- Llamada desde auth/callback después de exchangeCodeForSession + getUser.
-- Nunca crea grants por cupo ni tester_link: loguearse no concede full.
-- Excepciones: staff/admin verificado en public.admins y mode='open_all'.
CREATE OR REPLACE FUNCTION public.rpc_rollout_link_user(
  p_visitor_id uuid,
  p_auth_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_day date := public.fn_rollout_today();
  v_mode text;
  v_user_grant public.rollout_grants;
  v_visitor_grant public.rollout_grants;
  v_staff text;
BEGIN
  IF p_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'p_auth_user_id requerido' USING ERRCODE = '22023';
  END IF;

  SELECT c.mode INTO v_mode FROM public.rollout_config c WHERE c.id = 1;
  v_mode := coalesce(v_mode, 'paused');

  PERFORM pg_advisory_xact_lock(hashtextextended('rollout:u:' || p_auth_user_id::text, 0));
  IF p_visitor_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('rollout:v:' || p_visitor_id::text, 0));
  END IF;

  SELECT g.* INTO v_user_grant
  FROM public.rollout_grants g
  WHERE g.auth_user_id = p_auth_user_id AND g.revoked_at IS NULL
  LIMIT 1;

  IF p_visitor_id IS NOT NULL THEN
    SELECT g.* INTO v_visitor_grant
    FROM public.rollout_grants g
    WHERE g.visitor_id = p_visitor_id AND g.revoked_at IS NULL
    LIMIT 1;
  END IF;

  IF v_user_grant.id IS NULL AND v_visitor_grant.id IS NOT NULL THEN
    IF v_visitor_grant.auth_user_id IS NULL THEN
      -- Visitante seleccionado antes de registrarse: la cuenta hereda el grant.
      UPDATE public.rollout_grants
      SET auth_user_id = p_auth_user_id, linked_at = now()
      WHERE id = v_visitor_grant.id
      RETURNING * INTO v_user_grant;
    ELSE
      -- Dispositivo con grant de otra cuenta (equipo compartido): el dispositivo
      -- sigue full, esta cuenta no hereda el grant.
      v_user_grant := v_visitor_grant;
    END IF;
  END IF;

  IF v_user_grant.id IS NULL THEN
    v_staff := public.fn_rollout_staff_source(p_auth_user_id);
    IF v_staff IS NOT NULL THEN
      INSERT INTO public.rollout_grants (visitor_id, auth_user_id, source, grant_day, linked_at, note)
      VALUES (
        CASE WHEN v_visitor_grant.id IS NULL THEN p_visitor_id END,
        p_auth_user_id, v_staff, v_day, now(), 'link: staff verificado'
      )
      RETURNING * INTO v_user_grant;
    END IF;
  END IF;

  -- open_all: todos reciben full, también quien inicia sesión sin grant.
  IF v_user_grant.id IS NULL AND v_mode = 'open_all' THEN
    INSERT INTO public.rollout_grants (visitor_id, auth_user_id, source, grant_day, linked_at, note)
    VALUES (p_visitor_id, p_auth_user_id, 'open_all', v_day, now(), 'link: open_all')
    RETURNING * INTO v_user_grant;
  END IF;

  IF v_user_grant.id IS NULL THEN
    RETURN public.fn_rollout_result('catalog', 'no_grant', NULL, v_day);
  END IF;
  IF v_mode = 'kill' THEN
    RETURN public.fn_rollout_result('catalog', 'kill', v_user_grant, v_day);
  END IF;
  RETURN public.fn_rollout_result('full', 'linked', v_user_grant, v_day);
END;
$$;

COMMENT ON FUNCTION public.rpc_rollout_link_user(uuid, uuid) IS
  'Vincula cuenta ↔ grant al loguear. No concede full por cupo. Solo service_role. canonical:362.';

-- ---------------------------------------------------------------------------
-- 8) Grants de funciones: solo service_role
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_rollout_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rollout_staff_source(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rollout_result(text, text, public.rollout_grants, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_rollout_resolve(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_rollout_link_user(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_rollout_today() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rollout_staff_source(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rollout_result(text, text, public.rollout_grants, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_rollout_resolve(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_rollout_link_user(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 9) Seed: el grupo previo al rollout conserva full (no consume cupo)
-- ---------------------------------------------------------------------------
-- Grupo previo = cuentas creadas antes del corte de la revisión de 362. Las altas
-- posteriores al corte NO reciben seed aunque existan en auth.users al aplicar.
-- Si el grupo ya no es exactamente 1 admin / 9 staff / 41 tester, aborta todo.
-- Clasificación desde public.admins (misma fuente que public.is_admin()):
--   role = 'super_admin'      → source 'admin'
--   otra fila en admins       → source 'staff'
--   sin fila en admins        → source 'tester'
-- Seed por auth_user_id (sin visitor_id): se asocia al dispositivo al loguear.
DO $$
DECLARE
  v_day date := public.fn_rollout_today();
  -- Última alta del grupo: 2026-09-26 21:10 ART (auth.users, consulta del 2026-09-29).
  v_cutoff constant timestamptz := '2026-09-29 00:00:00-03';
  v_admin int;
  v_staff int;
  v_tester int;
BEGIN
  SELECT
    count(*) FILTER (WHERE s.source = 'admin'),
    count(*) FILTER (WHERE s.source = 'staff'),
    count(*) FILTER (WHERE s.source = 'tester')
  INTO v_admin, v_staff, v_tester
  FROM (
    SELECT coalesce(public.fn_rollout_staff_source(u.id), 'tester') AS source
    FROM auth.users u
    WHERE u.created_at < v_cutoff
  ) s;

  IF (v_admin, v_staff, v_tester) IS DISTINCT FROM (1, 9, 41) THEN
    RAISE EXCEPTION '362 seed: grupo previo esperado admin=1 staff=9 tester=41, encontrado admin=% staff=% tester=%',
      v_admin, v_staff, v_tester;
  END IF;

  INSERT INTO public.rollout_grants (auth_user_id, source, grant_day, note)
  SELECT
    u.id,
    coalesce(public.fn_rollout_staff_source(u.id), 'tester'),
    v_day,
    'seed:362'
  FROM auth.users u
  WHERE u.created_at < v_cutoff
    -- Cualquier grant previo (también revocado) bloquea el seed: reaplicar no revive revocaciones.
    AND NOT EXISTS (
      SELECT 1 FROM public.rollout_grants g
      WHERE g.auth_user_id = u.id
    );

  SELECT
    count(*) FILTER (WHERE source = 'admin'),
    count(*) FILTER (WHERE source = 'staff'),
    count(*) FILTER (WHERE source = 'tester')
  INTO v_admin, v_staff, v_tester
  FROM public.rollout_grants
  WHERE note = 'seed:362';

  RAISE NOTICE '362 seed: admin=% staff=% tester=% (grupo previo al 2026-09-29: 1 / 9 / 41)',
    v_admin, v_staff, v_tester;
END $$;

COMMIT;
