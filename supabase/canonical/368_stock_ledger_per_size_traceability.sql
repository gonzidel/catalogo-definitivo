-- 368_stock_ledger_per_size_traceability.sql
--
-- TÉCNICA (2026-10-05): trazabilidad completa del stock por talle.
--
-- Problema (auditorías R2776 y L3040): stock_history no registra varios caminos
-- que mueven stock, así que no se puede reconstruir de dónde sale una diferencia:
--   * rpc_checkout_cart (descuento por compra)
--   * rpc_cancel_order_item (reingreso de ítems reserved/waiting)
--   * rpc_cancel_order_full / borrado de pedidos (el contenido del pedido se pierde)
--   * mantenimiento de vencidos anterior a 367
--   * rpc_save_product_variant_initial_stock (solo registra el total por variante)
--
-- Solución: tabla public.stock_ledger alimentada por triggers, sin tocar ninguna
-- RPC. Cualquier camino (actual o futuro, RPC, cron o SQL directo) queda registrado:
--   * event 'stock': cada cambio de stock_qty en variant_size_warehouse_stock
--     (talle + depósito, antes/después, delta).
--   * event 'source': alta/baja/cambio de order_item_stock_sources (unidades
--     descontadas atadas a un ítem de pedido), con pedido, variante y talle.
--   * event 'order_item_deleted': foto del ítem antes de borrarse.
--   * event 'order_deleted': foto del pedido antes de borrarse (número, estado).
-- Todas las filas guardan txid, la RPC de origen (extraída de current_query()),
-- auth.uid() y el rol de la API, para unir el movimiento de stock con el pedido
-- de la misma transacción.
--
-- No cambia stock, reservas, checkout ni flujos: solo agrega filas de auditoría.
-- stock_history sigue igual (la UI que lo lee no cambia).
--
-- Grants: hasta 2026-10-30 Supabase todavía otorga por defecto todo a anon y
-- authenticated en tablas nuevas; se revoca explícitamente. Solo admins leen
-- (RLS con is_admin()); nadie escribe por la API, solo los triggers.

BEGIN;

-- CREATE TRIGGER toma SHARE ROW EXCLUSIVE en orders, order_items,
-- order_item_stock_sources y variant_size_warehouse_stock: no esperar detrás
-- de una transacción larga (si vence, reintentar).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Guardas: no pisar objetos existentes.
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF to_regclass('public.stock_ledger') IS NOT NULL THEN
    RAISE EXCEPTION '368: public.stock_ledger ya existe';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE NOT tgisinternal AND tgname LIKE 'trg_stock_ledger_%'
  ) THEN
    RAISE EXCEPTION '368: ya existen triggers trg_stock_ledger_*';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1) Tabla
-- ---------------------------------------------------------------------------
CREATE TABLE public.stock_ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  txid          bigint      NOT NULL DEFAULT txid_current(),
  event         text        NOT NULL
                CHECK (event IN ('stock', 'source', 'order_item_deleted', 'order_deleted')),
  variant_id    uuid,
  size          text,
  warehouse_id  uuid,
  qty_before    integer,
  qty_after     integer,
  delta         integer,
  order_id      uuid,
  order_item_id uuid,
  order_number  text,
  status        text,
  origin        text,
  actor         uuid,
  api_role      text
);

COMMENT ON TABLE public.stock_ledger IS
  'canonical:368 — registro automático (triggers) de cada cambio de stock por talle/depósito, '
  'fuentes de reserva de ítems y borrados de ítems/pedidos. Unir por txid. Solo lectura admin.';
COMMENT ON COLUMN public.stock_ledger.qty_before IS
  'stock: stock_qty antes; source: qty de la fuente antes; order_item_deleted: quantity del ítem.';
COMMENT ON COLUMN public.stock_ledger.status IS
  'source/order_item_deleted: estado del ítem; order_deleted: estado del pedido.';
COMMENT ON COLUMN public.stock_ledger.origin IS
  'Función pública invocada por la sentencia de nivel superior (RPC, cron) o inicio del SQL directo.';

