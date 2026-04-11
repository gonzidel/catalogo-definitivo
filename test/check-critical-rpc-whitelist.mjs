import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const canonicalDir = path.join(repoRoot, "supabase", "canonical");

const CRITICAL_RPC_WHITELIST = {
  "rpc_checkout_cart": new Set([
    "10_checkout_flow.sql",
    "13_warehouses.sql",
    "82_rpc_checkout_cart_deduct_by_size.sql",
    "86_rpc_checkout_cart_ensure_deduct_by_size.sql",
    "122_checkout_return_order_number.sql",
    "123_order_expiry_and_notifications.sql",
    "124_rpc_checkout_cart_deduct_by_size.sql",
    "149_consolidate_critical_rpcs.sql",
  ]),
  "rpc_close_order": new Set([
    "10_checkout_flow.sql",
    "10_checkout_flow_restore.sql",
    "52_add_closed_at_to_orders.sql",
    "83_rpc_close_order_no_stock_deduction.sql",
    "123_order_expiry_and_notifications.sql",
    "149_consolidate_critical_rpcs.sql",
  ]),
  "rpc_void_public_sale": new Set([
    "79_void_public_sale.sql",
    "141_public_sale_stock_trace_and_void.sql",
    "149_consolidate_critical_rpcs.sql",
  ]),
};

const patterns = [
  { rpc: "rpc_checkout_cart", regex: /create\s+or\s+replace\s+function\s+public\.rpc_checkout_cart\s*\(/gi },
  { rpc: "rpc_close_order", regex: /create\s+or\s+replace\s+function\s+public\.rpc_close_order\s*\(/gi },
  { rpc: "rpc_void_public_sale", regex: /create\s+or\s+replace\s+function\s+public\.rpc_void_public_sale\s*\(/gi },
];

function walkSqlFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSqlFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];
for (const filePath of walkSqlFiles(canonicalDir)) {
  const baseName = path.basename(filePath);
  const sql = fs.readFileSync(filePath, "utf8");

  for (const { rpc, regex } of patterns) {
    const hasDefinition = regex.test(sql);
    regex.lastIndex = 0;
    if (!hasDefinition) continue;

    if (!CRITICAL_RPC_WHITELIST[rpc].has(baseName)) {
      violations.push(`${rpc} redefinida en archivo no autorizado: supabase/canonical/${baseName}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Fallo check-critical-rpc-whitelist:");
  for (const v of violations) {
    console.error(`- ${v}`);
  }
  process.exit(2);
}

console.log("OK: whitelist de RPC críticas sin redefiniciones no autorizadas.");
