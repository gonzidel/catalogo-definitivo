-- 141_transports_canonicalization_and_dedup.sql
-- Unifica nombres de transportes, reasigna customers.transport_id y evita duplicados futuros.
-- No modifica orders.transport_id.

create or replace function public.normalize_transport_name(p_value text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    lower(
      trim(
        translate(
          coalesce(p_value, ''),
          'áàäâãéèëêíìïîóòöôõúùüûñ',
          'aaaaaeeeeiiiiooooouuuun'
        )
      )
    ),
    '\s+',
    ' ',
    'g'
  );
$$;

with canonical_map(alias_key, canonical_name) as (
  values
    ('correo argentino', 'Correo Argentino'),
    ('via cargo', 'Via Cargo'),
    ('credifin', 'Credifin'),
    ('snaider', 'Snaider'),
    ('transporte snaider', 'Snaider'),
    ('sede', 'SEDE'),
    ('retiro de local', 'Retiro de Local'),
    ('retiro del local', 'Retiro de Local'),
    ('retiro local', 'Retiro de Local')
)
update public.transports t
set name = cm.canonical_name,
    updated_at = now()
from canonical_map cm
where public.normalize_transport_name(t.name) = cm.alias_key
  and t.name is distinct from cm.canonical_name;

with duplicates as (
  select
    id as duplicate_id,
    first_value(id) over (
      partition by public.normalize_transport_name(name)
      order by created_at asc nulls last, id asc
    ) as canonical_id,
    public.normalize_transport_name(name) as normalized_name
  from public.transports
),
to_merge as (
  select duplicate_id, canonical_id, normalized_name
  from duplicates
  where duplicate_id <> canonical_id
),
updated_customers as (
  update public.customers c
  set transport_id = tm.canonical_id,
      updated_at = now()
  from to_merge tm
  where c.transport_id = tm.duplicate_id
  returning c.id
)
select count(*) as merged_customers
from updated_customers;

with duplicates as (
  select
    id as duplicate_id,
    first_value(id) over (
      partition by public.normalize_transport_name(name)
      order by created_at asc nulls last, id asc
    ) as canonical_id
  from public.transports
),
deletable_duplicates as (
  select d.duplicate_id
  from duplicates d
  where d.duplicate_id <> d.canonical_id
    and not exists (
      select 1 from public.orders o where o.transport_id = d.duplicate_id
    )
)
delete from public.transports t
using deletable_duplicates dd
where t.id = dd.duplicate_id;

create unique index if not exists transports_name_normalized_unique
  on public.transports ((public.normalize_transport_name(name)));
