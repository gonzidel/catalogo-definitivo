-- 371: Security Advisor WARN (2026-10-08) — EXECUTE de funciones SECURITY DEFINER y search_path mutable.
--
-- Contexto: docs/FYL-Obsidian/73-SUPABASE-ADVISORS-SECURITY-DEFINER-RLS-2026-10-08.md
--
-- 1) Trigger functions: nadie las invoca por RPC; disparar un trigger no exige EXECUTE al usuario.
-- 2) Helpers internos y funciones huérfanas peligrosas: solo las llaman otras funciones
--    SECURITY DEFINER (owner postgres), cron (postgres) o service_role (passkeys, n8n).
-- 3) RPCs con guard interno (admins / auth.uid()): anon ya era rechazado por el guard; se quita
--    anon/PUBLIC y se deja authenticated explícito para no romper admin ni clientes logueados.
-- 4) search_path fijo para 6 funciones INVOKER.
--
-- Fuera de alcance: superficie pública intencional (get_product_image*, rpc_catalog_public_version,
-- rpc_get_customer_public_data, rpc_get_nuevos_ingresos_products, rpc_get_public_curated_banner_by_slug,
-- rpc_get_variant_size_reserved) y RPCs admin sin guard que el panel llama como authenticated
-- (requieren CREATE OR REPLACE con guard, fase 2).

BEGIN;

-- 1) Trigger functions
REVOKE EXECUTE ON FUNCTION
  public.fn_orders_assign_kanban_inbox(),
  public.fn_trg_catalog_snapshot_dirty(),
  public.trg_cleanup_missing_sources_on_cancel(),
  public.trg_order_item_missing_adjust_total(),
  public.trg_orders_enqueue_crm_event(),
  public.trg_orders_total_exclude_missing()
FROM PUBLIC, anon, authenticated;

