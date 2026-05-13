#!/usr/bin/env node

/**
 * Harness de concurrencia checkout FYL.
 *
 * Requiere staging o fixtures aislados. Por defecto se niega a correr contra
 * produccion para evitar contaminar stock real.
 */

const required = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "FYL_TEST_ACCESS_TOKEN",
  "FYL_TEST_CART_ID",
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Faltan variables: ${missing.join(", ")}`);
  process.exit(2);
}

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const accessToken = process.env.FYL_TEST_ACCESS_TOKEN;
const cartId = process.env.FYL_TEST_CART_ID;
const isProd = /dtfznewwvsadkorxwzft\.supabase\.co/.test(url);

if (isProd && process.env.FYL_CONCURRENCY_ALLOW_PROD_FIXTURES !== "1") {
  console.error("Abortado: produccion requiere FYL_CONCURRENCY_ALLOW_PROD_FIXTURES=1 y fixtures aislados.");
  process.exit(3);
}

async function rpcCheckout(operationId) {
  const res = await fetch(`${url}/rest/v1/rpc/rpc_checkout_cart`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_operation_id: operationId,
      p_metadata: {
        source: "checkout-concurrency-smoke",
        cart_id: cartId,
        at: new Date().toISOString(),
      },
    }),
  });

  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text };
}

const sameOperationId = crypto.randomUUID();
const competingOperationA = crypto.randomUUID();
const competingOperationB = crypto.randomUUID();

const scenarios = [
  {
    name: "same operation replay",
    calls: [sameOperationId, sameOperationId],
  },
  {
    name: "two operations same cart",
    calls: [competingOperationA, competingOperationB],
  },
];

for (const scenario of scenarios) {
  const results = await Promise.all(scenario.calls.map((id) => rpcCheckout(id)));
  console.log(JSON.stringify({ scenario: scenario.name, results }, null, 2));
}
