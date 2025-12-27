-- 110_fix_function_search_path.sql
-- Fija search_path seguro para funciones en schema public
-- Evita ataques por shadowing (Supabase linter: function_search_path_mutable)

do $$
declare
  r record;
  updated_count int := 0;
  failed_count int := 0;
begin
  for r in
    select
      p.oid,
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as identity_args,
      p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      -- excluir funciones internas/extensión si quisieras (opcional):
      -- and p.proname not like 'pg_%'
      and (
        p.proconfig is null
        or not exists (
          select 1
          from unnest(p.proconfig) as cfg
          where cfg like 'search_path=%'
        )
      )
  loop
    begin
      execute format(
        'alter function %I.%I(%s) set search_path = %L;',
        r.schema_name,
        r.function_name,
        r.identity_args,
        'pg_catalog, public'
      );

      updated_count := updated_count + 1;
      raise notice '✅ search_path fijado: %.%(%)', r.schema_name, r.function_name, r.identity_args;

    exception when others then
      failed_count := failed_count + 1;
      raise warning '❌ No se pudo actualizar %.%(%) -> %', r.schema_name, r.function_name, r.identity_args, sqlerrm;
    end;
  end loop;

  raise notice '---';
  raise notice 'Resumen: % funciones actualizadas, % fallidas', updated_count, failed_count;
end $$;

-- Recargar esquema para PostgREST
select pg_notify('pgrst', 'reload schema');

