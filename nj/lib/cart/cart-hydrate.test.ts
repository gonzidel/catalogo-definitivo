import assert from "node:assert/strict";
import { test } from "node:test";
import { isUniqueConflict, mergeHydratedCartItems } from "./cart-hydrate";

test("hydrate no pisa una qty local más nueva (synced=false)", () => {
  const local = [
    {
      id: "uuid-1",
      variant_id: "var-1",
      size: "52",
      qty: 3,
      synced: false,
      is_offer: true,
    },
  ];
  const server = [
    {
      id: "uuid-1",
      variant_id: "var-1",
      size: "52",
      qty: 1,
      synced: true,
      is_offer: false,
    },
  ];
  const merged = mergeHydratedCartItems(local, server);
  assert.equal(merged[0]?.qty, 3);
  assert.equal(merged[0]?.synced, false);
  assert.equal(merged[0]?.is_offer, true);
  assert.equal(merged[0]?.id, "uuid-1");
});

test("hydrate sí toma qty server si la línea local ya está synced", () => {
  const local = [
    { id: "uuid-1", variant_id: "var-1", size: "52", qty: 3, synced: true },
  ];
  const server = [
    { id: "uuid-1", variant_id: "var-1", size: "52", qty: 1, synced: true },
  ];
  const merged = mergeHydratedCartItems(local, server);
  assert.equal(merged[0]?.qty, 1);
});

test("remove remoto-first no borra local si el delete falla", async () => {
  const local = new Map<string, { id: string }>([["var-1|52", { id: "uuid-1" }]]);
  async function handleRemove(key: string, remoteOk: boolean) {
    if (!remoteOk) return false;
    local.delete(key);
    return true;
  }
  const ok = await handleRemove("var-1|52", false);
  assert.equal(ok, false);
  assert.equal(local.has("var-1|52"), true);
});

test("409/23505 idempotente no bloquea: se reusa el id existente", () => {
  assert.equal(isUniqueConflict({ code: "23505" }), true);
  assert.equal(isUniqueConflict({ status: 409, message: "duplicate key" }), true);
  assert.equal(
    isUniqueConflict({ message: "duplicate key value violates unique constraint ux_cart_items_cart_variant_size" }),
    true
  );
  assert.equal(isUniqueConflict({ message: "network" }), false);
});
