/**
 * Tests: decisión de experiencia full/catalog (cookies firmadas, bots, prefetch, día ART).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildMirrorValue, parseMirrorValue, sourceToCode, codeToSource } from "./constants";
import { signExperience, verifyExperience } from "./cookie";
import { canEnterFullArea, displayExperience, evaluateSigned, isVisitorId, shouldResolve } from "./decide";
import { daysBetween, rolloutDay, secondsUntilRolloutDayEnds } from "./day";
import {
  isBotUserAgent,
  isCanonicalHost,
  isDocumentNavigation,
  isLegacyCatalogoPath,
  isNjDoorPath,
  mapLegacyCatalogoPath,
} from "./request";
import { isLegacyLandingPath } from "./legacy-hosting";

const SECRET = "s".repeat(40);
const VID = "3f2b8c1e-9a4d-4c7b-8e2f-1a2b3c4d5e6f";
const OTHER_VID = "7d1e2f3a-4b5c-4d6e-9f70-8a9b0c1d2e3f";

function headers(values: Record<string, string>) {
  const map = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

// ── Cookie firmada ─────────────────────────────────────────────────────────

test("firma y verifica full con source", async () => {
  const raw = await signExperience(SECRET, VID, { experience: "full", source: "quota", day: "2026-09-29" });
  assert.match(raw, /^v1\.f\.q\.2026-09-29\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await verifyExperience(SECRET, VID, raw), {
    experience: "full",
    source: "quota",
    day: "2026-09-29",
  });
});

test("catalog firmado no lleva source", async () => {
  const raw = await signExperience(SECRET, VID, { experience: "catalog", source: "quota", day: "2026-09-29" });
  assert.match(raw, /^v1\.c\.-\.2026-09-29\./);
  assert.deepEqual(await verifyExperience(SECRET, VID, raw), {
    experience: "catalog",
    source: null,
    day: "2026-09-29",
  });
});

test("cambiar catalog por full invalida la firma", async () => {
  const raw = await signExperience(SECRET, VID, { experience: "catalog", source: null, day: "2026-09-29" });
  const forged = raw.replace("v1.c.-.", "v1.f.q.");
  assert.equal(await verifyExperience(SECRET, VID, forged), null);
});

test("cambiar el día o el source invalida la firma", async () => {
  const raw = await signExperience(SECRET, VID, { experience: "full", source: "tester", day: "2026-09-01" });
  assert.equal(await verifyExperience(SECRET, VID, raw.replace("2026-09-01", "2026-09-29")), null);
  assert.equal(await verifyExperience(SECRET, VID, raw.replace("v1.f.t.", "v1.f.a.")), null);
});

test("la cookie copiada a otro visitor_id no vale", async () => {
  const raw = await signExperience(SECRET, VID, { experience: "full", source: "quota", day: "2026-09-29" });
  assert.equal(await verifyExperience(SECRET, OTHER_VID, raw), null);
});

test("otro secreto no verifica (rotación de ROLLOUT_COOKIE_SECRET)", async () => {
  const raw = await signExperience(SECRET, VID, { experience: "full", source: "quota", day: "2026-09-29" });
  assert.equal(await verifyExperience("x".repeat(40), VID, raw), null);
});

test("valores malformados devuelven null sin lanzar", async () => {
  for (const raw of [
    undefined,
    null,
    "",
    "full",
    "v1.f.q.2026-09-29",
    "v2.f.q.2026-09-29.abc",
    "v1.x.q.2026-09-29.abc",
    "v1.f.q.29-09-2026.abc",
    "v1.f.q.2026-09-29.%%%",
    "v1.f.q.2026-09-29.abc.extra",
  ]) {
    assert.equal(await verifyExperience(SECRET, VID, raw), null, String(raw));
  }
  assert.equal(await verifyExperience("", VID, "v1.f.q.2026-09-29.abc"), null);
});

// ── Cookie espejo (solo UI) ────────────────────────────────────────────────

test("espejo: ida y vuelta de todos los sources", () => {
  for (const source of ["quota", "tester", "tester_link", "staff", "admin", "open_all", "manual"] as const) {
    assert.equal(codeToSource(sourceToCode(source)), source);
    assert.deepEqual(parseMirrorValue(buildMirrorValue("full", source)), { experience: "full", source });
  }
  assert.equal(buildMirrorValue("catalog", "quota"), "c");
  assert.deepEqual(parseMirrorValue("c"), { experience: "catalog", source: null });
  assert.equal(parseMirrorValue("zzz"), null);
  assert.equal(parseMirrorValue(undefined), null);
  assert.deepEqual(parseMirrorValue("f.?"), { experience: "full", source: null });
});

// ── Decisión ───────────────────────────────────────────────────────────────

test("isVisitorId solo acepta UUID", () => {
  assert.equal(isVisitorId(VID), true);
  assert.equal(isVisitorId(crypto.randomUUID()), true);
  for (const v of [undefined, null, "", "abc", `${VID}x`, "00000000-0000-0000-0000-000000000000"]) {
    assert.equal(isVisitorId(v), false, String(v));
  }
});

test("catalog firmado vale solo el mismo día ART", () => {
  const signed = { experience: "catalog" as const, source: null, day: "2026-09-29" };
  for (const mode of ["paused", "quota", "kill"] as const) {
    assert.deepEqual(evaluateSigned(signed, "2026-09-29", mode), { usable: true, fresh: true }, mode);
    assert.deepEqual(evaluateSigned(signed, "2026-09-30", mode), { usable: false, fresh: false }, mode);
  }
});

test("open_all ignora el catalog firmado del día: se vuelve a resolver", () => {
  const signed = { experience: "catalog" as const, source: null, day: "2026-09-29" };
  const { usable, fresh } = evaluateSigned(signed, "2026-09-29", "open_all");
  assert.deepEqual({ usable, fresh }, { usable: false, fresh: false });
  const base = { mode: "open_all" as const, fresh, door: false, bot: false, eligibleRequest: true };
  assert.equal(shouldResolve({ ...base, current: usable ? signed : null }), true);
  assert.equal(shouldResolve({ ...base, current: null, eligibleRequest: false }), false, "RSC/prefetch no resuelven");
  assert.equal(shouldResolve({ ...base, current: null, bot: true }), false, "bots no resuelven");
});

test("full firmado siempre vale; se revalida a los 7 días", () => {
  const signed = { experience: "full" as const, source: "quota" as const, day: "2026-09-20" };
  for (const mode of ["paused", "quota", "open_all", "kill"] as const) {
    assert.deepEqual(evaluateSigned(signed, "2026-09-26", mode), { usable: true, fresh: true }, mode);
    assert.deepEqual(evaluateSigned(signed, "2026-09-27", mode), { usable: true, fresh: false }, mode);
    assert.deepEqual(evaluateSigned(null, "2026-09-27", mode), { usable: false, fresh: false }, mode);
  }
});

const full = { experience: "full" as const, source: "quota" as const, day: "2026-09-29" };
const catalog = { experience: "catalog" as const, source: null, day: "2026-09-29" };
const base = { mode: "quota" as const, current: null, fresh: false, door: false, bot: false, eligibleRequest: true };

test("shouldResolve: visitante nuevo en navegación de documento", () => {
  assert.equal(shouldResolve(base), true);
});

test("shouldResolve: bots, prefetch/RSC y kill nunca resuelven", () => {
  assert.equal(shouldResolve({ ...base, bot: true }), false);
  assert.equal(shouldResolve({ ...base, bot: true, door: true }), false);
  assert.equal(shouldResolve({ ...base, eligibleRequest: false }), false);
  assert.equal(shouldResolve({ ...base, mode: "kill" }), false);
  assert.equal(shouldResolve({ ...base, mode: "kill", door: true }), false);
});

test("shouldResolve: catalog del día no reintenta salvo puerta /nj", () => {
  assert.equal(shouldResolve({ ...base, current: catalog, fresh: true }), false);
  assert.equal(shouldResolve({ ...base, current: catalog, fresh: true, door: true }), true);
});

test("shouldResolve: full fresco no llama a la base; vencido revalida", () => {
  assert.equal(shouldResolve({ ...base, current: full, fresh: true }), false);
  assert.equal(shouldResolve({ ...base, current: full, fresh: true, door: true }), false);
  assert.equal(shouldResolve({ ...base, current: full, fresh: false }), true);
});

test("shouldResolve: paused y open_all también consultan (la base decide)", () => {
  assert.equal(shouldResolve({ ...base, mode: "paused" }), true);
  assert.equal(shouldResolve({ ...base, mode: "open_all" }), true);
});

test("displayExperience: kill pinta catalog sin mirar el grant", () => {
  assert.equal(displayExperience("kill", full), "catalog");
  assert.equal(displayExperience("quota", full), "full");
  assert.equal(displayExperience("quota", catalog), "catalog");
  assert.equal(displayExperience("open_all", null), "catalog");
});

test("canEnterFullArea exige full firmado", () => {
  for (const mode of ["paused", "quota", "open_all"] as const) {
    assert.equal(canEnterFullArea(mode, full, false), true);
    assert.equal(canEnterFullArea(mode, catalog, false), false);
    assert.equal(canEnterFullArea(mode, null, false), false);
  }
});

test("canEnterFullArea en kill: clientes con grant afuera, staff verificado adentro", () => {
  assert.equal(canEnterFullArea("kill", full, false), false);
  assert.equal(canEnterFullArea("kill", catalog, false), false);
  assert.equal(canEnterFullArea("kill", full, true), true);
  assert.equal(canEnterFullArea("kill", null, true), true);
});

// ── Día ART ────────────────────────────────────────────────────────────────

test("rolloutDay usa la medianoche de Buenos Aires (UTC-3)", () => {
  assert.equal(rolloutDay(new Date("2026-09-30T02:59:59Z")), "2026-09-29");
  assert.equal(rolloutDay(new Date("2026-09-30T03:00:00Z")), "2026-09-30");
});

test("secondsUntilRolloutDayEnds", () => {
  assert.equal(secondsUntilRolloutDayEnds(new Date("2026-09-30T03:00:00Z")), 86400);
  assert.equal(secondsUntilRolloutDayEnds(new Date("2026-09-30T02:00:00Z")), 3600);
  assert.equal(secondsUntilRolloutDayEnds(new Date("2026-09-30T02:59:59Z")), 60);
});

test("daysBetween", () => {
  assert.equal(daysBetween("2026-09-29", "2026-09-29"), 0);
  assert.equal(daysBetween("2026-09-22", "2026-09-29"), 7);
  assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1);
  assert.equal(daysBetween("bad", "2026-03-01"), Number.POSITIVE_INFINITY);
});

// ── Request ────────────────────────────────────────────────────────────────

test("bots y clientes HTTP no consumen cupo", () => {
  for (const ua of [
    undefined,
    "",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "facebookexternalhit/1.1",
    "WhatsApp/2.23.20.0 A",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36",
    "curl/8.4.0",
    "vercel-screenshot/1.0",
    "Mozilla/5.0 (Linux; Android 11; moto g(9) play) Chrome-Lighthouse",
  ]) {
    assert.equal(isBotUserAgent(ua), true, String(ua));
  }
});

test("navegadores móviles reales e in-app no son bots", () => {
  for (const ua of [
    "Mozilla/5.0 (Linux; Android 13; SM-A135M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0",
    "Mozilla/5.0 (Linux; Android 13; SM-A135M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/460.0.0.0;]",
  ]) {
    assert.equal(isBotUserAgent(ua), false, ua);
  }
});

test("solo navegaciones de documento GET son elegibles", () => {
  assert.equal(isDocumentNavigation("GET", headers({ "sec-fetch-dest": "document" })), true);
  assert.equal(isDocumentNavigation("GET", headers({ accept: "text/html,application/xhtml+xml" })), true);
  assert.equal(isDocumentNavigation("POST", headers({ "sec-fetch-dest": "document" })), false);
  assert.equal(isDocumentNavigation("GET", headers({ "sec-fetch-dest": "empty" })), false);
  assert.equal(isDocumentNavigation("GET", headers({ accept: "*/*" })), false);
  assert.equal(isDocumentNavigation("GET", headers({ rsc: "1", "sec-fetch-dest": "document" })), false);
  assert.equal(isDocumentNavigation("GET", headers({ "next-router-prefetch": "1", accept: "text/html" })), false);
  assert.equal(isDocumentNavigation("GET", headers({ "next-router-state-tree": "x", accept: "text/html" })), false);
  assert.equal(isDocumentNavigation("GET", headers({ "x-middleware-prefetch": "1", accept: "text/html" })), false);
  assert.equal(isDocumentNavigation("GET", headers({ purpose: "prefetch", accept: "text/html" })), false);
  assert.equal(
    isDocumentNavigation("GET", headers({ "sec-purpose": "prefetch;prerender", "sec-fetch-dest": "document" })),
    false
  );
});

