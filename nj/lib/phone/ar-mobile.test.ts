import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatPhoneE164,
  formatPhoneInput,
  phoneToLocalInput,
  validatePhone,
} from "./ar-mobile";

test("formatPhoneInput agrupa área y número", () => {
  assert.equal(formatPhoneInput("3734444974"), "373 444-4974");
  assert.equal(formatPhoneInput("37344"), "373 44");
});

test("validatePhone acepta 8–10 dígitos", () => {
  assert.equal(validatePhone("3734444974"), true);
  assert.equal(validatePhone("123"), false);
});

test("formatPhoneE164 antepone +54 9 (misma lógica que ProfileOnboardingModal)", () => {
  // Regex de área 2–4 dígitos: con 10 dígitos locales toma área de 4.
  assert.equal(formatPhoneE164("3734444974"), "+54 9 3734 44-4974");
});

test("phoneToLocalInput quita +54 9", () => {
  assert.equal(phoneToLocalInput("+54 9 373 444-4974"), "373 444-4974");
  assert.equal(phoneToLocalInput("3734444974"), "373 444-4974");
});
