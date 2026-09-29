/**
 * Tests: Clarity de test solo en el host de pruebas de NJ.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  NJ_TEST_CLARITY_PROJECT_ID,
  PRODUCTION_CLARITY_PROJECT_ID,
  clarityProjectForHost,
  isNjTestClarityHost,
} from "./clarity";
import { shouldUseProductionAnalytics } from "./hosts";

test("www con rollout activo mide con el proyecto productivo de catalogo1", () => {
  assert.equal(clarityProjectForHost("www.fylmoda.com.ar", true), PRODUCTION_CLARITY_PROJECT_ID);
  assert.equal(clarityProjectForHost("fylmoda.com.ar", true), PRODUCTION_CLARITY_PROJECT_ID);
});

test("www sin rollout (proxy desde catalogo1) no carga Clarity desde nj", () => {
  assert.equal(clarityProjectForHost("www.fylmoda.com.ar", false), null);
  assert.equal(shouldUseProductionAnalytics("www.fylmoda.com.ar", false), false);
});

test("host de test sigue con su proyecto; previews sin Clarity", () => {
  assert.equal(clarityProjectForHost("nj-fyl-testing.vercel.app", true), NJ_TEST_CLARITY_PROJECT_ID);
  assert.equal(clarityProjectForHost("nj-fyl-testing.vercel.app", false), NJ_TEST_CLARITY_PROJECT_ID);
  assert.equal(clarityProjectForHost("nj-abc123-gonzidel.vercel.app", true), null);
  assert.equal(shouldUseProductionAnalytics("nj-abc123-gonzidel.vercel.app", true), false);
});

test("el ID del proyecto de test es yekz20nia8", () => {
  assert.equal(NJ_TEST_CLARITY_PROJECT_ID, "yekz20nia8");
});

test("habilitado en nj-fyl-testing.vercel.app", () => {
  assert.equal(isNjTestClarityHost("nj-fyl-testing.vercel.app"), true);
  assert.equal(isNjTestClarityHost("NJ-FYL-TESTING.vercel.app"), true);
  assert.equal(isNjTestClarityHost("nj-fyl-testing.vercel.app."), true);
});

test("deshabilitado en dominios productivos", () => {
  for (const host of [
    "www.fylmoda.com.ar",
    "fylmoda.com.ar",
    "nj.fylmoda.com.ar",
    "nj-fyl-testing.vercel.app.fylmoda.com.ar",
  ]) {
    assert.equal(isNjTestClarityHost(host), false, host);
  }
});

test("deshabilitado en otros deploys de Vercel y en local", () => {
  for (const host of [
    "nj-gonzidel.vercel.app",
    "nj-6743kxivk-gonzidel.vercel.app",
    "catalogo-definitivo.vercel.app",
    "nj-fyl-testing.vercel.app.evil.com",
    "fyl-testing.vercel.app",
    "localhost",
    "127.0.0.1",
    "",
  ]) {
    assert.equal(isNjTestClarityHost(host), false, host);
  }
});
