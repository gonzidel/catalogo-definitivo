"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatPhoneE164,
  formatPhoneInput,
  phoneToLocalInput,
  validatePhone,
} from "@/lib/phone/ar-mobile";
import {
  clearWhatsappInvalidSnooze,
  snoozeWhatsappInvalid,
} from "@/lib/phone/whatsapp-invalid-snooze";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { rpcCustomerFixPhoneClearWhatsappInvalid } from "@/lib/supabase/whatsapp-invalid";

interface WhatsAppInvalidModalProps {
  open: boolean;
  customerId: string;
  currentPhone: string | null;
  onDismissed: () => void;
  onFixed: (newPhone: string) => void;
}

export default function WhatsAppInvalidModal({
  open,
  customerId,
  currentPhone,
  onDismissed,
  onFixed,
}: WhatsAppInvalidModalProps) {
  const [mounted, setMounted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) {
      setEditing(false);
      setError(null);
      setSaving(false);
      return;
    }
    setPhone(phoneToLocalInput(currentPhone));
  }, [open, currentPhone]);

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, [open]);

  if (!mounted || !open) return null;

  async function handleSave() {
    setError(null);
    const raw = phone.replace(/\s|-/g, "").trim();
    if (!validatePhone(raw)) {
      setError("Ingresá un celular válido (código de área + número).");
      return;
    }
    const formatted = formatPhoneE164(raw);
    setSaving(true);
    try {
      const supabase = getSupabaseBrowserClient();
      await rpcCustomerFixPhoneClearWhatsappInvalid(supabase, formatted);
      clearWhatsappInvalidSnooze(customerId);
      onFixed(formatted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    snoozeWhatsappInvalid(customerId);
    onDismissed();
  }

  const node = (
    <div
      className="profile-onboarding-modal-root wi-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wi-title"
    >
      <div className="profile-onboarding-card wi-card">
        {!editing ? (
          <>
            <h2 id="wi-title" className="pom-title">
              Número de WhatsApp
            </h2>
            <p className="pom-sub">
              Tu número no aparece como válido en WhatsApp. Corregilo para que
              podamos avisarte sobre el estado de tu pedido.
            </p>
            {currentPhone ? (
              <p className="wi-current">
                Número cargado: <strong>{currentPhone}</strong>
              </p>
            ) : null}
            <div className="wi-actions">
              <button
                type="button"
                className="pom-submit"
                onClick={() => setEditing(true)}
              >
                Editar número
              </button>
              <button
                type="button"
                className="wi-btn-secondary"
                onClick={handleCancel}
              >
                Cancelar
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="wi-title" className="pom-title">
              Corregir número
            </h2>
            <p className="pom-sub">
              El número que usó es:{" "}
              <strong>{currentPhone || "—"}</strong>
            </p>
            <label className="pom-label" htmlFor="wi-phone">
              Teléfono nuevo <span className="pom-req">*</span>
            </label>
            <div className="pom-phone-row">
              <span className="pom-phone-prefix">+54 9</span>
              <input
                id="wi-phone"
                className="pom-input pom-phone-input"
                value={phone}
                onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                autoComplete="tel"
                inputMode="tel"
                disabled={saving}
              />
            </div>
            <p className="pom-hint">Código de área + número (sin el 9 inicial).</p>
            {error ? <p className="pom-error">{error}</p> : null}
            <div className="wi-actions">
              <button
                type="button"
                className="pom-submit"
                disabled={saving}
                onClick={() => void handleSave()}
              >
                {saving ? "Guardando…" : "Aceptar"}
              </button>
              <button
                type="button"
                className="wi-btn-secondary"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setError(null);
                  setPhone(phoneToLocalInput(currentPhone));
                }}
              >
                Cancelar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
