import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWhatsAppUrl } from "./domain";

test("WhatsApp no duplica el 9 cuando el teléfono ya viene como +54 9", () => {
  const url = buildWhatsAppUrl("+54 9 3624 75-5101");
  assert.equal(url, "https://wa.me/5493624755101");
});

test("WhatsApp no genera 5499 si el número ya tiene 9 nacional", () => {
  const url = buildWhatsAppUrl("93624755101");
  assert.equal(url, "https://wa.me/5493624755101");
});

test("WhatsApp acepta 0 de área local", () => {
  const url = buildWhatsAppUrl("03624755101");
  assert.equal(url, "https://wa.me/5493624755101");
});

test("WhatsApp acepta solo el nacional de 10 dígitos", () => {
  const url = buildWhatsAppUrl("3624755101");
  assert.equal(url, "https://wa.me/5493624755101");
});

test("WhatsApp corrige un 5499 ya mal armado", () => {
  const url = buildWhatsAppUrl("54993624755101");
  assert.equal(url, "https://wa.me/5493624755101");
});

test("WhatsApp incluye el texto del mensaje", () => {
  const url = buildWhatsAppUrl("03624755101", "Hola");
  assert.equal(url, `https://wa.me/5493624755101?text=${encodeURIComponent("Hola")}`);
});
