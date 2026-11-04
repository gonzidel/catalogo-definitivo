-- 363_fix_transfer_alias_cbu_labels.sql
--
-- Los mensajes de cierre clienta (customer_closed_transfer y
-- customer_closed_correo, migración 320) salían con las etiquetas cruzadas:
--   Alias: 0170218940000003684953
--   CBU/CVU: calzados.fyl.2025
-- El número de 22 dígitos es el CBU y calzados.fyl.2025 es el alias.
-- Solo se corrigen las dos constantes; los builders
-- fn_build_closed_order_transfer_message / fn_build_closed_order_correo_message
-- las leen en cada llamada, así que no hace falta recrearlos.
--
-- Paridad frontend: nj/lib/orders/closed-order-messages.ts
-- (FYL_TRANSFER_ALIAS / FYL_TRANSFER_CBU).
--
-- Avisos ya encolados conservan el texto con el que se crearon
-- (admin_order_message_notifications.message); al 2026-10-02 no había
-- pendientes con el texto viejo.
--
-- Rollback: 363_ROLLBACK_fix_transfer_alias_cbu_labels.sql

CREATE OR REPLACE FUNCTION public.fn_fyl_transfer_alias()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'calzados.fyl.2025'::text $$;

CREATE OR REPLACE FUNCTION public.fn_fyl_transfer_cbu()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '0170218940000003684953'::text $$;

DO $$
BEGIN
  IF public.fn_fyl_transfer_alias() <> 'calzados.fyl.2025'
     OR public.fn_fyl_transfer_cbu() <> '0170218940000003684953' THEN
    RAISE EXCEPTION '363 FAIL: alias/CBU no quedaron corregidos';
  END IF;

  IF position('Alias: calzados.fyl.2025' IN public.fn_build_closed_order_transfer_message('Snaider', 1000)) = 0
     OR position('CBU/CVU: 0170218940000003684953' IN public.fn_build_closed_order_transfer_message('Snaider', 1000)) = 0 THEN
    RAISE EXCEPTION '363 FAIL: el mensaje de transferencia sigue con etiquetas cruzadas';
  END IF;
END $$;
