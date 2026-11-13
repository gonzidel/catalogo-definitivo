-- Rollback 409_product_search_profiles
drop view if exists public.product_search_profiles_public;
drop trigger if exists product_search_profiles_updated_at on public.product_search_profiles;
drop function if exists public.tg_product_search_profiles_updated_at();
drop table if exists public.product_search_profiles;
select pg_notify('pgrst', 'reload schema');
