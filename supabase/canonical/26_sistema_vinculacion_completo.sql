-- SISTEMA COMPLETO DE VINCULACIÓN DE CLIENTES
-- Ejecuta esto para habilitar la vinculación automática cuando clientes se registran con Google

-- 1. Tabla de vinculación entre customers y auth.users
CREATE TABLE IF NOT EXISTS public.customer_auth_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  linked_at timestamptz DEFAULT now(),
  match_type text, -- 'email', 'phone', 'dni', 'new', 'manual'
  created_at timestamptz DEFAULT now()
);

-- Índices para búsquedas rápidas
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_auth_links_auth_user 
  ON public.customer_auth_links(auth_user_id);

CREATE INDEX IF NOT EXISTS idx_customer_auth_links_customer 
  ON public.customer_auth_links(customer_id);

-- 2. Función helper: Obtener customer_id desde auth_user_id
CREATE OR REPLACE FUNCTION public.get_customer_id_for_user(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_customer_id uuid;
BEGIN
  SELECT customer_id INTO v_customer_id
  FROM public.customer_auth_links
  WHERE auth_user_id = p_user_id
  LIMIT 1;
  
  -- Si no hay vínculo, usar el user_id directamente (compatibilidad)
  RETURN COALESCE(v_customer_id, p_user_id);
END;
$$;

-- 3. Función principal: Vincular o crear customer
CREATE OR REPLACE FUNCTION public.rpc_link_or_create_customer(
  p_user_id uuid,
  p_email text,
  p_phone text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_dni text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
  v_match_type text;
  v_existing_customer RECORD;
  v_linked_customer_id uuid;
  v_temp_id uuid;
  v_customer_number_temp text;
  v_address_temp text;
  v_city_temp text;
  v_province_temp text;
BEGIN
  -- Verificar si ya está vinculado
  SELECT customer_id INTO v_linked_customer_id
  FROM public.customer_auth_links
  WHERE auth_user_id = p_user_id
  LIMIT 1;
  
  IF v_linked_customer_id IS NOT NULL THEN
    RETURN json_build_object(
      'action', 'already_linked',
      'customer_id', v_linked_customer_id,
      'message', 'Cliente ya está vinculado'
    );
  END IF;
  
  -- Buscar por email (coincidencia exacta, case-insensitive)
  IF p_email IS NOT NULL AND trim(p_email) != '' THEN
    SELECT c.id, c.full_name, c.phone, c.dni, c.email, c.customer_number, 
           c.created_by_admin, c.address, c.city, c.province
    INTO v_existing_customer
    FROM public.customers c
    WHERE lower(trim(c.email)) = lower(trim(p_email))
      AND c.id NOT IN (
        SELECT customer_id 
        FROM public.customer_auth_links 
        WHERE customer_id IS NOT NULL
      )
    LIMIT 1;
    
    IF v_existing_customer.id IS NOT NULL THEN
      v_match_type := 'email';
      v_customer_id := v_existing_customer.id;
    END IF;
  END IF;
  
  -- Si no hay match por email, buscar por teléfono
  IF v_customer_id IS NULL AND p_phone IS NOT NULL AND trim(p_phone) != '' THEN
    SELECT c.id, c.full_name, c.phone, c.dni, c.email, c.customer_number, 
           c.created_by_admin, c.address, c.city, c.province
    INTO v_existing_customer
    FROM public.customers c
    WHERE c.phone = trim(p_phone)
      AND c.id NOT IN (
        SELECT customer_id 
        FROM public.customer_auth_links 
        WHERE customer_id IS NOT NULL
      )
    LIMIT 1;
    
    IF v_existing_customer.id IS NOT NULL THEN
      v_match_type := 'phone';
      v_customer_id := v_existing_customer.id;
    END IF;
  END IF;
  
  -- Si no hay match por teléfono, buscar por DNI
  IF v_customer_id IS NULL AND p_dni IS NOT NULL AND trim(p_dni) != '' THEN
    SELECT c.id, c.full_name, c.phone, c.dni, c.email, c.customer_number, 
           c.created_by_admin, c.address, c.city, c.province
    INTO v_existing_customer
    FROM public.customers c
    WHERE c.dni = trim(p_dni)
      AND c.id NOT IN (
        SELECT customer_id 
        FROM public.customer_auth_links 
        WHERE customer_id IS NOT NULL
      )
    LIMIT 1;
    
    IF v_existing_customer.id IS NOT NULL THEN
      v_match_type := 'dni';
      v_customer_id := v_existing_customer.id;
    END IF;
  END IF;
  
  -- Si hay match: VINCULAR cuenta existente
  IF v_customer_id IS NOT NULL THEN
    -- Si el customer es temporal (creado por admin), migrar
    IF v_existing_customer.created_by_admin = true THEN
      v_temp_id := v_customer_id;
      
      -- Guardar datos del temporal
      SELECT customer_number, address, city, province
      INTO v_customer_number_temp, v_address_temp, v_city_temp, v_province_temp
      FROM public.customers
      WHERE id = v_temp_id;
      
      -- Actualizar orders y carts al nuevo customer_id
      UPDATE public.orders SET customer_id = p_user_id WHERE customer_id = v_temp_id;
      UPDATE public.carts SET customer_id = p_user_id WHERE customer_id = v_temp_id;
      
      -- Crear nuevo customer con auth_user_id
      INSERT INTO public.customers (
        id, full_name, email, phone, dni, address, city, province,
        customer_number, auth_provider, created_by_admin, linked_at
      )
      VALUES (
        p_user_id,
        COALESCE(nullif(trim(p_full_name), ''), v_existing_customer.full_name),
        COALESCE(nullif(trim(p_email), ''), v_existing_customer.email),
        COALESCE(nullif(trim(p_phone), ''), v_existing_customer.phone),
        COALESCE(nullif(trim(p_dni), ''), v_existing_customer.dni),
        v_address_temp, v_city_temp, v_province_temp,
        v_customer_number_temp,
        'google', false, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        full_name = COALESCE(nullif(trim(p_full_name), ''), customers.full_name),
        email = COALESCE(nullif(trim(p_email), ''), customers.email),
        phone = COALESCE(nullif(trim(p_phone), ''), customers.phone),
        dni = COALESCE(nullif(trim(p_dni), ''), customers.dni),
        auth_provider = 'google',
        created_by_admin = false,
        linked_at = now(),
        updated_at = now();
      
      -- Eliminar customer temporal
      DELETE FROM public.customers WHERE id = v_temp_id;
      
      v_customer_id := p_user_id;
    ELSE
      -- Customer existente normal, solo actualizar datos
      UPDATE public.customers
      SET 
        email = COALESCE(nullif(trim(p_email), ''), email),
        phone = COALESCE(nullif(trim(p_phone), ''), phone),
        full_name = COALESCE(nullif(trim(p_full_name), ''), full_name),
        dni = COALESCE(nullif(trim(p_dni), ''), dni),
        auth_provider = 'google',
        linked_at = now(),
        updated_at = now()
      WHERE id = v_customer_id;
    END IF;
    
    -- Crear vínculo
    INSERT INTO public.customer_auth_links (customer_id, auth_user_id, match_type)
    VALUES (v_customer_id, p_user_id, v_match_type)
    ON CONFLICT (auth_user_id) DO UPDATE SET
      customer_id = v_customer_id,
      match_type = v_match_type;
    
    RETURN json_build_object(
      'action', 'linked',
      'customer_id', v_customer_id,
      'match_type', v_match_type,
      'customer_number', v_existing_customer.customer_number,
      'message', 'Cliente vinculado exitosamente'
    );
  END IF;
  
  -- Si no hay match: CREAR nuevo cliente
  SELECT id INTO v_customer_id
  FROM public.customers
  WHERE id = p_user_id
  LIMIT 1;
  
  IF v_customer_id IS NULL THEN
    -- Crear nuevo customer con el ID del auth.users
    INSERT INTO public.customers (
      id, full_name, email, phone, dni, customer_number,
      auth_provider, created_by_admin, linked_at
    )
    VALUES (
      p_user_id,
      nullif(trim(p_full_name), ''),
      nullif(trim(p_email), ''),
      nullif(trim(p_phone), ''),
      nullif(trim(p_dni), ''),
      public.generate_customer_number(),
      'google',
      false,
      now()
    )
    RETURNING id INTO v_customer_id;
  END IF;
  
  -- Crear vínculo
  INSERT INTO public.customer_auth_links (customer_id, auth_user_id, match_type)
  VALUES (v_customer_id, p_user_id, 'new')
  ON CONFLICT (auth_user_id) DO NOTHING;
  
  RETURN json_build_object(
    'action', 'created',
    'customer_id', v_customer_id,
    'message', 'Nuevo cliente creado'
  );
END;
$$;

-- 4. Permisos
GRANT EXECUTE ON FUNCTION public.get_customer_id_for_user(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.rpc_link_or_create_customer(uuid, text, text, text, text) TO authenticated, anon;
GRANT SELECT ON public.customer_auth_links TO authenticated;

-- 5. RLS para customer_auth_links
ALTER TABLE public.customer_auth_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_auth_links_self_select ON public.customer_auth_links;
CREATE POLICY customer_auth_links_self_select ON public.customer_auth_links
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

DROP POLICY IF EXISTS customer_auth_links_admin_all ON public.customer_auth_links;
CREATE POLICY customer_auth_links_admin_all ON public.customer_auth_links
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admins 
      WHERE user_id = auth.uid()
    )
  );

-- 6. Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');
