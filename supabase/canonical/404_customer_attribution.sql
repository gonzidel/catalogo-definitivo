-- 404: atribución first-touch por clienta + idempotencia de eventos a Meta (CAPI).
-- Estado: APLICAR PRIMERO EN RAMA DE PRUEBA DE SUPABASE. No aplicado en producción.
-- Esquema contrastado en solo lectura contra fyl-core el 2026-11-03:
--   customers.id (uuid), orders.id (uuid), customer_auth_links(customer_id, auth_user_id, linked_at),
--   admins(user_id). En clientas web customers.id = auth.uid() (ver nj/app/auth/callback/route.ts).
-- Rollback: 404_ROLLBACK_customer_attribution.sql

-- 1) Atribución first-touch (una fila por clienta, nunca se pisa)
create table if not exists public.customer_attribution (
  customer_id           uuid primary key references public.customers(id) on delete cascade,
  first_seen_at         timestamptz,
  registered_at         timestamptz not null default now(),
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  utm_content           text,
  utm_term              text,
  fbclid                text,
  fbc                   text,
  fbp                   text,
  ctwa_clid             text,
  ad_id                 text,
  wa_referral           jsonb,
  landing_url           text,
  referrer              text,
  channel               text,
  is_existing_customer  boolean not null default false,
  captured_by           text not null default 'web'
);
create index if not exists customer_attribution_registered_at_idx on public.customer_attribution (registered_at);
create index if not exists customer_attribution_channel_idx on public.customer_attribution (channel);

-- 2) Idempotencia de eventos enviados a Meta
create table if not exists public.meta_capi_events (
  event_id     text primary key,
  event_name   text not null,
  customer_id  uuid references public.customers(id) on delete set null,
  order_id     uuid references public.orders(id) on delete set null,
  status       text not null default 'pending',
  response     jsonb,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

-- 3) RLS: solo admins leen; escribe únicamente service_role y la función de abajo
alter table public.customer_attribution enable row level security;
alter table public.meta_capi_events     enable row level security;

revoke insert, update, delete, truncate on public.customer_attribution from anon, authenticated;
revoke insert, update, delete, truncate on public.meta_capi_events     from anon, authenticated;
revoke all on public.customer_attribution from anon;
revoke all on public.meta_capi_events     from anon;

drop policy if exists customer_attribution_admin_select on public.customer_attribution;
create policy customer_attribution_admin_select on public.customer_attribution
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists meta_capi_events_admin_select on public.meta_capi_events;
create policy meta_capi_events_admin_select on public.meta_capi_events
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

-- 4) Función que llama el front. No confía en ningún customer_id del navegador.
-- Devuelve true si la clienta ya tiene fila de atribución (recién creada o previa);
-- false si todavía no existe la ficha de clienta (el front reintenta luego).
create or replace function public.fn_register_attribution(p jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_customer uuid;
  v_created  timestamptz;
  v_first    timestamptz;
begin
  if v_uid is null then return false; end if;

  begin
    v_first := nullif(p->>'first_seen_at','')::timestamptz;
  exception when others then
    v_first := null;
  end;

  -- clienta vieja que unió su cuenta...
  select l.customer_id into v_customer
    from public.customer_auth_links l
   where l.auth_user_id = v_uid
   order by l.linked_at desc nulls last
   limit 1;
  -- ...o clienta web cuyo id coincide con el usuario de auth
  if v_customer is null then
    select c.id into v_customer from public.customers c where c.id = v_uid;
  end if;
  if v_customer is null then return false; end if;

  select created_at into v_created from public.customers where id = v_customer;

  insert into public.customer_attribution (
    customer_id, first_seen_at, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    fbclid, fbc, fbp, landing_url, referrer, channel, is_existing_customer, captured_by
  ) values (
    v_customer, v_first,
    left(p->>'utm_source',100), left(p->>'utm_medium',100), left(p->>'utm_campaign',200),
    left(p->>'utm_content',200), left(p->>'utm_term',200),
    left(p->>'fbclid',300), left(p->>'fbc',300), left(p->>'fbp',300),
    left(p->>'landing_url',500), left(p->>'referrer',500),
    case
      when coalesce(p->>'fbclid','') <> ''
        or lower(coalesce(p->>'utm_source','')) in ('facebook','fb','ig','instagram','meta') then 'paid_meta'
      when coalesce(p->>'utm_source','') <> '' then 'other'
      when coalesce(p->>'referrer','') <> '' then 'referral'
      else 'direct'
    end,
    -- existía antes de su primer toque (margen de 1 día) => no es clienta nueva
    (v_first is not null and v_created < v_first - interval '1 day'),
    'web'
  )
  on conflict (customer_id) do nothing;   -- first-touch: nunca se pisa

  return true;
end;
$$;

revoke all on function public.fn_register_attribution(jsonb) from public, anon;
grant execute on function public.fn_register_attribution(jsonb) to authenticated;
