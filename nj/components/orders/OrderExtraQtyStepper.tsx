"use client";

interface OrderExtraQtyStepperProps {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  /** compact = filas de lista; modal = formulario Extra/Resta */
  size?: "compact" | "modal";
}

export default function OrderExtraQtyStepper({
  value,
  onChange,
  disabled = false,
  min = 1,
  max = 99,
  size = "compact",
}: OrderExtraQtyStepperProps) {
  const qty = Math.max(min, Math.min(max, Math.floor(Number(value) || min)));
  return (
    <div className={`order-extra-qty order-extra-qty--${size}`} role="group" aria-label="Cantidad del extra">
      <button
        type="button"
        className="order-extra-qty__btn"
        disabled={disabled || qty <= min}
        aria-label="Quitar una unidad"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onChange(qty - 1);
        }}
      >
        −
      </button>
      <span className="order-extra-qty__value" aria-live="polite">
        {qty}
      </span>
      <button
        type="button"
        className="order-extra-qty__btn"
        disabled={disabled || qty >= max}
        aria-label="Agregar una unidad"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onChange(qty + 1);
        }}
      >
        +
      </button>
    </div>
  );
}
