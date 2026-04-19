-- 169_rpc_operations_infra.sql
--
-- Infraestructura común de idempotencia fuerte (replay-safe) para RPCs críticas.
-- Patrón único para stock/pedidos/ventas:
--   - operation_id (uuid) obligatorio
--   - request_fingerprint (md5 del request jsonb serializado)
--   - estados mínimos: in_progress | completed | failed
--   - replay exacto: misma operation_id + mismo fingerprint + completed => devuelve resultado previo
--   - mismatch: misma operation_id + fingerprint distinto => excepción explícita
--   - failed: permite reintento y sobrescribe error en el nuevo intento
--
-- Importante:
--   - Esta migración NO modifica RPCs de negocio todavía.
--   - Crea tabla + helpers reutilizables para luego integrar RPC por RPC.

create table if not exists public.rpc_operations (
  operation_id         uuid primary key,
  operation_kind       text not null,
  status               text not null
    check (status in ('in_progress', 'completed', 'failed')),
  request_fingerprint  text not null,
  request_json         jsonb not null default '{}'::jsonb,
  result_json          jsonb,
  error_json           jsonb,
  actor_user_id        uuid,
  target_type          text,
  target_id            text,
  attempts             int not null default 1 check (attempts >= 1),
  started_at           timestamptz not null default now(),
  completed_at         timestamptz,
  failed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_rpc_operations_kind_target_created
  on public.rpc_operations (operation_kind, target_type, target_id, created_at desc);

create index if not exists idx_rpc_operations_status
  on public.rpc_operations (status);

create index if not exists idx_rpc_operations_updated_at
  on public.rpc_operations (updated_at desc);

create or replace function public.touch_rpc_operations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_rpc_operations_updated_at on public.rpc_operations;
create trigger trg_touch_rpc_operations_updated_at
before update on public.rpc_operations
for each row
execute function public.touch_rpc_operations_updated_at();

alter table public.rpc_operations enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'rpc_operations'
      and policyname = 'rpc_operations_no_direct_access'
  ) then
    create policy rpc_operations_no_direct_access
      on public.rpc_operations
      for all
      to public
      using (false)
      with check (false);
  end if;
end $$;

revoke all on table public.rpc_operations from public, anon, authenticated;

comment on table public.rpc_operations is
'Registro genérico de idempotencia fuerte para RPCs críticas.';

comment on column public.rpc_operations.attempts is
'Cantidad de intentos para la misma operation_id (failed -> in_progress incrementa attempts).';

