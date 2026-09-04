"use client";

import { useEffect, useState } from "react";
import { buildPaymentConfirmedMessage } from "@/lib/orders/closed-order-messages";
import { buildWhatsAppUrl } from "@/lib/orders/domain";
import { usePaymentPendingStore } from "@/lib/orders/payment-pending-notifications";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function PaymentCard({
  customerName,
  phone,
  onCopyMessage,
  onAccept,
  onSendAndAccept,
}: {
  customerName: string;
  phone: string | null;
  onCopyMessage: () => void;
  onAccept: () => void;
  onSendAndAccept: () => void;
}) {
  const waEmpty = buildWhatsAppUrl(phone);

  return (
    <article className="order-payments__card">
      <p className="order-payments__card-name">{customerName}</p>
      {phone && waEmpty ? (
        <a
          className="order-payments__card-phone"
          href={waEmpty}
          target="_blank"
          rel="noopener noreferrer"
        >
          {phone}
        </a>
      ) : (
        <span className="order-payments__card-phone order-payments__card-phone--muted">
          Sin teléfono
        </span>
      )}
      <div className="order-payments__card-actions">
        <button type="button" className="order-payments__btn" onClick={onCopyMessage}>
          Mensaje
        </button>
        <button type="button" className="order-payments__btn order-payments__btn--accept" onClick={onAccept}>
          Aceptar
        </button>
        <button
          type="button"
          className="order-payments__btn order-payments__btn--primary"
          disabled={!phone}
          onClick={onSendAndAccept}
        >
          Enviar y aceptar
        </button>
      </div>
    </article>
  );
}

interface OrderPaymentsPanelProps {
  open: boolean;
  onClose: () => void;
}

/** Panel de pagos pendientes de confirmación (transferencias). */
export default function OrderPaymentsPanel({ open, onClose }: OrderPaymentsPanelProps) {
  const hydrate = usePaymentPendingStore((s) => s.hydrate);
  const subscribeRealtime = usePaymentPendingStore((s) => s.subscribeRealtime);
  const payments = usePaymentPendingStore((s) => s.payments);
  const confirmPayment = usePaymentPendingStore((s) => s.confirmPayment);

  useEffect(() => {
    void hydrate();
    const unsub = subscribeRealtime();
    return unsub;
  }, [hydrate, subscribeRealtime]);

  const paymentMessage = buildPaymentConfirmedMessage();

  const handleCopyMessage = async () => {
    await copyText(paymentMessage);
  };

  const handleAccept = async (orderId: string) => {
    await confirmPayment(orderId);
  };

  const handleSendAndAccept = async (orderId: string, phone: string | null) => {
    await copyText(paymentMessage);
    await confirmPayment(orderId);
    const url = buildWhatsAppUrl(phone, paymentMessage);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  if (!open) return null;

  return (
    <>
      <div
        className="order-payments__backdrop"
        role="presentation"
        onClick={onClose}
      />
      <div className="order-payments__panel" role="dialog" aria-label="Pagos pendientes">
        <div className="order-payments__panel-head">
          <h2 className="order-payments__panel-title">Pagos</h2>
          <button
            type="button"
            className="order-payments__panel-close"
            aria-label="Cerrar panel"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {payments.length === 0 ? (
          <p className="order-payments__empty">Sin pagos pendientes de confirmar</p>
        ) : (
          <div className="order-payments__list">
            {payments.map((payment) => (
              <PaymentCard
                key={payment.id}
                customerName={payment.customerName}
                phone={payment.phone}
                onCopyMessage={() => void handleCopyMessage()}
                onAccept={() => void handleAccept(payment.orderId)}
                onSendAndAccept={() =>
                  void handleSendAndAccept(payment.orderId, payment.phone)
                }
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Hook para contador de pagos pendientes en header/menú. */
export function usePaymentPendingCount(): number {
  const hydrate = usePaymentPendingStore((s) => s.hydrate);
  const subscribeRealtime = usePaymentPendingStore((s) => s.subscribeRealtime);
  const count = usePaymentPendingStore((s) => s.payments.length);

  useEffect(() => {
    void hydrate();
    const unsub = subscribeRealtime();
    return unsub;
  }, [hydrate, subscribeRealtime]);

  return count;
}
