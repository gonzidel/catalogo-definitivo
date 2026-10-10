-- 373: auto-vínculo de identidad de cliente con criterio mixto y vínculo decidido en el servidor.
--
-- Contexto: docs/FYL-Obsidian/73-SUPABASE-ADVISORS-SECURITY-DEFINER-RLS-2026-10-08.md
--
-- Regla (NEGOCIO CONFIRMADO 2026-10-09): una ficha se vincula automáticamente si el teléfono coincide
-- completo (últimos 8 dígitos normalizados, ambos lados con 8+) y, si la ficha tiene DNI, además el DNI.
-- Como alternativa vincula por email solo si es el email verificado por Google de la cuenta
-- (auth.identities), nunca el email enviado por el navegador; las cuentas email/contraseña no cuentan
-- porque la confirmación de email puede estar en autoconfirmación. DNI solo ya no vincula. Las fichas
-- de otros usuarios web (id en auth.users) no se pueden reclamar.
--
-- Cambios:
-- 1) fyl_customer_identity_match_ok / fyl_verified_auth_email: la regla en un solo lugar.
-- 2) Trigger a0_customers_protect_identity_link: un cliente no puede escribir customer_number, qr_code
--    ni public_sales_customer_id; solo admins, service_role, cron o las RPC de vínculo (flag
--    fyl.customer_link_write).
-- 3) rpc_link_public_sales_customer: usa auth.uid(), aplica la regla y ya no devuelve QR, ids, nombre
--    ni dirección.
-- 4) rpc_upsert_customer: SECURITY DEFINER sobre la fila de auth.uid(); ignora número/qr/id de caja
--    enviados por el navegador y vincula con caja en el servidor con la regla. La fusión con fichas de
--    admin queda solo en rpc_link_or_create_customer (copiar el número de admin chocaba con
--    customers_customer_number_unique y hacía fallar el guardado).
-- 5) rpc_link_or_create_customer: aplica la regla; el resto del flujo (fusión con ficha de admin) igual.

BEGIN;

