-- 264_rpc_find_similar_tags.sql
-- Chequeo de similitud al crear tags nuevos (ver seccion "Crear tags nuevos" de la
-- propuesta): sin aprobacion humana, el algoritmo de similitud es el unico control.
create or replace function public.rpc_find_similar_tags(
  p_name text,
  p_level int,
  p_category text,
  p_parent_id uuid
)
returns table(id uuid, name text, similarity real)
language sql
stable
security invoker
as $$
  select t.id, t.name, similarity(t.name, p_name) as similarity
  from public.tags t
  where t.level = p_level
    and t.category = p_category
    and (
      (p_level = 1 and t.parent_id is null)
      or (p_level > 1 and t.parent_id = p_parent_id)
    )
    and similarity(t.name, p_name) > 0.35
  order by similarity desc
  limit 5;
$$;

grant execute on function public.rpc_find_similar_tags(text, int, text, uuid) to authenticated;

select pg_notify('pgrst','reload schema');
