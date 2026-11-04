-- 334_paso_b_staging_harness.sql
-- Mutante. SOLO contra un schema fyl-core clonado (branch sano).
-- NO ejecutar en dtfznewwvsadkorxwzft (producción).
--
-- Prefijo de fixtures: FYL334B
-- Requiere: warehouses, RPCs create/update local_order, create/void public_sale,
--           generate_sale_number, generate_local_order_number, admins, auth.uid().

-- Este archivo es el plan ejecutable. Cada bloque se corre en su propia sesión
-- después de aplicar 334. No se auto-ejecuta.

-- =============================================================================
-- 0) Guard: abortar si parece producción
-- =============================================================================
do $$
begin
  if exists (
    select 1 from public.public_sales
    where sale_number in ('fylA10223', '#fylA10223')
      and notes ilike '%LOC00769%'
  ) and exists (
    select 1 from public.local_orders where order_number = 'LOC00769'
  ) then
    raise exception '334 Paso B: este lookup parece fyl-core prod. Abortado.';
  end if;
end $$;

-- =============================================================================
-- 1) Impersonación admin (misma sesión)
-- =============================================================================
-- Elegir un admin existente o crear uno de fixture en el branch.
-- select set_config('request.jwt.claim.sub', '<admin_user_id>', true);
-- select set_config('request.jwt.claims', '{"sub":"<admin_user_id>","role":"authenticated"}', true);

-- =============================================================================
-- 2) Casos
-- =============================================================================
-- B1 Pedido simple
--   rpc_create_local_order → rpc_finalize_local_order_to_public_sale (mismos items)
--   CHECK: lo.total_amount = ps.total_amount
--          ps.local_order_id = lo.id
--          lo.status = 'completed'
--          count(public_sale_items) = líneas + extras notes
--          stock no baja otra vez (from_local_order)
--
-- B2 Agregar producto
--   create 1 línea → finalize con 2 líneas
--   CHECK: venta tiene exactamente las 2; stock de la nueva línea descontado
--          una sola vez (en update, no en create)
--
-- B3 Quitar producto
--   create 2 líneas → finalize con 1
--   CHECK: venta tiene 1; stock de la quitada vuelve a venta-publico
--          (herencia de rpc_update_local_order: SIEMPRE a VP, no al depósito origen)
--
-- B4 Notes
--   shipping / discount / extras_amount / extras_percentage / combo
--   CHECK: total = greatest(lines+ship-disc+extra$,0) luego * (1+pct/100)
--          envío y descuento NO aparecen como public_sale_items
--
-- B5 Doble cierre
--   finalize ×2 mismo id
--   CHECK: 1 public_sale; 2º response idempotent_replay=true
--
-- B6 Carrera
--   dos execute_sql paralelos, mismo local_order
--   CHECK: 1 public_sale; la otra replay o 23505
--
-- B7 Error forzado
--   replace temporal rpc_close_mirrored_retiro_from_local_order → RAISE
--   finalize → exception
--   CHECK: 0 public_sales nuevas, lo.status != completed, stock = pre-finalize
--   restaurar close original
--
-- B8 Void
--   finalize → rpc_void_public_sale
--   CHECK: stock +qty_venta_publico/+qty_general por sold_size_normalized
--          segundo void no duplica; UNIQUE permite otra venta pero completed bloquea
--
-- B9 Backfill FYLA10223-like
--   insert loc + sale notes 'Pedido local LOC…' sin local_order_id
--   correr el UPDATE de 334
--   CHECK: solo cambia local_order_id; total_amount / items / voided_at iguales