-- 1) Regla de coincidencia
CREATE OR REPLACE FUNCTION public.fyl_customer_identity_match_ok(
  p_input_phone text,
  p_input_dni text,
  p_record_phone text,
  p_record_dni text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $function$
  SELECT coalesce(
           length(s.input_phone) >= 8
           AND length(s.record_phone) >= 8
           AND right(s.input_phone, 8) = right(s.record_phone, 8)
           AND (s.record_dni = '' OR s.record_dni = s.input_dni),
           false)
  FROM (
    SELECT public.normalize_phone_digits_for_match(p_input_phone) AS input_phone,
           public.normalize_phone_digits_for_match(p_record_phone) AS record_phone,
           regexp_replace(coalesce(p_input_dni, ''), '\D', '', 'g') AS input_dni,
           regexp_replace(coalesce(p_record_dni, ''), '\D', '', 'g') AS record_dni
  ) s
$function$;

REVOKE EXECUTE ON FUNCTION public.fyl_customer_identity_match_ok(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fyl_customer_identity_match_ok(text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fyl_verified_auth_email(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
  SELECT nullif(lower(trim(i.identity_data->>'email')), '')
  FROM auth.identities i
  WHERE i.user_id = p_user_id
    AND i.provider = 'google'
    AND i.identity_data->>'email_verified' = 'true'
  ORDER BY i.created_at ASC NULLS LAST
  LIMIT 1
$function$;

REVOKE EXECUTE ON FUNCTION public.fyl_verified_auth_email(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fyl_verified_auth_email(uuid) TO service_role;

-- 2) Columnas de identidad protegidas
CREATE OR REPLACE FUNCTION public.fn_customers_protect_identity_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
BEGIN
  IF coalesce(auth.role(), '') IN ('', 'service_role')
     OR current_setting('fyl.customer_link_write', true) = '1'
     OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.customer_number := NULL;
    NEW.qr_code := NULL;
    NEW.public_sales_customer_id := NULL;
  ELSE
    NEW.customer_number := OLD.customer_number;
    NEW.qr_code := OLD.qr_code;
    NEW.public_sales_customer_id := OLD.public_sales_customer_id;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_customers_protect_identity_link() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a0_customers_protect_identity_link ON public.customers;
CREATE TRIGGER a0_customers_protect_identity_link
  BEFORE INSERT OR UPDATE OF customer_number, qr_code, public_sales_customer_id ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.fn_customers_protect_identity_link();

-- 3) Vista previa de vínculo (perfil vanilla)
CREATE OR REPLACE FUNCTION public.rpc_link_public_sales_customer(p_user_id uuid, p_email text, p_dni text, p_phone text, p_province text DEFAULT NULL::text, p_city text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_auth_email text;
  v_public_customer RECORD;
  v_admin_customer RECORD;
  v_geo_required boolean;
BEGIN
  IF v_uid IS NULL OR v_uid IS DISTINCT FROM p_user_id THEN
    RETURN json_build_object('found', false);
  END IF;

  v_auth_email := public.fyl_verified_auth_email(v_uid);

  v_geo_required :=
    (p_province IS NOT NULL AND trim(p_province) <> '')
    OR (p_city IS NOT NULL AND trim(p_city) <> '');

  SELECT id, customer_number
  INTO v_public_customer
  FROM public.public_sales_customers
  WHERE (
      public.fyl_customer_identity_match_ok(p_phone, p_dni, phone, document_number)
      OR (v_auth_email IS NOT NULL AND lower(trim(email)) = v_auth_email)
    )
    AND id NOT IN (
      SELECT public_sales_customer_id
      FROM public.customers
      WHERE public_sales_customer_id IS NOT NULL
    )
  ORDER BY public.fyl_customer_identity_match_ok(p_phone, p_dni, phone, document_number) DESC,
           created_at ASC NULLS LAST
  LIMIT 1;

  IF v_public_customer.id IS NOT NULL THEN
    RETURN json_build_object(
      'found', true,
      'source', 'public_sales',
      'customer_number', v_public_customer.customer_number
    );
  END IF;

  SELECT id, customer_number
  INTO v_admin_customer
  FROM public.customers
  WHERE created_by_admin = true
    AND id NOT IN (
      SELECT customer_id
      FROM public.customer_auth_links
      WHERE customer_id IS NOT NULL
    )
    AND (
      (
        public.fyl_customer_identity_match_ok(p_phone, p_dni, phone, dni)
        AND (
          NOT v_geo_required
          OR (
            (p_province IS NULL OR trim(p_province) = ''
              OR lower(trim(coalesce(province, ''))) = lower(trim(p_province)))
            AND (p_city IS NULL OR trim(p_city) = ''
              OR lower(trim(coalesce(city, ''))) = lower(trim(p_city)))
          )
        )
      )
      OR (v_auth_email IS NOT NULL AND lower(trim(email)) = v_auth_email)
    )
  ORDER BY public.fyl_customer_identity_match_ok(p_phone, p_dni, phone, dni) DESC,
           created_at ASC NULLS LAST
  LIMIT 1;

  IF v_admin_customer.id IS NOT NULL THEN
    RETURN json_build_object(
      'found', true,
      'source', 'admin_orders',
      'customer_number', v_admin_customer.customer_number
    );
  END IF;

  RETURN json_build_object('found', false);
END;
$function$;

-- 4) Guardado de perfil: el vínculo con caja lo decide el servidor
CREATE OR REPLACE FUNCTION public.rpc_upsert_customer(p_full_name text, p_address text, p_city text, p_province text, p_phone text, p_dni text, p_email text, p_customer_number text DEFAULT NULL::text, p_qr_code uuid DEFAULT NULL::uuid, p_public_sales_customer_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_id uuid;
  v_current_psc uuid;
  v_psc_id uuid;
  v_psc_qr uuid;
  v_psc_number text;
  v_auth_email text;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Usuario no autenticado'
    );
  END IF;

  v_auth_email := public.fyl_verified_auth_email(v_user_id);

  INSERT INTO public.customers (
    id,
    full_name,
    address,
    city,
    province,
    phone,
    dni,
    email,
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
    updated_at = now();

  SELECT public_sales_customer_id INTO v_current_psc
  FROM public.customers
  WHERE id = v_user_id;

  PERFORM set_config('fyl.customer_link_write', '1', true);

  IF v_current_psc IS NULL THEN
    SELECT psc.id, psc.qr_code, psc.customer_number
    INTO v_psc_id, v_psc_qr, v_psc_number
    FROM public.public_sales_customers psc
    WHERE (
        public.fyl_customer_identity_match_ok(p_phone, p_dni, psc.phone, psc.document_number)
        OR (v_auth_email IS NOT NULL AND lower(trim(psc.email)) = v_auth_email)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.customers c WHERE c.public_sales_customer_id = psc.id
      )
    ORDER BY public.fyl_customer_identity_match_ok(p_phone, p_dni, psc.phone, psc.document_number) DESC,
             psc.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_psc_id IS NOT NULL THEN
      UPDATE public.customers SET
        public_sales_customer_id = v_psc_id,
        qr_code = v_psc_qr,
        customer_number = CASE
          WHEN v_psc_number IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.customers o
            WHERE o.customer_number = v_psc_number AND o.id <> v_user_id
          ) THEN v_psc_number
          ELSE customer_number
        END,
        updated_at = now()
      WHERE id = v_user_id;
    END IF;
  END IF;

  PERFORM set_config('fyl.customer_link_write', '', true);

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

-- 5) Vínculo/fusión al iniciar sesión o completar perfil (catálogo vanilla y NJ)
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
  v_auth_email text;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RETURN json_build_object('action', 'error', 'message', 'No autorizado');
  END IF;

  PERFORM set_config('fyl.customer_link_write', '1', true);

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
    WHERE public.fyl_customer_identity_match_ok(p_phone, p_dni, c.phone, c.dni)
      AND c.id NOT IN (SELECT customer_id FROM public.customer_auth_links WHERE customer_id IS NOT NULL)
      AND c.id IS DISTINCT FROM p_user_id
      AND (coalesce(c.created_by_admin, false) = true
           OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = c.id))
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
      v_match_type := CASE
        WHEN coalesce(trim(v_existing_customer.dni), '') = '' THEN 'phone'
        ELSE 'phone_dni'
      END;
      v_customer_id := v_existing_customer.id;
    END IF;
  END IF;

  v_auth_email := public.fyl_verified_auth_email(p_user_id);

  IF v_customer_id IS NULL AND v_auth_email IS NOT NULL THEN
    SELECT c.id, c.full_name, c.phone, c.dni, c.email, c.customer_number,
           c.created_by_admin, c.address, c.city, c.province,
           c.qr_code, c.public_sales_customer_id
    INTO v_existing_customer
    FROM public.customers c
    WHERE lower(trim(c.email)) = v_auth_email
      AND c.id NOT IN (SELECT customer_id FROM public.customer_auth_links WHERE customer_id IS NOT NULL)
      AND c.id IS DISTINCT FROM p_user_id
      AND (coalesce(c.created_by_admin, false) = true
           OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = c.id))
    ORDER BY c.created_by_admin DESC NULLS LAST, c.created_at ASC NULLS LAST
    LIMIT 1;

    IF v_existing_customer.id IS NOT NULL THEN
      v_match_type := 'email';
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

REVOKE EXECUTE ON FUNCTION
  public.rpc_link_public_sales_customer(uuid, text, text, text, text, text),
  public.rpc_upsert_customer(text, text, text, text, text, text, text, text, uuid, uuid),
  public.rpc_link_or_create_customer(uuid, text, text, text, text, text, text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.rpc_link_public_sales_customer(uuid, text, text, text, text, text),
  public.rpc_upsert_customer(text, text, text, text, text, text, text, text, uuid, uuid),
  public.rpc_link_or_create_customer(uuid, text, text, text, text, text, text)
TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
