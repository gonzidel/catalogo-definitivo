-- 168_public_sale_details_expose_stock_breakdown.sql
-- Exponer desglose de stock por línea en rpc_get_public_sale_details
-- para visibilidad de ventas sin stock confirmado (qty_venta_publico=0 y qty_general=0).

create or replace function public.rpc_get_public_sale_details(p_sale_id uuid)
returns json language plpgsql security definer as $$
declare
  v_result json;
begin
  select json_build_object(
    'sale', json_build_object(
      'id', ps.id,
      'sale_number', ps.sale_number,
      'created_at', ps.created_at,
      'customer_name',
        case
          when psc.first_name is not null
          then psc.first_name || ' ' || coalesce(psc.last_name, '')
          else null
        end,
      'total_amount', ps.total_amount,
      'item_count', ps.item_count,
      'credit_used', ps.credit_used,
      'notes', ps.notes
    ),
    'items', (
      select json_agg(
        json_build_object(
          'id', psi.id,
          'sku', COALESCE(pv.sku, 'EXTRA-ESPECIAL'),
          'product_name', COALESCE(psi.product_name, p.name, 'Extra especial'),
          'color', pv.color,
          'size', pv.size,
          'qty', psi.qty,
          'price', psi.price_snapshot,
          'is_return', psi.is_return,
          'qty_venta_publico', psi.qty_venta_publico,
          'qty_general', psi.qty_general
        )
      )
      from public.public_sale_items psi
      left join public.product_variants pv on pv.id = psi.variant_id
      left join public.products p on p.id = pv.product_id
      where psi.sale_id = p_sale_id
    )
  ) into v_result
  from public.public_sales ps
  left join public.public_sales_customers psc on psc.id = ps.customer_id
  where ps.id = p_sale_id;

  return v_result;
end $$;
