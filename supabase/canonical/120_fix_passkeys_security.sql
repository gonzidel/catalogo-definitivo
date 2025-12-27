-- 120_fix_passkeys_security.sql
-- Hardening de WebAuthn/Passkeys
-- - webauthn_challenges: bloqueo total (solo service_role / Edge Function)
-- - passkeys: solo SELECT para usuarios (auth.uid = user_id), sin escrituras desde frontend

-- =========================
-- 1) webauthn_challenges
-- =========================
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema='public' and table_name='webauthn_challenges'
  ) then
    alter table public.webauthn_challenges enable row level security;
    alter table public.webauthn_challenges force row level security;

    revoke all on public.webauthn_challenges from anon;
    revoke all on public.webauthn_challenges from authenticated;
    revoke all on public.webauthn_challenges from public;

    -- eliminar policies (por si existían)
    drop policy if exists webauthn_challenges_select on public.webauthn_challenges;
    drop policy if exists webauthn_challenges_insert on public.webauthn_challenges;
    drop policy if exists webauthn_challenges_update on public.webauthn_challenges;
    drop policy if exists webauthn_challenges_delete on public.webauthn_challenges;

    raise notice '✅ webauthn_challenges: cerrado para anon/authenticated (solo service_role)';
  end if;
end $$;

-- =========================
-- 2) passkeys
-- =========================
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema='public' and table_name='passkeys'
  ) then
    alter table public.passkeys enable row level security;
    alter table public.passkeys force row level security;

    -- Blindaje: no grants al rol public
    revoke all on public.passkeys from public;

    -- limpiar policies peligrosas si existieran
    drop policy if exists passkeys_insert_own on public.passkeys;
    drop policy if exists passkeys_update_own on public.passkeys;
    drop policy if exists passkeys_delete_own on public.passkeys;

    -- dejar SOLO SELECT para el dueño
    drop policy if exists passkeys_select_own on public.passkeys;

    create policy passkeys_select_own
      on public.passkeys
      for select
      to authenticated
      using (auth.uid() = user_id);

    raise notice '✅ passkeys: solo SELECT own para authenticated; sin INSERT/UPDATE/DELETE desde frontend';
  end if;
end $$;

select pg_notify('pgrst','reload schema');

