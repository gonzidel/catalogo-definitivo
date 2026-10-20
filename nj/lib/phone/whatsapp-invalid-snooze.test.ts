import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearWhatsappInvalidSnooze,
  isWhatsappInvalidSnoozed,
  snoozeWhatsappInvalid,
  WHATSAPP_INVALID_SNOOZE_MS,
} from "./whatsapp-invalid-snooze";

const store = new Map<string, string>();

test("snooze 12h oculta el aviso hasta vencer", () => {
  const g = globalThis as typeof globalThis & { localStorage: Storage };
  const prev = g.localStorage;
  const mock: Storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(g, "localStorage", {
    configurable: true,
    writable: true,
    value: mock,
  });

  try {
    store.clear();
    const id = "cust-1";
    const now = 1_000_000;
    assert.equal(isWhatsappInvalidSnoozed(id, now), false);
    const until = snoozeWhatsappInvalid(id, now);
    assert.equal(until, now + WHATSAPP_INVALID_SNOOZE_MS);
    assert.equal(isWhatsappInvalidSnoozed(id, now + 60_000), true);
    assert.equal(isWhatsappInvalidSnoozed(id, until), false);
    clearWhatsappInvalidSnooze(id);
    assert.equal(isWhatsappInvalidSnoozed(id, now), false);
  } finally {
    Object.defineProperty(g, "localStorage", {
      configurable: true,
      writable: true,
      value: prev,
    });
  }
});
