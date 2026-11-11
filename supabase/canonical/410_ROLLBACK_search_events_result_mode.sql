alter table public.search_events drop column if exists result_mode;
select pg_notify('pgrst', 'reload schema');
