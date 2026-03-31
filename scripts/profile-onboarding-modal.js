/**
 * Modal obligatorio para completar datos de cliente (primer registro).
 * Se usa desde index2 (auth-status) y client/dashboard (dashboard.js) y login.js.
 */

import { supabase } from "./supabase-client.js";
import { hasInitialProfileComplete } from "../client/auth-helper.js";
import { ARGENTINA_PROVINCES, PROVINCE_CITIES } from "./argentina-locations-data.js";

let profileModalVisible = false;

/** Evita reabrir el modal en cada recarga (index2 → dashboard) en la misma sesión de pestaña. */
const PROFILE_MODAL_SHOWN_SESSION_KEY = "fyl_profile_modal_shown_session_uid";

export function clearProfileOnboardingSessionFlag() {
  try {
    sessionStorage.removeItem(PROFILE_MODAL_SHOWN_SESSION_KEY);
  } catch (_) {
    /* ignore */
  }
}

function markProfileOnboardingShownThisSession(userId) {
  if (!userId) return;
  try {
    sessionStorage.setItem(PROFILE_MODAL_SHOWN_SESSION_KEY, userId);
  } catch (_) {
    /* ignore */
  }
}

function wasProfileOnboardingShownThisSession(userId) {
  if (!userId) return false;
  try {
    return sessionStorage.getItem(PROFILE_MODAL_SHOWN_SESSION_KEY) === userId;
  } catch (_) {
    return false;
  }
}

function sanitizeText(text, maxLength = 255) {
  if (!text) return "";
  return String(text)
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .substring(0, maxLength);
}

function validatePhone(phone) {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s\-()]/g, "");
  return /^\d{8,10}$/.test(cleaned);
}

function formatPhone(phone) {
  if (!phone) return "";
  let cleaned = phone.replace(/[\s\-()]/g, "");
  if (cleaned.length >= 8) cleaned = "9" + cleaned;
  if (cleaned.length >= 10) {
    const match = cleaned.match(/^9(\d{2,4})(\d{6,8})$/);
    if (match) {
      const areaCode = match[1];
      const number = match[2];
      const formattedNumber =
        number.length > 4 ? `${number.slice(0, -4)}-${number.slice(-4)}` : number;
      return `+54 9 ${areaCode} ${formattedNumber}`;
    }
  }
  return `+54 9 ${cleaned}`;
}

