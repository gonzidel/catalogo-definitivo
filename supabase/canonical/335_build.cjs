/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const path = require("path");

const dir = __dirname;
const src = fs.readFileSync(path.join(dir, "331_rpc_checkout_cart_sellable_gate.sql"), "utf8");

const OLD_309 = [
  "      SELECT price INTO v_item_price FROM public.product_variants WHERE id = r.variant_id;",
  "      v_item_price := COALESCE(NULLIF(r.price_snapshot, 0), v_item_price, r.price_snapshot, 0);",
].join("\n");

const NEW_309 = [
  "      -- 335: autoridad de precio = get_effective_price(variant_id). No usar cart snapshot.",
  "      v_item_price := public.get_effective_price(r.variant_id);",
  "      IF v_item_price IS NULL OR v_item_price <= 0 THEN",
  "        RAISE EXCEPTION",
  "          USING MESSAGE = format(",
  "            'Precio inválido para %s (color %s).',",
  "            coalesce(r.product_name,'producto'), coalesce(r.color,'-')",
  "          );",
  "      END IF;",
  "      IF r.price_snapshot IS DISTINCT FROM v_item_price THEN",
  "        RAISE NOTICE 'checkout price authority: variant % snapshot % effective %',",
  "          r.variant_id, r.price_snapshot, v_item_price;",
  "      END IF;",
].join("\n");

const OLD_NORM = [
  "    SELECT price INTO v_item_price FROM public.product_variants WHERE id = r.variant_id;",
  "    v_item_price := COALESCE(NULLIF(r.price_snapshot, 0), v_item_price, r.price_snapshot, 0);",
].join("\n");

const NEW_NORM = [
  "    -- 335: autoridad de precio = get_effective_price(variant_id). No usar cart snapshot.",
  "    v_item_price := public.get_effective_price(r.variant_id);",
  "    IF v_item_price IS NULL OR v_item_price <= 0 THEN",
  "      RAISE EXCEPTION",
  "        USING MESSAGE = format(",
  "          'Precio inválido para %s (color %s).',",
  "          coalesce(r.product_name,'producto'), coalesce(r.color,'-')",
  "        );",
  "    END IF;",
  "    IF r.price_snapshot IS DISTINCT FROM v_item_price THEN",
  "      RAISE NOTICE 'checkout price authority: variant % snapshot % effective %',",
  "        r.variant_id, r.price_snapshot, v_item_price;",
  "    END IF;",
].join("\n");

if (!src.includes(OLD_309)) throw new Error("309 block not found");
if (!src.includes(OLD_NORM)) throw new Error("normal block not found");

let out = src.replace(OLD_309, NEW_309).replace(OLD_NORM, NEW_NORM);

if (out.includes("NULLIF(r.price_snapshot, 0)")) {
  throw new Error("NULLIF price_snapshot still present");
}
if ((out.match(/get_effective_price\(r\.variant_id\)/g) || []).length !== 2) {
  throw new Error("expected 2 get_effective_price assignments");
}

const headerRe = /-- 331_rpc_checkout_cart_sellable_gate\.sql[\s\S]*?-- Rollback: 331_ROLLBACK_rpc_checkout_cart_sellable_gate\.sql\n/;
if (!headerRe.test(src)) throw new Error("331 header not found");

out = out.replace(
  headerRe,
  `-- 335_rpc_checkout_cart_effective_price.sql
-- Autoridad de precio en checkout: get_effective_price(variant_id).
-- No usa cart_items.price_snapshot para el monto cobrado.
--
-- Wrapper rpc_checkout_cart(uuid, jsonb) NO se modifica (replay/idempotencia intactos).
-- Stock, OISS, 309 awaiting_apartado, reserved_qty write, locks: intactos.
-- Promos 2x1/2xMonto siguen recálculo sobre order_items ya persistidos.
--
-- Base: canonical 331 live md5 9901c2cf5a32fc2ecad95c30c247b77e
-- Rollback: 335_ROLLBACK_rpc_checkout_cart_effective_price.sql
`
);

out = out.replace(
  /COMMENT ON FUNCTION public\.rpc_checkout_cart\(\) IS\s+'canonical:331[^']*';/,
  `COMMENT ON FUNCTION public.rpc_checkout_cart() IS
  'canonical:335 | line price = get_effective_price(variant_id); snapshot no es autoridad. stock/309/wrapper intactos. anterior canonical:331 md5 9901c2cf5a32fc2ecad95c30c247b77e';`
);

if (!out.includes("canonical:335")) throw new Error("comment not updated");

fs.writeFileSync(path.join(dir, "335_rpc_checkout_cart_effective_price.sql"), out);
console.log("wrote 335_rpc_checkout_cart_effective_price.sql", out.length);
