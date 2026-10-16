import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareRetiroPickedColumn,
  isLocalPickupBoardOrder,
  isMovedFromOrdersToRetiro,
} from "./board-scope";
import { filterOrdersForColumn } from "./classification";
import type { AdminOrder } from "@/types/orders";

function order(partial: Partial<AdminOrder>): AdminOrder {
  return {
    id: "o1",
    order_number: "A1",
    status: "active",
    customer_id: "c1",
    total_amount: 1000,
    notes: null,
    source: "customer",
    created_at: "2026-09-14T00:00:00Z",
    local_deferred_pickup: false,
    order_items: [
      {
        id: "i1",
        order_id: "o1",
        variant_id: "v1",
        product_name: "X",
        color: "Negro",
        size: "38",
        quantity: 1,
        price_snapshot: 1000,
        status: "picked",
      },
    ],
    ...partial,
  } as AdminOrder;
}

test("perfil Retira local sin botón Local queda en Pedidos", () => {
  const o = order({
    transportName: "Retira local",
    customers: {
      id: "c1",
      full_name: "Maria",
      province: "Formosa",
      city: "El Colorado",
      phone: null,
      email: null,
      dni: null,
    },
  });
  assert.equal(isLocalPickupBoardOrder(o), false);
});

test("geo Corrientes Capital sin botón Local queda en Pedidos", () => {
  const o = order({
    transportName: "MyM",
    customers: {
      id: "c1",
      full_name: "Ana",
      province: "Corrientes",
      city: "Corrientes",
      phone: null,
      email: null,
      dni: null,
    },
  });
  assert.equal(isLocalPickupBoardOrder(o), false);
});

test("botón Local manda a Retiro", () => {
  const o = order({
    transportName: "Retira local",
    notes: JSON.stringify({
      kanban_scope: "local_pickup",
      retiro_origin: "moved_from_orders",
    }),
  });
  assert.equal(isLocalPickupBoardOrder(o), true);
});

test("Enviar al local desde cerrados manda a Retiro", () => {
  const o = order({
    transportName: "SEDE",
    notes: JSON.stringify({
      kanban_scope: "local_pickup",
      retiro_origin: "moved_from_closed",
    }),
  });
  assert.equal(isLocalPickupBoardOrder(o), true);
});

test("botón Depósito saca de Retiro aunque el perfil sea Retira local", () => {
  const o = order({
    transportName: "Retira local",
    notes: JSON.stringify({ kanban_scope: "shipping" }),
  });
  assert.equal(isLocalPickupBoardOrder(o), false);
});

test("checkout deferred 36 h queda en Retiro", () => {
  const o = order({ local_deferred_pickup: true, transportName: "MyM" });
  assert.equal(isLocalPickupBoardOrder(o), true);
});

test("Apartados Retiro: enviados desde Pedidos quedan arriba y el más reciente primero", () => {
  const olderMoved = order({
    id: "older",
    created_at: "2026-10-01T00:00:00Z",
    notes: JSON.stringify({
      kanban_scope: "local_pickup",
      retiro_origin: "moved_from_orders",
      moved_to_local_at: "2026-10-16T10:00:00.000Z",
    }),
  });
  const newerMoved = order({
    id: "newer",
    created_at: "2026-09-01T00:00:00Z",
    notes: JSON.stringify({
      kanban_scope: "local_pickup",
      retiro_origin: "moved_from_orders",
      moved_to_local_at: "2026-10-16T12:00:00.000Z",
    }),
  });
  const localSale = order({
    id: "sale",
    status: "closed",
    payment_method: "Pendiente",
    transportName: "Retira local",
    notes: JSON.stringify({ kanban_scope: "local_pickup" }),
  });
  const plain = order({
    id: "plain",
    notes: JSON.stringify({ kanban_scope: "local_pickup" }),
  });

  assert.equal(isMovedFromOrdersToRetiro(newerMoved), true);
  assert.equal(isMovedFromOrdersToRetiro(plain), false);

  const sorted = [plain, olderMoved, localSale, newerMoved].sort((a, b) =>
    compareRetiroPickedColumn(a, b, {
      isAwaitingSale: (o) => o.id === "sale",
    })
  );
  assert.deepEqual(
    sorted.map((o) => o.id),
    ["newer", "older", "sale", "plain"]
  );
});

test("espejo caja queda en Retiro", () => {
  const o = order({
    notes: JSON.stringify({
      mirrored_from_local_order: true,
      retiro_origin: "public_sales",
    }),
  });
  assert.equal(isLocalPickupBoardOrder(o), true);
});

test("cerrado COD sin Local va a Cerrados de Pedidos, no a Retiro", () => {
  const closedCod = order({
    status: "closed",
    payment_method: "Contra Reembolso",
    notes: JSON.stringify({ pau_source: true }),
    transportName: "Retira local",
  });
  assert.equal(isLocalPickupBoardOrder(closedCod), false);
  assert.equal(
    filterOrdersForColumn([closedCod], "closed", { boardScope: "shipping" }).length,
    1
  );
  assert.equal(
    filterOrdersForColumn([closedCod], "closed", { boardScope: "local_pickup" }).length,
    0
  );
});
