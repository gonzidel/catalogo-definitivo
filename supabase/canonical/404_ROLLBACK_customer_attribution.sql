-- Rollback de 404_customer_attribution.sql
drop function if exists public.fn_register_attribution(jsonb);
drop table if exists public.meta_capi_events;
drop table if exists public.customer_attribution;
