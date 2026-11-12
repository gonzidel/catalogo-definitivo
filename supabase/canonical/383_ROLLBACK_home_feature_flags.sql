-- 383_ROLLBACK_home_feature_flags.sql
-- Revierte 383_home_feature_flags.sql.
-- Efecto en el frontend: el banner de Ofertas falla cerrado (no se muestra) si la tabla no existe.

drop trigger if exists home_feature_flags_touch on public.home_feature_flags;
drop table if exists public.home_feature_flags;
drop function if exists public.home_feature_flags_touch();
