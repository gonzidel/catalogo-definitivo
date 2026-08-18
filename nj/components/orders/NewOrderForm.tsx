"use client";

import { useState } from "react";
import OrderCreateModal from "./OrderCreateModal";

interface NewOrderFormProps {
  className?: string;
  label?: string;
}

export default function NewOrderForm({
  className = "kanban-column__add-btn",
  label = "+",
}: NewOrderFormProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={className}
        title="Crear pedido manual"
        aria-label="Crear pedido manual"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open ? <OrderCreateModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}
