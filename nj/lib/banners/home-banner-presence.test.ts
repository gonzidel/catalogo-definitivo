import assert from "node:assert/strict";
import { test } from "node:test";
import {
  interpretOfertasPresence,
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

test("ofertas: check apagado → absent, sin importar las ofertas", () => {
  assert.equal(
    interpretOfertasPresence({
      flagError: null,
      flagEnabled: false,
      offersRowCount: 10,
    }),
    "absent"
  );
});

test("ofertas: sin fila del flag → absent", () => {
  assert.equal(
    interpretOfertasPresence({ flagError: null, flagEnabled: undefined }),
    "absent"
  );
});

test("ofertas: error leyendo el flag (p. ej. migración pendiente) → unknown, el cliente falla cerrado", () => {
  const state = interpretOfertasPresence({
    flagError: { message: "relation does not exist" },
    flagEnabled: undefined,
  });
  assert.equal(state, "unknown");
  assert.equal(shouldReserveBannerSlot(state), false);
});

test("ofertas: check activo con ofertas → present; sin ofertas → absent; error → unknown", () => {
  assert.equal(
    interpretOfertasPresence({ flagError: null, flagEnabled: true, offersRowCount: 1 }),
    "present"
  );
  assert.equal(
    interpretOfertasPresence({ flagError: null, flagEnabled: true, offersRowCount: 0 }),
    "absent"
  );
  assert.equal(
    interpretOfertasPresence({
      flagError: null,
      flagEnabled: true,
      offersError: { message: "timeout" },
    }),
    "unknown"
  );
});

