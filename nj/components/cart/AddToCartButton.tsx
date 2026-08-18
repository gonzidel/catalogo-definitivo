"use client";

import { useState } from "react";
import { useCartStore } from "@/store/cart";

interface AddToCartButtonProps {
  variantId: string;
  productName: string;
  color: string;
  size: string | null;
  priceSnapshot: number;
  isOffer?: boolean;
  imagen?: string;
  disabled?: boolean;
}

export default function AddToCartButton({
  variantId,
  productName,
  color,
  size,
  priceSnapshot,
  isOffer = false,
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
      is_offer: isOffer,
      imagen,
    });
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  }

  const noSize = !size;

  return (
    <button
      type="button"
      onClick={handleAdd}
      disabled={disabled || noSize || added}
      className={[
        "add-to-cart-btn",
        added ? "is-added" : "",
        noSize || disabled ? "is-disabled" : "",
      ]
        .filter(Boolean)
        .join(" ")}
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
