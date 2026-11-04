-- Tests 377: correr DENTRO de la transacción de la migración, antes del COMMIT
-- (o en una base con datos de producción). Cualquier fallo aborta la transacción.

DO $$
DECLARE
  v_drift text;
BEGIN
  SELECT string_agg(o.order_number, ',' ORDER BY o.order_number)
  INTO v_drift
  FROM public.orders o
  WHERE o.status IN ('active', 'closing_soon', 'closed')
    AND round(public.fn_order_canonical_total(o.id, o.notes)) <> round(coalesce(o.total_amount, 0));

  -- Antes de 377 solo difieren el afectado por el bug y un histórico ya conocido.
  IF coalesce(v_drift, '') NOT IN ('A56703,A57638', 'A57638', 'A56703', '') THEN
    RAISE EXCEPTION '377: pedidos abiertos/cerrados cambiarían de total: %', v_drift;
  END IF;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT o.order_number, public.fn_order_promo_discount(o.id) AS discount, x.expected
    FROM public.orders o
    JOIN (VALUES ('A57569', 4000), ('A57610', 8000), ('A57624', 4000), ('A57638', 4000)) AS x(order_number, expected)
      ON x.order_number = o.order_number
  LOOP
    IF r.discount <> r.expected THEN
      RAISE EXCEPTION '377: % descuento % (esperado %)', r.order_number, r.discount, r.expected;
    END IF;
  END LOOP;
END $$;

-- El trigger fija el total canónico aunque la ruta escriba otro valor (simula Editar pedido sin promo).
SAVEPOINT t377;
DO $$
DECLARE
  v_total numeric;
BEGIN
  UPDATE public.orders SET total_amount = 293000 WHERE order_number = 'A57638'
  RETURNING total_amount INTO v_total;
  IF v_total <> 289000 THEN
    RAISE EXCEPTION '377: A57638 quedó en % (esperado 289000)', v_total;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT t377;

-- Pedidos enviados no se tocan.
SAVEPOINT t377_sent;
DO $$
DECLARE
  v_total numeric;
BEGIN
  UPDATE public.orders SET total_amount = 171500 WHERE order_number = 'A57569'
  RETURNING total_amount INTO v_total;
  IF v_total <> 171500 THEN
    RAISE EXCEPTION '377: un pedido sent cambió de total (%)', v_total;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT t377_sent;