CREATE INDEX idx_stock_ledger_variant_created ON public.stock_ledger (variant_id, created_at DESC);
CREATE INDEX idx_stock_ledger_txid            ON public.stock_ledger (txid);
CREATE INDEX idx_stock_ledger_order_id        ON public.stock_ledger (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_stock_ledger_order_item_id   ON public.stock_ledger (order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX idx_stock_ledger_created_brin    ON public.stock_ledger USING brin (created_at);

ALTER TABLE public.stock_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.stock_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.stock_ledger TO authenticated;
GRANT SELECT ON TABLE public.stock_ledger TO service_role;

CREATE POLICY stock_ledger_admin_select ON public.stock_ledger
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ---------------------------------------------------------------------------
-- 2) Contexto de la transacción
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_stock_ledger_origin()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_query text := coalesce(current_query(), '');
  v_match text[];
BEGIN
  v_match := regexp_match(v_query, '"?public"?\."?([A-Za-z0-9_]+)"?\s*\(');
  IF v_match IS NOT NULL THEN
    RETURN v_match[1];
  END IF;
  RETURN 'sql: ' || left(regexp_replace(v_query, '\s+', ' ', 'g'), 80);
END
$function$;

CREATE FUNCTION public.fn_stock_ledger_api_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    session_user::text
  );
$function$;

-- ---------------------------------------------------------------------------
-- 3) Stock por talle/depósito
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.trgfn_stock_ledger_size_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_before integer;
  v_after  integer;
  v_row    record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_before := 0;            v_after := NEW.stock_qty; v_row := NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := OLD.stock_qty; v_after := NEW.stock_qty; v_row := NEW;
  ELSE
    v_before := OLD.stock_qty; v_after := 0;             v_row := OLD;
  END IF;

  IF v_before IS NOT DISTINCT FROM v_after THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.stock_ledger (
    event, variant_id, size, warehouse_id, qty_before, qty_after, delta,
    origin, actor, api_role
  ) VALUES (
    'stock', v_row.variant_id, v_row.size, v_row.warehouse_id,
    v_before, v_after, coalesce(v_after, 0) - coalesce(v_before, 0),
    public.fn_stock_ledger_origin(), auth.uid(), public.fn_stock_ledger_api_role()
  );
  RETURN NULL;
END
$function$;

CREATE TRIGGER trg_stock_ledger_size_stock
  AFTER INSERT OR DELETE OR UPDATE OF stock_qty ON public.variant_size_warehouse_stock
  FOR EACH ROW EXECUTE FUNCTION public.trgfn_stock_ledger_size_stock();

-- ---------------------------------------------------------------------------
-- 4) Fuentes de reserva por ítem
--    En borrados en cascada (pedido -> ítems -> fuentes) el ítem ya no es
--    visible: se toman pedido/variante/talle de la foto order_item_deleted
--    registrada en la misma transacción.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.trgfn_stock_ledger_item_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_before     integer;
  v_after      integer;
  v_row        record;
  v_order_id   uuid;
  v_variant_id uuid;
  v_size       text;
  v_status     text;
  v_number     text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_before := 0;       v_after := NEW.qty; v_row := NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := OLD.qty; v_after := NEW.qty; v_row := NEW;
  ELSE
    v_before := OLD.qty; v_after := 0;       v_row := OLD;
  END IF;

  IF v_before IS NOT DISTINCT FROM v_after THEN
    RETURN NULL;
  END IF;

  SELECT oi.order_id, oi.variant_id, oi.size, oi.status
    INTO v_order_id, v_variant_id, v_size, v_status
    FROM public.order_items oi
   WHERE oi.id = v_row.order_item_id;

  IF FOUND THEN
    SELECT o.order_number INTO v_number FROM public.orders o WHERE o.id = v_order_id;
  ELSE
    SELECT l.order_id, l.variant_id, l.size, l.status, l.order_number
      INTO v_order_id, v_variant_id, v_size, v_status, v_number
      FROM public.stock_ledger l
     WHERE l.event = 'order_item_deleted'
       AND l.order_item_id = v_row.order_item_id
     ORDER BY l.id DESC
     LIMIT 1;
  END IF;

  INSERT INTO public.stock_ledger (
    event, variant_id, size, warehouse_id, qty_before, qty_after, delta,
    order_id, order_item_id, order_number, status,
    origin, actor, api_role
  ) VALUES (
    'source', v_variant_id, v_size, v_row.warehouse_id,
    v_before, v_after, coalesce(v_after, 0) - coalesce(v_before, 0),
    v_order_id, v_row.order_item_id, v_number, v_status,
    public.fn_stock_ledger_origin(), auth.uid(), public.fn_stock_ledger_api_role()
  );
  RETURN NULL;
