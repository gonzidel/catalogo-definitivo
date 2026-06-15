import type { OrderItemStatus } from "@/types/orders";

const LABELS: Record<string, string> = {
  reserved: "Reservado",
  picked: "Apartado",
  waiting: "Espera",
  missing: "Falta",
  cancelled: "Cancelado",
};

interface ItemStatusBadgeProps {
  status: OrderItemStatus | string;
}

export default function ItemStatusBadge({ status }: ItemStatusBadgeProps) {
  const key = String(status || "reserved").trim().toLowerCase();
  const cls = `order-item-badge order-item-badge--${key in LABELS ? key : "reserved"}`;
  return <span className={cls}>{LABELS[key] || key}</span>;
}
