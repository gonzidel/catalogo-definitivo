/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const path = require("path");

const dir = __dirname;
const rollbackPath = path.join(dir, "331_ROLLBACK_rpc_checkout_cart_sellable_gate.sql");
const migPath = path.join(dir, "331_rpc_checkout_cart_sellable_gate.sql");

const OLD_GATE = `    SELECT public.get_total_stock(r.variant_id) INTO v_total_stock;
    SELECT reserved_qty INTO v_reserved
    FROM public.product_variants
    WHERE id = r.variant_id FOR UPDATE;

    v_available := coalesce(v_total_stock, 0) - coalesce(v_reserved, 0);
    IF v_qty > v_available THEN
      RAISE EXCEPTION
        USING MESSAGE = format(
          'Stock insuficiente para %s (color %s talle %s). Disponible: %s, solicitado: %s.',
          coalesce(r.product_name,'producto'), coalesce(r.color,'-'), coalesce(r.size,'-'),
          v_available, v_qty
        );
    END IF;`;

const NEW_GATE = `    -- Fase 3: reserved_qty ya no gobierna disponibilidad.
    -- Serializamos la variante (write legacy de reserved_qty + orden de locks vigente).
    -- El gate autoritativo es el físico web del talle, DESPUÉS del FOR UPDATE
    -- de variant_size_warehouse_stock (misma semántica que fn_sellable_qty).
    PERFORM 1
    FROM public.product_variants
    WHERE id = r.variant_id
    FOR UPDATE;`;

const SIZE_CHECK_OLD = `      IF (coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0)) < v_qty THEN`;

const SIZE_CHECK_NEW = `      -- Gate canónico post-lock: sellable_qty = general + venta-publico de este talle.
      IF (coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0)) < v_qty THEN`;

const NO_SIZE_OLD = `    -- Solo sin talle: descontar de variant_warehouse_stock (legacy compatible)
    IF NOT v_use_size_table AND v_size_normalized = '' THEN
      v_remaining_qty := v_qty;
      v_qty_from_general := 0;
      v_qty_from_venta := 0;

      SELECT coalesce(stock_qty, 0) INTO v_general_stock
      FROM public.variant_warehouse_stock
      WHERE variant_id = r.variant_id AND warehouse_id = v_general_id;`;

const NO_SIZE_NEW = `    -- Solo sin talle: descontar de variant_warehouse_stock (legacy compatible)
    IF NOT v_use_size_table AND v_size_normalized = '' THEN
      v_remaining_qty := v_qty;
      v_qty_from_general := 0;
      v_qty_from_venta := 0;

      -- Mismo orden de lock que el path por talle: ORDER BY warehouse_id.
      v_size_stock_general := 0;
      v_size_stock_venta := 0;
      FOR v_size_row IN
        SELECT warehouse_id, stock_qty
        FROM public.variant_warehouse_stock
        WHERE variant_id = r.variant_id
          AND warehouse_id IN (v_general_id, v_venta_id)
        ORDER BY warehouse_id
        FOR UPDATE
      LOOP
        IF v_size_row.warehouse_id = v_general_id THEN
          v_size_stock_general := coalesce(v_size_row.stock_qty, 0);
        ELSIF v_size_row.warehouse_id = v_venta_id THEN
          v_size_stock_venta := coalesce(v_size_row.stock_qty, 0);
        END IF;
      END LOOP;

      IF (coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0)) < v_qty THEN
        RAISE EXCEPTION
          USING MESSAGE = format(
            'Stock insuficiente para %s (color %s). Disponible: %s, solicitado: %s.',
            coalesce(r.product_name,'producto'), coalesce(r.color,'-'),
            coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0),
            v_qty
          );
      END IF;

      SELECT coalesce(stock_qty, 0) INTO v_general_stock
      FROM public.variant_warehouse_stock
      WHERE variant_id = r.variant_id AND warehouse_id = v_general_id;`;

