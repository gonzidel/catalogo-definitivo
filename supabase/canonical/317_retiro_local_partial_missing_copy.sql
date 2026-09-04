-- 317: copy parcial + todo sin stock — retiro local especial.

CREATE OR REPLACE FUNCTION public.fn_build_retiro_local_customer_status_message(
  p_confirmed_count integer,
  p_missing_labels jsonb,
  p_pickup_deadline_at timestamptz DEFAULT NULL,
  p_dashboard_url text DEFAULT '/nj/dashboard?tab=active-order',
  p_order_number text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_missing text[];
  v_missing_count int;
  v_url text;
  v_confirmed int;
  v_count_label text;
  v_plazo_ready text := '';
  v_plazo_inline text := '';
  v_time text;
  v_days int;
  v_order_no text;
  v_pickup_hint text;
BEGIN
  SELECT coalesce(array_agg(x), '{}'::text[])
    INTO v_missing
    FROM jsonb_array_elements_text(coalesce(p_missing_labels, '[]'::jsonb)) AS t(x);

  v_missing_count := coalesce(array_length(v_missing, 1), 0);
  v_url := coalesce(nullif(trim(p_dashboard_url), ''), '/nj/dashboard?tab=active-order');
  v_confirmed := greatest(0, coalesce(p_confirmed_count, 0));
  v_order_no := nullif(trim(p_order_number), '');

  IF p_pickup_deadline_at IS NOT NULL THEN
    v_time := to_char(p_pickup_deadline_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI') || ' hs';
    v_days := (p_pickup_deadline_at::date - (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date);
    IF v_days <= 0 THEN
      v_plazo_inline := 'hoy a las ' || v_time;
      v_plazo_ready := 'Tenés tiempo hasta ' || v_plazo_inline || '.';
    ELSIF v_days = 1 THEN
      v_plazo_inline := 'mañana a las ' || v_time;
      v_plazo_ready := 'Tenés tiempo hasta ' || v_plazo_inline || '.';
    ELSE
      v_plazo_inline := 'el ' || to_char(p_pickup_deadline_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM') || ' a las ' || v_time;
      v_plazo_ready := 'Tenés tiempo hasta ' || v_plazo_inline || '.';
    END IF;
  END IF;

  IF v_missing_count = 0 THEN
    v_pickup_hint := CASE
      WHEN v_order_no IS NOT NULL THEN 'Al retirar, indicá tu nombre o número de pedido ' || v_order_no || '.'
      ELSE 'Al retirar, indicá tu nombre o número de pedido.'
    END;

    RETURN 'Hola 👋 Tu pedido ya está listo para retirar.' || E'\n\n'
      || 'Podés pasar por nuestro local en Av. Alberdi 1099.'
      || CASE WHEN v_plazo_ready <> '' THEN ' ' || v_plazo_ready ELSE '' END
      || E'\n\n' || v_pickup_hint || E'\n\n'
      || 'Podés revisar tu pedido acá: ' || v_url || ' 😊';
  END IF;

  IF v_confirmed <= 0 THEN
    RETURN 'Hola 👋 No pudimos preparar tu pedido porque los productos que elegiste ya no están disponibles.' || E'\n\n'
      || 'Podés revisar el detalle de tu pedido acá: ' || v_url || E'\n\n'
      || 'Cualquier consulta, podés escribirnos 😊';
  END IF;

  IF v_confirmed = 1 THEN
    v_count_label := '1 producto';
  ELSE
    v_count_label := v_confirmed::text || ' productos';
  END IF;

  RETURN 'Hola 👋 Tu pedido ya está listo para retirar.' || E'\n\n'
    || 'Pudimos preparar *' || v_count_label || '*, pero algunos ya no están disponibles.' || E'\n\n'
    || 'Podés pasar por nuestro local en *Av. Alberdi 1099*.'
    || CASE
         WHEN v_plazo_inline <> '' THEN ' Tenés tiempo hasta *' || v_plazo_inline || '* para retirarlo.'
         ELSE ''
       END
    || E'\n\n'
    || 'Podés revisar qué productos están listos y cuáles faltaron acá: ' || v_url || E'\n\n'
    || 'Cualquier consulta, podés escribirnos 😊';
END;
$$;
