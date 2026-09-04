import { getCustomerFacingItemStatus } from "@/lib/orders/waiting-source";
import type { WarehouseIds } from "@/types/orders";

export interface CustomerOrderItemLike {
  id: string;
  product_name?: string | null;
  color?: string | null;
  size?: string | null;
  quantity?: number | null;
  price_snapshot?: number | null;
  imagen?: string | null;
  status?: string | null;
  variant_id?: string | null;
  created_at?: string | null;
  order_item_stock_sources?: { warehouse_id: string; qty: number }[];
}

export interface GroupedCustomerOrderItem extends CustomerOrderItemLike {
  /** Todos los order_item ids agrupados en esta fila */
  itemIds: string[];
  /** Id usado para quitar 1 unidad / alternativas */
  primaryItemId: string;
}

function groupKey(item: CustomerOrderItemLike, warehouseIds: WarehouseIds): string {
  const statusKey = getCustomerFacingItemStatus(item, warehouseIds);
  const variantId = String(item.variant_id || "").trim();
  const name = String(item.product_name || "").trim().toLowerCase();
  const color = String(item.color || "").trim().toLowerCase();
  const size = String(item.size || "").trim().toLowerCase();
  const price = Number(item.price_snapshot || 0);
  // La variante en FYL es producto+color; el talle vive aparte. Si la clave
  // usa solo variant_id, talles distintos del mismo color se fusionan mal en
  // Mi pedido (bug A56427: Chocolate 36×2 + 40×3 → una fila T.36 ×5).
  const productKey = variantId
    ? `${variantId}|${size}`
    : `${name}|${color}|${size}`;
  return `${productKey}|${statusKey}|${price}`;
}

/** Agrupa líneas idénticas (mismo producto, talle, precio y estado visible) sumando cantidades. */
export function groupCustomerOrderItems<T extends CustomerOrderItemLike>(
  items: T[],
  warehouseIds: WarehouseIds
): Array<GroupedCustomerOrderItem & T> {
  const map = new Map<string, GroupedCustomerOrderItem & T>();

  for (const item of items) {
    const qty = Number(item.quantity ?? 0) || 0;
    if (qty <= 0) continue;

    const key = groupKey(item, warehouseIds);
    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        ...item,
        quantity: qty,
        itemIds: [item.id],
        primaryItemId: item.id,
      });
      continue;
    }

    existing.quantity = (Number(existing.quantity ?? 0) || 0) + qty;
    existing.itemIds.push(item.id);

    const existingMs = new Date(existing.created_at ?? 0).getTime();
    const itemMs = new Date(item.created_at ?? 0).getTime();
    if (itemMs > existingMs) {
      existing.created_at = item.created_at;
      existing.primaryItemId = item.id;
    }
  }

  return Array.from(map.values());
}
