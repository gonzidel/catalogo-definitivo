-- 382_whatsapp_invalid_phone.sql
-- Admin marca número WhatsApp inválido; la clienta ve aviso hasta corregir el teléfono.
-- Snooze de UI (12 h) es solo cliente; la fuente de verdad es whatsapp_invalid_at.
--
-- Rollback: 382_ROLLBACK_whatsapp_invalid_phone.sql

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS whatsapp_invalid_at timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_invalid_by uuid,
  ADD COLUMN IF NOT EXISTS whatsapp_invalid_phone text;

COMMENT ON COLUMN public.customers.whatsapp_invalid_at IS
  'Cuando un admin marcó el teléfono como inválido en WhatsApp. NULL = sin aviso.';
COMMENT ON COLUMN public.customers.whatsapp_invalid_by IS
  'admins.user_id que marcó el número inválido.';
COMMENT ON COLUMN public.customers.whatsapp_invalid_phone IS
  'Copia del phone al momento del aviso (auditoría).';

-- Cualquier cambio de phone limpia el flag (perfil, RPC admin, fix clienta).
CREATE OR REPLACE FUNCTION public.fn_clear_whatsapp_invalid_on_phone_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    NEW.whatsapp_invalid_at := NULL;
    NEW.whatsapp_invalid_by := NULL;
    NEW.whatsapp_invalid_phone := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_whatsapp_invalid_on_phone_change ON public.customers;
CREATE TRIGGER trg_clear_whatsapp_invalid_on_phone_change
  BEFORE UPDATE OF phone ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_clear_whatsapp_invalid_on_phone_change();

CREATE OR REPLACE FUNCTION public.rpc_admin_mark_whatsapp_invalid(p_customer_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_phone text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_id requerido';
  END IF;

  SELECT phone INTO v_phone
    FROM public.customers
   WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente no encontrado';
  END IF;

  UPDATE public.customers
     SET whatsapp_invalid_at = now(),
         whatsapp_invalid_by = auth.uid(),
         whatsapp_invalid_phone = phone,
         updated_at = now()
   WHERE id = p_customer_id;

  RETURN json_build_object(
    'ok', true,
    'customer_id', p_customer_id,
    'phone', v_phone
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_customer_fix_phone_clear_whatsapp_invalid(p_phone text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_phone text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_phone := nullif(trim(coalesce(p_phone, '')), '');
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'Teléfono requerido';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = v_uid) THEN
    RAISE EXCEPTION 'Cliente no encontrado';
  END IF;

  UPDATE public.customers
     SET phone = v_phone,
         updated_at = now()
   WHERE id = v_uid;
  -- El trigger limpia whatsapp_invalid_* al cambiar phone.

  RETURN json_build_object('ok', true, 'phone', v_phone);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_clear_whatsapp_invalid_on_phone_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_admin_mark_whatsapp_invalid(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_customer_fix_phone_clear_whatsapp_invalid(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.rpc_admin_mark_whatsapp_invalid(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_customer_fix_phone_clear_whatsapp_invalid(text)
  TO authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