create or replace function public.rpc_operations_begin(
  p_operation_id uuid,
  p_operation_kind text,
  p_request jsonb default '{}'::jsonb,
  p_target_type text default null,
  p_target_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user_id uuid;
  v_fp text;
  v_hex text;
  v_lock_key1 int;
  v_lock_key2 int;
  v_existing_status text;
  v_existing_fp text;
  v_existing_result jsonb;
begin
  if p_operation_id is null then
    raise exception
      'rpc_operations_begin: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  if p_operation_kind is null or trim(p_operation_kind) = '' then
    raise exception
      'rpc_operations_begin: p_operation_kind es obligatorio'
      using errcode = '22023';
  end if;

  v_user_id := auth.uid();
  v_fp := md5(coalesce(p_request, '{}'::jsonb)::text);

  -- Advisory lock por operation_id usando 2 llaves int4 derivadas del UUID.
  -- Se usa folding XOR para cubrir los 128 bits del UUID y minimizar colisiones.
  v_hex := replace(lower(p_operation_id::text), '-', '');
  v_lock_key1 := (
    ('x' || substr(v_hex, 1,  8))::bit(32)::int
    # ('x' || substr(v_hex, 17, 8))::bit(32)::int
  );
  v_lock_key2 := (
    ('x' || substr(v_hex, 9,  8))::bit(32)::int
    # ('x' || substr(v_hex, 25, 8))::bit(32)::int
  );
  perform pg_advisory_xact_lock(v_lock_key1, v_lock_key2);

  select status, request_fingerprint, result_json
    into v_existing_status, v_existing_fp, v_existing_result
  from public.rpc_operations
  where operation_id = p_operation_id
  for update;

  if not found then
    insert into public.rpc_operations (
      operation_id,
      operation_kind,
      status,
      request_fingerprint,
      request_json,
      actor_user_id,
      target_type,
      target_id,
      attempts,
      started_at
    ) values (
      p_operation_id,
      p_operation_kind,
      'in_progress',
      v_fp,
      coalesce(p_request, '{}'::jsonb),
      v_user_id,
      p_target_type,
      p_target_id,
      1,
      now()
    );

    -- NULL => proceed con lógica de negocio.
    return null;
  end if;

  if v_existing_fp is distinct from v_fp then
    raise exception
      'operation_id_conflict: la misma operation_id fue usada con distinto request'
      using errcode = '22000';
  end if;

  if v_existing_status = 'completed' then
    -- Replay-safe: devolver resultado previo exacto.
    return v_existing_result;
  end if;

  if v_existing_status = 'in_progress' then
    raise exception
      'conflict_in_progress: operación en curso para operation_id=%',
      p_operation_id
      using errcode = '55P03';
  end if;

  -- status = failed:
  -- permitir retry con la misma operation_id y mismo request; se sobrescribe el
  -- error cuando el nuevo intento termine en failed nuevamente.
  update public.rpc_operations
  set
    status = 'in_progress',
    attempts = attempts + 1,
    started_at = now(),
    failed_at = null,
    error_json = null
  where operation_id = p_operation_id;

  return null;
end;
$$;

create or replace function public.rpc_operations_complete(
  p_operation_id uuid,
  p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_result jsonb;
begin
  if p_operation_id is null then
    raise exception
      'rpc_operations_complete: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  update public.rpc_operations
  set
    status = 'completed',
    result_json = coalesce(p_result, '{}'::jsonb),
    completed_at = now(),
    failed_at = null,
    error_json = null
  where operation_id = p_operation_id
    and status = 'in_progress'
  returning result_json into v_result;

  if not found then
    -- Si ya estaba completed, devolver el resultado existente.
    select result_json
      into v_result
    from public.rpc_operations
    where operation_id = p_operation_id
      and status = 'completed';

    if v_result is null then
      raise exception
        'rpc_operations_complete: operación no está en progreso (operation_id=%)',
        p_operation_id
        using errcode = '55000';
    end if;
  end if;

  return v_result;
end;
$$;

create or replace function public.rpc_operations_fail(
  p_operation_id uuid,
  p_error jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_operation_id is null then
    raise exception
      'rpc_operations_fail: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  update public.rpc_operations
  set
    status = 'failed',
    error_json = coalesce(p_error, '{}'::jsonb),
    failed_at = now()
  where operation_id = p_operation_id
    and status = 'in_progress';
end;
$$;

create or replace function public.rpc_operations_cleanup(
  p_keep_completed_days int default 90,
  p_keep_failed_days int default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_deleted_completed int := 0;
  v_deleted_failed int := 0;
begin
  if coalesce(p_keep_completed_days, 0) < 1 then
    raise exception
      'rpc_operations_cleanup: p_keep_completed_days debe ser >= 1'
      using errcode = '22023';
  end if;

  if coalesce(p_keep_failed_days, 0) < 1 then
    raise exception
      'rpc_operations_cleanup: p_keep_failed_days debe ser >= 1'
      using errcode = '22023';
  end if;

  delete from public.rpc_operations
  where status = 'completed'
    and completed_at < now() - make_interval(days => p_keep_completed_days);
  get diagnostics v_deleted_completed = row_count;

  delete from public.rpc_operations
  where status = 'failed'
    and failed_at < now() - make_interval(days => p_keep_failed_days);
  get diagnostics v_deleted_failed = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_completed', v_deleted_completed,
    'deleted_failed', v_deleted_failed
  );
end;
$$;

revoke all on function public.rpc_operations_begin(uuid, text, jsonb, text, text)
  from public, anon, authenticated;
revoke all on function public.rpc_operations_complete(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.rpc_operations_fail(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.rpc_operations_cleanup(int, int)
  from public, anon, authenticated;

grant execute on function public.rpc_operations_begin(uuid, text, jsonb, text, text)
  to service_role;
grant execute on function public.rpc_operations_complete(uuid, jsonb)
  to service_role;
grant execute on function public.rpc_operations_fail(uuid, jsonb)
  to service_role;
grant execute on function public.rpc_operations_cleanup(int, int)
  to service_role;

comment on function public.rpc_operations_begin(uuid, text, jsonb, text, text) is
'Reserva/reutiliza una operation_id con lock advisory. Devuelve NULL para continuar o result_json previo si es replay completed.';

comment on function public.rpc_operations_complete(uuid, jsonb) is
'Marca una operation_id como completed y persiste el resultado final de la RPC.';

comment on function public.rpc_operations_fail(uuid, jsonb) is
'Marca una operation_id como failed con error_json. Retry posterior con misma operation_id queda permitido.';

comment on function public.rpc_operations_cleanup(int, int) is
'Limpieza de retención para rpc_operations (completed y failed).';
