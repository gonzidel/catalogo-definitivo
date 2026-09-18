-- 340_cancelled_pending_stock_count_sources.sql
--
-- El flag admin_confirmed_missing se usa para dos cosas:
--   1) ítem marcado "sin stock" (missing) y luego cancelado por la clienta (269)
--   2) alta manual admin sin stock verificado, que igual inyecta fuentes
--
-- 319 excluía (1) y (2) del "stock pendiente". En (2) el stock SÍ está apartado
-- (A56782 Ana Chamorro, A56807 Jaqueline Mazzeto): la clienta quita el producto
-- y el Kanban no pedía ✓ / no iba a Cancelados. Si el admin confirmaba otro
-- ítem, order_eligible_for_empty_deletion podía borrar el pedido con esas
-- fuentes todavía vivas (mismo riesgo que 319 / A56391).
--
-- Criterio nuevo = espejo de nj/lib/orders/domain.ts:
-- cancelled + order_item_stock_sources.qty > 0 → pendiente, sin mirar el flag.
--
-- Riesgo: BAJO. Más conservador (bloquea borrado; pide ✓ si hay fuentes).
-- Un ítem missing con traza fantasma (A55552) puede volver a pedir ✓; el admin
-- no debe confirmar si no hay pieza física.
-- Rollback: reaplicar la función desde 319_order_eligible_pending_cancelled_stock.sql.

CREATE OR REPLACE FUNCTION public.order_has_cancelled_items_pending_stock_return(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) = 'cancelled'
      AND greatest(coalesce(s.qty, 0), 0) > 0
  );
$$;

COMMENT ON FUNCTION public.order_has_cancelled_items_pending_stock_return(uuid) IS
  'true si el pedido tiene ítems cancelled con order_item_stock_sources qty > 0 (340: no excluye admin_confirmed_missing; alta manual con stock inyectado también cuenta).';
