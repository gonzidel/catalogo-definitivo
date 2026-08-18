-- 244_rpc_get_invoiced_summary.sql
-- Resumen de monto facturado (CAE emitidos), solo para visualización en
-- Ventas Diarias. No se suma a ningún total de ventas existente.
-- "Semana" arranca el lunes. "Mes" arranca el día 1 y se reinicia solo cada mes
-- porque siempre se filtra desde el 1° del mes actual en adelante.

CREATE OR REPLACE FUNCTION public.rpc_get_invoiced_summary()
RETURNS TABLE (
  monto_hoy numeric,
  monto_semana numeric,
  monto_mes numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hoy date;
  v_inicio_semana date;
  v_inicio_mes date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores pueden consultar este resumen';
  END IF;

  v_hoy := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  v_inicio_semana := v_hoy - (EXTRACT(isodow FROM v_hoy)::int - 1);
  v_inicio_mes := date_trunc('month', v_hoy)::date;

  -- invoices.created_at es timestamptz genuino: alcanza con UNA conversión de
  -- zona horaria. "AT TIME ZONE 'UTC' AT TIME ZONE '...'" (doble conversión) es
  -- el patrón correcto solo para columnas timestamp SIN zona horaria que ya
  -- guardan valores en UTC — aplicado a un timestamptz real da un resultado
  -- incorrecto (desplaza ~3hs y puede cambiar el día calculado).
  RETURN QUERY
  SELECT
    COALESCE(SUM(monto_facturado) FILTER (
      WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = v_hoy
    ), 0),
    COALESCE(SUM(monto_facturado) FILTER (
      WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= v_inicio_semana
    ), 0),
    COALESCE(SUM(monto_facturado) FILTER (
      WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= v_inicio_mes
    ), 0)
  FROM public.invoices;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_invoiced_summary() TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