test("puerta /nj y rutas /catalogo", () => {
  assert.equal(isNjDoorPath("/nj"), true);
  assert.equal(isNjDoorPath("/nj/producto/ABC"), true);
  assert.equal(isNjDoorPath("/njx"), false);
  assert.equal(isNjDoorPath("/"), false);

  assert.equal(isLegacyCatalogoPath("/catalogo"), true);
  assert.equal(isLegacyCatalogoPath("/catalogo/calzado"), true);
  assert.equal(isLegacyCatalogoPath("/catalogos"), false);

  assert.equal(mapLegacyCatalogoPath("/catalogo"), "/");
  assert.equal(mapLegacyCatalogoPath("/catalogo/"), "/");
  assert.equal(mapLegacyCatalogoPath("/catalogo/calzado"), "/calzado");
  assert.equal(mapLegacyCatalogoPath("/catalogo/producto/AB-12"), "/producto/AB-12");
});

test("landings de Firebase no pasan por la decisión de experiencia", () => {
  assert.equal(isLegacyLandingPath("/revendedoras"), true);
  assert.equal(isLegacyLandingPath("/calzado-femenino-por-mayor"), true);
  assert.equal(isLegacyLandingPath("/terms"), true);
  assert.equal(isLegacyLandingPath("/calzado"), false);
  assert.equal(isLegacyLandingPath("/"), false);
  assert.equal(isLegacyLandingPath("/quienes-somos"), false);
});

test("solo www es host canónico (el resto recibe noindex)", () => {
  assert.equal(isCanonicalHost("www.fylmoda.com.ar"), true);
  assert.equal(isCanonicalHost("WWW.FYLMODA.COM.AR"), true);
  for (const host of ["fylmoda.com.ar", "nj-gonzidel.vercel.app", "nj-fyl-testing.vercel.app", "localhost:3000", null, ""]) {
    assert.equal(isCanonicalHost(host), false, String(host));
  }
});
