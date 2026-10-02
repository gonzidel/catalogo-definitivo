-- 363_ROLLBACK_fix_transfer_alias_cbu_labels.sql
-- Vuelve a las constantes de 320 (etiquetas cruzadas).

CREATE OR REPLACE FUNCTION public.fn_fyl_transfer_alias()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '0170218940000003684953'::text $$;

CREATE OR REPLACE FUNCTION public.fn_fyl_transfer_cbu()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'calzados.fyl.2025'::text $$;
