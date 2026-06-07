// admin/customer-create-shared.js — Alta de clienta (misma validación que customers.html)

import { PROVINCE_CITIES_DATA } from "./argentina-cities-data.js?v=m260607";

const PROVINCE_CITIES = PROVINCE_CITIES_DATA;
const ARGENTINA_PROVINCES = Object.keys(PROVINCE_CITIES).sort();

export function validatePhone(phone) {
  if (!phone) return false;
  let cleaned = phone.replace(/^\+54\s?/i, "");
  cleaned = cleaned.replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("9")) cleaned = cleaned.substring(1);
  return /^\d{8,10}$/.test(cleaned);
}

export function formatPhone(phone) {
  if (!phone) return "";
  let cleaned = phone.replace(/^\+54\s?/i, "");
  cleaned = cleaned.replace(/[\s\-()]/g, "");
  if (!cleaned.startsWith("9") && cleaned.length >= 8) cleaned = "9" + cleaned;
  if (cleaned.length >= 10) {
    const match = cleaned.match(/^9?(\d{2,4})(\d{6,8})$/);
    if (match) {
      const areaCode = match[1];
      const number = match[2];
      const formattedNumber =
        number.length > 4 ? `${number.slice(0, -4)}-${number.slice(-4)}` : number;
      return `+54 9 ${areaCode} ${formattedNumber}`;
    }
  }
  return `+54 ${cleaned}`;
}

/**
 * @param {Record<string, string>} raw
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
export function validateNewCustomerForm(raw) {
  const firstName = String(raw.firstName || "").trim();
  const lastName = String(raw.lastName || "").trim();
  const dni = String(raw.dni || "").trim();
  const phone = String(raw.phone || "").trim();
  const email = String(raw.email || "").trim();
  const address = String(raw.address || "").trim();
  const province = String(raw.province || "").trim();
  const city = String(raw.city || "").trim();

  if (!firstName || !lastName) {
    return { ok: false, error: "Nombre y apellido son obligatorios" };
  }
  if (!phone) {
    return { ok: false, error: "Teléfono es obligatorio" };
  }
  if (!validatePhone(phone)) {
    return {
      ok: false,
      error: "El teléfono debe tener entre 8 y 10 dígitos (código de área + número)",
    };
  }
  if (!address) {
    return { ok: false, error: "Dirección es obligatoria" };
  }
  if (!province) {
    return { ok: false, error: "Provincia es obligatoria" };
  }
  if (!ARGENTINA_PROVINCES.includes(province)) {
    return { ok: false, error: "La provincia seleccionada no es válida" };
  }
  if (!city) {
    return { ok: false, error: "Ciudad es obligatoria" };
  }
  const cities = PROVINCE_CITIES[province] || [];
  if (!cities.includes(city)) {
    return { ok: false, error: "La ciudad no es válida para la provincia elegida" };
  }
  if (dni && (dni.length < 7 || dni.length > 8 || !/^\d+$/.test(dni))) {
    return { ok: false, error: "El DNI debe tener entre 7 y 8 dígitos numéricos" };
  }

  return {
    ok: true,
    data: {
      full_name: `${firstName} ${lastName}`.trim(),
      phone: formatPhone(phone),
      email: email || null,
      dni: dni || null,
      address,
      city,
      province,
    },
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {object} customerData
 */
export async function createAdminCustomer(sb, customerData) {
  const { data, error } = await sb.rpc("rpc_create_admin_customer", {
    p_full_name: customerData.full_name,
    p_email: customerData.email || null,
    p_phone: customerData.phone || null,
    p_dni: customerData.dni || null,
    p_address: customerData.address || null,
    p_city: customerData.city || null,
    p_province: customerData.province || null,
  });

  if (error) throw error;
  if (!data?.success) {
    throw new Error(data?.message || data?.error || "No se pudo crear la clienta");
  }

  const { data: customer, error: fetchError } = await sb
    .from("customers")
    .select("id, customer_number, full_name, dni, phone, email, city, province, address")
    .eq("id", data.customer_id)
    .single();

  if (fetchError) throw fetchError;
  return customer;
}

/**
 * Autocomplete provincia/ciudad (misma UX que customers.html).
 * @param {{ provinceInput: HTMLInputElement, provinceDropdown: HTMLElement, cityInput: HTMLInputElement, cityDropdown: HTMLElement, dialogRoot?: HTMLElement }} opts
 * @returns {() => void} cleanup
 */
