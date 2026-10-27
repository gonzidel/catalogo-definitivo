import assert from "node:assert/strict";
import { test } from "node:test";
import { RETIRO_NOTES_ILIKE_PATTERNS } from "./order-queries";

/** Equivalente aproximado de ILIKE con solo `%` (sin `_`). */
function ilikeContains(text: string, pattern: string): boolean {
  const parts = String(pattern).split("%").map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  return new RegExp(`^${parts.join(".*")}$`, "i").test(text);
}

function matchesRetiroNotesPool(notes: string): boolean {
  return RETIRO_NOTES_ILIKE_PATTERNS.some((pattern) => ilikeContains(notes, pattern));
}

const COMPACT_MOVED =
  '{"discount":0,"shipping":0,"kanban_scope":"local_pickup","extras_amount":0,"retiro_origin":"moved_from_orders","extras_percentage":0,"moved_to_local_at":"2026-10-27T12:43:13.879Z"}';

const SPACED_MOVED =
  '{"discount": 0, "shipping": 0, "kanban_scope": "local_pickup", "extras_amount": 0, "retiro_origin": "moved_from_orders", "extras_percentage": 0, "moved_to_local_at": "2026-10-27T12:43:13.879Z"}';

const SPACED_MIRROR =
  '{"mirrored_from_local_order": true, "retiro_origin": "public_sales"}';

const SHIPPING_ONLY = '{"discount":0,"shipping":0,"kanban_scope":"shipping"}';

test("Retiro: notes compactos de Local siguen entrando al pool", () => {
  assert.equal(matchesRetiroNotesPool(COMPACT_MOVED), true);
});

test("Retiro: notes con espacio tras ':' (jsonb::text) también entran — caso A58510", () => {
  assert.equal(matchesRetiroNotesPool(SPACED_MOVED), true);
  assert.equal(matchesRetiroNotesPool(SPACED_MIRROR), true);
});

test("Retiro: kanban_scope shipping no entra por estos patrones", () => {
  assert.equal(matchesRetiroNotesPool(SHIPPING_ONLY), false);
});
