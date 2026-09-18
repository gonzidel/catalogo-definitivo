import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CUSTOMER_DASHBOARD_MESSAGE_URL,
  getDashboardActiveOrderUrl,
  resolveAuthRedirectBase,
  stripPublicAppPrefix,
} from "./site-url";

test("auth redirect keeps /nj when the callback still arrives under the prefix", () => {
  const base = resolveAuthRedirectBase({
    nextUrlPathname: "/nj/auth/callback",
    requestUrl: "https://www.fylmoda.com.ar/nj/auth/callback?code=1",
    forwardedHost: "www.fylmoda.com.ar",
    forwardedProto: "https",
    host: "www.fylmoda.com.ar",
    pfx: "nj",
  });
  assert.equal(base, "https://www.fylmoda.com.ar/nj");
});

test("auth redirect uses root after cutover", () => {
  const base = resolveAuthRedirectBase({
    nextUrlPathname: "/auth/callback",
    requestUrl: "https://www.fylmoda.com.ar/auth/callback?code=1",
    forwardedHost: "www.fylmoda.com.ar",
    forwardedProto: "https",
    host: "www.fylmoda.com.ar",
    pfx: null,
  });
  assert.equal(base, "https://www.fylmoda.com.ar");
});

test("stripPublicAppPrefix normalizes legacy paths", () => {
  assert.equal(stripPublicAppPrefix("/nj"), "/");
  assert.equal(stripPublicAppPrefix("/nj/dashboard"), "/dashboard");
  assert.equal(stripPublicAppPrefix("/admin"), "/admin");
});

test("mensajes WhatsApp usan el dashboard de testeo, no localhost", () => {
  assert.equal(
    getDashboardActiveOrderUrl(),
    "https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart"
  );
  assert.equal(getDashboardActiveOrderUrl(), CUSTOMER_DASHBOARD_MESSAGE_URL);
  assert.doesNotMatch(getDashboardActiveOrderUrl(), /localhost/);
});