export function initArgentinaLocationAutocomplete(opts) {
  const { provinceInput, provinceDropdown, cityInput, cityDropdown, dialogRoot } = opts;
  let provinceClickBound = false;

  function hideDropdowns() {
    provinceDropdown.style.display = "none";
    cityDropdown.style.display = "none";
  }

  function updateCitiesList(province) {
    const cities = PROVINCE_CITIES[province] || [];
    cityInput.dataset.availableCities = JSON.stringify(cities);
  }

  function handleProvinceInput(value) {
    const query = value.toLowerCase().trim();
    if (query.length === 0) {
      provinceDropdown.style.display = "none";
      return;
    }
    const matches = ARGENTINA_PROVINCES.filter((p) => p.toLowerCase().includes(query));
    if (matches.length === 0) {
      provinceDropdown.style.display = "none";
      return;
    }
    provinceDropdown.innerHTML = matches
      .map(
        (province) =>
          `<div class="pau-cf-dropdown-item" data-value="${province}">${province}</div>`
      )
      .join("");
    provinceDropdown.style.display = "block";
    provinceDropdown.querySelectorAll(".pau-cf-dropdown-item").forEach((item) => {
      item.addEventListener("click", () => {
        provinceInput.value = item.dataset.value || "";
        provinceDropdown.style.display = "none";
        updateCitiesList(provinceInput.value);
        cityInput.disabled = false;
        cityInput.placeholder = "Escriba para buscar ciudad…";
        cityInput.value = "";
        cityInput.focus();
      });
    });
  }

  function handleCityInput(value) {
    if (cityInput.disabled) return;
    const availableCitiesStr = cityInput.dataset.availableCities;
    if (!availableCitiesStr) {
      cityDropdown.style.display = "none";
      return;
    }
    const availableCities = JSON.parse(availableCitiesStr);
    const query = value.toLowerCase().trim();
    if (query.length === 0) {
      cityDropdown.style.display = "none";
      return;
    }
    const matches = availableCities.filter((city) => city.toLowerCase().includes(query));
    if (matches.length === 0) {
      cityDropdown.style.display = "none";
      return;
    }
    cityDropdown.innerHTML = matches
      .map((city) => `<div class="pau-cf-dropdown-item" data-value="${city}">${city}</div>`)
      .join("");
    cityDropdown.style.display = "block";
    cityDropdown.querySelectorAll(".pau-cf-dropdown-item").forEach((item) => {
      item.addEventListener("click", () => {
        cityInput.value = item.dataset.value || "";
        cityDropdown.style.display = "none";
      });
    });
  }

  const onProvinceInput = (e) => handleProvinceInput(e.target.value);
  const onProvinceFocus = () => {
    if (provinceInput.value.length > 0) handleProvinceInput(provinceInput.value);
  };
  const onCityInput = (e) => handleCityInput(e.target.value);
  const onCityFocus = () => {
    if (!cityInput.disabled && cityInput.value.length > 0) {
      handleCityInput(cityInput.value);
    }
  };

  provinceInput.addEventListener("input", onProvinceInput);
  provinceInput.addEventListener("focus", onProvinceFocus);
  cityInput.addEventListener("input", onCityInput);
  cityInput.addEventListener("focus", onCityFocus);

  if (!provinceClickBound) {
    const root = dialogRoot || document;
    root.addEventListener("click", (e) => {
      if (
        !provinceInput.contains(e.target) &&
        !provinceDropdown.contains(e.target)
      ) {
        provinceDropdown.style.display = "none";
      }
      if (!cityInput.contains(e.target) && !cityDropdown.contains(e.target)) {
        cityDropdown.style.display = "none";
      }
    });
    provinceClickBound = true;
  }

  return () => {
    provinceInput.removeEventListener("input", onProvinceInput);
    provinceInput.removeEventListener("focus", onProvinceFocus);
    cityInput.removeEventListener("input", onCityInput);
    cityInput.removeEventListener("focus", onCityFocus);
    hideDropdowns();
  };
}

export function resetCustomerCreateForm(els) {
  els.form?.reset();
  if (els.cityInput) {
    els.cityInput.disabled = true;
    els.cityInput.placeholder = "Seleccioná provincia primero…";
    els.cityInput.value = "";
    delete els.cityInput.dataset.availableCities;
  }
  if (els.errorEl) {
    els.errorEl.hidden = true;
    els.errorEl.textContent = "";
  }
  if (els.provinceDropdown) els.provinceDropdown.style.display = "none";
  if (els.cityDropdown) els.cityDropdown.style.display = "none";
}
