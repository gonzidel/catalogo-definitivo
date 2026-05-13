-- 212_security_definer_grants_batch1.sql
--
-- Primer batch de hardening SECURITY DEFINER:
-- - revoca EXECUTE de anon/PUBLIC
-- - conserva EXECUTE para authenticated/service_role
-- - fija search_path seguro sin reescribir cuerpos de funciones
--
-- No incluye allowlist publica temporal: rpc_get_variant_size_reserved,
-- get_meta_feed, helpers de catalogo/tags/ofertas.

DO $$
DECLARE
  fn_name text;
  fn regprocedure;
  signatures text[] := ARRAY[
    'add_collaborator_by_email(text,uuid)',
    'add_collaborator_to_admins(uuid,text,uuid)',
    'confirm_user_email(uuid)',
    'confirm_user_email_by_address(text)',
    'create_collaborator_with_account(text,text,uuid)',
    'get_customer_kpis(timestamp with time zone,timestamp with time zone)',
    'get_customer_registration_methods(timestamp with time zone,timestamp with time zone)',
    'get_customer_timeseries(timestamp with time zone,timestamp with time zone,text)',
    'get_daily_sales_summary(date,text)',
    'get_dashboard_kpis(timestamp with time zone,timestamp with time zone,text)',
    'get_order_source_breakdown(timestamp with time zone,timestamp with time zone)',
    'get_sales_timeseries(timestamp with time zone,timestamp with time zone,text,text)',
    'get_top_categories(timestamp with time zone,timestamp with time zone,text)',
    'get_top_products(timestamp with time zone,timestamp with time zone,text,integer)',
    'get_top_skus(timestamp with time zone,timestamp with time zone,text,integer)',
    'get_variant_stock_by_warehouse(uuid)',
    'is_admin()',
    'is_super_admin(uuid)',
    'metrics_dashboard_compare(date,date)',
    'metrics_product_alerts(date,date)',
    'metrics_purchase_by_supplier(date,date)',
    'metrics_replenishment(date,date)',
    'metrics_replenishment_effectiveness(date,date)',
    'metrics_weekly_purchase_plan(date,date)',
    'purchase_create_rule_version(uuid,jsonb)',
    'purchase_register_receipt(uuid,timestamp with time zone,text,text,jsonb)',
    'rpc_add_customer_credit(uuid,numeric,text)',
    'rpc_add_return_credit(uuid,numeric,text)',
    'rpc_bulk_create_customers(jsonb)',
    'rpc_cancel_order_full(uuid)',
    'rpc_cancel_order_item(uuid)',
    'rpc_cancel_order_item_units(uuid,integer)',
    'rpc_checkout_cart()',
    'rpc_checkout_cart(uuid,jsonb)',
    'rpc_close_order(uuid,text)',
    'rpc_complete_pending_sale(uuid,uuid)',
    'rpc_create_admin_customer(text,text,text,text,text,text,text)',
    'rpc_create_local_order(uuid,jsonb,jsonb)',
    'rpc_create_pending_sale(integer,jsonb)',
    'rpc_create_public_customer(text,text,text,text,text)',
    'rpc_create_public_sale(jsonb,uuid,text,boolean)',
    'rpc_create_public_sale(jsonb,uuid,text,boolean,numeric)',
    'rpc_create_public_sale(jsonb,uuid,text,boolean,numeric,uuid,jsonb)',
    'rpc_delete_admin_customer(uuid)',
    'rpc_delete_empty_order(uuid)',
    'rpc_delete_local_order(uuid)',
    'rpc_get_customer_credits(uuid)',
    'rpc_get_customer_total_credit(uuid)',
    'rpc_get_local_order_items(uuid)',
    'rpc_get_local_orders(text,uuid)',
    'rpc_get_pending_sales()',
    'rpc_get_public_sale_details(uuid)',
    'rpc_get_public_sales_history(integer,integer)',
    'rpc_get_public_sales_history(integer,integer,date,text)',
    'rpc_get_shipping_lists(date,date)',
    'rpc_get_shipping_orders(date,uuid)',
    'rpc_get_shipping_orders_range(date,date,uuid)',
    'rpc_link_public_sales_customer(uuid,text,text,text)',
    'rpc_link_public_sales_customer(uuid,text,text,text,text,text)',
    'rpc_load_local_order_to_sale(uuid)',
    'rpc_mark_labels_printed(uuid)',
    'rpc_mark_order_as_devolucion(uuid)',
    'rpc_mark_order_as_devolucion(uuid,uuid,jsonb)',
    'rpc_mark_order_as_sent(uuid)',
    'rpc_mark_order_items_picked(uuid[],uuid,jsonb)',
    'rpc_mark_pending_sale_processing(uuid)',
    'rpc_move_size_stock(uuid,text,text,text,integer,text)',
    'rpc_move_size_stock(uuid,text,text,text,integer,text,uuid,jsonb)',
    'rpc_orders_daily_maintenance()',
    'rpc_reconcile_stock(boolean)',
    'rpc_remove_order_item_restore_stock(uuid)',
    'rpc_reopen_order(uuid)',
    'rpc_reschedule_sent_order(uuid,timestamp with time zone)',
    'rpc_revert_order_to_picked(uuid)',
    'rpc_save_shipping_list(uuid,text,date,jsonb)',
    'rpc_search_public_customer(text)',
    'rpc_send_order_to_local(uuid)',
    'rpc_split_order_item_status(uuid,integer,integer,integer,uuid)',
    'rpc_sync_daily_sales_envios_by_date(date)',
    'rpc_update_admin_customer(uuid,text,text,text,text,text,text,text)',
    'rpc_update_customer_transport(uuid,uuid)',
    'rpc_update_local_order(uuid,jsonb)',
    'rpc_update_order_item_status(uuid,text,uuid)',
    'rpc_update_order_labels_count(uuid,integer)',
    'rpc_upsert_customer(text,text,text,text,text,text,text,text,uuid,uuid)',
    'rpc_void_public_sale(uuid)',
    'rpc_void_public_sale(uuid,uuid,jsonb)'
  ];
BEGIN
  FOREACH fn_name IN ARRAY signatures LOOP
    fn := to_regprocedure('public.' || fn_name);
    IF fn IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, PUBLIC', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_catalog', fn);
    END IF;
  END LOOP;
END $$;

SELECT pg_notify('pgrst', 'reload schema');
