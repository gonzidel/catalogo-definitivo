import test from "node:test";
import assert from "node:assert/strict";
import { getTransportesDisponibles } from "../client/transportes-data.js";

test("localidad con SEDE y Expreso Norte ofrece los dos, SEDE primero", () => {
  assert.deepEqual(getTransportesDisponibles("Corrientes", "Curuzú Cuatiá"), ["SEDE", "Expreso Norte"]);
  assert.deepEqual(getTransportesDisponibles("corrientes", "CURUZU CUATIA"), ["SEDE", "Expreso Norte"]);
  assert.deepEqual(getTransportesDisponibles("Corrientes", "Goya"), ["SEDE", "Expreso Norte"]);
});

test("localidad solo SEDE sigue siendo exclusiva", () => {
  assert.deepEqual(getTransportesDisponibles("Corrientes", "Alvear"), ["SEDE"]);
  assert.deepEqual(getTransportesDisponibles("Chaco", "Charata"), ["SEDE"]);
});

test("localidad solo Expreso Norte no cambia", () => {
  const opciones = getTransportesDisponibles("Corrientes", "Empedrado");
  assert.equal(opciones[0], "Expreso Norte");
  assert.ok(!opciones.includes("SEDE"));
});

test("Corrientes Capital sigue limitado a Retira local + MyM", () => {
  assert.deepEqual(getTransportesDisponibles("Corrientes", "Corrientes"), ["Retira local", "MyM"]);
});