function formatPhoneInput(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length > 10) digits = digits.substring(0, 10);
  if (digits.length === 0) return "";
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** @returns {() => void} abort listener */
function bindProvinceCityAutocomplete(root) {
  const provinceInput = root.querySelector("#pom-province");
  const provinceDd = root.querySelector("#pom-province-dd");
  const cityInput = root.querySelector("#pom-city");
  const cityDd = root.querySelector("#pom-city-dd");
  if (!provinceInput || !provinceDd || !cityInput || !cityDd) return () => {};

  function applyProvinceSelection(prov) {
    const cities = PROVINCE_CITIES[prov] || [];
    provinceInput.value = prov;
    provinceDd.style.display = "none";
    cityInput.dataset.availableCities = JSON.stringify(cities);
    cityInput.disabled = false;
    cityInput.placeholder = "Escribí para buscar localidad…";
    cityInput.value = "";
  }

  function showProvinceMatches(value) {
    const query = value.toLowerCase().trim();
    if (!query) {
      provinceDd.style.display = "none";
      return;
    }
    const exact = ARGENTINA_PROVINCES.find(
      (p) => p.toLowerCase() === query
    );
    if (exact) {
      applyProvinceSelection(exact);
      return;
    }
    const matches = ARGENTINA_PROVINCES.filter((p) => p.toLowerCase().includes(query));
    if (!matches.length) {
      provinceDd.style.display = "none";
      return;
    }
    provinceDd.innerHTML = matches
      .map(
        (p) =>
          `<button type="button" class="pom-dd-item" data-province="${p.replace(/"/g, "&quot;")}">${p}</button>`
      )
      .join("");
    provinceDd.style.display = "block";
    provinceDd.querySelectorAll(".pom-dd-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const prov = btn.getAttribute("data-province");
        applyProvinceSelection(prov);
      });
    });
  }

  function showCityMatches(value) {
    if (cityInput.disabled) return;
    const raw = cityInput.dataset.availableCities;
    if (!raw) {
      cityDd.style.display = "none";
      return;
    }
    let availableCities = [];
    try {
      availableCities = JSON.parse(raw);
    } catch {
      return;
    }
    const query = value.toLowerCase().trim();
    if (!query) {
      cityDd.style.display = "none";
      return;
    }
    const matches = availableCities.filter((c) => c.toLowerCase().includes(query));
    if (!matches.length) {
      cityDd.style.display = "none";
      return;
    }
    cityDd.innerHTML = matches
      .map(
        (c) =>
          `<button type="button" class="pom-dd-item" data-city="${c.replace(/"/g, "&quot;")}">${c}</button>`
      )
      .join("");
    cityDd.style.display = "block";
    cityDd.querySelectorAll(".pom-dd-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        cityInput.value = btn.getAttribute("data-city");
        cityDd.style.display = "none";
      });
    });
  }

  provinceInput.addEventListener("input", (e) => showProvinceMatches(e.target.value));
  provinceInput.addEventListener("focus", () => {
    if (provinceInput.value) showProvinceMatches(provinceInput.value);
  });
  cityInput.addEventListener("input", (e) => showCityMatches(e.target.value));
  cityInput.addEventListener("focus", () => {
    if (cityInput.value && !cityInput.disabled) showCityMatches(cityInput.value);
  });

  const ac = new AbortController();
  document.addEventListener(
    "click",
    (e) => {
      if (!root.contains(e.target)) {
        provinceDd.style.display = "none";
        cityDd.style.display = "none";
        return;
      }
      if (e.target !== provinceInput && !provinceDd.contains(e.target)) provinceDd.style.display = "none";
      if (e.target !== cityInput && !cityDd.contains(e.target)) cityDd.style.display = "none";
    },
    { capture: true, signal: ac.signal }
  );

  return () => ac.abort();
}

function bindPhoneFormat(root) {
  const phoneInput = root.querySelector("#pom-phone");
  if (!phoneInput) return;
  phoneInput.addEventListener("input", (e) => {
    const pos = e.target.selectionStart;
    const old = e.target.value;
    const next = formatPhoneInput(e.target.value);
    if (old !== next) {
      e.target.value = next;
      const diff = next.length - old.length;
      e.target.setSelectionRange(pos + diff, pos + diff);
    }
  });
  phoneInput.addEventListener("paste", (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData).getData("text");
    const digits = pasted.replace(/\D/g, "");
    e.target.value = formatPhoneInput(digits.length > 10 ? digits.substring(0, 10) : digits);
  });
}

/**
 * Si el usuario está logueado y falta perfil, muestra el modal.
 * @param {object} options
 * @param {boolean} [options.force] Si true, ignora "ya mostrado en esta pestaña" (p. ej. al hacer pedido con perfil incompleto).
 * @param {() => void} [options.onComplete] Tras guardar OK (antes de cerrar el overlay).
 * @returns {Promise<boolean>} true si se mostró el modal y el usuario guardó; false si no aplica
 */
