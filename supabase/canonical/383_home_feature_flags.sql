-- 383_home_feature_flags.sql
-- Flags públicos de funcionalidades del inicio (hoy: banner de Ofertas).
--
-- Estado: PROPUESTA LOCAL. No aplicada en producción (requiere aprobación explícita).
-- Rollback: 383_ROLLBACK_home_feature_flags.sql
-- Verificación: 383_home_feature_flags_verify.sql
--
-- Diseño:
--   * Lectura pública (anon + authenticated): un flag no contiene datos sensibles y el
--     inicio SSR/cliente necesita leerlo sin sesión.
--   * Escritura solo para admins (public.admins) vía RLS; nunca anon.
--   * Sin DELETE: los flags se apagan, no se borran.
--   * Data API grants explícitos (Supabase ya no los otorga solos en tablas nuevas).
--   * Nace APAGADO: desplegar el frontend o el admin antes que esta migración es seguro.

create table if not exists public.home_feature_flags (
  key        text primary key,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint home_feature_flags_key_format check (key ~ '^[a-z][a-z0-9_]{2,63}$')
);

comment on table public.home_feature_flags is
  'Flags públicos del inicio (on/off). Lectura anon; escritura solo admins. Ver FYL-Obsidian/76.';

alter table public.home_feature_flags enable row level security;

-- Auditoría mínima: quién y cuándo tocó el flag (no confía en lo que mande el cliente).
create or replace function public.home_feature_flags_touch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := "auth".uid();
  return new;
end;
$$;

drop trigger if exists home_feature_flags_touch on public.home_feature_flags;
create trigger home_feature_flags_touch
  before insert or update on public.home_feature_flags
  for each row execute function public.home_feature_flags_touch();

-- RLS ----------------------------------------------------------------------

drop policy if exists home_feature_flags_public_read on public.home_feature_flags;
create policy home_feature_flags_public_read
  on public.home_feature_flags
  for select
  to anon, authenticated
  using (true);

drop policy if exists home_feature_flags_admin_insert on public.home_feature_flags;
create policy home_feature_flags_admin_insert
  on public.home_feature_flags
  for insert
  to authenticated
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists home_feature_flags_admin_update on public.home_feature_flags;
create policy home_feature_flags_admin_update
  on public.home_feature_flags
  for update
  to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

-- Grants (mínimo privilegio) ------------------------------------------------

revoke all on table public.home_feature_flags from public;
revoke all on table public.home_feature_flags from anon, authenticated;

grant select on table public.home_feature_flags to anon, authenticated;
grant insert, update on table public.home_feature_flags to authenticated;
grant all on table public.home_feature_flags to service_role;

revoke all on function public.home_feature_flags_touch() from public, anon;
grant execute on function public.home_feature_flags_touch() to authenticated, service_role;

-- Semilla: banner de Ofertas del inicio, apagado.
insert into public.home_feature_flags (key, enabled)
values ('home_offers_banner', false)
on conflict (key) do nothing;
