"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { PROVINCE_CITIES_DATA } from "@/lib/data/argentina-cities-data";
import DropdownSelect from "@/components/ui/DropdownSelect";
import { linkOrCreateCustomerIdentity } from "@/lib/supabase/link-customer-identity";
import {
  formatPhoneLocalDisplay,
  formatPhoneStored,
  sanitizePhoneInput,
  validateArgentinaPhone,
} from "@/lib/utils/phone-ar";

const CUSTOM_CITY = "__otra__";

export interface ProfileOnboardingModalProps {
  open: boolean;
  userId: string;
  email: string;
  onCompleted: () => void;
}

function sanitize(text: string, max = 255) {
  return String(text || "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .slice(0, max);
}

export default function ProfileOnboardingModal({
  open,
  userId,
  email,
  onCompleted,
}: ProfileOnboardingModalProps) {
  const provinces = useMemo(
    () => Object.keys(PROVINCE_CITIES_DATA).sort((a, b) => a.localeCompare(b, "es")),
    []
  );

  // Nombre/apellido vacíos a propósito: no precargar desde Google ni autofill
  // del navegador (el usuario los completa a mano).
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dni, setDni] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [customCity, setCustomCity] = useState("");
  const [isCustomCity, setIsCustomCity] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (open) return;
    setError(null);
  }, [open]);

  const cities = province
    ? (PROVINCE_CITIES_DATA as Record<string, string[]>)[province] ?? []
    : [];
  const provinceOptions = useMemo(
    () => provinces.map((p) => ({ value: p, label: p })),
    [provinces]
  );
  const cityOptions = useMemo(
    () => [
      ...cities.map((c) => ({ value: c, label: c })),
      { value: CUSTOM_CITY, label: "Otra (escribir)" },
    ],
    [cities]
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const fn = sanitize(firstName, 100);
    const ln = sanitize(lastName, 100);
    const phoneCheck = validateArgentinaPhone(phone);
    const dniDigits = dni.replace(/\D/g, "");
    const prov = sanitize(province, 100);
    const cityVal = sanitize(isCustomCity ? customCity : city, 100);
    const addr = sanitize(address, 500);

    if (fn.length < 2) {
      setError("El nombre debe tener al menos 2 caracteres");
      return;
    }
    if (ln.length < 2) {
      setError("El apellido debe tener al menos 2 caracteres");
      return;
    }
    if (dniDigits.length < 7 || dniDigits.length > 8) {
      setError("DNI: 7 u 8 dígitos");
      return;
    }
    if (!phoneCheck.ok) {
      setPhoneError(phoneCheck.error ?? "Teléfono no válido");
      setError(phoneCheck.error ?? "Teléfono no válido");
      return;
    }
    if (!prov || !provinces.includes(prov)) {
      setError("Elegí una provincia válida");
      return;
    }
    if (cityVal.length < 2) {
      setError("La localidad es obligatoria");
      return;
    }
    if (addr.length < 4) {
      setError("La dirección es obligatoria");
      return;
    }

    setSaving(true);
    try {
      const supabase = getSupabaseBrowserClient();
      // El prefijo interno "+54 9" se agrega solo acá; el cliente nunca lo ve.
      const formattedPhone = formatPhoneStored(phoneCheck.digits);
      const fullName = `${fn} ${ln}`.trim();

      let customerNumber: string | null = null;
      let qrCode: string | null = null;
      let publicSalesCustomerId: string | null = null;

      // 1) Merge real admin↔auth (teléfono + provincia/localidad) antes del upsert
      const authLink = await linkOrCreateCustomerIdentity(supabase, {
        userId,
        email,
        phone: formattedPhone,
        fullName,
        dni: dniDigits,
        province: prov,
        city: cityVal,
      });

      if (authLink.errorMessage) {
        // Sin merge no seguimos: evita crear el duplicado y ocultar el fallo
        throw new Error(
          `No se pudo vincular con un cliente existente: ${authLink.errorMessage}`
        );
      }

      if (authLink.customerNumber) {
        customerNumber = authLink.customerNumber;
      }

      // 2) Lookup public-sales (QR / customer_number) — no mergea UUID admin
      const { data: linkResult, error: linkError } = await supabase.rpc(
        "rpc_link_public_sales_customer",
        {
          p_user_id: userId,
          p_email: email,
          p_dni: dniDigits,
          p_phone: formattedPhone,
          p_province: prov,
          p_city: cityVal,
        }
      );

      if (!linkError && linkResult?.found) {
        if (linkResult.source === "public_sales") {
          if (!customerNumber && linkResult.customer_number) {
            customerNumber = linkResult.customer_number ?? null;
          }
          qrCode = linkResult.qr_code ?? null;
          publicSalesCustomerId = linkResult.public_sales_customer_id ?? null;
        }
      }

      // 3) Completar perfil (dirección, etc.) sobre id = auth.uid()
      //    El nombre del formulario manda (no el del contacto admin).
      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        "rpc_upsert_customer",
        {
          p_full_name: fullName,
          p_address: addr,
          p_city: cityVal,
          p_province: prov,
          p_phone: formattedPhone,
          p_dni: dniDigits,
          p_email: email,
          p_customer_number: customerNumber,
          p_qr_code: qrCode,
          p_public_sales_customer_id: publicSalesCustomerId,
        }
      );

      if (rpcError) throw new Error(rpcError.message || "Error al guardar");
      if (rpcResult && typeof rpcResult === "object" && rpcResult.success === false) {
        throw new Error(rpcResult.error || "Error al guardar");
      }

      onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="profile-onboarding-modal-root"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nj-pom-title"
    >
      <div className="profile-onboarding-card">
        <>
        <h2 id="nj-pom-title" className="pom-title">
          Completá tus datos
        </h2>
        <p className="pom-sub">
          Necesitamos estos datos para tu cuenta mayorista antes de armar el carrito.
        </p>
        <form className="pom-form" onSubmit={handleSubmit} noValidate>
          <label className="pom-label">Email</label>
          <input className="pom-input" type="email" value={email} readOnly disabled />

          <div className="pom-row">
            <div className="pom-field">
              <label className="pom-label" htmlFor="nj-pom-first">
                Nombre <span className="pom-req">*</span>
              </label>
              <input
                id="nj-pom-first"
                className="pom-input"
                name="fyl-pom-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="words"
                spellCheck={false}
                maxLength={100}
                required
              />
            </div>
            <div className="pom-field">
              <label className="pom-label" htmlFor="nj-pom-last">
                Apellido <span className="pom-req">*</span>
              </label>
              <input
                id="nj-pom-last"
                className="pom-input"
                name="fyl-pom-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="words"
                spellCheck={false}
                maxLength={100}
                required
              />
            </div>
          </div>

          <label className="pom-label" htmlFor="nj-pom-dni">
            DNI <span className="pom-req">*</span>
          </label>
          <input
            id="nj-pom-dni"
            className="pom-input"
            value={dni}
            onChange={(e) => setDni(e.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric"
            maxLength={8}
            required
          />

          <label className="pom-label" htmlFor="nj-pom-phone">
            Teléfono <span className="pom-req">*</span>
          </label>
          <input
            id="nj-pom-phone"
            className="pom-input"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => {
              setPhone(sanitizePhoneInput(e.target.value));
              if (phoneError) setPhoneError(null);
            }}
            onBlur={() => {
              if (!phone.trim()) return;
              const check = validateArgentinaPhone(phone);
              if (check.ok) {
                setPhone(formatPhoneLocalDisplay(check.digits));
                setPhoneError(null);
              } else {
                setPhoneError(check.error ?? "Teléfono no válido");
              }
            }}
            placeholder="Ej: 362 472-0762"
            autoComplete="tel-national"
            aria-invalid={phoneError ? true : undefined}
            aria-describedby="nj-pom-phone-hint"
            required
          />
          <p
            id="nj-pom-phone-hint"
            className="pom-hint"
            role={phoneError ? "alert" : undefined}
            style={phoneError ? { color: "#b91c1c" } : undefined}
          >
            {phoneError ?? "Característica + número, sin 0 ni 15."}
          </p>

          <label className="pom-label" htmlFor="nj-pom-address">
            Dirección (calle y número) <span className="pom-req">*</span>
          </label>
          <input
            id="nj-pom-address"
            className="pom-input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Ej: San Martín 123"
            autoComplete="street-address"
            maxLength={500}
            required
          />

          <label className="pom-label" id="nj-pom-province-label" htmlFor="nj-pom-province">
            Provincia <span className="pom-req">*</span>
          </label>
          <DropdownSelect
            id="nj-pom-province"
            labelledBy="nj-pom-province-label"
            value={province}
            placeholder="Escribí para buscar provincia…"
            options={provinceOptions}
            searchable
            onChange={(value) => {
              setProvince(value);
              setCity("");
              setCustomCity("");
              setIsCustomCity(false);
            }}
          />

          <label className="pom-label" id="nj-pom-city-label" htmlFor="nj-pom-city">
            Localidad <span className="pom-req">*</span>
          </label>
          <DropdownSelect
            id="nj-pom-city"
            labelledBy="nj-pom-city-label"
            value={isCustomCity ? CUSTOM_CITY : city}
            placeholder={
              province ? "Escribí para buscar localidad…" : "Primero elegí provincia"
            }
            disabled={!province}
            options={cityOptions}
            searchable
            onChange={(value) => {
              if (value === CUSTOM_CITY) {
                setIsCustomCity(true);
                setCity("");
              } else {
                setIsCustomCity(false);
                setCity(value);
              }
            }}
          />
          {isCustomCity && (
            <input
              className="pom-input"
              style={{ marginTop: 8 }}
              value={customCity}
              onChange={(e) => setCustomCity(e.target.value)}
              placeholder="Escribí tu localidad"
              required
            />
          )}

          {error && <div className="pom-error">{error}</div>}

          <button type="submit" className="pom-submit" disabled={saving}>
            {saving ? "Guardando…" : "Guardar y continuar"}
          </button>
        </form>
        </>
      </div>
    </div>,
    document.body
  );
}
