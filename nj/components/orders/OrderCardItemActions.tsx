"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  waitingLocalLabel as waitingLocalLabelForScope,
  waitingLocalShortLabel,
} from "@/lib/orders/board-scope";
import type { DraftChangeKind } from "@/lib/orders/draft-changes";
import { useOrdersStore } from "@/hooks/useOrders";

interface OrderCardItemActionsProps {
  orderId: string;
  itemId: string;
  disabled?: boolean;
  variant?: "active" | "waiting-pick";
  /** Variante + talle del ítem, para poder consultar/ajustar existencias al marcar "sin stock". */
  variantId?: string | null;
  size?: string | null;
  /** Retiro local diferido: solo apartar o sin stock, sin "En espera". */
  hideWaitingAction?: boolean;
  /** Controla el panel "Origen de espera" desde el padre, para que solo uno esté abierto a la vez */
  waitingPanelOpen?: boolean;
  onToggleWaitingPanel?: () => void;
  onCloseWaitingPanel?: () => void;
  onMarkMissing: (orderId: string, itemId: string) => Promise<void>;
  onMarkPicked: (orderId: string, itemId: string) => Promise<void>;
  onMarkWaiting: (
    orderId: string,
    itemId: string,
    source: "fabrica" | "local"
  ) => Promise<void>;
  /** Consulta existencias web de variante+talle antes de confirmar "sin stock". */
  getVariantSizeStockQty?: (variantId: string, size: string) => Promise<number>;
  /** Lleva a 0 el stock de esa variante+talle (admin eligió "Sí, quitar el stock"). */
  onZeroStock?: (variantId: string, size: string, itemId?: string | null) => Promise<void>;
  /**
   * Modo borrador (mobile / Retiro): tocar los botones no aplica nada, solo marca el
   * cambio pendiente (color) hasta que se confirme desde la barra del pedido.
   */
  draftMode?: boolean;
  draftKind?: DraftChangeKind | null;
  onStagePicked?: () => void;
  onStageWaiting?: (source: "fabrica" | "local") => void;
  onStageMissing?: () => void;
  /**
   * Si devuelve true, el padre ya abrió otro flujo (p. ej. «Repartir unidades»
   * para ítems multi-unidad) y no hay que stagear ni abrir el confirm de missing.
   */
  onRequestMissing?: () => boolean;
}