END
$function$;

CREATE TRIGGER trg_stock_ledger_item_source
  AFTER INSERT OR DELETE OR UPDATE OF qty ON public.order_item_stock_sources
  FOR EACH ROW EXECUTE FUNCTION public.trgfn_stock_ledger_item_source();

-- ---------------------------------------------------------------------------
-- 5) Foto de ítems y pedidos antes de borrarse
--    BEFORE DELETE: corre antes de la cascada, así las fuentes todavía existen
--    y el número de pedido queda disponible para las filas 'source'.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.trgfn_stock_ledger_order_item_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_number text;
BEGIN
  SELECT o.order_number INTO v_number FROM public.orders o WHERE o.id = OLD.order_id;
  IF v_number IS NULL THEN
    SELECT l.order_number INTO v_number
      FROM public.stock_ledger l
     WHERE l.event = 'order_deleted' AND l.order_id = OLD.order_id
     ORDER BY l.id DESC
     LIMIT 1;
  END IF;

  INSERT INTO public.stock_ledger (
    event, variant_id, size, qty_before, qty_after, delta,
    order_id, order_item_id, order_number, status,
    origin, actor, api_role
  ) VALUES (
    'order_item_deleted', OLD.variant_id, OLD.size, OLD.quantity, 0, NULL,
    OLD.order_id, OLD.id, v_number, OLD.status,
    public.fn_stock_ledger_origin(), auth.uid(), public.fn_stock_ledger_api_role()
  );
  RETURN OLD;
END
$function$;

CREATE TRIGGER trg_stock_ledger_order_item_deleted
  BEFORE DELETE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.trgfn_stock_ledger_order_item_deleted();

CREATE FUNCTION public.trgfn_stock_ledger_order_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.stock_ledger (
    event, order_id, order_number, status,
    origin, actor, api_role
  ) VALUES (
    'order_deleted', OLD.id, OLD.order_number, OLD.status,
    public.fn_stock_ledger_origin(), auth.uid(), public.fn_stock_ledger_api_role()
  );
  RETURN OLD;
END
$function$;

CREATE TRIGGER trg_stock_ledger_order_deleted
  BEFORE DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.trgfn_stock_ledger_order_deleted();

-- ---------------------------------------------------------------------------
-- 6) Permisos de funciones: solo las usan los triggers.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.fn_stock_ledger_origin()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_stock_ledger_api_role()               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trgfn_stock_ledger_size_stock()          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trgfn_stock_ledger_item_source()         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trgfn_stock_ledger_order_item_deleted()  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trgfn_stock_ledger_order_deleted()       FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) Vista legible para auditorías (RLS de la tabla base vía security_invoker).
-- ---------------------------------------------------------------------------
CREATE VIEW public.vw_stock_ledger_readable
WITH (security_invoker = on) AS
SELECT
  l.id,
  l.created_at,
  l.txid,
  l.event,
  pv.sku,
  p.name        AS product_name,
  pv.color,
  l.size,
  w.code        AS warehouse,
  l.qty_before,
  l.qty_after,
  l.delta,
  l.order_number,
  l.status,
  l.origin,
  coalesce(a.email, l.actor::text) AS actor,
  l.api_role,
  l.variant_id,
  l.order_id,
  l.order_item_id
FROM public.stock_ledger l
LEFT JOIN public.product_variants pv ON pv.id = l.variant_id
LEFT JOIN public.products p          ON p.id = pv.product_id
LEFT JOIN public.warehouses w        ON w.id = l.warehouse_id
LEFT JOIN public.admins a            ON a.user_id = l.actor;

REVOKE ALL ON public.vw_stock_ledger_readable FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vw_stock_ledger_readable TO authenticated, service_role;

COMMENT ON VIEW public.vw_stock_ledger_readable IS
  'canonical:368 — stock_ledger con SKU, producto, depósito y email del admin que lo hizo.';

COMMIT;
