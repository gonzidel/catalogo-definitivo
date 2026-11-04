import assert from "node:assert/strict";
import { test } from "node:test";
import {
  interpretPresenceProbe,
  shouldFetchBanner,
  shouldReserveBannerSlot,
  type BannerPresenceState,
} from "./home-banner-presence";

test("banner confirmado presente: reserva y consulta", () => {
  const state = interpretPresenceProbe({ error: null, rowCount: 1 });
  assert.equal(state, "present");
  assert.equal(shouldReserveBannerSlot(state), true);
  assert.equal(shouldFetchBanner(state), true);
});

test("banner confirmado ausente: no reserva ni consulta", () => {
  const state = interpretPresenceProbe({ error: null, rowCount: 0 });
  assert.equal(state, "absent");
  assert.equal(shouldReserveBannerSlot(state), false);
  assert.equal(shouldFetchBanner(state), false);
});

test("error de consulta SSR → unknown (cliente puede recuperar)", () => {
  const state = interpretPresenceProbe({
    error: { message: "timeout" },
    rowCount: 0,
  });
  assert.equal(state, "unknown");
  assert.equal(shouldReserveBannerSlot(state), false);
  assert.equal(shouldFetchBanner(state), true);
});

test("configuración presente pero sin items válidos → absent", () => {
  const state = interpretPresenceProbe({
    error: null,
    rowCount: 1,
    emptyItems: true,
  });
  assert.equal(state, "absent");
  assert.equal(shouldReserveBannerSlot(state), false);
  assert.equal(shouldFetchBanner(state), false);
});

test("helpers tri-state exhaustivos", () => {
  const states: BannerPresenceState[] = ["present", "absent", "unknown"];
  assert.deepEqual(
    states.map(shouldReserveBannerSlot),
    [true, false, false]
  );
  assert.deepEqual(
    states.map(shouldFetchBanner),
    [true, false, true]
  );
});