export async function maybeShowProfileOnboardingModal(options = {}) {
  if (typeof document === "undefined") return false;
  if (window.__CATALOG_ONLY__) return false;
  if (profileModalVisible) return false;

  const { force = false } = options;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) return false;

  const profileOk = await hasInitialProfileComplete();
  if (profileOk) {
    clearProfileOnboardingSessionFlag();
    return false;
  }

  if (!force && wasProfileOnboardingShownThisSession(session.user.id)) {
    return false;
  }

  profileModalVisible = true;
  markProfileOnboardingShownThisSession(session.user.id);

  return new Promise((resolve) => {
    const old = document.getElementById("profile-onboarding-modal");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "profile-onboarding-modal";
    overlay.className = "profile-onboarding-modal-root";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "pom-title");

    overlay.innerHTML = `
      <div class="profile-onboarding-card">
        <h2 id="pom-title" class="pom-title">Completá tus datos</h2>
        <p class="pom-sub">Necesitamos estos datos para tu cuenta mayorista.</p>
        <form id="pom-form" class="pom-form" novalidate>
          <label class="pom-label">Email</label>
          <input id="pom-email" class="pom-input" type="email" readonly disabled value="" />
          <div class="pom-row">
            <div class="pom-field">
              <label class="pom-label" for="pom-first-name">Nombre <span class="pom-req">*</span></label>
              <input id="pom-first-name" class="pom-input" required autocomplete="given-name" maxlength="100" />
            </div>
            <div class="pom-field">
              <label class="pom-label" for="pom-last-name">Apellido <span class="pom-req">*</span></label>
              <input id="pom-last-name" class="pom-input" required autocomplete="family-name" maxlength="100" />
            </div>
          </div>
          <label class="pom-label" for="pom-dni">DNI <span class="pom-req">*</span></label>
          <input id="pom-dni" class="pom-input" required inputmode="numeric" pattern="[0-9]{7,8}" maxlength="8" autocomplete="off" />
          <label class="pom-label" for="pom-phone">Teléfono <span class="pom-req">*</span></label>
          <div class="pom-phone-row">
            <span class="pom-phone-prefix">+54 9</span>
            <input id="pom-phone" class="pom-input pom-phone-input" required autocomplete="tel" placeholder="362 472-0762" />
          </div>
          <p class="pom-hint">Código de área + número (sin el 9 inicial).</p>
          <label class="pom-label" for="pom-address">Dirección (calle y número) <span class="pom-req">*</span></label>
          <input id="pom-address" class="pom-input" required autocomplete="street-address" maxlength="500" placeholder="Ej: San Martín 123" />
          <div class="pom-rel">
            <label class="pom-label" for="pom-province">Provincia <span class="pom-req">*</span></label>
            <input id="pom-province" class="pom-input" required placeholder="Buscá provincia…" autocomplete="off" />
            <div id="pom-province-dd" class="pom-dropdown"></div>
          </div>
          <div class="pom-rel">
            <label class="pom-label" for="pom-city">Localidad <span class="pom-req">*</span></label>
            <input id="pom-city" class="pom-input" required disabled placeholder="Escribí o elegí de la lista…" autocomplete="off" />
            <div id="pom-city-dd" class="pom-dropdown"></div>
          </div>
          <div id="pom-error" class="pom-error" hidden></div>
          <button type="submit" id="pom-submit" class="pom-submit">Guardar y continuar</button>
        </form>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.classList.add("modal-open");

    const emailEl = overlay.querySelector("#pom-email");
    if (emailEl) emailEl.value = session.user.email || "";

    requestAnimationFrame(() => {
      overlay.querySelector("#pom-first-name")?.focus();
    });

    const stopDdListen = bindProvinceCityAutocomplete(overlay);
    bindPhoneFormat(overlay);

    const form = overlay.querySelector("#pom-form");
    const errEl = overlay.querySelector("#pom-error");
    const submitBtn = overlay.querySelector("#pom-submit");

    function showErr(msg) {
      if (!errEl) return;
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    function hideErr() {
      if (!errEl) return;
      errEl.hidden = true;
      errEl.textContent = "";
    }

    function cleanup() {
      try {
        stopDdListen();
      } catch (_) {
        /* ignore */
      }
      profileModalVisible = false;
      overlay.remove();
      document.body.classList.remove("modal-open");
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideErr();

      const firstName = sanitizeText(overlay.querySelector("#pom-first-name")?.value, 100);
      const lastName = sanitizeText(overlay.querySelector("#pom-last-name")?.value, 100);
      const phoneRaw = (overlay.querySelector("#pom-phone")?.value || "").replace(/\s|-/g, "").trim();
      const dni = (overlay.querySelector("#pom-dni")?.value || "").trim().replace(/\D/g, "");
      const city = sanitizeText(overlay.querySelector("#pom-city")?.value, 100);
      const province = sanitizeText(overlay.querySelector("#pom-province")?.value, 100);
      const address = sanitizeText(overlay.querySelector("#pom-address")?.value, 500);

      try {
        if (!firstName || firstName.length < 2) throw new Error("El nombre debe tener al menos 2 caracteres");
        if (!lastName || lastName.length < 2) throw new Error("El apellido debe tener al menos 2 caracteres");
        if (!dni || dni.length < 7 || dni.length > 8) throw new Error("DNI: 7 u 8 dígitos");
        if (!validatePhone(phoneRaw)) throw new Error("Teléfono: código de área + número (8 a 10 dígitos)");
        if (!province || !ARGENTINA_PROVINCES.includes(province)) throw new Error("Elegí una provincia válida");
        if (!city || city.length < 2) throw new Error("La localidad es obligatoria (podés escribirla aunque no esté en la lista)");
        if (!address || address.length < 4) throw new Error("La dirección es obligatoria");

        submitBtn.disabled = true;
        submitBtn.textContent = "Guardando…";

        const user = session.user;
        const formattedPhone = formatPhone(phoneRaw);

        let customerNumber = null;
        let qrCode = null;
        let publicSalesCustomerId = null;

        const { data: linkResult, error: linkError } = await supabase.rpc(
          "rpc_link_public_sales_customer",
          {
            p_user_id: user.id,
            p_email: user.email,
            p_dni: dni,
            p_phone: formattedPhone,
            p_province: province,
            p_city: city,
          }
        );

        if (!linkError && linkResult?.found) {
          customerNumber = linkResult.customer_number;
          if (linkResult.source === "public_sales") {
            qrCode = linkResult.qr_code;
            publicSalesCustomerId = linkResult.public_sales_customer_id;
          }
        }

        const payload = {
          full_name: `${firstName} ${lastName}`.trim(),
          phone: formattedPhone,
          dni,
          province,
          city,
          email: user.email,
          address,
        };

        if (linkResult?.found && linkResult.source === "admin_orders" && linkResult.address && !address) {
          payload.address = linkResult.address;
        }

        if (customerNumber) {
          payload.customer_number = customerNumber;
          if (qrCode) payload.qr_code = qrCode;
          if (publicSalesCustomerId) payload.public_sales_customer_id = publicSalesCustomerId;
        }

        const { data: rpcResult, error: rpcError } = await supabase.rpc("rpc_upsert_customer", {
          p_full_name: payload.full_name,
          p_address: payload.address || null,
          p_city: payload.city,
          p_province: payload.province,
          p_phone: payload.phone,
          p_dni: payload.dni,
          p_email: payload.email,
          p_customer_number: payload.customer_number || null,
          p_qr_code: payload.qr_code || null,
          p_public_sales_customer_id: payload.public_sales_customer_id || null,
        });

        if (rpcError) throw new Error(rpcError.message || "Error al guardar");
        if (!rpcResult?.success) throw new Error(rpcResult?.error || "Error al guardar");

        cleanup();
        options.onComplete?.();
        resolve(true);
      } catch (err) {
        console.error("profile-onboarding-modal:", err);
        showErr(err.message || "No se pudo guardar");
        submitBtn.disabled = false;
        submitBtn.textContent = "Guardar y continuar";
      }
    });

    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") e.preventDefault();
    });
  });
}
