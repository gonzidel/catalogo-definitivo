"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { lightboxImageUrl } from "@/lib/cloudinary";
import { isSpecialExtraItem } from "@/lib/orders/domain";
import { fetchOrderItemImageUrl } from "@/lib/supabase/order-item-image";

export type OrderItemImageSource = {
  imagen?: string | null;
  variant_id?: string | null;
  product_name?: string | null;
  color?: string | null;
  size?: string | null;
  is_special_extra?: boolean | null;
};

interface OrderItemImageButtonProps {
  item: OrderItemImageSource;
  disabled?: boolean;
}

export default function OrderItemImageButton({ item, disabled = false }: OrderItemImageButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  if (isSpecialExtraItem(item)) return null;

  const handleOpen = async () => {
    if (disabled || loading) return;
    setOpen(true);
    setLoading(true);
    setFailed(false);
    setImageUrl(null);
    try {
      const src = await fetchOrderItemImageUrl(item);
      if (src) {
        setImageUrl(lightboxImageUrl(src));
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const label = item.product_name || "Producto";

  return (
    <>
      <button
        type="button"
        className="order-item-image-btn"
        disabled={disabled}
        aria-label={`Ver imagen de ${label}`}
        title="Ver imagen"
        onClick={() => void handleOpen()}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="order-modal-backdrop order-modal-backdrop--stack"
              role="presentation"
              onClick={() => setOpen(false)}
            >
              <div
                className="order-item-image-preview"
                role="dialog"
                aria-label={`Imagen de ${label}`}
                onClick={(e) => e.stopPropagation()}
              >
                {loading ? (
                  <p className="order-item-image-preview__status">Cargando imagen…</p>
                ) : failed || !imageUrl ? (
                  <p className="order-item-image-preview__status">Sin imagen disponible</p>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="order-item-image-preview__img"
                    src={imageUrl}
                    alt={label}
                    decoding="async"
                  />
                )}
                <button
                  type="button"
                  className="order-card__btn order-item-image-preview__close"
                  onClick={() => setOpen(false)}
                >
                  Cerrar
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
