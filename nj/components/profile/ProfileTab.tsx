"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import DropdownSelect from "@/components/ui/DropdownSelect";
import ProfileShippingBlock from "./ProfileShippingBlock";
import { linkOrCreateCustomerIdentity } from "@/lib/supabase/link-customer-identity";

// ─── Datos de provincias/ciudades ─────────────────────────────────────────────

const ARGENTINA_PROVINCES = [
  "Buenos Aires", "Catamarca", "Chaco", "Chubut", "Córdoba", "Corrientes",
  "Entre Ríos", "Formosa", "Jujuy", "La Pampa", "La Rioja", "Mendoza",
  "Misiones", "Neuquén", "Río Negro", "Salta", "San Juan", "San Luis",
  "Santa Cruz", "Santa Fe", "Santiago del Estero", "Tierra del Fuego",
  "Tucumán", "CABA",
];

const PROVINCE_CITIES: Record<string, string[]> = {
  "Buenos Aires": ["La Plata", "Mar del Plata", "Bahía Blanca", "Tandil", "Quilmes", "Lanús", "Banfield", "Lomas de Zamora", "Avellaneda", "Merlo", "San Miguel", "Moreno", "Morón", "Florencio Varela", "Berazategui", "San Isidro", "Tigre", "Pilar", "Malvinas Argentinas", "Esteban Echeverría"],
  "Catamarca": ["San Fernando del Valle de Catamarca", "Valle Viejo", "Fray Mamerto Esquiú", "San Isidro"],
  "Chaco": ["Resistencia", "Barranqueras", "Villa Ángela", "Presidencia Roque Sáenz Peña", "Charata", "General San Martín", "Juan José Castelli", "Machagai", "Quitilipi", "Villa Berthet"],
  "Chubut": ["Rawson", "Comodoro Rivadavia", "Trelew", "Puerto Madryn", "Esquel", "Sarmiento", "Gaiman"],
  "Córdoba": ["Córdoba", "Villa Carlos Paz", "Río Cuarto", "Villa María", "San Francisco", "Villa Allende", "Jesús María", "Unquillo", "La Calera", "Marcos Juárez"],
  "Corrientes": ["Corrientes", "Goya", "Mercedes", "Curuzú Cuatiá", "Bella Vista", "Paso de los Libres", "Monte Caseros", "Esquina"],
  "Entre Ríos": ["Paraná", "Concordia", "Gualeguaychú", "Concepción del Uruguay", "Villaguay", "Colón", "Nogoyá", "Federación"],
  "Formosa": ["Formosa", "Clorinda", "Pirané", "El Colorado", "Comandante Fontana", "Laguna Naick Neck"],
  "Jujuy": ["San Salvador de Jujuy", "Palpalá", "Perico", "San Pedro de Jujuy", "La Quiaca", "Humahuaca"],
  "La Pampa": ["Santa Rosa", "General Pico", "Toay", "Realicó", "Eduardo Castex", "General Acha"],
  "La Rioja": ["La Rioja", "Chilecito", "Arauco", "Aminga", "Chamical"],
  "Mendoza": ["Mendoza", "San Rafael", "Godoy Cruz", "Luján de Cuyo", "Maipú", "Guaymallén", "Las Heras", "Rivadavia", "Tunuyán", "San Martín"],
  "Misiones": ["Posadas", "Oberá", "Eldorado", "Puerto Iguazú", "Leandro N. Alem", "Apóstoles", "Montecarlo"],
  "Neuquén": ["Neuquén", "Cutral Có", "Plottier", "Zapala", "San Martín de los Andes", "Villa La Angostura"],
  "Río Negro": ["Viedma", "Bariloche", "General Roca", "Cipolletti", "Allen", "Cinco Saltos", "Villa Regina"],
  "Salta": ["Salta", "Orán", "Tartagal", "Cafayate", "Metán", "Rosario de la Frontera", "Embarcación", "Güemes", "Cerrillos"],
  "San Juan": ["San Juan", "Rawson", "Rivadavia", "Santa Lucía", "Pocito", "Chimbas", "Caucete"],
  "San Luis": ["San Luis", "Villa Mercedes", "Merlo", "La Toma", "Justo Daract"],
  "Santa Cruz": ["Río Gallegos", "Caleta Olivia", "El Calafate", "Puerto Deseado", "Pico Truncado"],
  "Santa Fe": ["Santa Fe", "Rosario", "Venado Tuerto", "Rafaela", "Reconquista", "Santo Tomé", "Villa Gobernador Gálvez", "San Lorenzo"],
  "Santiago del Estero": ["Santiago del Estero", "La Banda", "Fernández", "Frías", "Termas de Río Hondo"],
  "Tierra del Fuego": ["Ushuaia", "Río Grande", "Tolhuin"],
  "Tucumán": ["San Miguel de Tucumán", "Yerba Buena", "Tafí Viejo", "Concepción", "Banda del Río Salí", "Alderetes"],
  "CABA": ["Ciudad Autónoma de Buenos Aires"],
};