const ROLLBACK_HEADER = `-- 331_ROLLBACK_rpc_checkout_cart_sellable_gate.sql
-- Restaura rpc_checkout_cart() exactamente como estaba antes de 331.
-- MD5 live pre-331: e93d0348c6b9655f1100eff803d0c825
-- No toca datos, físico, reserved_qty ni el wrapper (uuid, jsonb).

`;

const MIG_HEADER = `-- 331_rpc_checkout_cart_sellable_gate.sql
-- Fase 3: checkout NORMAL valida físico web del talle bajo lock.
--
-- Gate eliminado:
--   qty > get_total_stock(variant) - reserved_qty
--
-- Gate nuevo (después de FOR UPDATE de variant_size_warehouse_stock):
--   sellable = general + venta-publico del talle normalizado
--   si sellable < qty → Stock por talle insuficiente
--
-- reserved_qty se sigue escribiendo (compatibilidad). Ya no se LEE para aceptar/rechazar.
-- Wrapper rpc_checkout_cart(uuid, jsonb) NO se modifica.
-- Rama 309 (awaiting_apartado) NO se modifica.
-- Split general → venta-publico y OISS intactos.
--
-- Base: definición LIVE md5 e93d0348c6b9655f1100eff803d0c825 (no el archivo 309 del repo).
-- Rollback: 331_ROLLBACK_rpc_checkout_cart_sellable_gate.sql

`;

const MIG_FOOTER = `
COMMENT ON FUNCTION public.rpc_checkout_cart() IS
  'canonical:331 | checkout normal: gate = físico web talle post-lock (sellable). reserved_qty se escribe pero no gobierna. 309 intacto. anterior md5 e93d0348c6b9655f1100eff803d0c825';

REVOKE ALL ON FUNCTION public.rpc_checkout_cart() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_checkout_cart() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_checkout_cart() TO service_role;
`;

const ROLLBACK_FOOTER = `
COMMENT ON FUNCTION public.rpc_checkout_cart() IS
  'canonical:253 | source:supabase/canonical/253_rpc_checkout_cart_apply_promo_discount.sql | recalcula total_amount con descuento de promos 2x1/2xMonto (antes: suma cruda sin descuento) | anterior: canonical:251.';

REVOKE ALL ON FUNCTION public.rpc_checkout_cart() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_checkout_cart() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_checkout_cart() TO service_role;
`;

function extractCreate(sql) {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.rpc_checkout_cart()");
  const end = sql.indexOf("\nCOMMENT ON FUNCTION");
  if (start < 0 || end < 0) throw new Error("no se pudo extraer CREATE del rollback");
  return sql.slice(start, end).trim();
}

function main() {
  const rollbackSql = fs.readFileSync(rollbackPath, "utf8").replace(/\r\n/g, "\n");
  const liveDef = extractCreate(rollbackSql);
  if (!liveDef.includes(OLD_GATE)) {
    throw new Error("no se encontró el gate reserved_qty en el rollback");
  }

  let next = liveDef;
  next = next.replace(OLD_GATE, NEW_GATE);
  if (next.includes("get_total_stock(r.variant_id)")) {
    throw new Error("el gate get_total_stock sigue presente");
  }
  if (next.split("v_available := coalesce(v_total_stock").length > 1) {
    throw new Error("el cálculo reserved_qty sigue presente");
  }
  next = next.replace(SIZE_CHECK_OLD, SIZE_CHECK_NEW);
  if (!next.includes(NO_SIZE_OLD)) {
    throw new Error("no se encontró el bloque sin talle");
  }
  next = next.replace(NO_SIZE_OLD, NO_SIZE_NEW);
  if (next.includes(OLD_GATE)) {
    throw new Error("el gate viejo sigue en el parche");
  }
  if (!next.includes("awaiting_apartado")) {
    throw new Error("se perdió la rama 309");
  }
  if (!next.includes("SET reserved_qty = greatest(reserved_qty - v_qty, 0)")) {
    throw new Error("se perdió el write legacy de reserved_qty");
  }

  fs.writeFileSync(migPath, MIG_HEADER + next.trim() + "\n" + MIG_FOOTER);
  console.log("wrote", migPath);
  console.log("live_len", liveDef.length, "patched_len", next.length);
}

main();
