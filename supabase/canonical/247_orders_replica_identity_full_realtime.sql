-- Realtime: filtros en UPDATE (order_id / customer_id) requieren columnas en el payload.
-- Con REPLICA IDENTITY DEFAULT solo viaja la PK y el cliente no ve cambios de status.
ALTER TABLE public.orders REPLICA IDENTITY FULL;
ALTER TABLE public.order_items REPLICA IDENTITY FULL;
