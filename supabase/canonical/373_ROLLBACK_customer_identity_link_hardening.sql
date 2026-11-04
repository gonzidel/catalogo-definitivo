-- ROLLBACK de 373: restaura las definiciones previas (2026-10-09) y quita trigger y helpers.
-- rpc_upsert_customer vuelve a SECURITY INVOKER (el original no declaraba SECURITY DEFINER).

BEGIN;

DROP TRIGGER IF EXISTS a0_customers_protect_identity_link ON public.customers;
DROP FUNCTION IF EXISTS public.fn_customers_protect_identity_link();

CREATE OR REPLACE FUNCTION public.rpc_link_public_sales_customer(p_user_id uuid, p_email text, p_dni text, p_phone text, p_province text DEFAULT NULL::text, p_city text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_public_customer RECORD;
  v_admin_customer RECORD;
  v_geo_required boolean;
BEGIN
  v_geo_required :=
    (p_province IS NOT NULL AND trim(p_province) <> '')
    OR (p_city IS NOT NULL AND trim(p_city) <> '');

  IF p_phone IS NOT NULL AND trim(p_phone) <> '' THEN
    SELECT id, customer_number, qr_code, first_name, last_name, phone, email, document_number
    INTO v_public_customer
    FROM public.public_sales_customers
    WHERE public.phones_match_by_suffix(phone, p_phone)
      AND id NOT IN (
        SELECT public_sales_customer_id
        FROM public.customers
        WHERE public_sales_customer_id IS NOT NULL
      )
    ORDER BY created_at ASC NULLS LAST
    LIMIT 1;

    IF v_public_customer.id IS NOT NULL THEN
      RETURN json_build_object(
        'found', true,
        'source', 'public_sales',
        'customer_number', v_public_customer.customer_number,
        'qr_code', v_public_customer.qr_code,
        'public_sales_customer_id', v_public_customer.id,
        'first_name', v_public_customer.first_name,
        'last_name', v_public_customer.last_name
      );
    END IF;

    SELECT id, customer_number, full_name, phone, dni, email, address, city, province
    INTO v_admin_customer
    FROM public.customers
    WHERE created_by_admin = true
      AND public.phones_match_by_suffix(phone, p_phone)
      AND id NOT IN (
        SELECT customer_id
        FROM public.customer_auth_links
        WHERE customer_id IS NOT NULL
      )
      AND (
        NOT v_geo_required
        OR (
          (p_province IS NULL OR trim(p_province) = ''
            OR lower(trim(coalesce(province, ''))) = lower(trim(p_province)))
          AND (p_city IS NULL OR trim(p_city) = ''
            OR lower(trim(coalesce(city, ''))) = lower(trim(p_city)))
        )
      )
    ORDER BY created_at ASC NULLS LAST
    LIMIT 1;

    IF v_admin_customer.id IS NOT NULL THEN
      RETURN json_build_object(
        'found', true,
        'source', 'admin_orders',
        'customer_number', v_admin_customer.customer_number,
        'admin_customer_id', v_admin_customer.id,
        'address', v_admin_customer.address,
        'city', v_admin_customer.city,
        'province', v_admin_customer.province,
        'full_name', v_admin_customer.full_name
      );
    END IF;
  END IF;

  IF p_email IS NOT NULL AND trim(p_email) <> '' THEN
    SELECT id, customer_number, qr_code, first_name, last_name, phone, email, document_number
    INTO v_public_customer
    FROM public.public_sales_customers
    WHERE lower(trim(email)) = lower(trim(p_email))
      AND id NOT IN (
        SELECT public_sales_customer_id
        FROM public.customers
        WHERE public_sales_customer_id IS NOT NULL
      )
    LIMIT 1;

    IF v_public_customer.id IS NOT NULL THEN
      RETURN json_build_object(
        'found', true,
        'source', 'public_sales',
        'customer_number', v_public_customer.customer_number,
        'qr_code', v_public_customer.qr_code,
        'public_sales_customer_id', v_public_customer.id,
        'first_name', v_public_customer.first_name,
        'last_name', v_public_customer.last_name
      );
    END IF;

    SELECT id, customer_number, full_name, phone, dni, email, address, city, province
    INTO v_admin_customer
    FROM public.customers
    WHERE created_by_admin = true
      AND lower(trim(email)) = lower(trim(p_email))
      AND id NOT IN (
        SELECT customer_id
        FROM public.customer_auth_links
        WHERE customer_id IS NOT NULL
      )
    LIMIT 1;

    IF v_admin_customer.id IS NOT NULL THEN
      RETURN json_build_object(
        'found', true,
        'source', 'admin_orders',
        'customer_number', v_admin_customer.customer_number,
        'admin_customer_id', v_admin_customer.id,
        'address', v_admin_customer.address,
        'city', v_admin_customer.city,
        'province', v_admin_customer.province,
        'full_name', v_admin_customer.full_name
      );
    END IF;
  END IF;

  IF p_dni IS NOT NULL AND trim(p_dni) <> '' THEN
    SELECT id, customer_number, qr_code, first_name, last_name, phone, email, document_number
    INTO v_public_customer
    FROM public.public_sales_customers
    WHERE trim(document_number) = trim(p_dni)
      AND id NOT IN (
        SELECT public_sales_customer_id
        FROM public.customers
        WHERE public_sales_customer_id IS NOT NULL
      )
    LIMIT 1;

    IF v_public_customer.id IS NOT NULL THEN
      RETURN json_build_object(
        'found', true,
        'source', 'public_sales',
        'customer_number', v_public_customer.customer_number,
        'qr_code', v_public_customer.qr_code,
        'public_sales_customer_id', v_public_customer.id,
        'first_name', v_public_customer.first_name,
        'last_name', v_public_customer.last_name
      );
    END IF;

    SELECT id, customer_number, full_name, phone, dni, email, address, city, province
    INTO v_admin_customer
    FROM public.customers
    WHERE created_by_admin = true
      AND trim(dni) = trim(p_dni)
      AND id NOT IN (
        SELECT customer_id
        FROM public.customer_auth_links
        WHERE customer_id IS NOT NULL
      )
    LIMIT 1;

    IF v_admin_customer.id IS NOT NULL THEN
      RETURN json_build_object(
        'found', true,
        'source', 'admin_orders',
        'customer_number', v_admin_customer.customer_number,
        'admin_customer_id', v_admin_customer.id,
        'address', v_admin_customer.address,
        'city', v_admin_customer.city,
        'province', v_admin_customer.province,
        'full_name', v_admin_customer.full_name
      );
    END IF;
  END IF;

  RETURN json_build_object('found', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_upsert_customer(p_full_name text, p_address text, p_city text, p_province text, p_phone text, p_dni text, p_email text, p_customer_number text DEFAULT NULL::text, p_qr_code uuid DEFAULT NULL::uuid, p_public_sales_customer_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.rpc_link_or_create_customer(p_user_id uuid, p_email text, p_phone text DEFAULT NULL::text, p_full_name text DEFAULT NULL::text, p_dni text DEFAULT NULL::text, p_province text DEFAULT NULL::text, p_city text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  v_qr_temp uuid;
  v_public_sales_id uuid;
  v_geo_required boolean;
  v_display_name text;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RETURN json_build_object('action', 'error', 'message', 'No autorizado');
  END IF;

  v_display_name := nullif(trim(coalesce(p_full_name, '')), '');

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

  v_geo_required :=
    (p_province IS NOT NULL AND trim(p_province) <> '')
    OR (p_city IS NOT NULL AND trim(p_city) <> '');

  IF p_phone IS NOT NULL AND trim(p_phone) <> '' THEN
    SELECT c.id, c.full_name, c.phone, c.dni, c.email, c.customer_number,
           c.created_by_admin, c.address, c.city, c.province,
           c.qr_code, c.public_sales_customer_id
    INTO v_existing_customer
    FROM public.customers c
    WHERE public.phones_match_by_suffix(c.phone, p_phone)
      AND c.id NOT IN (SELECT customer_id FROM public.customer_auth_links WHERE customer_id IS NOT NULL)
      AND c.id IS DISTINCT FROM p_user_id
      AND (
        NOT v_geo_required
        OR (
          (p_province IS NULL OR trim(p_province) = ''
            OR public.normalize_geo_label(c.province) = public.normalize_geo_label(p_province))
          AND (p_city IS NULL OR trim(p_city) = ''
            OR public.normalize_geo_label(c.city) = public.normalize_geo_label(p_city))
        )
      )
    ORDER BY c.created_by_admin DESC NULLS LAST, c.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_existing_customer.id IS NOT NULL THEN
      v_match_type := 'phone';
      v_customer_id := v_existing_customer.id;
    END IF;
  END IF;

  IF v_customer_id IS NULL AND p_email IS NOT NULL AND trim(p_email) <> '' THEN
    SELECT c.id, c.full_name, c.phone, c.dni, c.email, c.customer_number,
           c.created_by_admin, c.address, c.city, c.province,
           c.qr_code, c.public_sales_customer_id
    INTO v_existing_customer
    FROM public.customers c
    WHERE lower(trim(c.email)) = lower(trim(p_email))
      AND c.id NOT IN (SELECT customer_id FROM public.customer_auth_links WHERE customer_id IS NOT NULL)
      AND c.id IS DISTINCT FROM p_user_id
    ORDER BY c.created_by_admin DESC NULLS LAST, c.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_existing_customer.id IS NOT NULL THEN
      v_match_type := 'email';
      v_customer_id := v_existing_customer.id;
    END IF;
  END IF;

  IF v_customer_id IS NULL AND p_dni IS NOT NULL AND trim(p_dni) <> '' THEN
    SELECT c.id, c.full_name, c.phone, c.dni, c.email, c.customer_number,
           c.created_by_admin, c.address, c.city, c.province,
           c.qr_code, c.public_sales_customer_id
    INTO v_existing_customer
    FROM public.customers c
    WHERE trim(c.dni) = trim(p_dni)
      AND c.id NOT IN (SELECT customer_id FROM public.customer_auth_links WHERE customer_id IS NOT NULL)
      AND c.id IS DISTINCT FROM p_user_id
    ORDER BY c.created_by_admin DESC NULLS LAST, c.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_existing_customer.id IS NOT NULL THEN
      v_match_type := 'dni';
      v_customer_id := v_existing_customer.id;
    END IF;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    IF coalesce(v_existing_customer.created_by_admin, false) = true THEN
      v_temp_id := v_customer_id;

      SELECT customer_number, address, city, province, qr_code, public_sales_customer_id
      INTO v_customer_number_temp, v_address_temp, v_city_temp, v_province_temp, v_qr_temp, v_public_sales_id
      FROM public.customers WHERE id = v_temp_id;

      UPDATE public.customers SET customer_number = NULL, updated_at = now() WHERE id = v_temp_id;
      UPDATE public.orders SET customer_id = p_user_id WHERE customer_id = v_temp_id;
      UPDATE public.carts SET customer_id = p_user_id WHERE customer_id = v_temp_id;

      IF to_regclass('public.customer_notifications') IS NOT NULL THEN
        EXECUTE 'UPDATE public.customer_notifications SET customer_id = $1 WHERE customer_id = $2' USING p_user_id, v_temp_id;
      END IF;
      IF to_regclass('public.order_notifications') IS NOT NULL THEN
        EXECUTE 'UPDATE public.order_notifications SET customer_id = $1 WHERE customer_id = $2' USING p_user_id, v_temp_id;
      END IF;
      IF to_regclass('public.cod_transport_customer_aliases') IS NOT NULL THEN
        EXECUTE 'UPDATE public.cod_transport_customer_aliases SET customer_id = $1 WHERE customer_id = $2' USING p_user_id, v_temp_id;
      END IF;
      IF to_regclass('public.cod_transport_differences') IS NOT NULL THEN
        EXECUTE 'UPDATE public.cod_transport_differences SET customer_id = $1 WHERE customer_id = $2' USING p_user_id, v_temp_id;
      END IF;
      IF to_regclass('public.cod_transport_adjustments') IS NOT NULL THEN
        EXECUTE 'UPDATE public.cod_transport_adjustments SET customer_id = $1 WHERE customer_id = $2' USING p_user_id, v_temp_id;
      END IF;
      IF to_regclass('public.customer_link_history') IS NOT NULL THEN
        EXECUTE 'UPDATE public.customer_link_history SET customer_id = $1 WHERE customer_id = $2' USING p_user_id, v_temp_id;
      END IF;

      INSERT INTO public.customers (
        id, full_name, email, phone, dni, address, city, province,
        customer_number, qr_code, public_sales_customer_id,
        auth_provider, created_by_admin, linked_at
      ) VALUES (
        p_user_id,
        COALESCE(v_display_name, v_existing_customer.full_name),
        COALESCE(nullif(trim(p_email), ''), v_existing_customer.email),
        COALESCE(nullif(trim(p_phone), ''), v_existing_customer.phone),
        COALESCE(nullif(trim(p_dni), ''), v_existing_customer.dni),
        v_address_temp,
        COALESCE(nullif(trim(coalesce(p_city, '')), ''), v_city_temp),
        COALESCE(nullif(trim(coalesce(p_province, '')), ''), v_province_temp),
        v_customer_number_temp, v_qr_temp, v_public_sales_id,
        'google', false, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        full_name = COALESCE(v_display_name, customers.full_name),
        email = COALESCE(nullif(trim(p_email), ''), customers.email),
        phone = COALESCE(nullif(trim(p_phone), ''), customers.phone),
        dni = COALESCE(nullif(trim(p_dni), ''), customers.dni),
        address = COALESCE(customers.address, v_address_temp),
        city = COALESCE(nullif(trim(coalesce(p_city, '')), ''), customers.city, v_city_temp),
        province = COALESCE(nullif(trim(coalesce(p_province, '')), ''), customers.province, v_province_temp),
        customer_number = COALESCE(v_customer_number_temp, customers.customer_number),
        qr_code = COALESCE(v_qr_temp, customers.qr_code),
        public_sales_customer_id = COALESCE(v_public_sales_id, customers.public_sales_customer_id),
        auth_provider = 'google', created_by_admin = false, linked_at = now(), updated_at = now();

      DELETE FROM public.customers WHERE id = v_temp_id;
      v_customer_id := p_user_id;
    ELSE
      UPDATE public.customers SET
        email = COALESCE(nullif(trim(p_email), ''), email),
        phone = COALESCE(nullif(trim(p_phone), ''), phone),
        full_name = COALESCE(v_display_name, full_name),
        dni = COALESCE(nullif(trim(p_dni), ''), dni),
        city = COALESCE(nullif(trim(coalesce(p_city, '')), ''), city),
        province = COALESCE(nullif(trim(coalesce(p_province, '')), ''), province),
        auth_provider = 'google', linked_at = now(), updated_at = now()
      WHERE id = v_customer_id;
    END IF;

    INSERT INTO public.customer_auth_links (customer_id, auth_user_id, match_type)
    VALUES (v_customer_id, p_user_id, v_match_type)
    ON CONFLICT (auth_user_id) DO UPDATE SET
      customer_id = EXCLUDED.customer_id,
      match_type = EXCLUDED.match_type,
      linked_at = now();

    RETURN json_build_object(
      'action', 'linked',
      'customer_id', v_customer_id,
      'match_type', v_match_type,
      'customer_number', v_existing_customer.customer_number,
      'message', 'Cliente vinculado exitosamente'
    );
  END IF;

  SELECT id INTO v_customer_id FROM public.customers WHERE id = p_user_id LIMIT 1;

  IF v_customer_id IS NULL THEN
    INSERT INTO public.customers (
      id, full_name, email, phone, dni, city, province, customer_number,
      auth_provider, created_by_admin, linked_at
    ) VALUES (
      p_user_id, v_display_name,
      nullif(trim(p_email), ''), nullif(trim(p_phone), ''), nullif(trim(p_dni), ''),
      nullif(trim(coalesce(p_city, '')), ''), nullif(trim(coalesce(p_province, '')), ''),
      public.generate_customer_number(), 'google', false, now()
    ) RETURNING id INTO v_customer_id;
  END IF;

  INSERT INTO public.customer_auth_links (customer_id, auth_user_id, match_type)
  VALUES (v_customer_id, p_user_id, 'new')
  ON CONFLICT (auth_user_id) DO NOTHING;

  RETURN json_build_object(
    'action', 'created',
    'customer_id', v_customer_id,
    'message', 'Nuevo cliente creado'
  );
END;
$function$;

DROP FUNCTION IF EXISTS public.fyl_customer_identity_match_ok(text, text, text, text);
DROP FUNCTION IF EXISTS public.fyl_verified_auth_email(uuid);

GRANT EXECUTE ON FUNCTION
  public.rpc_link_public_sales_customer(uuid, text, text, text, text, text),
  public.rpc_upsert_customer(text, text, text, text, text, text, text, text, uuid, uuid),
  public.rpc_link_or_create_customer(uuid, text, text, text, text, text, text)
TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
