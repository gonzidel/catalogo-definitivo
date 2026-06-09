"use client";

import { useState } from "react";
import { useCartStore } from "@/store/cart";

interface AddToCartButtonProps {
  variantId: string;
  productName: string;
  color: string;
  size: string | null;
  priceSnapshot: number;
  imagen?: string;
  disabled?: boolean;
}

export default function AddToCartButton({
  variantId,
  productName,
  color,
  size,
  priceSnapshot,
  imagen,
  disabled,
}: AddToCartButtonProps) {
  const addItem = useCartStore((s) => s.addItem);
  const [added, setAdded] = useState(false);

  function handleAdd() {
    if (!size) return;
    addItem({
      variant_id: variantId,
      product_name: productName,
      color,
      size,
      qty: 1,
      price_snapshot: priceSnapshot,
      imagen,
    });
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  }

  const noSize = !size;

  return (
    <button
      onClick={handleAdd}
      disabled={disabled || noSize || added}
      style={{
        width: "100%",
        padding: "15px 20px",
        borderRadius: 14,
        border: "none",
        background: added ? "#5a9e6f" : noSize ? "#e0e0e0" : "#CD844D",
        color: noSize ? "#aaa" : "#fff",
        fontSize: 16,
        fontWeight: 700,
        cursor: disabled || noSize ? "not-allowed" : "pointer",
        transition: "background 0.2s",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
      }}
    >
      {added ? (
        <>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Agregado al carrito
        </>
      ) : noSize ? (
        "Seleccioná un talle"
      ) : (
        <>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="21" r="1" />
            <circle cx="20" cy="21" r="1" />
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
          </svg>
          Agregar al carrito
        </>
      )}
    </button>
  );
}