const CUSTOM_CITY_VALUE = "__otra__";

// ─── Helpers de estilo ────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 10,
  border: "1.5px solid #e0d8d0", fontSize: 14, color: "#333",
  background: "#fff", outline: "none", boxSizing: "border-box",
  fontFamily: "inherit",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#bbb",
  letterSpacing: "0.06em", textTransform: "uppercase" as const,
  display: "block", marginBottom: 6,
};

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
}

function SectionHeader({ title, editing, onEdit }: { title: string; editing: boolean; onEdit: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#bbb", letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {title}
      </span>
      {!editing && (
        <button
          type="button"
          onClick={onEdit}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            background: "#f5f0eb", border: "none", borderRadius: 8,
            padding: "5px 10px", cursor: "pointer",
            fontSize: 12, fontWeight: 600, color: "#CD844D",
          }}
        >
          <PencilIcon /> Editar
        </button>
      )}
    </div>
  );
}

function ReadRow({ label, value }: { label: string; value?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #f5f5f5" }}>
      <span style={{ fontSize: 12, color: "#aaa" }}>{label}</span>
      <span style={{ fontSize: 14, color: value ? "#333" : "#ccc", fontWeight: value ? 500 : 400 }}>
        {value || "—"}
      </span>
    </div>
  );
}

