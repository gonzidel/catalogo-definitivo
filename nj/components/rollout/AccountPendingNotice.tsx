"use client";

import { useEffect, useState } from "react";
import { NOTICE_COOKIE } from "@/lib/rollout/constants";
import { clearCookie, readCookie } from "@/lib/rollout/client";
import { useExperience } from "@/hooks/useExperience";
import WhatsAppButton from "@/components/contact/WhatsAppButton";

export const ACCOUNT_PENDING_EVENT = "fyl:account-pending";

export function openAccountPendingNotice() {
  window.dispatchEvent(new Event(ACCOUNT_PENDING_EVENT));
}

/** Cuenta logueada que sigue en catalog: aviso breve, sin detalles internos. */
export default function AccountPendingNotice() {
  const experience = useExperience();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (experience !== "catalog") return;
    if (readCookie(NOTICE_COOKIE)) {
      clearCookie(NOTICE_COOKIE);
      setOpen(true);
    }
    const show = () => setOpen(true);
    window.addEventListener(ACCOUNT_PENDING_EVENT, show);
    return () => window.removeEventListener(ACCOUNT_PENDING_EVENT, show);
  }, [experience]);

  if (experience !== "catalog" || !open) return null;

  return (
    <div className="account-notice" role="status">
      <p className="account-notice__text">
        ¡Listo, ya ingresaste! 👋 Podés seguir viendo el catálogo y consultarnos por WhatsApp cuando quieras.
      </p>
      <div className="account-notice__actions">
        <WhatsAppButton variant="notice" className="account-notice__cta">
          Escribinos
        </WhatsAppButton>
        <button
          type="button"
          className="account-notice__close"
          onClick={() => setOpen(false)}
          aria-label="Cerrar aviso"
        >
          ×
        </button>
      </div>
    </div>
  );
}
