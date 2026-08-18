"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  canonicalizeTransportName,
  getTransportesDisponibles,
  guardarTransporteElegido,
} from "@/lib/transport";
import {
  getTransportExplanationText,
  resolveShippingOptions,
} from "@/lib/transport/shipping-helpers";

const WHATSAPP_HREF = "https://wa.me/5493624118637";

interface OrderTransportConfirmModalProps {
  open: boolean;
  province?: string | null;
  city?: string | null;
  currentTransport?: string | null;
  onCancel: () => void;
  onConfirm: (transport: string) => void;
}

export function getOrderTransportConfirmKey(customerId: string) {
  return `fyl-nj-close-transport-confirmed:${customerId}`;
}

export default function OrderTransportConfirmModal({
  open,
  province,
  city,
  currentTransport,
  onCancel,
  onConfirm,
}: OrderTransportConfirmModalProps) {
  const [mounted, setMounted] = useState(false);
  const [selectedTransport, setSelectedTransport] = useState("");

  useEffect(() => setMounted(true), []);

  const shipping = useMemo(() => {
    const prov = String(province || "").trim();
    const locality = String(city || "").trim();
    const current = canonicalizeTransportName(currentTransport || "");

    if (!prov || !locality) {
      const fallback = current || "Correo Argentino";
      return {
        province: prov,
        city: locality,
        options: [fallback],
        recommended: fallback,
      };
    }

    const raw = getTransportesDisponibles(prov, locality);
    const resolved = resolveShippingOptions(prov, locality, raw);
    const options = resolved.opciones.length > 0 ? resolved.opciones : [current || "Correo Argentino"];
    const recommended = current && options.includes(current)
      ? current
      : canonicalizeTransportName(resolved.efectivo || options[0]);

    return {
      province: prov,
      city: locality,
      options,
      recommended: options.includes(recommended) ? recommended : options[0],
    };
  }, [city, currentTransport, province]);

  useEffect(() => {
    if (!open) return;
    setSelectedTransport(shipping.recommended);
  }, [open, shipping.recommended]);

  if (!mounted || !open) return null;

  const chosenTransport = shipping.options.includes(selectedTransport)
    ? selectedTransport
    : shipping.recommended;
  const hasMultipleOptions = shipping.options.length > 1;
  const locationLabel = shipping.city && shipping.province
    ? `${shipping.city}, ${shipping.province}`
    : "Tu localidad";

  function handleConfirm() {
    if (shipping.province && shipping.city && chosenTransport) {
      guardarTransporteElegido(shipping.province, shipping.city, chosenTransport);
    }
    onConfirm(chosenTransport);
  }

  return createPortal(
    <div className="profile-onboarding-modal-root" role="dialog" aria-modal="true" aria-labelledby="order-transport-title">
      <div className="profile-onboarding-card profile-onboarding-card--transport">
        <h2 id="order-transport-title" className="pom-title pom-title--center">
          Retiro/envío del pedido
        </h2>
        <p className="pom-sub pom-sub--center">
          Antes de cerrarlo, confirmá cómo vamos a preparar este pedido.
        </p>

        <div className="pom-location-card">
          <span className="pom-location-card__label">Localidad</span>
          <strong>{locationLabel}</strong>
        </div>

        <div className="pom-transport-panel">
          <div className="pom-transport-panel__header">
            <span>{hasMultipleOptions ? "Elegí una opción" : "Opción disponible"}</span>
          </div>
          <p className="pom-transport-panel__copy">
            {hasMultipleOptions
              ? "Seleccioná la opción que querés usar para este pedido."
              : `Para tu localidad corresponde ${chosenTransport}.`}
          </p>

          <div className="pom-transport-options" role="radiogroup" aria-label="Opciones de retiro o envío">
            {shipping.options.map((transport) => {
              const checked = transport === chosenTransport;
              return (
                <button
                  key={transport}
                  type="button"
                  className={`pom-transport-option${checked ? " is-selected" : ""}`}
                  onClick={() => setSelectedTransport(canonicalizeTransportName(transport))}
                  role="radio"
                  aria-checked={checked}
                >
                  <span className="pom-transport-option__main">
                    <span className="pom-transport-option__name">{transport}</span>
                    <span className="pom-transport-option__detail">
                      {getTransportExplanationText(transport)}
                    </span>
                  </span>
                  <span className="pom-transport-option__check" aria-hidden="true">
                    {checked ? "✓" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <a className="pom-whatsapp" href={WHATSAPP_HREF} target="_blank" rel="noopener noreferrer">
          Consultar por WhatsApp
        </a>

        <div className="active-order-sheet__actions active-order-sheet__actions--stack active-order-sheet__actions--flat">
          <button type="button" className="pom-submit" onClick={handleConfirm}>
            Continuar para cerrar pedido
          </button>
          <button type="button" className="active-order-btn active-order-btn--secondary active-order-btn--sheet-secondary" onClick={onCancel}>
            Volver
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