function SectionActions({ saving, onSave, onCancel }: { saving: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
      <button
        type="button"
        onClick={onCancel}
        style={{
          flex: 1, padding: "10px", borderRadius: 10,
          border: "1.5px solid #e0d8d0", background: "none",
          color: "#888", fontSize: 13, fontWeight: 500, cursor: "pointer",
        }}
      >
        Cancelar
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        style={{
          flex: 2, padding: "10px", borderRadius: 10, border: "none",
          background: saving ? "#e8a96b" : "#CD844D",
          color: "#fff", fontSize: 13, fontWeight: 700,
          cursor: saving ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "Guardando..." : "Guardar"}
      </button>
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  full_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  dni?: string;
  city?: string;
  province?: string;
  customer_number?: string;
}

interface ProfileTabProps {
  customer: Customer | null;
  userEmail: string;
  userId: string;
  onLogout: () => void;
  loggingOut: boolean;
  /** Notifica al componente padre los campos guardados, para que el prop `customer`
   * se mantenga al día incluso si este tab se desmonta/remonta (cambio de pestaña). */
  onCustomerUpdate?: (patch: Partial<Customer>) => void;
  /** Notifica al componente padre cuando el cliente elige otro transporte,
   * para que el header (que muestra el transporte activo) se refresque. */
  assignedTransportName?: string | null;
  onTransportChange?: (transporte: string, transportId?: string | null) => void;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ProfileTab({ customer, userEmail, userId, onLogout, loggingOut, onCustomerUpdate, assignedTransportName, onTransportChange }: ProfileTabProps) {
  // ── Personal section state ──
  const [editingPersonal, setEditingPersonal] = useState(false);
  const [personal, setPersonal] = useState({
    full_name: customer?.full_name ?? "",
    phone: customer?.phone ?? "",
    dni: customer?.dni ?? "",
  });
  const [personalDraft, setPersonalDraft] = useState(personal);
  const [savingPersonal, setSavingPersonal] = useState(false);
  const [personalError, setPersonalError] = useState<string | null>(null);
  const [personalOk, setPersonalOk] = useState(false);

  // ── Location section state ──
  const [editingLocation, setEditingLocation] = useState(false);

  const savedCityInList = customer?.province
    ? (PROVINCE_CITIES[customer.province] ?? []).includes(customer?.city ?? "")
    : false;

  const [location, setLocation] = useState({
    address: customer?.address ?? "",
    province: customer?.province ?? "",
    city: customer?.city ?? "",
  });
  const [locationDraft, setLocationDraft] = useState(location);
  const [isCustomCity, setIsCustomCity] = useState(!savedCityInList && !!customer?.city);
  const [customCity, setCustomCity] = useState(!savedCityInList ? (customer?.city ?? "") : "");
  const [isCustomCityDraft, setIsCustomCityDraft] = useState(isCustomCity);
  const [customCityDraft, setCustomCityDraft] = useState(customCity);
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationOk, setLocationOk] = useState(false);

  const citiesForProvince = locationDraft.province ? (PROVINCE_CITIES[locationDraft.province] ?? []) : [];
  const effectiveCityDraft = isCustomCityDraft ? customCityDraft : locationDraft.city;
  const effectiveCity = isCustomCity ? customCity : location.city;
  const provinceOptions = useMemo(
    () => ARGENTINA_PROVINCES.map((p) => ({ value: p, label: p })),
    []
  );
  const cityOptions = useMemo(
    () => [
      ...citiesForProvince.map((c) => ({ value: c, label: c })),
      { value: CUSTOM_CITY_VALUE, label: "Otra localidad..." },
    ],
    [citiesForProvince]
  );

  // Si el padre refresca el customer (onboarding / router.refresh), actualizar
  // la UI sin esperar un F5. No pisar mientras el usuario está editando.
  useEffect(() => {
    if (editingPersonal || editingLocation) return;

    const nextPersonal = {
      full_name: customer?.full_name ?? "",
      phone: customer?.phone ?? "",
      dni: customer?.dni ?? "",
    };
    setPersonal(nextPersonal);
    setPersonalDraft(nextPersonal);

    const cityInList = customer?.province
      ? (PROVINCE_CITIES[customer.province] ?? []).includes(customer?.city ?? "")
      : false;
    const nextLocation = {
      address: customer?.address ?? "",
      province: customer?.province ?? "",
      city: customer?.city ?? "",
    };
    setLocation(nextLocation);
    setLocationDraft(nextLocation);
    setIsCustomCity(!cityInList && !!customer?.city);
    setCustomCity(!cityInList ? (customer?.city ?? "") : "");
    setIsCustomCityDraft(!cityInList && !!customer?.city);
    setCustomCityDraft(!cityInList ? (customer?.city ?? "") : "");
  }, [
    customer?.full_name,
    customer?.phone,
    customer?.dni,
    customer?.address,
    customer?.province,
    customer?.city,
    editingPersonal,
    editingLocation,
  ]);

  function startEditPersonal() {
    setPersonalDraft(personal);
    setPersonalError(null);
    setEditingPersonal(true);
  }
  function cancelPersonal() {
    setPersonalDraft(personal);
    setPersonalError(null);
    setEditingPersonal(false);
  }

  function startEditLocation() {
    setLocationDraft(location);
    setIsCustomCityDraft(isCustomCity);
    setCustomCityDraft(customCity);
    setLocationError(null);
    setEditingLocation(true);
  }
  function cancelLocation() {
    setLocationDraft(location);
    setIsCustomCityDraft(isCustomCity);
    setCustomCityDraft(customCity);
    setLocationError(null);
    setEditingLocation(false);
  }

  function handleProvinceChange(province: string) {
    setLocationDraft((f) => ({ ...f, province, city: "" }));
    setIsCustomCityDraft(false);
    setCustomCityDraft("");
  }

  function handleCitySelectChange(val: string) {
    if (val === CUSTOM_CITY_VALUE) {
      setIsCustomCityDraft(true);
      setCustomCityDraft("");
      setLocationDraft((f) => ({ ...f, city: "" }));
    } else {
      setIsCustomCityDraft(false);
      setLocationDraft((f) => ({ ...f, city: val }));
    }
  }

  async function getRpcBase(supabase: ReturnType<typeof getSupabaseBrowserClient>) {
    const { data: current } = await supabase
      .from("customers")
      .select("customer_number, qr_code, public_sales_customer_id")
      .eq("id", userId)
      .maybeSingle();
    const { data: { user } } = await supabase.auth.getUser();
    return { current, email: user?.email ?? userEmail };
  }

  const savePersonal = useCallback(async () => {
    setSavingPersonal(true);
    setPersonalError(null);
    const supabase = getSupabaseBrowserClient();
    const { current, email } = await getRpcBase(supabase);

    const fullName = personalDraft.full_name.trim();
    const phone = personalDraft.phone.trim();
    const dni = personalDraft.dni.trim();
    const province = location.province.trim();
    const city = effectiveCity.trim();

    // Reintento de vinculación si el perfil ya existía sin merge (tel + geo)
    if (phone && province && city) {
      const authLink = await linkOrCreateCustomerIdentity(supabase, {
        userId,
        email,
        phone,
        fullName,
        dni,
        province,
        city,
      });
      if (authLink.errorMessage) {
        setSavingPersonal(false);
        setPersonalError(
          `No se pudo vincular con un cliente existente: ${authLink.errorMessage}`
        );
        return;
      }
      if (authLink.customerNumber && !current?.customer_number) {
        // keep for upsert below via refreshed current
      }
    }

    const { data: currentAfterLink } = await supabase
      .from("customers")
      .select("customer_number, qr_code, public_sales_customer_id")
      .eq("id", userId)
      .maybeSingle();

    const { data, error } = await supabase.rpc("rpc_upsert_customer", {
      p_full_name: fullName || null,
      p_address: location.address.trim() || null,
      p_city: city || null,
      p_province: province || null,
      p_phone: phone || null,
      p_dni: dni || null,
      p_email: email,
      p_customer_number: currentAfterLink?.customer_number ?? current?.customer_number ?? null,
      p_qr_code: currentAfterLink?.qr_code ?? current?.qr_code ?? null,
      p_public_sales_customer_id:
        currentAfterLink?.public_sales_customer_id ?? current?.public_sales_customer_id ?? null,
    });
    setSavingPersonal(false);
    // La RPC atrapa sus propias excepciones y devuelve { success: false, error }
    // en vez de un error de Postgrest, así que hay que revisar ambos casos.
    if (error) { setPersonalError(error.message || "No se pudo guardar."); return; }
    if (data && typeof data === "object" && (data as { success?: boolean }).success === false) {
      setPersonalError((data as { error?: string }).error || "No se pudo guardar.");
      return;
    }
    setPersonal(personalDraft);
    onCustomerUpdate?.({ full_name: personalDraft.full_name, phone: personalDraft.phone, dni: personalDraft.dni });
    setPersonalOk(true);
    setEditingPersonal(false);
    setTimeout(() => setPersonalOk(false), 3000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personalDraft, location, effectiveCity, userId, userEmail, onCustomerUpdate]);

  const saveLocation = useCallback(async () => {
    setSavingLocation(true);
    setLocationError(null);
    const supabase = getSupabaseBrowserClient();
    const { current, email } = await getRpcBase(supabase);
    const { data, error } = await supabase.rpc("rpc_upsert_customer", {
      p_full_name: personal.full_name.trim() || null,
      p_address: locationDraft.address.trim() || null,
      p_city: effectiveCityDraft.trim() || null,
      p_province: locationDraft.province.trim() || null,
      p_phone: personal.phone.trim() || null,
      p_dni: personal.dni.trim() || null,
      p_email: email,
      p_customer_number: current?.customer_number ?? null,
      p_qr_code: current?.qr_code ?? null,
      p_public_sales_customer_id: current?.public_sales_customer_id ?? null,
    });
    setSavingLocation(false);
    // La RPC atrapa sus propias excepciones y devuelve { success: false, error }
    // en vez de un error de Postgrest, así que hay que revisar ambos casos.
    if (error) { setLocationError(error.message || "No se pudo guardar."); return; }
    if (data && typeof data === "object" && (data as { success?: boolean }).success === false) {
      setLocationError((data as { error?: string }).error || "No se pudo guardar.");
      return;
    }
    setLocation({ ...locationDraft, city: effectiveCityDraft });
    setIsCustomCity(isCustomCityDraft);
    setCustomCity(customCityDraft);
    onCustomerUpdate?.({
      address: locationDraft.address,
      city: effectiveCityDraft,
      province: locationDraft.province,
    });
    setLocationOk(true);
    setEditingLocation(false);
    setTimeout(() => setLocationOk(false), 3000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationDraft, effectiveCityDraft, isCustomCityDraft, customCityDraft, personal, userId, userEmail, onCustomerUpdate]);

  const cardStyle: React.CSSProperties = {
    background: "#fff", borderRadius: 16,
    boxShadow: "0 1px 4px rgba(0,0,0,0.07)", padding: "14px 16px",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

      {/* ── Retiro/envío asignado ── */}
      <div style={cardStyle}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#bbb", letterSpacing: "0.06em", textTransform: "uppercase", display: "block", marginBottom: 10 }}>
          Retiro/envío
        </span>
        <ProfileShippingBlock
          province={effectiveCity ? (editingLocation ? locationDraft.province : location.province) : customer?.province}
          city={effectiveCity || customer?.city}
          assignedTransportName={assignedTransportName}
          onTransportChange={onTransportChange}
        />
      </div>

      {/* ── Datos personales ── */}
      <div style={cardStyle}>
        <SectionHeader title="Datos personales" editing={editingPersonal} onEdit={startEditPersonal} />

        {/* Email — siempre solo lectura */}
        <ReadRow label="Email" value={customer?.email ?? userEmail} />

        {editingPersonal ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
            <div>
              <label style={labelStyle}>Nombre completo</label>
              <input type="text" value={personalDraft.full_name}
                onChange={(e) => setPersonalDraft((f) => ({ ...f, full_name: e.target.value }))}
                placeholder="Tu nombre y apellido" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Teléfono / WhatsApp</label>
              <input type="tel" value={personalDraft.phone}
                onChange={(e) => setPersonalDraft((f) => ({ ...f, phone: e.target.value }))}
                placeholder="+54 9 XXXX XXXXXX" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>DNI</label>
              <input type="text" inputMode="numeric" value={personalDraft.dni}
                onChange={(e) => setPersonalDraft((f) => ({ ...f, dni: e.target.value.replace(/\D/g, "") }))}
                placeholder="Sin puntos, solo números" style={inputStyle} />
            </div>
            {personalError && (
              <div style={{ padding: "9px 12px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fca5a5", fontSize: 12, color: "#991b1b" }}>
                {personalError}
              </div>
            )}
            <SectionActions saving={savingPersonal} onSave={savePersonal} onCancel={cancelPersonal} />
          </div>
        ) : (
          <>
            <ReadRow label="Nombre" value={personal.full_name} />
            <ReadRow label="Teléfono" value={personal.phone} />
            <ReadRow label="DNI" value={personal.dni} />
            {personalOk && (
              <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 8, background: "#f0fdf4", border: "1px solid #86efac", fontSize: 12, color: "#166534", display: "flex", alignItems: "center", gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Guardado correctamente
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Dirección y ubicación ── */}
      <div style={cardStyle}>
        <SectionHeader title="Dirección y ubicación" editing={editingLocation} onEdit={startEditLocation} />

        {editingLocation ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={labelStyle}>Dirección</label>
              <input type="text" value={locationDraft.address}
                onChange={(e) => setLocationDraft((f) => ({ ...f, address: e.target.value }))}
                placeholder="Calle, número, piso..." style={inputStyle} />
            </div>
            <div>
              <label id="profile-province-label" style={labelStyle}>Provincia</label>
              <DropdownSelect
                labelledBy="profile-province-label"
                value={locationDraft.province}
                placeholder="Seleccioná una provincia"
                options={provinceOptions}
                onChange={handleProvinceChange}
              />
            </div>
            {locationDraft.province && (
              <div>
                <label id="profile-city-label" style={labelStyle}>Localidad</label>
                {citiesForProvince.length > 0 ? (
                  <>
                    <DropdownSelect
                      labelledBy="profile-city-label"
                      value={isCustomCityDraft ? CUSTOM_CITY_VALUE : (locationDraft.city || "")}
                      placeholder="Seleccioná una localidad"
                      options={cityOptions}
                      onChange={handleCitySelectChange}
                    />
                    {isCustomCityDraft && (
                      <input type="text" value={customCityDraft}
                        onChange={(e) => { setCustomCityDraft(e.target.value); setLocationDraft((f) => ({ ...f, city: e.target.value })); }}
                        placeholder="Escribí tu localidad" style={{ ...inputStyle, marginTop: 8 }} autoFocus />
                    )}
                  </>
                ) : (
                  <input type="text" value={effectiveCityDraft}
                    onChange={(e) => { setCustomCityDraft(e.target.value); setLocationDraft((f) => ({ ...f, city: e.target.value })); }}
                    placeholder="Escribí tu localidad" style={inputStyle} />
                )}
              </div>
            )}
            {locationError && (
              <div style={{ padding: "9px 12px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fca5a5", fontSize: 12, color: "#991b1b" }}>
                {locationError}
              </div>
            )}
            <SectionActions saving={savingLocation} onSave={saveLocation} onCancel={cancelLocation} />
          </div>
        ) : (
          <>
            <ReadRow label="Dirección" value={location.address} />
            <ReadRow label="Localidad" value={effectiveCity} />
            <ReadRow label="Provincia" value={location.province} />
            {locationOk && (
              <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 8, background: "#f0fdf4", border: "1px solid #86efac", fontSize: 12, color: "#166534", display: "flex", alignItems: "center", gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Guardado correctamente
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Cerrar sesión ── */}
      <button
        onClick={onLogout}
        disabled={loggingOut}
        style={{
          width: "100%", padding: "12px 16px", borderRadius: 12,
          background: "#fff", border: "1.5px solid #fca5a5",
          color: "#991b1b", fontSize: 14, fontWeight: 500,
          cursor: loggingOut ? "not-allowed" : "pointer",
          opacity: loggingOut ? 0.6 : 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        {loggingOut ? "Saliendo..." : "Cerrar sesión"}
      </button>

    </div>
  );
}
