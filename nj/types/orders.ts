export type OrderItemStatus =
  | "reserved"
  | "picked"
  | "waiting"
  | "missing"
  | "cancelled"
  | "expired";

export type OrderStatus =
  | "active"
  | "closing_soon"
  | "closed"
  | "sent"
  | "stock_pending"
  | "devolución"
  | "devolucion"
  | "cancelled"
  | "expired";

export type WarehouseLabel = "General" | "Local" | "Mixto" | null;

export type KanbanColumnId =
  | "active"
  | "picked"
  | "waiting"
  | "closed"
  | "stock_pending"
  | "cancelled";

export interface OrderItemStockSource {
  warehouse_id: string;
  qty: number;
}

export interface AdminOrderCustomer {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  dni: string | null;
  transport_id?: string | null;
  city: string | null;
  province: string | null;
}

export interface AdminOrderItem {
  id: string;
  order_id: string;
  variant_id: string | null;
  product_name: string | null;
  color: string | null;
  size: string | null;
  quantity: number;
  price_snapshot: number | null;
  imagen?: string | null;
  status: OrderItemStatus | string;
  admin_confirmed_missing?: boolean | null;
  checked_by?: string | null;
  checked_at?: string | null;
  order_item_stock_sources?: OrderItemStockSource[];
  warehouseLabel?: WarehouseLabel;
  /** Enrichment: promo 2x1/2xMonto o oferta por color activa (ver offer-badges.ts). */
  isOffer?: boolean;
}

export interface AdminTransport {
  id: string;
  name: string;
}

export interface AdminOrder {
  id: string;
  order_number: string | null;
  status: OrderStatus | string;
  customer_id: string;
  total_amount: number | null;
  notes: string | null;
  source: string | null;
  created_at: string;
  sent_at?: string | null;
  expires_at?: string | null;
  dismantle_at?: string | null;
  transport_id?: string | null;
  customers?: AdminOrderCustomer | AdminOrderCustomer[] | null;
  order_items?: AdminOrderItem[];
  transportName?: string | null;
  transportBadgeClass?: string | null;
}

export interface WarehouseIds {
  general: string | null;
  ventaPublico: string | null;
}

export interface PaymentMethod {
  id: string;
  name: string;
}

export const KANBAN_COLUMNS: { id: KanbanColumnId; label: string }[] = [
  { id: "active", label: "Activos" },
  { id: "picked", label: "Apartados" },
  { id: "waiting", label: "Espera" },
  { id: "closed", label: "Cerrados" },
  { id: "stock_pending", label: "Stock Pend." },
  { id: "cancelled", label: "Cancelados" },
];
