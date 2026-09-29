/**
 * Tests: conteo de días que ve la clienta (header, chip, banner, campanita).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { customerDaysLeft } from "./deadline";

// Jueves 01/10/2026 17:00 (hora local, como dismantle_at).
const deadline = new Date(2026, 9, 1, 17, 0);
const at = (month: number, day: number, hour: number) =>
  new Date(2026, month, day, hour, 0).getTime();

test("2d 10h antes del vencimiento muestra 3 días", () => {
  assert.equal(customerDaysLeft(deadline, at(8, 29, 7)), 3);
});

test("después de las 17:00 del martes quedan 2 días", () => {
  assert.equal(customerDaysLeft(deadline, at(8, 29, 18)), 2);
});

test("exactamente 48 h antes son 2 días", () => {
  assert.equal(customerDaysLeft(deadline, at(8, 29, 17)), 2);
});

test("lunes a la mañana (3d 10h) muestra 4 días", () => {
  assert.equal(customerDaysLeft(deadline, at(8, 28, 7)), 4);
});

test("día anterior al vencimiento es Mañana (1) aunque falten más de 24 h", () => {
  assert.equal(customerDaysLeft(deadline, at(8, 30, 7)), 1);
  assert.equal(customerDaysLeft(deadline, at(8, 30, 18)), 1);
});

test("día del vencimiento es Hoy (0)", () => {
  assert.equal(customerDaysLeft(deadline, at(9, 1, 7)), 0);
  assert.equal(customerDaysLeft(deadline, at(9, 1, 18)), 0);
});

test("días posteriores al vencimiento son negativos", () => {
  assert.equal(customerDaysLeft(deadline, at(9, 2, 9)), -1);
});

test("el conteo nunca sube a medida que pasa el tiempo", () => {
  let previous = Number.POSITIVE_INFINITY;
  for (let t = at(8, 24, 0); t <= at(9, 2, 0); t += 30 * 60 * 1000) {
    const days = customerDaysLeft(deadline, t);
    assert.ok(days <= previous, `subió de ${previous} a ${days} en ${new Date(t).toString()}`);
    previous = days;
  }
});
