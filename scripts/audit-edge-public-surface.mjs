#!/usr/bin/env node

const SUPABASE_URL = process.env.SUPABASE_URL || "https://dtfznewwvsadkorxwzft.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

if (process.env.FYL_AUDIT_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const checks = [
  {
    name: "qz-sign requires JWT",
    url: `${SUPABASE_URL}/functions/v1/qz-sign`,
    options: { method: "POST", body: "probe", headers: { "content-type": "text/plain" } },
    expect: (status, body) =>
      status === 401 &&
      /authorization|jwt|auth/i.test(body) &&
      !/x-qz-secret/i.test(body),
  },
  {
    name: "catalog snapshot anon readable",
    url: `${SUPABASE_URL}/rest/v1/catalog_public_snapshot?select=Articulo&limit=1`,
    options: { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
    expect: (status) => status === 200,
    skipWithoutAnon: true,
  },
  {
    name: "stock audit snapshot anon closed",
    url: `${SUPABASE_URL}/rest/v1/vw_stock_audit_snapshot?select=product_id&limit=1`,
    options: { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
    expect: (status) => status === 401 || status === 403 || status === 404,
    skipWithoutAnon: true,
  },
];

let failed = 0;

for (const check of checks) {
  if (check.skipWithoutAnon && !SUPABASE_ANON_KEY) {
    console.log(`SKIP ${check.name}: SUPABASE_ANON_KEY no configurada`);
    continue;
  }

  const res = await fetch(check.url, check.options);
  const body = await res.text();
  const ok = check.expect(res.status, body);
  console.log(`${ok ? "OK" : "FAIL"} ${check.name}: HTTP ${res.status}`);
  if (!ok) {
    failed += 1;
    console.log(body.slice(0, 300));
  }
}

if (failed > 0) process.exit(1);
