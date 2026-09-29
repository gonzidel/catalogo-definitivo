/**
 * Tests: proxy a Firebase (landings, admin vanilla, QR) cuando nj ocupa la raíz de www.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { LEGACY_HOSTING_ORIGIN, legacyHostingRedirects, legacyHostingRewrites } from "./legacy-hosting";

const require = createRequire(import.meta.url);
// Mismo matcher que usa Next para rewrites/redirects.
const { pathToRegexp } = require("next/dist/compiled/path-to-regexp") as {
  pathToRegexp: (path: string, keys?: unknown[], options?: { strict?: boolean; sensitive?: boolean }) => RegExp;
};

function matchSource<T extends { source: string }>(sources: T[], pathname: string): T | undefined {
  return sources.find((r) => pathToRegexp(r.source, [], { strict: true, sensitive: false }).test(pathname));
}

test("admin vanilla, QR y scripts van a Firebase", () => {
  const rewrites = legacyHostingRewrites();
  for (const path of [
    "/admin/index.html",
    "/admin/public-sales.html",
    "/admin/public-sales.js",
    "/admin/css/admin.css",
    "/customer.html",
    "/scripts/config.js",
    "/scripts/vendor/supabase-js.bundle.min.js",
    "/config.prod.js",
    "/qz-site.crt",
    "/certs/qz-site.crt",
    "/styles.css",
    "/icons/icon-192x192.png",
    "/revendedoras",
    "/terms",
  ]) {
    const rule = matchSource(rewrites, path);
    assert.ok(rule, `sin proxy para ${path}`);
    assert.ok(rule.destination.startsWith(LEGACY_HOSTING_ORIGIN));
  }
});

test("rutas del admin nj y de la app no se proxean", () => {
  const rewrites = legacyHostingRewrites();
  for (const path of [
    "/admin",
    "/admin/orders",
    "/admin/retiro",
    "/admin/products/123",
    "/admin/conciliacion-reembolso/remesas/nueva",
    "/",
    "/calzado",
    "/producto/653",
    "/quienes-somos",
    "/dashboard",
    "/logo.png",
  ]) {
    assert.equal(matchSource(rewrites, path), undefined, `${path} no debería ir a Firebase`);
  }
});

test("redirects de compatibilidad son temporales", () => {
  const redirects = legacyHostingRedirects();
  assert.ok(redirects.every((r) => r.permanent === false));
  assert.equal(matchSource(redirects, "/admin")?.destination, "/admin/index.html");
  assert.equal(matchSource(redirects, "/admin/orders"), undefined);
  assert.equal(matchSource(redirects, "/catalogo.html")?.destination, "/");
  assert.equal(matchSource(redirects, "/client/dashboard.html")?.destination, "/");
});
