import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractArgentinaNationalDigits,
  isSameArgentinaPhone,
  formatPhoneLocalDisplay,
  formatPhoneStored,
  phoneForDisplay,
  sanitizePhoneInput,
  validateArgentinaPhone,
} from "./phone-ar";

test("normaliza los formatos habituales a 10 dígitos nacionales", () => {
  const casos = [
    "3624720762",
    "362 472-0762",
    "03624720762",
    "0362 4720762",
    "+54 9 362 472-0762",
    "+54 9 3624 72-0762",
    "5493624720762",
    "549 362 4720762",
    "543624720762",
    "93624720762",
    "0054 9 362 4720762",
    "(0362) 472-0762",
  ];
  for (const raw of casos) {
    assert.equal(extractArgentinaNationalDigits(raw), "3624720762", raw);
  }
});

test("quita el 15 después de la característica", () => {
  assert.equal(extractArgentinaNationalDigits("362 15 4720762"), "3624720762");
  assert.equal(extractArgentinaNationalDigits("0362 15-472-0762"), "3624720762");
  assert.equal(extractArgentinaNationalDigits("011 15 2345-6789"), "1123456789");
  assert.equal(extractArgentinaNationalDigits("11 15 2345 6789"), "1123456789");
  assert.equal(extractArgentinaNationalDigits("2966 15 123456"), "2966123456");
});

test("no toca un número de 10 dígitos que casualmente contiene 15", () => {
  assert.equal(extractArgentinaNationalDigits("3621547207"), "3621547207");
});

test("acepta números completos", () => {
  for (const raw of ["362 472-0762", "+54 9 11 2345-6789", "2966 123456", "351 1234567"]) {
    const r = validateArgentinaPhone(raw);
    assert.equal(r.ok, true, raw);
  }
});

test("rechaza vacío indicando que es obligatorio", () => {
  const r = validateArgentinaPhone("");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /obligatorio|Ingresá/i);
});

test("rechaza 8 y 9 dígitos (incompletos) con cuántos faltan", () => {
  const nueve = validateArgentinaPhone("362 472076");
  assert.equal(nueve.ok, false);
  assert.match(nueve.error ?? "", /Falta 1 dígito/);

  const ocho = validateArgentinaPhone("362 47207");
  assert.equal(ocho.ok, false);
  assert.match(ocho.error ?? "", /Faltan 2 dígitos/);

  const siete = validateArgentinaPhone("3624720");
  assert.equal(siete.ok, false);
  assert.match(siete.error ?? "", /Faltan 3 dígitos/);
});

test("rechaza si sobran dígitos sin poder deducir el motivo", () => {
  const r = validateArgentinaPhone("362 472 07621 55");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Sobran 3 dígitos/);
});

test("rechaza características imposibles", () => {
  for (const raw of ["4624720762", "5624720762", "1024720762", "1224720762", "7624720762"]) {
    const r = validateArgentinaPhone(raw);
    assert.equal(r.ok, false, raw);
  }
});

test("rechaza números con todos los dígitos iguales", () => {
  assert.equal(validateArgentinaPhone("3333333333").ok, false);
  assert.equal(validateArgentinaPhone("1111111111").ok, false);
});

test("el mensaje de error nunca menciona 54 ni 9 como requisito visible", () => {
  for (const raw of ["", "123", "362 4720", "99999999999999"]) {
    const r = validateArgentinaPhone(raw);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error ?? "", /\+?54|\b9\b/);
  }
});

test("guarda con prefijo interno y agrupa por característica", () => {
  assert.equal(formatPhoneStored("3624720762"), "+54 9 362 472-0762");
  assert.equal(formatPhoneStored("1123456789"), "+54 9 11 2345-6789");
});

test("muestra al cliente solo el número local, sin 54 ni 9", () => {
  assert.equal(formatPhoneLocalDisplay("3624720762"), "362 472-0762");
  assert.equal(formatPhoneLocalDisplay("1123456789"), "11 2345-6789");
  assert.equal(phoneForDisplay("+54 9 3624 72-0762"), "362 472-0762");
  assert.equal(phoneForDisplay("+54 9 11 2345-6789"), "11 2345-6789");
  assert.equal(phoneForDisplay("3624720762"), "362 472-0762");
  assert.equal(phoneForDisplay(""), "");
  assert.equal(phoneForDisplay(null), "");
});

test("un dato viejo incompleto se muestra sin prefijo y sin inventar dígitos", () => {
  assert.equal(phoneForDisplay("+54 9 362 4720"), "362 4720");
});

test("la limpieza del campo nunca recorta: un autocompletado largo conserva los dígitos finales", () => {
  const largo = "  +54  9  (362)  472 - 0762  ";
  assert.equal(largo.length > 24, true);
  const limpio = sanitizePhoneInput(largo);
  assert.equal(limpio.replace(/\D/g, ""), "5493624720762");
  assert.equal(validateArgentinaPhone(limpio).digits, "3624720762");
  assert.equal(validateArgentinaPhone(limpio).ok, true);
});

test("detecta que es el mismo número aunque cambie el formato", () => {
  assert.equal(isSameArgentinaPhone("+54 9 5436 44-3211", "543 644-3211"), true);
  assert.equal(isSameArgentinaPhone("+54 9 362 472-0762", "03624720762"), true);
  assert.equal(isSameArgentinaPhone("+54 9 362 472-0762", "362 472-0763"), false);
  assert.equal(isSameArgentinaPhone("", "362 472-0762"), false);
  assert.equal(isSameArgentinaPhone(null, ""), false);
});
 
