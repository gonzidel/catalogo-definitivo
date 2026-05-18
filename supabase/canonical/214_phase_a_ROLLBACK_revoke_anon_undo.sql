-- 214 ROLLBACK — Emergencia: deshace SOLO los revokes de la Fase A.
-- Restaura superficie indebida (anon con privilegios amplios en 3 vistas).
-- Usar solo si un deploy falla y hay que volver al estado previo inmediato;
-- la dirección correcta es fix-forward con 214, no mantener anon en compras/publicación.

GRANT ALL PRIVILEGES ON TABLE public.purchase_order_line_fulfillment TO anon;
GRANT ALL PRIVILEGES ON TABLE public.purchase_spend_by_season TO anon;
GRANT ALL PRIVILEGES ON TABLE public.vw_publication_events_performance TO anon;

SELECT pg_notify('pgrst', 'reload schema');
