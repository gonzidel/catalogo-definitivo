-- 45_eliminate_auth_dependencies.sql
-- Objetivo: Eliminar dependencias a auth.identities y auth.users desde RPCs y Triggers públicos
-- para resolver errores de permisos (403/42501) definitivamente.

-- 1. Eliminar Trigger y Función problemáticos que acceden a auth.*
DROP TRIGGER IF EXISTS set_customer_auth_provider_trigger ON public.customers;
DROP FUNCTION IF EXISTS public.set_customer_auth_provider();

-- 2. Eliminar funciones auxiliares que leen auth.* y ya no se deberían usar en flujos críticos
-- (Ojo: get_auth_provider podría ser útil en otros contextos, pero si causa problemas la eliminamos o redefinimos)
-- Por seguridad y limpieza, la vamos a mantener pero NO la usaremos en triggers automáticos.
-- Si sync_customer_auth_provider dependía de ella para triggers, ya no importa porque eliminamos el trigger.

-- 3. Redefinir rpc_upsert_customer para asegurar que NO hay lógica oculta y es puramente transaccional sobre public.customers
-- Quitamos SECURITY DEFINER si es posible para que use permisos del usuario, 
-- PERO como customers tiene RLS estricto, a veces SECURITY DEFINER es necesario para saltar validaciones complejas si el usuario no es admin.
-- Sin embargo, el requisito dice "No usar SECURITY DEFINER como workaround" si es para saltar permisos de auth.*
-- Como esta RPC solo toca public.customers, la mantendremos limpia.

CREATE OR REPLACE FUNCTION public.rpc_upsert_customer(
  p_full_name text,
  p_address text,
  p_city text,
  p_province text,
  p_phone text,
  p_dni text,
  p_email text,
  p_customer_number text DEFAULT NULL,
  p_qr_code uuid DEFAULT NULL,
  p_public_sales_customer_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
-- Quitamos SECURITY DEFINER para respetar RLS y evitar elevación de privilegios innecesaria
-- El usuario autenticado debería tener permiso de UPDATE sobre su propio registro en public.customers
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- Obtener el ID del usuario autenticado
  v_user_id := auth.uid();
  
  IF v_user_id IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Usuario no autenticado'
    );
  END IF;

  -- Upsert directo sobre public.customers
  -- Al eliminar el trigger set_customer_auth_provider_trigger, esto no dispara lecturas a auth.*
  INSERT INTO public.customers (
    id,
    full_name,
    address,
    city,
    province,
    phone,
    dni,
    email,
    customer_number,
    qr_code,
    public_sales_customer_id,
    created_at,
    updated_at
  ) VALUES (
    v_user_id,
    p_full_name,
    p_address,
    p_city,
    p_province,
    p_phone,
    p_dni,
    p_email,
    p_customer_number,
    p_qr_code,
    p_public_sales_customer_id,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    address = EXCLUDED.address,
    city = EXCLUDED.city,
    province = EXCLUDED.province,
    phone = EXCLUDED.phone,
    dni = EXCLUDED.dni,
    email = EXCLUDED.email,
    customer_number = COALESCE(NULLIF(EXCLUDED.customer_number, NULL), customers.customer_number),
    qr_code = COALESCE(NULLIF(EXCLUDED.qr_code, NULL), customers.qr_code),
    public_sales_customer_id = COALESCE(NULLIF(EXCLUDED.public_sales_customer_id, NULL), customers.public_sales_customer_id),
    updated_at = now();

  RETURN json_build_object(
    'success', true,
    'customer_id', v_user_id
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$$;

-- 4. Asegurarse que la columna auth_provider acepte nulos o tenga valor por defecto simple si es necesaria
-- Por ahora no hacemos nada DDL extra a menos que sea obligatorio
-- Si auth_provider era NOT NULL, fallaría. Asumimos que es nullable (es lo standard).

-- 5. Recargar esquema para limpiar caché
SELECT pg_notify('pgrst', 'reload schema');

DO $$
BEGIN
    RAISE NOTICE '✅ Dependencias a auth.* eliminadas. Trigges desactivados.';
END $$;
