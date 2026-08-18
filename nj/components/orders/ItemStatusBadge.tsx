import type { OrderItemStatus } from "@/types/orders";

const LABELS: Record<string, string> = {
  reserved: "Reservado",
  picked: "Apartado",
  waiting: "Espera",
  missing: "Falta",
  cancelled: "Cancelado",
};

const COMPACT_LABELS: Record<string, string> = {
  reserved: "Res.",
  picked: "Ap.",
  waiting: "Esp.",
  missing: "Falta",
  cancelled: "Can.",
};

interface ItemStatusBadgeProps {
  status: OrderItemStatus | string;
  compact?: boolean;
  /** El ítem no se está resolviendo individualmente, sino que va a devolverse
   *  en bloque junto con el resto del pedido (ej. vencido, pendiente de
   *  desarmar). Dentro de este modo, "reservado"/"espera" se distinguen en
   *  amarillo porque esas unidades nunca se separaron físicamente del
   *  depósito (devolverlas es solo un ajuste de sistema); el resto (apartado,
   *  cancelado, falta) se muestra en gris neutro. */
  muted?: boolean;
}

export default function ItemStatusBadge({ status, compact = false, muted = false }: ItemStatusBadgeProps) {
  const key = String(status || "reserved").trim().toLowerCase();
  const labels = compact ? COMPACT_LABELS : LABELS;
  const fullLabel = LABELS[key] || key;
  const neverPhysicallySeparated = key === "reserved" || key === "waiting";
  const mutedClass = muted
    ? neverPhysicallySeparated
      ? " order-item-badge--pending-return"
      : " order-item-badge--muted"
    : "";
  const cls = `order-item-badge order-item-badge--${key in LABELS ? key : "reserved"}${compact ? " order-item-badge--compact" : ""}${mutedClass}`;
  return (
    <span
      className={cls}
      title={
        muted && neverPhysicallySeparated
          ? "Nunca se separó físicamente del depósito — devolverlo es solo un ajuste de sistema"
          : compact
            ? fullLabel
            : undefined
      }
    >
      {labels[key] || key}
    </span>
  );
}