export default function OrderCardItemActions({
  orderId,
  itemId,
  disabled = false,
  variant = "active",
  variantId = null,
  size = null,
  hideWaitingAction = false,
  waitingPanelOpen = false,
  onToggleWaitingPanel,
  onCloseWaitingPanel,
  onMarkMissing,
  onMarkPicked,
  onMarkWaiting,
  getVariantSizeStockQty,
  onZeroStock,
  draftMode = false,
  draftKind = null,
  onStagePicked,
  onStageWaiting,
  onStageMissing,
  onRequestMissing,
}: OrderCardItemActionsProps) {
  const [missingOpen, setMissingOpen] = useState(false);
  const [zeroStockPrompt, setZeroStockPrompt] = useState<number | null>(null);
  const [zeroStockBusy, setZeroStockBusy] = useState(false);
  const boardScope = useOrdersStore((s) => s.boardScope);
  const waitingLocalLabel = waitingLocalLabelForScope(boardScope);
  const waitingLocalShort = waitingLocalShortLabel(boardScope);
  const waitingLocalBtnClass =
    boardScope === "local_pickup"
      ? "order-card__btn--waiting-deposito"
      : "order-card__btn--waiting-local";

  /**
   * Consulta existencias ANTES de marcar "sin stock".
   * Si hay stock en la web, muestra Sí/No (quitar stock o dejarlo) y aplica
   * el mark missing al responder — así el modal no se pierde cuando el pedido
   * cambia de columna al quedar missing.
   */
  const handleMissing = async () => {
    setMissingOpen(false);

    if (variantId && size && getVariantSizeStockQty) {
      try {
        const stock = await getVariantSizeStockQty(variantId, size);
        if (stock > 0) {
          setZeroStockPrompt(stock);
          return;
        }
      } catch {
        // Si falla la consulta, sigue igual y marca missing.
      }
    }

    await onMarkMissing(orderId, itemId);
  };

  /** No: marca sin stock y deja las existencias de la web como están. */
  const handleZeroStockNo = async () => {
    setZeroStockBusy(true);
    try {
      await onMarkMissing(orderId, itemId);
    } finally {
      setZeroStockBusy(false);
      setZeroStockPrompt(null);
    }
  };

  /** Sí: marca sin stock y pone a 0 las existencias de esa variante+talle. */
  const handleZeroStockYes = async () => {
    setZeroStockBusy(true);
    try {
      await onMarkMissing(orderId, itemId);
      if (variantId && size && onZeroStock) {
        await onZeroStock(variantId, size, itemId);
      }
    } finally {
      setZeroStockBusy(false);
      setZeroStockPrompt(null);
    }
  };

  const stagedPicked = draftMode && draftKind === "picked";
  const stagedWaitingFabrica = draftMode && draftKind === "waiting-fabrica";
  const stagedWaitingLocal = draftMode && draftKind === "waiting-local";
  const stagedWaiting = stagedWaitingFabrica || stagedWaitingLocal;
  const stagedMissing = draftMode && draftKind === "missing";

  const handlePickClick = () => {
    // Siempre pasa por el padre: ahí se intercepta multi-unidad («Repartir
    // unidades») y, si no aplica, el propio padre stagea en draftMode o llama RPC.
    void onMarkPicked(orderId, itemId);
  };

  const handleMissingClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (onRequestMissing?.()) return;
    if (draftMode) {
      onStageMissing?.();
      return;
    }
    setMissingOpen(true);
  };

  const handleWaitingSourceClick = (source: "fabrica" | "local") => {
    onCloseWaitingPanel?.();
    if (draftMode) {
      onStageWaiting?.(source);
      return;
    }
    void onMarkWaiting(orderId, itemId, source);
  };

  return (
    <>
      <div className="order-card__item-quick-actions">
        <button
          type="button"
          className={`order-card__item-action order-card__item-action--pick${variant === "waiting-pick" ? " order-card__item-action--pick-large" : ""}${stagedPicked ? " order-card__item-action--staged-picked" : ""}`}
          disabled={disabled}
          aria-label="Marcar como apartado"
          title="Apartar"
          onClick={handlePickClick}
        >
          ✓
        </button>

        {variant === "active" && !hideWaitingAction ? (
          <span className="order-card__waiting-anchor">
            <button
              type="button"
              className={`order-card__item-action order-card__item-action--wait${stagedWaiting ? " order-card__item-action--staged-waiting" : ""}`}
              disabled={disabled}
              aria-label="Marcar en espera"
              title="En espera"
              onClick={(event) => {
                event.stopPropagation();
                onToggleWaitingPanel?.();
              }}
            >
              {stagedWaitingFabrica ? "F" : stagedWaitingLocal ? waitingLocalShort : "⏳"}
            </button>

            {waitingPanelOpen ? (
              <>
                <span
                  className="order-card__waiting-popover-catcher"
                  role="presentation"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseWaitingPanel?.();
                  }}
                />
                <span
                  className="order-card__waiting-popover"
                  role="dialog"
                  aria-label="Origen de espera"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="order-card__waiting-popover-close"
                    aria-label="Cerrar"
                    onClick={() => onCloseWaitingPanel?.()}
                  >
                    ×
                  </button>
                  <span className="order-card__waiting-popover-actions">
                    <button
                      type="button"
                      className="order-card__btn order-card__btn--waiting-fabrica"
                      disabled={disabled}
                      onClick={() => handleWaitingSourceClick("fabrica")}
                    >
                      Fábrica
                    </button>
                    <button
                      type="button"
                      className={`order-card__btn ${waitingLocalBtnClass}`}
                      disabled={disabled}
                      onClick={() => handleWaitingSourceClick("local")}
                    >
                      {waitingLocalLabel}
                    </button>
                  </span>
                </span>
              </>
            ) : null}
          </span>
        ) : null}

        <button
          type="button"
          className={`order-card__item-action order-card__item-action--missing${variant === "waiting-pick" ? " order-card__item-action--missing-large" : ""}${stagedMissing ? " order-card__item-action--staged-missing" : ""}`}
          disabled={disabled}
          aria-label="Marcar sin stock"
          title="Sin stock"
          onClick={handleMissingClick}
        >
          ✕
        </button>
      </div>

      {missingOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="order-modal-backdrop order-modal-backdrop--item"
              role="presentation"
              onClick={() => setMissingOpen(false)}
            >
              <div
                className="order-modal order-modal--compact"
                role="dialog"
                aria-labelledby="missing-item-title"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="order-modal__title" id="missing-item-title">
                  Sin stock
                </h3>
                <p className="order-modal__text">
                  ¿Marcar este producto como sin stock? La clienta lo verá en su pedido para
                  quitarlo o cambiarlo.
                </p>
                <div className="order-modal__actions order-modal__actions--big">
                  <button
                    type="button"
                    className="order-card__btn"
                    onClick={() => setMissingOpen(false)}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="order-card__btn order-card__btn--danger"
                    disabled={disabled}
                    onClick={() => void handleMissing()}
                  >
                    Sin stock
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {zeroStockPrompt !== null && typeof document !== "undefined"
        ? createPortal(
            <div
              className="order-modal-backdrop order-modal-backdrop--item"
              role="presentation"
              onClick={() => {
                if (!zeroStockBusy) setZeroStockPrompt(null);
              }}
            >
              <div
                className="order-modal order-modal--compact"
                role="dialog"
                aria-labelledby="zero-stock-title"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="order-modal__title" id="zero-stock-title">
                  ¿Quitar el stock de la web?
                </h3>
                <p className="order-modal__text">
                  En la web todavía figuran <strong>{zeroStockPrompt}</strong> en existencia de
                  este producto (talle {size}).
                  <br />
                  Como no hay stock real, ¿querés poner esas existencias en 0?
                </p>
                <div className="order-modal__actions order-modal__actions--big">
                  <button
                    type="button"
                    className="order-card__btn"
                    disabled={zeroStockBusy}
                    onClick={() => void handleZeroStockNo()}
                  >
                    No
                  </button>
                  <button
                    type="button"
                    className="order-card__btn order-card__btn--danger"
                    disabled={zeroStockBusy}
                    onClick={() => void handleZeroStockYes()}
                  >
                    {zeroStockBusy ? "Aplicando…" : "Sí, quitar el stock"}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
