-- 382_ROLLBACK_whatsapp_invalid_phone.sql

DROP TRIGGER IF EXISTS trg_clear_whatsapp_invalid_on_phone_change ON public.customers;
DROP FUNCTION IF EXISTS public.fn_clear_whatsapp_invalid_on_phone_change();
DROP FUNCTION IF EXISTS public.rpc_admin_mark_whatsapp_invalid(uuid);
DROP FUNCTION IF EXISTS public.rpc_customer_fix_phone_clear_whatsapp_invalid(text);

ALTER TABLE public.customers
  DROP COLUMN IF EXISTS whatsapp_invalid_at,
  DROP COLUMN IF EXISTS whatsapp_invalid_by,
  DROP COLUMN IF EXISTS whatsapp_invalid_phone;

SELECT pg_notify('pgrst', 'reload schema');
