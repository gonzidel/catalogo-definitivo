/**
 * Inbox Ani/Fati — filtros de vista.
 * Run: npx tsx lib/orders/kanban-inbox.selftest.ts
 */
import {
  filterOrdersByKanbanInboxView,
  isKanbanInboxOwner,
  isKanbanInboxView,
  orderMatchesKanbanInboxView,
} from "./kanban-inbox";
import type { AdminOrder } from "@/types/orders";

let failed = 0;

function check(name: string, cond: boolean) {
  if (!cond) {
    failed += 1;
    console.log(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function orderWithOwner(id: string, owner: "ani" | "fati" | null): AdminOrder {
  return {
    id,
    order_number: id,
    status: "active",
    customer_id: `c-${id}`,
    total_amount: 1000,
    notes: null,
    source: "customer",
    created_at: "2026-09-01T00:00:00Z",
    customers: {
      id: `c-${id}`,
      full_name: id,
      phone: null,
      email: null,
      dni: null,
      city: null,
      province: null,
      kanban_inbox_owner: owner,
    },
  };
}

check("owner ani", isKanbanInboxOwner("ani"));
check("owner fati", isKanbanInboxOwner("fati"));
check("owner bad", !isKanbanInboxOwner("anny"));
check("view general", isKanbanInboxView("general"));

const ani = orderWithOwner("1", "ani");
const fati = orderWithOwner("2", "fati");
const none = orderWithOwner("3", null);

check(
  "general shows all",
  filterOrdersByKanbanInboxView([ani, fati], "general", { boardScope: "shipping" })
    .length === 2
);
check(
  "picked ignores filter",
  filterOrdersByKanbanInboxView([ani, fati], "ani", {
    boardScope: "shipping",
    columnId: "picked",
  }).length === 2
);
check("ani keeps ani", orderMatchesKanbanInboxView(ani, "ani", { boardScope: "shipping" }));
check("ani hides fati", !orderMatchesKanbanInboxView(fati, "ani", { boardScope: "shipping" }));
check("ani hides unassigned", !orderMatchesKanbanInboxView(none, "ani", { boardScope: "shipping" }));
check(
  "retiro no filter",
  orderMatchesKanbanInboxView(fati, "ani", { boardScope: "local_pickup" })
);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