-- 2) Helpers internos / huérfanas: solo service_role (y owner)
REVOKE EXECUTE ON FUNCTION
  public.fn_ensure_payment_pending(uuid, text, text, text),
  public.fn_orders_exclude_missing_from_total(uuid),
  public.fn_refresh_awaiting_apartado_availability(uuid),
  public.fn_retract_unsent_customer_closed_notifications(uuid),
  public.fn_reserved_by_variant_size(),
  public.link_pending_customer_to_user(text, uuid),
  public.rpc_create_pending_customer(text, text, text, text, text, text, text),
  public.rpc_create_temporary_customer(uuid, text, text, text, text, text, text, text, text),
  public.change_cart_status(uuid, text),
  public.clear_user_cart(uuid),
  public.get_cart_summary(uuid),
  public.get_or_create_user_cart(uuid),
  public.get_user_cart_complete(uuid),
  public.remove_cart_item(uuid),
  public.update_cart_item_quantity(uuid, integer),
  public.sync_cart_from_local(uuid, jsonb),
  public.confirm_existing_unconfirmed_users(),
  public.confirm_user_email(uuid),
  public.confirm_user_email_by_address(text),
  public.populate_existing_customer_emails(),
  public.sync_all_customers_auth_provider(),
  public.sync_customer_auth_provider(uuid),
  public.get_auth_provider(uuid),
  public.get_customer_id_for_user(uuid),
  public.rpc_get_user_id_by_email(text),
  public.rpc_migrate_temp_customer_to_auth(uuid, uuid),
  public.rpc_cleanup_expired_credits(),
  public.rpc_close_stuck_customer_requested_orders(),
  public.maint_try_delete_order_if_eligible(uuid, text),
  public.release_reserved_qty_for_order(uuid, text, text),
  public.fyl_rebuild_catalog_public_snapshot_parity(boolean),
  public.purchase_compute_lines(uuid, uuid, jsonb),
  public.purchase_resolve_supplier(text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.fn_ensure_payment_pending(uuid, text, text, text),
  public.fn_orders_exclude_missing_from_total(uuid),
  public.fn_refresh_awaiting_apartado_availability(uuid),
  public.fn_retract_unsent_customer_closed_notifications(uuid),
  public.fn_reserved_by_variant_size(),
  public.link_pending_customer_to_user(text, uuid),
  public.rpc_create_pending_customer(text, text, text, text, text, text, text),
  public.rpc_create_temporary_customer(uuid, text, text, text, text, text, text, text, text),
  public.change_cart_status(uuid, text),
  public.clear_user_cart(uuid),
  public.get_cart_summary(uuid),
  public.get_or_create_user_cart(uuid),
  public.get_user_cart_complete(uuid),
  public.remove_cart_item(uuid),
  public.update_cart_item_quantity(uuid, integer),
  public.sync_cart_from_local(uuid, jsonb),
  public.confirm_existing_unconfirmed_users(),
  public.confirm_user_email(uuid),
  public.confirm_user_email_by_address(text),
  public.populate_existing_customer_emails(),
  public.sync_all_customers_auth_provider(),
  public.sync_customer_auth_provider(uuid),
  public.get_auth_provider(uuid),
  public.get_customer_id_for_user(uuid),
  public.rpc_get_user_id_by_email(text),
  public.rpc_migrate_temp_customer_to_auth(uuid, uuid),
  public.rpc_cleanup_expired_credits(),
  public.rpc_close_stuck_customer_requested_orders(),
  public.maint_try_delete_order_if_eligible(uuid, text),
  public.release_reserved_qty_for_order(uuid, text, text),
  public.fyl_rebuild_catalog_public_snapshot_parity(boolean),
  public.purchase_compute_lines(uuid, uuid, jsonb),
  public.purchase_resolve_supplier(text)
TO service_role;

-- 3) RPCs con guard interno: authenticated explícito, sin anon/PUBLIC
GRANT EXECUTE ON FUNCTION
  public.cleanup_missing_order_item_sources(uuid, text),
  public.rpc_admin_extend_order_24h(uuid),
  public.rpc_admin_mark_expired_order_sent(uuid),
  public.rpc_admin_mark_item_missing(uuid),
  public.rpc_admin_reopen_expired_order(uuid),
  public.rpc_admin_zero_variant_size_stock(uuid, text, uuid),
  public.rpc_cancel_order_item_units(uuid, integer),
  public.rpc_clear_admin_expiry_warn_sent(uuid),
  public.rpc_complete_customer_closed_notification(uuid, boolean),
  public.rpc_confirm_closed_order_payment(uuid),
  public.rpc_create_admin_customer(text, text, text, text, text, text, text, jsonb, boolean, boolean),
  public.rpc_create_admin_local_cannot_separate_alert(integer),
  public.rpc_customer_reopen_order_for_editing(uuid),
  public.rpc_customer_replace_missing_item(uuid, uuid, text, text, text, text),
  public.rpc_customer_request_close(uuid),
  public.rpc_customer_request_order_extension_24h(uuid),
  public.rpc_dismiss_admin_order_message(uuid),
  public.rpc_enqueue_customer_closed_notifications(uuid),
  public.rpc_get_invoiced_summary(),
  public.rpc_get_shipping_orders(date, uuid),
  public.rpc_get_shipping_orders_range(date, date, uuid),
  public.rpc_list_admin_expiry_warn_sent(),
  public.rpc_list_admin_order_message_notifications(),
  public.rpc_list_admin_payment_pending(),
  public.rpc_list_correo_pending_shipping_cost(),
  public.rpc_mark_admin_expiry_warn_sent(uuid),
  public.rpc_mark_admin_order_message_copied(uuid),
  public.rpc_mark_order_item_waiting_source(uuid, text, uuid),
  public.rpc_record_admin_local_wait_resolution(uuid, uuid, text, text),
  public.rpc_refresh_my_order_availability(uuid),
  public.rpc_resolve_order_label_identity(uuid),
  public.rpc_set_correo_shipping_cost(uuid, numeric),
  public.rpc_set_my_transport(text),
  public.rpc_split_order_item_unit_to_waiting_source(uuid, integer, text, uuid),
  public.rpc_switch_cod_order_to_pagado(uuid, boolean),
  public.rpc_update_admin_customer(uuid, text, text, text, text, text, text, text, jsonb, boolean, boolean),
  public.rpc_update_admin_local_wait_snapshot_prior(uuid, integer, jsonb),
  public.rpc_upsert_admin_local_wait_snapshot(uuid, text, text, integer, jsonb, uuid[], text, uuid[], text, timestamp with time zone),
  public.rpc_upsert_admin_local_wait_snapshot(uuid, text, text, integer, jsonb, uuid[], text),
  public.rpc_wa_enqueue_expiry_events(),
  public.rpc_wa_preview_expiry_events()
TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION
  public.cleanup_missing_order_item_sources(uuid, text),
  public.rpc_admin_extend_order_24h(uuid),
  public.rpc_admin_mark_expired_order_sent(uuid),
  public.rpc_admin_mark_item_missing(uuid),
  public.rpc_admin_reopen_expired_order(uuid),
  public.rpc_admin_zero_variant_size_stock(uuid, text, uuid),
  public.rpc_cancel_order_item_units(uuid, integer),
  public.rpc_clear_admin_expiry_warn_sent(uuid),
  public.rpc_complete_customer_closed_notification(uuid, boolean),
  public.rpc_confirm_closed_order_payment(uuid),
  public.rpc_create_admin_customer(text, text, text, text, text, text, text, jsonb, boolean, boolean),
  public.rpc_create_admin_local_cannot_separate_alert(integer),
  public.rpc_customer_reopen_order_for_editing(uuid),
  public.rpc_customer_replace_missing_item(uuid, uuid, text, text, text, text),
  public.rpc_customer_request_close(uuid),
  public.rpc_customer_request_order_extension_24h(uuid),
  public.rpc_dismiss_admin_order_message(uuid),
  public.rpc_enqueue_customer_closed_notifications(uuid),
  public.rpc_get_invoiced_summary(),
  public.rpc_get_shipping_orders(date, uuid),
  public.rpc_get_shipping_orders_range(date, date, uuid),
  public.rpc_list_admin_expiry_warn_sent(),
  public.rpc_list_admin_order_message_notifications(),
  public.rpc_list_admin_payment_pending(),
  public.rpc_list_correo_pending_shipping_cost(),
  public.rpc_mark_admin_expiry_warn_sent(uuid),
  public.rpc_mark_admin_order_message_copied(uuid),
  public.rpc_mark_order_item_waiting_source(uuid, text, uuid),
  public.rpc_record_admin_local_wait_resolution(uuid, uuid, text, text),
  public.rpc_refresh_my_order_availability(uuid),
  public.rpc_resolve_order_label_identity(uuid),
  public.rpc_set_correo_shipping_cost(uuid, numeric),
  public.rpc_set_my_transport(text),
  public.rpc_split_order_item_unit_to_waiting_source(uuid, integer, text, uuid),
  public.rpc_switch_cod_order_to_pagado(uuid, boolean),
  public.rpc_update_admin_customer(uuid, text, text, text, text, text, text, text, jsonb, boolean, boolean),
  public.rpc_update_admin_local_wait_snapshot_prior(uuid, integer, jsonb),
  public.rpc_upsert_admin_local_wait_snapshot(uuid, text, text, integer, jsonb, uuid[], text, uuid[], text, timestamp with time zone),
  public.rpc_upsert_admin_local_wait_snapshot(uuid, text, text, integer, jsonb, uuid[], text),
  public.rpc_wa_enqueue_expiry_events(),
  public.rpc_wa_preview_expiry_events()
FROM PUBLIC, anon;

-- 4) search_path fijo (funciones SECURITY INVOKER)
ALTER FUNCTION public.rpc_find_similar_tags(text, integer, text, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.normalize_transport_name(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_fyl_transfer_titular() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_fyl_transfer_cbu() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_fyl_transfer_alias() SET search_path = public, pg_temp;
ALTER FUNCTION public.register_local_sale_to_daily_sales() SET search_path = public, pg_temp;

COMMIT;

NOTIFY pgrst, 'reload schema';
