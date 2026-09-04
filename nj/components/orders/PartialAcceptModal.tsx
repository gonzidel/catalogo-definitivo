"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  waitingLocalLabel,
  waitingLocalShortLabel,
} from "@/lib/orders/board-scope";
import { formatPriceAr } from "@/lib/orders/domain";
import { useOrdersStore } from "@/hooks/useOrders";
import type { AdminOrderItem } from "@/types/orders";
import ItemStatusBadge from "./ItemStatusBadge";
import OrderItemImageButton from "./OrderItemImageButton";

type UnitState = "picked" | "missing" | "waiting-fabrica" | "waiting-local";

interface PartialAcceptModalProps {
  item: AdminOrderItem;
  disabled?: boolean;
  onClose: () => void;
  onApply: (nPicked: number, nMissing: number, nFabrica: number, nLocal: number) => void;
}

/**
 * Panel de reparto por unidad para ítems reservados con más de 1 unidad del
 * mismo producto/talle. Desglosa el ítem en una fila por unidad — igual que
 * en la fila de la tarjeta (badge, lupa, precio, ✓/⏳/✕) — para que el admin
 * decida cada una por separado y aplique todo junto con un solo toque.
 */
export default function PartialAcceptModal({
  item,
  disabled = false,
  onClose,
  onApply,
}: PartialAcceptModalProps) {
  const qty = Math.max(1, Number(item.quantity) || 1);
  // Por defecto todas quedan "apartadas": el admin solo toca las que cambian.
  const [units, setUnits] = useState<UnitState[]>(() => Array.from({ length: qty }, () => "picked"));
  const [openSourcePickerIdx, setOpenSourcePickerIdx] = useState<number | null>(null);
  const boardScope = useOrdersStore((s) => s.boardScope);
  const localLabel = waitingLocalLabel(boardScope);
  const localShort = waitingLocalShortLabel(boardScope);
  const localSourceBtnClass =
    boardScope === "local_pickup"
      ? "order-partial-accept__source-btn--deposito"
      : "order-partial-accept__source-btn--local";

  const label = useMemo(
    () => `${item.product_name || "Producto"} · ${item.color || "-"} · ${item.size || "-"}`,
    [item]
  );

  const nPicked = units.filter((u) => u === "picked").length;
  const nMissing = units.filter((u) => u === "missing").length;
  const nFabrica = units.filter((u) => u === "waiting-fabrica").length;
  const nLocal = units.filter((u) => u === "waiting-local").length;

  const setUnit = (idx: number, state: UnitState) => {
    setUnits((prev) => prev.map((u, i) => (i === idx ? state : u)));
    setOpenSourcePickerIdx(null);
  };

  const toggleSourcePicker = (idx: number) => {
    setOpenSourcePickerIdx((cur) => (cur === idx ? null : idx));
  };

  const handleApply = () => {
    onApply(nPicked, nMissing, nFabrica, nLocal);
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="order-modal-backdrop order-modal-backdrop--item" role="presentation" onClick={onClose}>
      <div
        className="order-modal order-modal--compact order-partial-accept-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="partial-accept-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="order-modal__title" id="partial-accept-title">
          Repartir unidades
        </h3>
        <p className="order-modal__text">{label}</p>

        <ul className="order-card__items order-partial-accept__units">
          {units.map((state, idx) => {
            const isPicked = state === "picked";
            const isMissing = state === "missing";
            const isFabrica = state === "waiting-fabrica";
            const isLocal = state === "waiting-local";
            const isWaiting = isFabrica || isLocal;
            const badgeStatus = isMissing ? "missing" : isWaiting ? "waiting" : "picked";

            return (
              <li key={idx} className="order-card__item-row order-card__item-row--split">
                <div className="order-card__item-label">
                  <span className="order-card__item-name">
                    {item.product_name || "Producto"} · {item.color || "-"}
                  </span>
                  <span className="order-card__item-meta">
                    <span className="order-card__item-size-qty">
                      {item.size || "-"} · Unidad {idx + 1}/{qty}
                    </span>
                  </span>
                </div>
                <div className="order-card__item-actions">
                  <span className="order-card__item-cell order-card__item-cell--badge">
                    <ItemStatusBadge status={badgeStatus} compact />
                    {isFabrica ? <span className="order-partial-accept__source-tag">F</span> : null}
                    {isLocal ? <span className="order-partial-accept__source-tag">{localShort}</span> : null}
                  </span>
                  <span className="order-card__item-cell order-card__item-cell--lupa">
                    {item.isOffer ? (
                      <span className="order-card__item-offer-fire" title="Producto en oferta" aria-label="Producto en oferta">
                        🔥
                      </span>
                    ) : null}
                    <OrderItemImageButton item={item} disabled={disabled} />
                  </span>
                  <span className="order-card__item-cell order-card__item-cell--price">
                    {formatPriceAr(item.price_snapshot)}
                  </span>
                  <span className="order-card__item-cell order-card__item-cell--actions">
                    <div className="order-card__item-quick-actions">
                      <button
                        type="button"
                        className={`order-card__item-action order-card__item-action--pick${isPicked ? " order-card__item-action--staged-picked" : ""}`}
                        disabled={disabled}
                        aria-label="Apartar esta unidad"
                        title="Apartar"
                        onClick={() => setUnit(idx, "picked")}
                      >
                        ✓
                      </button>

                      {openSourcePickerIdx === idx ? (
                        <>
                          <button
                            type="button"
                            className="order-card__item-action order-partial-accept__source-btn order-partial-accept__source-btn--fabrica"
                            disabled={disabled}
                            aria-label="Espera de fábrica"
                            title="Fábrica"
                            onClick={() => setUnit(idx, "waiting-fabrica")}
                          >
                            F
                          </button>
                          <button
                            type="button"
                            className={`order-card__item-action order-partial-accept__source-btn ${localSourceBtnClass}`}
                            disabled={disabled}
                            aria-label={`Espera de ${localLabel.toLowerCase()}`}
                            title={localLabel}
                            onClick={() => setUnit(idx, "waiting-local")}
                          >
                            {localShort}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={`order-card__item-action order-card__item-action--wait${isWaiting ? " order-card__item-action--staged-waiting" : ""}`}
                          disabled={disabled}
                          aria-label="Marcar en espera esta unidad"
                          title="En espera"
                          onClick={() => toggleSourcePicker(idx)}
                        >
                          {isFabrica ? "F" : isLocal ? localShort : "⏳"}
                        </button>
                      )}

                      <button
                        type="button"
                        className={`order-card__item-action order-card__item-action--missing${isMissing ? " order-card__item-action--staged-missing" : ""}`}
                        disabled={disabled}
                        aria-label="Marcar sin stock esta unidad"
                        title="Sin stock"
                        onClick={() => setUnit(idx, "missing")}
                      >
                        ✕
                      </button>
                    </div>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="order-partial-accept__summary">
          Apartados: {nPicked} · Espera fábrica: {nFabrica} · Espera {localLabel.toLowerCase()}: {nLocal} · Sin stock:{" "}
          {nMissing}
        </p>

        <div className="order-modal__actions">
          <button type="button" className="order-card__btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="order-card__btn order-card__btn--primary"
            disabled={disabled}
            onClick={handleApply}
          >
            Aplicar
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
