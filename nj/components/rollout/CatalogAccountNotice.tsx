"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { NOTICE_COOKIE } from "@/lib/rollout/constants";
import { clearCookie, readCookie } from "@/lib/rollout/client";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useExperience } from "@/hooks/useExperience";
import WhatsAppButton from "@/components/contact/WhatsAppButton";

export const CATALOG_ACCOUNT_EVENT = "fyl:catalog-account";

/** Avatar en catalog: muestra la cuenta y permite cerrar sesión (no hay /dashboard). */
export function openCatalogAccount() {
  window.dispatchEvent(new Event(CATALOG_ACCOUNT_EVENT));
}

type View = "login" | "account";

/**
 * catalog con sesión iniciada. `login`: aviso único tras el login (cookie del callback).
 * `account`: al tocar el avatar. Sin detalles internos.
 */
export default function CatalogAccountNotice() {
  const experience = useExperience();
  const [view, setView] = useState<View | null>(null);
  const [accountLabel, setAccountLabel] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (experience !== "catalog") return;
    if (readCookie(NOTICE_COOKIE)) {
      clearCookie(NOTICE_COOKIE);
      setView("login");
    }
    const showAccount = () => {
      void getSupabaseBrowserClient()
        .auth.getSession()
        .then(({ data }: { data: { session: Session | null } }) => {
          const user = data.session?.user;
          const meta = (user?.user_metadata ?? {}) as Record<string, string | undefined>;
          setAccountLabel(meta.full_name ?? meta.name ?? user?.email ?? "");
          setView("account");
        });
    };
    window.addEventListener(CATALOG_ACCOUNT_EVENT, showAccount);
    return () => window.removeEventListener(CATALOG_ACCOUNT_EVENT, showAccount);
  }, [experience]);

  async function handleLogout() {
    setLoggingOut(true);
    await getSupabaseBrowserClient().auth.signOut();
    setLoggingOut(false);
    setView(null);
  }

  if (experience !== "catalog" || !view) return null;

  const close = (
    <button
      type="button"
      className="account-notice__close"
      onClick={() => setView(null)}
      aria-label="Cerrar aviso"
    >
      ×
    </button>
  );

  if (view === "account") {
    return (
      <div className="account-notice" role="dialog" aria-label="Tu cuenta">
        <p className="account-notice__text">
          Tu cuenta{accountLabel ? <>: <strong>{accountLabel}</strong></> : null}
        </p>
        <div className="account-notice__actions">
          <button
            type="button"
            className="account-notice__cta account-notice__cta--secondary"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
          </button>
          {close}
        </div>
      </div>
    );
  }

  return (
    <div className="account-notice" role="status">
      <p className="account-notice__text">
        ¡Listo, ya ingresaste! 👋 Podés seguir viendo el catálogo y consultarnos por WhatsApp cuando quieras.
      </p>
      <div className="account-notice__actions">
        <WhatsAppButton variant="notice" className="account-notice__cta">
          Escribinos
        </WhatsAppButton>
        {close}
      </div>
    </div>
  );
}
