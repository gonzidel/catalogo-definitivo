-- 359_BACKFILL_order_totals_cancel_missing.sql
--
-- Repara undercharge por cancel-from-missing (auditoría 69) y A56761
-- all-missing pre-356.
--
-- Criterio: total = sum(qty*price) WHERE status NOT IN ('cancelled','missing')
-- Guardas: order_number + total_amount actual exacto (anti-carrera).
--
-- NO APLICAR sin aprobación explícita. Preferible DESPUÉS de 359 (código).
-- Riesgo: medio (UPDATE orders.total_amount). No toca stock ni ítems.

-- Snapshot esperado (revalidar con SELECT antes de correr):
-- A57356: 415500 → 451000
-- A57180: 54900 → 67900
-- A57219: 69600 → 75600
-- A56761: 30000 → 0
--
-- Ejecutar dentro de una transacción manual si el cliente lo permite.
-- Si algún UPDATE afecta 0 filas (total ya cambió), abortar y re-auditar.

UPDATE public.orders o
SET total_amount = 451000.00,
    updated_at = now()
WHERE o.order_number = 'A57356'
  AND o.id = '716a5617-de0f-4e8f-98f9-3c154b039fa0'
  AND o.status = 'active'
  AND o.total_amount = 415500.00;

UPDATE public.orders o
SET total_amount = 67900.00,
    updated_at = now()
WHERE o.order_number = 'A57180'
  AND o.id = '030c450a-ce28-4fa5-85c2-813408a3658a'
  AND o.status = 'closing_soon'
  AND o.total_amount = 54900.00;

UPDATE public.orders o
SET total_amount = 75600.00,
    updated_at = now()
WHERE o.order_number = 'A57219'
  AND o.id = '9517934b-fb3d-4821-8ed0-cde2ef04ce67'
  AND o.status = 'closing_soon'
  AND o.total_amount = 69600.00;

UPDATE public.orders o
SET total_amount = 0,
    updated_at = now()
WHERE o.order_number = 'A56761'
  AND o.id = '8ff3f2ab-0a2d-433b-b029-26ae5cd871f2'
  AND o.status = 'active'
  AND o.total_amount = 30000.00;

-- Post-check (correr aparte o al final):
-- SELECT order_number, total_amount, expected, delta FROM ... (ver tests 359 §C)
-- Expect: 4 filas, delta = 0, y cada UPDATE devolvió 1 fila.
