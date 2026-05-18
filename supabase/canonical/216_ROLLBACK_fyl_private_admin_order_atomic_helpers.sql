-- 216_ROLLBACK_fyl_private_admin_order_atomic_helpers.sql

drop function if exists fyl_private.admin_order_item_qualifies_deduction(jsonb);
drop function if exists fyl_private.admin_order_payload_sha256(jsonb);
drop function if exists fyl_private.normalize_size_admin_order(text);

select pg_notify('pgrst', 'reload schema');
