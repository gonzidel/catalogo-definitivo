"use client";

import { createPortal } from "react-dom";

interface ZeroStockPromptProps {
  /** Existencias que figuran hoy en la web para esa variante + talle. */
  stock: number;
  size?: string | null;
  busy?: boolean;
  /** Modo borrador: la decisión queda marcada y se aplica recién al confirmar el pedido. */
  deferred?: boolean;
  /** "No": marca sin stock y deja las existencias como están. */
  onNo: () => void;
  /** "Sí": marca sin stock y lleva a 0 todo el stock de ese talle. */
  onYes: () => void;
  onClose: () => void;
}

/** Aviso "¿Quitar el stock de la web?" al marcar un producto sin stock. */
export default function ZeroStockPrompt({
  stock,
  size = null,
  busy = false,
  deferred = false,
  onNo,
  onYes,
  onClose,
}: ZeroStockPromptProps) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="order-modal-backdrop order-modal-backdrop--item"
      role="presentation"
      onClick={(event) => {
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <div
        className="order-modal order-modal--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby="zero-stock-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="order-modal__title" id="zero-stock-title">
          ¿Quitar el stock de la web?
        </h3>
        <p className="order-modal__text">
          En la web todavía figuran <strong>{stock}</strong> en existencia de este producto
          (talle {size}).
          <br />
          Como no hay stock real, ¿querés poner esas existencias en 0?
          {deferred ? (
            <>
              <br />
              Se aplica al confirmar el pedido.
            </>
          ) : null}
        </p>
        <div className="order-modal__actions order-modal__actions--big">
          <button type="button" className="order-card__btn" disabled={busy} onClick={onNo}>
            No
          </button>
          <button
            type="button"
            className="order-card__btn order-card__btn--danger"
            disabled={busy}
            onClick={onYes}
          >
            {busy ? "Aplicando…" : "Sí, quitar el stock"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
