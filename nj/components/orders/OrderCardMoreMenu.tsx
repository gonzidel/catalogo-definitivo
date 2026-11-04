"use client";

import { useEffect, useRef, useState } from "react";

interface OrderCardMoreMenuProps {
  alreadyMarked: boolean;
  busy?: boolean;
  onMarkInvalid: () => void | Promise<void>;
}

/**
 * Menú ⋮ junto al conteo de productos (Activos).
 * Por ahora solo "Número inválido".
 */
export default function OrderCardMoreMenu({
  alreadyMarked,
  busy = false,
  onMarkInvalid,
}: OrderCardMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div
      className="order-card__more"
      ref={rootRef}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="order-card__more-btn"
        aria-label="Más opciones del pedido"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
          setConfirming(false);
        }}
      >
        ⋯
      </button>
      {open ? (
        <div className="order-card__more-menu" role="menu">
          {!confirming ? (
            <button
              type="button"
              role="menuitem"
              className="order-card__more-item"
              disabled={busy || alreadyMarked}
              onClick={(event) => {
                event.stopPropagation();
                if (alreadyMarked) return;
                setConfirming(true);
              }}
            >
              {alreadyMarked ? "Número ya avisado" : "Número inválido"}
            </button>
          ) : (
            <div className="order-card__more-confirm">
              <p className="order-card__more-confirm-text">
                ¿Seguro que querés avisar que el número no es válido en WhatsApp?
              </p>
              <div className="order-card__more-confirm-actions">
                <button
                  type="button"
                  className="order-card__more-confirm-yes"
                  disabled={busy}
                  onClick={async (event) => {
                    event.stopPropagation();
                    await onMarkInvalid();
                    setConfirming(false);
                    setOpen(false);
                  }}
                >
                  Sí
                </button>
                <button
                  type="button"
                  className="order-card__more-confirm-no"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    setConfirming(false);
                  }}
                >
                  No
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
