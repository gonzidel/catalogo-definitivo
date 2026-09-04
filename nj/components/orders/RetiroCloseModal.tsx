"use client";

import { useMemo, useState } from "react";
import {
  formatPriceAr,
  getOrderDisplayNumber,
} from "@/lib/orders/domain";
import {
  finalizeRetiroOrderSale,
  getRetiroSaleTotals,
  type RetiroPayMethod,
} from "@/lib/orders/retiro-finalize-sale";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { AdminOrder } from "@/types/orders";

type Step = "method" | "cash" | "card";

interface RetiroCloseModalProps {
  order: AdminOrder;
  busy?: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

export default function RetiroCloseModal({
  order,
  busy = false,
  onClose,
  onDone,
  onError,
}: RetiroCloseModalProps) {
  const [step, setStep] = useState<Step>("method");
  const [surchargePct, setSurchargePct] = useState("0");
  const [submitting, setSubmitting] = useState(false);

  const pctNum = Math.max(0, Number(String(surchargePct).replace(",", ".")) || 0);
  const cashTotals = useMemo(() => getRetiroSaleTotals(order, 0), [order]);
  const cardTotals = useMemo(
    () => getRetiroSaleTotals(order, pctNum),
    [order, pctNum]
  );

  const orderLabel = getOrderDisplayNumber(order);
  const locked = busy || submitting;

  async function handlePrint(method: RetiroPayMethod) {
    if (locked) return;
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const result = await finalizeRetiroOrderSale(
        supabase,
        order,
        method,
        method === "Tarjeta" ? pctNum : 0
      );
      const creditNote =
        result.creditUsed > 0
          ? ` · crédito ${formatPriceAr(result.creditUsed)}`
          : "";
      onDone(
        `Venta ${result.saleNumber} · ${formatPriceAr(result.total)}${creditNote} · pedido cerrado`
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "No se pudo finalizar la venta";
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="order-modal-backdrop"
      role="presentation"
      onClick={() => {
        if (!locked) onClose();
      }}
    >
      <div
        className="order-modal order-modal--retiro-close"
        role="dialog"
        aria-labelledby={`retiro-close-${order.id}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="order-modal__title" id={`retiro-close-${order.id}`}>
          {step === "method"
            ? "Cerrar pedido"
            : step === "cash"
              ? "Cobro en efectivo"
              : "Cobro con tarjeta"}
        </h3>
        <p className="order-modal__text">Pedido {orderLabel}</p>

        {step === "method" ? (
          <>
            <p className="order-modal__text">¿Cómo paga?</p>
            <div className="order-modal__payment-options">
              <button
                type="button"
                className="order-modal__payment-btn order-modal__payment-btn--green"
                disabled={locked}
                onClick={() => setStep("cash")}
              >
                <CashIcon />
                Efectivo
              </button>
              <button
                type="button"
                className="order-modal__payment-btn order-modal__payment-btn--yellow"
                disabled={locked}
                onClick={() => setStep("card")}
              >
                <CardIcon />
                Tarjeta
              </button>
            </div>
            <div className="order-modal__actions">
              <button
                type="button"
                className="order-card__btn"
                disabled={locked}
                onClick={onClose}
              >
                Cancelar
              </button>
            </div>
          </>
        ) : null}

        {step === "cash" ? (
          <>
            <div className="retiro-close-summary">
              <div className="retiro-close-summary__row">
                <span>Productos</span>
                <strong>
                  {cashTotals.productUnits} unidad
                  {cashTotals.productUnits !== 1 ? "es" : ""}
                </strong>
              </div>
              <div className="retiro-close-summary__row retiro-close-summary__row--total">
                <span>Total a cobrar</span>
                <strong>{formatPriceAr(cashTotals.total)}</strong>
              </div>
            </div>
            <div className="order-modal__actions order-modal__actions--retiro">
              <button
                type="button"
                className="order-card__btn"
                disabled={locked}
                onClick={onClose}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn"
                disabled={locked}
                onClick={() => setStep("method")}
              >
                Volver
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={locked || cashTotals.total <= 0}
                onClick={() => void handlePrint("Efectivo")}
              >
                {submitting ? "Procesando…" : "Imprimir"}
              </button>
            </div>
          </>
        ) : null}

        {step === "card" ? (
          <>
            <label className="retiro-close-surcharge">
              <span>Recargo (%)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                inputMode="decimal"
                value={surchargePct}
                disabled={locked}
                onChange={(e) => setSurchargePct(e.target.value)}
                className="retiro-close-surcharge__input"
              />
            </label>
            <div className="retiro-close-summary">
              <div className="retiro-close-summary__row">
                <span>Subtotal</span>
                <strong>{formatPriceAr(cardTotals.subtotal)}</strong>
              </div>
              <div className="retiro-close-summary__row">
                <span>
                  Recargo
                  {cardTotals.surchargePct > 0
                    ? ` (${cardTotals.surchargePct}%)`
                    : ""}
                </span>
                <strong>{formatPriceAr(cardTotals.surchargeAmount)}</strong>
              </div>
              <div className="retiro-close-summary__row retiro-close-summary__row--total">
                <span>Total a cobrar</span>
                <strong>{formatPriceAr(cardTotals.total)}</strong>
              </div>
            </div>
            <div className="order-modal__actions order-modal__actions--retiro">
              <button
                type="button"
                className="order-card__btn"
                disabled={locked}
                onClick={onClose}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="order-card__btn"
                disabled={locked}
                onClick={() => setStep("method")}
              >
                Volver
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary"
                disabled={locked || cardTotals.total <= 0}
                onClick={() => void handlePrint("Tarjeta")}
              >
                {submitting ? "Procesando…" : "Imprimir"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  );
}
