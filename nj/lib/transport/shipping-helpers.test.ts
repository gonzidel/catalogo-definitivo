import assert from "node:assert/strict";
import { test } from "node:test";
import { getTransportesDisponibles } from "./index";
import { resolveCloseTransportOptions } from "./shipping-helpers";

function closeOptions(province: string, city: string, current?: string | null) {
  return resolveCloseTransportOptions(
    province,
    city,
    getTransportesDisponibles(province, city),
    current
  );
}

test("Tacuarendí (Santa Fe) ofrece Snaider además de Correo Argentino", () => {
  for (const city of ["Tacuarendi (Emb. Kilometro 421)", "Tacuarendí"]) {
    const { options, recommended } = closeOptions("Santa Fe", city);
    assert.deepEqual(options, ["Snaider", "Correo Argentino"]);
    assert.equal(recommended, "Snaider");
  }
});

test("el transporte asignado en BD se ofrece y preselecciona aunque la geo no lo liste", () => {
  const { options, recommended } = closeOptions("Tierra del Fuego", "Ushuaia", "Transporte Snaider");
  assert.deepEqual(options, ["Snaider", "Correo Argentino"]);
  assert.equal(recommended, "Snaider");
});

test("sin transporte asignado, se mantienen solo las opciones geo", () => {
  const { options, recommended } = closeOptions("Tierra del Fuego", "Ushuaia");
  assert.deepEqual(options, ["Correo Argentino"]);
  assert.equal(recommended, "Correo Argentino");
});

test("sin provincia o localidad, cae al asignado o a Correo Argentino", () => {
  assert.deepEqual(resolveCloseTransportOptions("", "", [], "Via Cargo"), {
    options: ["Via Cargo"],
    recommended: "Via Cargo",
  });
  assert.deepEqual(resolveCloseTransportOptions("", "", [], null), {
    options: ["Correo Argentino"],
    recommended: "Correo Argentino",
  });
});
