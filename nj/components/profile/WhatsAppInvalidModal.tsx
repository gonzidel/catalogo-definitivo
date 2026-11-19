"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatPhoneLocalDisplay,
  formatPhoneStored,
  isSameArgentinaPhone,
  phoneForDisplay,
  sanitizePhoneInput,
  validateArgentinaPhone,
} from "@/lib/utils/phone-ar";
import {
  clearWhatsappInvalidSnooze,
  snoozeWhatsappInvalid,
} from "@/lib/phone/whatsapp-invalid-snooze";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { rpcCustomerFixPhoneClearWhatsappInvalid } from "@/lib/supabase/whatsapp-invalid";

/** Precarga el número actual solo si es un celular completo; si está mal armado, se empieza vacío. */
function initialPhoneInput(currentPhone: string | null): string {
  const shown = phoneForDisplay(currentPhone);
  return validateArgentinaPhone(shown).ok ? shown : "";
}

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
    setPhone(initialPhoneInput(currentPhone));
  }, [open, currentPhone]);

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, [open]);

  if (!mounted || !open) return null;

  async function handleSave() {
    setError(null);
    const check = validateArgentinaPhone(phone);
    if (!check.ok) {
      setError(check.error ?? "Ingresá un celular válido.");
      return;
    }
    // Si el número no cambió, el aviso no se limpia (el trigger solo reacciona a un phone distinto).
    if (isSameArgentinaPhone(currentPhone, phone)) {
      setError("Es el mismo número que tenés cargado. Corregilo para que podamos avisarte.");
      return;
    }
    // El prefijo interno "+54 9" se agrega solo acá; el cliente nunca lo ve.
    const formatted = formatPhoneStored(check.digits);
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
                Número cargado: <strong>{phoneForDisplay(currentPhone)}</strong>
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
              <strong>{phoneForDisplay(currentPhone) || "—"}</strong>
            </p>
            <label className="pom-label" htmlFor="wi-phone">
              Teléfono nuevo <span className="pom-req">*</span>
            </label>
            <input
              id="wi-phone"
              className="pom-input"
              type="tel"
              value={phone}
              onChange={(e) => {
                setPhone(sanitizePhoneInput(e.target.value));
                if (error) setError(null);
              }}
              onBlur={() => {
                if (!phone.trim()) return;
                const check = validateArgentinaPhone(phone);
                if (check.ok) setPhone(formatPhoneLocalDisplay(check.digits));
                else setError(check.error ?? "Teléfono no válido");
              }}
              placeholder="Ej: 362 472-0762"
              autoComplete="tel-national"
              inputMode="tel"
              disabled={saving}
            />
            <p className="pom-hint">Característica + número, sin 0 ni 15.</p>
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
                  setPhone(initialPhoneInput(currentPhone));
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
