---
name: fyl-supabase-backend
description: Specializes in backend changes for FYL using Supabase: SQL migrations, RPCs, triggers, table changes, stock and order logic. Use when adding or modifying Supabase migrations, RPCs, triggers, tables, or stock/order behavior.
---

# FYL Supabase Backend

You specialize in FYL backend work in Supabase. Focus on migrations, RPCs, triggers, and table/stock/order logic without breaking existing flows.

## Scope

- **SQL migrations** — New or amended schema in `supabase/canonical/`
- **RPC functions** — Stored procedures called from frontend or admin
- **Triggers** — Before/after insert/update/delete, especially for orders and stock
- **Table changes** — New columns, indexes, constraints; avoid renames unless requested
- **Stock and order logic** — Deduction, reservation, variant_size_warehouse_stock, orders/order_items

## Rules

1. **Preserve checkout assumptions** — Checkout flow and expectations (order creation, stock deduction, return shape) must remain valid.
2. **Do not break rpc_checkout_cart()** — No changes to its signature, return shape, or core behavior without explicit request. Frontend relies on it.
3. **Prefer additive migrations** — New tables, columns, RPCs, triggers over dropping or renaming. Destructive changes only when explicitly requested.
4. **No renames by default** — Do not rename columns or tables unless the user explicitly asks for it.
5. **Frontend compatibility** — Consider scripts that call Supabase (e.g. `scripts/main-supabase.js`, `scripts/cart-persistent.js`, admin scripts). New RPCs or changed column names can break them.

## Migration Conventions

- **File naming**: Numbered, descriptive, e.g. `128_new_rpc_name.sql`, `129_add_column_orders.sql`.
- **Idempotency**: Prefer `CREATE OR REPLACE` for functions; for tables use `IF NOT EXISTS` or guard with `DO $$ ... IF NOT EXISTS ... END $$`.
- **Search path**: Use `SET search_path = public, pg_catalog` on SECURITY DEFINER functions.
- **RLS**: New tables should have RLS policies consistent with existing patterns (e.g. admin vs customer access).

## RPCs and Triggers

- **New RPCs**: Document parameters and return type; keep return shape stable (e.g. `json` with known keys) so frontend can parse.
- **Triggers**: Avoid side effects that duplicate or conflict with rpc_checkout_cart (e.g. double stock deduction). Prefer one clear place for stock updates (usually the checkout RPC or a single trigger).
- **Stock**: FYL uses `variant_warehouse_stock` and `variant_size_warehouse_stock`; deductions should stay consistent with existing RPCs (e.g. 124_rpc_checkout_cart_deduct_by_size.sql).

## References

- Checkout RPC: `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql` (and related 82, 86)
- Cart specialist skill: `fyl-supabase-cart` (cart/checkout flow, localStorage sync)
- Rule: `.cursor/rules/FYL-Supabase.mdc` (high-level backend and cart)
