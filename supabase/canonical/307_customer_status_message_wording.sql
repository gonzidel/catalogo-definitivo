-- 307_customer_status_message_wording.sql
-- Nuevo copy WhatsApp Activos / campana (paridad nj/lib/orders/customer-status-message.ts)

CREATE OR REPLACE FUNCTION public.fn_build_customer_status_message(
  p_confirmed_count integer,
  p_missing_labels jsonb,
  p_dashboard_url text DEFAULT '/nj/dashboard?tab=active-order'
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
BEGIN
  SELECT coalesce(array_agg(x), '{}'::text[])
    INTO v_missing
    FROM jsonb_array_elements_text(coalesce(p_missing_labels, '[]'::jsonb)) AS t(x);

  v_missing_count := coalesce(array_length(v_missing, 1), 0);
  v_url := coalesce(nullif(trim(p_dashboard_url), ''), '/nj/dashboard?tab=active-order');
  v_confirmed := greatest(0, coalesce(p_confirmed_count, 0));

  IF v_missing_count = 0 THEN
    RETURN 'Hola 👋 Todos los productos de tu pedido ya están apartados y listos.' || E'\n\n'
      || 'Podés revisar tu pedido cuando quieras desde acá: ' || v_url || ' 😊';
  END IF;

  IF v_confirmed <= 0 THEN
    RETURN 'Hola 👋 No pudimos apartar los productos de tu pedido porque ya no quedan disponibles.' || E'\n\n'
      || 'Podés revisar cuáles son desde acá: ' || v_url || '.' || E'\n\n'
      || 'Cualquier consulta, podés escribirnos 😊';
  END IF;

  IF v_confirmed = 1 THEN
    v_count_label := '1 producto';
  ELSE
    v_count_label := v_confirmed::text || ' productos';
  END IF;

  RETURN 'Hola 👋 Ya apartamos ' || v_count_label || ' de tu pedido, pero algunos ya no están disponibles.' || E'\n\n'
    || 'Podés revisar cuáles quedaron apartados y cuáles faltaron desde acá: ' || v_url || '.' || E'\n\n'
    || 'Cualquier consulta, podés escribirnos 😊';
END;
$$;
