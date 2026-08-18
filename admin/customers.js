// admin/customers.js
// Gestión de clientes en el panel de admin

console.log("📦 Módulo customers.js cargado");

import { supabase as supabaseClient } from "../scripts/supabase-client.js?v=m260607";
import { preloadAuthState, can, isAdminUser } from "./auth-state.js?v=m260607";
import { createScreenScope } from "../scripts/net/screen-scope.js";
import { wrapSupabase, createAbortScope, FYL_ERROR_KIND, classifyError } from "../scripts/net/fyl-fetch.js";
import {
  normalizeDniInput,
  isValidDni,
  formatDniDisplay,
  DNI_VALIDATION_MESSAGE,
} from "../scripts/utils/dni.js?v=m260607";

/**
 * Scope de clientes: libera el estado "usable" cuando el buscador está
 * operativo y el usuario puede buscar o crear clientes.
 *
 * Punto usable: después de reemplazar el placeholder "Cargando clientes..."
 * por "Escribe en el campo..." y enganchar los listeners, AUNQUE la
 * verificación de auth/permisos siga corriendo en segundo plano.
 *
 * onFirstPaint: asegura que el contenedor muestra el estado correcto.
 * onReady: auth y permisos verificados, pantalla completamente garantizada.
 */
const customersScope = createScreenScope("admin-customers", {
  onFirstPaint({ reason }) {
    // El placeholder ya fue insertado antes de llamar aquí.
    // Habilitamos explícitamente el input de búsqueda en caso de que haya
    // quedado deshabilitado por algún path previo.
    const searchInput = document.getElementById("customer-search");
    if (searchInput) searchInput.disabled = false;
    globalThis.markBootStage?.("admin-customers.ui_usable", { reason });
  },
  onReady({ reason }) {
    globalThis.markBootStage?.("admin-customers.auth_verified", { reason });
  },
});

let supabase = supabaseClient;
let editingCustomerId = null;
let searchTimeout = null;
/** Última búsqueda no vacía; sirve para refrescar la lista tras guardar o eliminar. */
let lastCustomerSearchQuery = "";

/**
 * AbortScope de búsqueda: independiente del lifecycle de la pantalla.
 * Cada nueva búsqueda aborta la anterior para evitar que resultados tardíos
 * pisen el DOM de una búsqueda más reciente.
 */
let _activeSearchAbortScope = null;

/**
 * Guard numérico de race condition: solo el seq más alto puede mutar
 * el contenedor de resultados.
 */
let _searchSeq = 0;

console.log("📦 Imports de customers.js completados");

// Provincias y ciudades argentinas para autocomplete
// Importar datos completos de ciudades
import { PROVINCE_CITIES_DATA } from './argentina-cities-data.js';

// Provincias y ciudades argentinas para autocomplete
const PROVINCE_CITIES = PROVINCE_CITIES_DATA;

const ARGENTINA_PROVINCES = Object.keys(PROVINCE_CITIES).sort();

const MAX_ADDITIONAL_NAMES = 3;

/**
 * Normaliza texto de ubicación (provincia/ciudad) para comparar sin
 * distinguir tildes ni mayúsculas/minúsculas. Esto evita que clientes ya
 * guardados con acentos (ej. "Córdoba") queden bloqueados porque el listado
 * de ciudades usa las claves sin acentos (ej. "Cordoba").
 */
function normalizeLocationText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/** Busca la clave real de PROVINCE_CITIES que corresponde a un valor guardado, ignorando tildes/mayúsculas. */
function findProvinceKey(provinceValue) {
  if (!provinceValue) return null;
  const target = normalizeLocationText(provinceValue);
  return ARGENTINA_PROVINCES.find((key) => normalizeLocationText(key) === target) || null;
}

/** Verifica si una ciudad pertenece a la lista de una provincia, ignorando tildes/mayúsculas. */
function cityBelongsToProvince(cityValue, provinceKey) {
  if (!cityValue || !provinceKey) return false;
  const cities = PROVINCE_CITIES[provinceKey] || [];
  const target = normalizeLocationText(cityValue);
  return cities.some((city) => normalizeLocationText(city) === target);
}

/** Evita autocompletado y aviso "Guardar dirección" de Chrome en el modal de clientes. */
function armCustomerFormAntiAutofill(root, { skipReadonly = false } = {}) {
  const scope = root || document.getElementById("customer-form");
  if (!scope) return;

  scope.querySelectorAll("input:not([type='hidden']):not([type='button']):not([type='submit']), textarea, select").forEach((el) => {
    el.setAttribute("autocomplete", "new-password");
    el.setAttribute("data-lpignore", "true");
    el.setAttribute("data-1p-ignore", "true");
    el.setAttribute("data-form-type", "other");

    if (typeof el._fylAutofillUnlock === "function") {
      el.removeEventListener("focus", el._fylAutofillUnlock);
      el.removeEventListener("pointerdown", el._fylAutofillUnlock);
      el._fylAutofillUnlock = null;
    }

    if (skipReadonly) {
      el.readOnly = false;
      return;
    }

    el.readOnly = true;
    const unlock = () => {
      el.readOnly = false;
    };
    el._fylAutofillUnlock = unlock;
    el.addEventListener("focus", unlock, { once: true });
    el.addEventListener("pointerdown", unlock, { once: true });
  });
}

function resetCustomerFormInputLocks(form) {
  const scope = form || document.getElementById("customer-form");
  if (!scope) return;

  scope.querySelectorAll("input, textarea, select").forEach((el) => {
    el.readOnly = false;
    if (typeof el._fylAutofillUnlock === "function") {
      el.removeEventListener("focus", el._fylAutofillUnlock);
      el.removeEventListener("pointerdown", el._fylAutofillUnlock);
      el._fylAutofillUnlock = null;
    }
  });
}

function dismissCustomerFormAutofillPrompt() {
  document.activeElement?.blur?.();
  const form = document.getElementById("customer-form");
  if (form) form.reset();
}

function splitPersonFullName(fullName) {
  const full = String(fullName || "").trim();
  if (!full) return { firstName: "", lastName: "" };
  const parts = full.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  const lastName = parts.pop();
  return { firstName: parts.join(" "), lastName };
}

function parseAdditionalNames(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .slice(0, MAX_ADDITIONAL_NAMES)
    .map((entry) => {
      let firstName = String(entry?.first_name || "").trim();
      let lastName = String(entry?.last_name || "").trim();
      if (!firstName && !lastName) {
        const legacyName = String(entry?.name || entry?.full_name || "").trim();
        if (legacyName) {
          const split = splitPersonFullName(legacyName);
          firstName = split.firstName;
          lastName = split.lastName;
        }
      }
      return {
        firstName,
        lastName,
        dni: String(entry?.dni || "").trim(),
      };
    })
    .filter((entry) => entry.firstName || entry.lastName || entry.dni);
}

function getAdditionalNamesElements() {
  return {
    modalContent: document.getElementById("customer-modal-content"),
    panel: document.getElementById("additional-names-panel"),
    list: document.getElementById("additional-names-list"),
    addBtn: document.getElementById("add-additional-name-btn"),
    hint: document.getElementById("additional-names-hint"),
  };
}

function resetAdditionalNamesPanel() {
  const { modalContent, panel, list, addBtn, hint } = getAdditionalNamesElements();
  if (list) list.innerHTML = "";
  if (panel) panel.hidden = true;
  if (modalContent) modalContent.classList.remove("is-expanded");
  if (addBtn) {
    addBtn.disabled = false;
    addBtn.textContent = "+ Agregar nombre";
  }
  if (hint) hint.textContent = "Hasta 3 sub-nombres (nombre, apellido y DNI)";
}

function updateAdditionalNamesControls() {
  const { modalContent, panel, list, addBtn, hint } = getAdditionalNamesElements();
  const count = list?.children.length || 0;
  const hasEntries = count > 0;

  if (panel) panel.hidden = !hasEntries;
  if (modalContent) modalContent.classList.toggle("is-expanded", hasEntries);
  if (addBtn) {
    addBtn.disabled = count >= MAX_ADDITIONAL_NAMES;
    addBtn.textContent = count >= MAX_ADDITIONAL_NAMES
      ? "Máximo alcanzado (3)"
      : "+ Agregar nombre";
  }
  if (hint) {
    hint.textContent = hasEntries
      ? `${count} de ${MAX_ADDITIONAL_NAMES} sub-nombres`
      : "Hasta 3 sub-nombres (nombre, apellido y DNI)";
  }
}

function addAdditionalNameEntry(firstName = "", lastName = "", dni = "") {
  const { list } = getAdditionalNamesElements();
  if (!list || list.children.length >= MAX_ADDITIONAL_NAMES) return;

  const index = list.children.length + 1;
  const entry = document.createElement("div");
  entry.className = "additional-name-entry";
  entry.innerHTML = `
    <div class="additional-name-entry-header">
      <span>Sub-nombre ${index}</span>
      <button type="button" class="additional-name-remove" aria-label="Quitar sub-nombre ${index}">&times;</button>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Nombre</label>
        <input
          type="text"
          class="additional-first-name-input"
          name="fyl-additional-given-name"
          placeholder="Ej: María"
          value="${escapeAttr(firstName)}"
          autocomplete="new-password"
          autocapitalize="off"
          spellcheck="false"
          data-lpignore="true"
          data-1p-ignore="true"
        />
      </div>
      <div class="form-group">
        <label>Apellido</label>
        <input
          type="text"
          class="additional-last-name-input"
          name="fyl-additional-family-name"
          placeholder="Ej: Gómez"
          value="${escapeAttr(lastName)}"
          autocomplete="new-password"
          autocapitalize="off"
          spellcheck="false"
          data-lpignore="true"
          data-1p-ignore="true"
        />
      </div>
    </div>
    <div class="form-group">
      <label>DNI / CUIT (opcional)</label>
      <input
        type="text"
        class="additional-dni-input"
        name="fyl-additional-doc-id"
        inputmode="numeric"
        placeholder="Ej: 12345678 o 20-37262546-6"
        value="${escapeAttr(formatDniDisplay(dni))}"
        pattern="[0-9\\-]{7,13}"
        title="${escapeAttr(DNI_VALIDATION_MESSAGE)}"
        autocomplete="new-password"
        autocapitalize="off"
        spellcheck="false"
        data-lpignore="true"
        data-1p-ignore="true"
      />
    </div>
  `;

  list.appendChild(entry);
  bindDniInputFormatting(entry.querySelector(".additional-dni-input"));
  armCustomerFormAntiAutofill(entry);
  updateAdditionalNamesControls();
  entry.querySelector(".additional-first-name-input")?.focus();
}

function renumberAdditionalNameEntries() {
  const { list } = getAdditionalNamesElements();
  if (!list) return;
  list.querySelectorAll(".additional-name-entry").forEach((entry, idx) => {
    const label = entry.querySelector(".additional-name-entry-header span");
    const removeBtn = entry.querySelector(".additional-name-remove");
    const number = idx + 1;
    if (label) label.textContent = `Sub-nombre ${number}`;
    if (removeBtn) removeBtn.setAttribute("aria-label", `Quitar sub-nombre ${number}`);
  });
}

function collectAdditionalNamesFromForm() {
  const { list } = getAdditionalNamesElements();
  if (!list) return [];

  const entries = [];
  list.querySelectorAll(".additional-name-entry").forEach((entry) => {
    const firstName = entry.querySelector(".additional-first-name-input")?.value?.trim() || "";
    const lastName = entry.querySelector(".additional-last-name-input")?.value?.trim() || "";
    const dni = entry.querySelector(".additional-dni-input")?.value?.trim() || "";
    if (!firstName && !lastName && !dni) return;
    entries.push({
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName} ${lastName}`.trim(),
      dni: dni ? normalizeDniInput(dni) : null,
    });
  });
  return entries;
}

function validateAdditionalNames(entries, errorDiv) {
  if (entries.length > MAX_ADDITIONAL_NAMES) {
    if (errorDiv) {
      errorDiv.textContent = `Solo se permiten hasta ${MAX_ADDITIONAL_NAMES} nombres adicionales`;
      errorDiv.style.display = "block";
    }
    return false;
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.first_name || !entry.last_name) {
      if (errorDiv) {
        errorDiv.textContent = `El sub-nombre ${i + 1} requiere nombre y apellido`;
        errorDiv.style.display = "block";
      }
      return false;
    }
    if (entry.dni && !isValidDni(entry.dni)) {
      if (errorDiv) {
        errorDiv.textContent = `El documento del sub-nombre ${i + 1} no es válido. ${DNI_VALIDATION_MESSAGE}`;
        errorDiv.style.display = "block";
      }
      return false;
    }
  }

  return true;
}

function bindDniInputFormatting(input) {
  if (!input || input.dataset.dniFormatBound === "1") return;
  input.dataset.dniFormatBound = "1";
  input.addEventListener("blur", () => {
    const normalized = normalizeDniInput(input.value);
    input.value = normalized ? formatDniDisplay(normalized) : "";
  });
}

function bindAllCustomerDniInputs() {
  bindDniInputFormatting(document.getElementById("customer-dni"));
  document.querySelectorAll(".additional-dni-input").forEach(bindDniInputFormatting);
}

function setupAdditionalNamesUI() {
  const { addBtn, list } = getAdditionalNamesElements();
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = "1";
    addBtn.addEventListener("click", () => addAdditionalNameEntry());
  }
  if (list && !list.dataset.bound) {
    list.dataset.bound = "1";
    list.addEventListener("click", (e) => {
      const removeBtn = e.target.closest(".additional-name-remove");
      if (!removeBtn) return;
      removeBtn.closest(".additional-name-entry")?.remove();
      renumberAdditionalNameEntries();
      updateAdditionalNamesControls();
    });
  }
}

function loadAdditionalNamesIntoForm(raw) {
  resetAdditionalNamesPanel();
  parseAdditionalNames(raw).forEach((entry) => {
    addAdditionalNameEntry(entry.firstName, entry.lastName, entry.dni || "");
  });
}

// Funciones de formato de teléfono
function validatePhone(phone) {
  if (!phone) return false;
  let cleaned = phone.replace(/^\+54\s?/i, "");
  cleaned = cleaned.replace(/[\s\-\(\)]/g, "");
  if (cleaned.startsWith("9")) {
    cleaned = cleaned.substring(1);
  }
  return /^\d{8,10}$/.test(cleaned);
}

function formatPhone(phone) {
  if (!phone) return "";
  let cleaned = phone.replace(/^\+54\s?/i, "");
  cleaned = cleaned.replace(/[\s\-\(\)]/g, "");
  if (!cleaned.startsWith("9") && cleaned.length >= 8) {
    cleaned = "9" + cleaned;
  }
  if (cleaned.length >= 10) {
    const match = cleaned.match(/^9?(\d{2,4})(\d{6,8})$/);
    if (match) {
      const areaCode = match[1];
      const number = match[2];
      const formattedNumber = number.length > 4
        ? `${number.slice(0, -4)}-${number.slice(-4)}`
        : number;
      return `+54 9 ${areaCode} ${formattedNumber}`;
    }
  }
  return `+54 ${cleaned}`;
}

function unformatPhone(phone) {
  if (!phone) return "";
  let cleaned = phone.replace(/^\+54\s?/i, "");
  cleaned = cleaned.replace(/\s/g, "");
  cleaned = cleaned.replace(/-/g, "");
  return cleaned;
}

function escapeAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

// Función helper para obtener icono y texto según el estado de registro/combinación
function getAuthProviderBadge(authProvider, customerId) {
  // Si fue creado por admin, no tiene usuario registrado
  if (authProvider === 'admin') {
    return {
      icon: '👤',
      text: 'Creado por Admin',
      class: 'auth-badge-admin',
      registered: false
    };
  }

  // Si tiene auth_provider (google, email, magiclink), significa que se registró y se combinó
  if (authProvider && authProvider !== 'admin') {
    return {
      icon: '✅',
      text: 'Registrado y Combinado',
      class: 'auth-badge-registered'
    };
  }

  // Si no tiene auth_provider pero tiene id que podría estar en auth.users, verificar
  // Por ahora, si no tiene auth_provider, asumimos que no está registrado/combinado
  return {
    icon: '⚠️',
    text: 'No Registrado',
    class: 'auth-badge-not-registered'
  };
}

// Función para obtener supabase
async function getSupabase() {
  if (supabase) return supabase;
  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }

  let attempts = 0;
  const maxAttempts = 50;
  while (!window.supabase && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }

  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }

  try {
    const module = await import("../scripts/supabase-client.js?v=m260607");
    supabase = module.supabase || window.supabase;
    if (!supabase) {
      await new Promise(resolve => setTimeout(resolve, 500));
      supabase = module.supabase || window.supabase;
    }
    if (supabase && !window.supabase) {
      window.supabase = supabase;
    }
    return supabase;
  } catch (error) {
    console.error("❌ Error importando supabase-client:", error);
    return null;
  }
}

// Inicializar autocomplete de provincias y ciudades
function initializeAutocomplete() {
  const provinceInput = document.getElementById("customer-province");
  const provinceDropdown = document.getElementById("province-dropdown");
  const cityInput = document.getElementById("customer-city");
  const cityDropdown = document.getElementById("city-dropdown");

  if (!provinceInput || !provinceDropdown || !cityInput || !cityDropdown) return;

  provinceInput.addEventListener("input", (e) => {
    handleProvinceInput(e.target.value);
  });

  provinceInput.addEventListener("focus", () => {
    if (provinceInput.value.length > 0) {
      handleProvinceInput(provinceInput.value);
    }
  });

  cityInput.addEventListener("input", (e) => {
    if (!cityInput.disabled) {
      handleCityInput(e.target.value);
    }
  });

  cityInput.addEventListener("focus", () => {
    if (!cityInput.disabled && cityInput.value.length > 0) {
      handleCityInput(cityInput.value);
    }
  });

  document.addEventListener("click", (e) => {
    if (provinceInput && !provinceInput.contains(e.target) && provinceDropdown && !provinceDropdown.contains(e.target)) {
      provinceDropdown.style.display = "none";
    }
    if (cityInput && !cityInput.contains(e.target) && cityDropdown && !cityDropdown.contains(e.target)) {
      cityDropdown.style.display = "none";
    }
  });
}

function handleProvinceInput(value) {
  const provinceInput = document.getElementById("customer-province");
  const provinceDropdown = document.getElementById("province-dropdown");
  const cityInput = document.getElementById("customer-city");

  if (!provinceInput || !provinceDropdown || !cityInput) return;

  const query = value.toLowerCase().trim();

  if (query.length === 0) {
    provinceDropdown.style.display = "none";
    return;
  }

  const matches = ARGENTINA_PROVINCES.filter(p =>
    p.toLowerCase().includes(query)
  );

  if (matches.length === 0) {
    provinceDropdown.style.display = "none";
    return;
  }

  provinceDropdown.innerHTML = matches.map(province => `
    <div class="custom-dropdown-item" data-value="${province}">${province}</div>
  `).join("");

  provinceDropdown.style.display = "block";

  provinceDropdown.querySelectorAll(".custom-dropdown-item").forEach(item => {
    item.addEventListener("click", () => {
      provinceInput.value = item.dataset.value;
      provinceDropdown.style.display = "none";
      updateCitiesList(item.dataset.value);
      cityInput.disabled = false;
      cityInput.placeholder = "Escriba para buscar ciudad...";
      cityInput.value = "";
    });
  });
}

function updateCitiesList(province) {
  const cityInput = document.getElementById("customer-city");
  const cityDropdown = document.getElementById("city-dropdown");

  if (!cityInput || !cityDropdown) return;

  const cities = PROVINCE_CITIES[province] || [];
  cityInput.dataset.availableCities = JSON.stringify(cities);
}

function handleCityInput(value) {
  const cityInput = document.getElementById("customer-city");
  const cityDropdown = document.getElementById("city-dropdown");

  if (!cityInput || !cityDropdown || cityInput.disabled) return;

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

  const matches = availableCities.filter(city =>
    city.toLowerCase().includes(query)
  );

  if (matches.length === 0) {
    cityDropdown.style.display = "none";
    return;
  }

  cityDropdown.innerHTML = matches.map(city => `
    <div class="custom-dropdown-item" data-value="${city}">${city}</div>
  `).join("");

  cityDropdown.style.display = "block";

  cityDropdown.querySelectorAll(".custom-dropdown-item").forEach(item => {
    item.addEventListener("click", () => {
      cityInput.value = item.dataset.value;
      cityDropdown.style.display = "none";
    });
  });
}

// Mostrar mensaje
function showMessage(message, type = "success") {
  const container = document.getElementById("message-container");
  if (!container) return;

  container.innerHTML = `<div class="message ${type}">${message}</div>`;

  if (type === "success") {
    setTimeout(() => {
      container.innerHTML = "";
    }, 3000);
  }
}

/**
 * Carga clientes por término de búsqueda.
 *
 * Fase 2:
 *  - wrapSupabase con signal + retry:1.
 *  - AbortScope propio por invocación (_activeSearchAbortScope).
 *  - Guard numérico (_searchSeq) para descartar resultados tardíos.
 *  - Sin re-verificación de auth en cada búsqueda (ya verificada en boot).
 *  - Errores de red → banner no bloqueante, sin "sin resultados".
 *  - Auth / permission → actuar solo si el servidor lo confirmó.
 */
async function loadCustomers(searchQuery = "") {
  const container = document.getElementById("customers-container");
  if (!container) return;

  // Sin query: mostrar placeholder, sin tocar scopes ni sequencia.
  if (!searchQuery || !searchQuery.trim()) {
    container.innerHTML = '<div class="empty-state"><p>Escribe en el campo de búsqueda para ver los clientes</p></div>';
    return;
  }

  // — Abort de la búsqueda anterior, scope propio para esta invocación —
  if (_activeSearchAbortScope) _activeSearchAbortScope.abort("new_search");
  const myScope = createAbortScope();
  _activeSearchAbortScope = myScope;
  const signal = myScope.signal;
  const mySeq = ++_searchSeq;

  /** true si esta búsqueda fue superada o abortada. */
  function isStale() { return mySeq !== _searchSeq || signal.aborted; }

  lastCustomerSearchQuery = searchQuery.trim();
  container.innerHTML = '<div class="loading">Buscando clientes...</div>';

  const db = await getSupabase();
  if (!db) {
    if (isStale()) return;
    container.innerHTML = '<div class="empty-state"><p>Error: No se pudo conectar con la base de datos.</p></div>';
    return;
  }

  const searchPattern = `%${searchQuery.trim()}%`;

  const result = await wrapSupabase(
    () => db
      .from("customers")
      .select("id, customer_number, full_name, dni, phone, email, city, province, address, auth_provider")
      .or(`full_name.ilike.${searchPattern},dni.ilike.${searchPattern},phone.ilike.${searchPattern},email.ilike.${searchPattern},customer_number.ilike.${searchPattern}`)
      .order("full_name", { ascending: true })
      .limit(100),
    { retries: 1, signal, label: "customers.search" }
  );

  if (isStale()) return;
  if (result.aborted) return;

  if (result.error) {
    const kind = result.kind;
    if (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) {
      // Error de red: no mostrar "sin resultados" — sería engañoso.
      container.innerHTML = `
        <div class="empty-state" style="display:flex;flex-direction:column;align-items:center;gap:10px;">
          <p style="color:#c00;margin:0;">Sin conexión. Verificá tu red e intentá de nuevo.</p>
          <button onclick="loadCustomers(lastCustomerSearchQuery)" style="padding:8px 14px;border:1px solid #c00;border-radius:6px;background:#fff;color:#c00;cursor:pointer;font-size:13px;">Reintentar</button>
        </div>`;
      return;
    }
    if (kind === FYL_ERROR_KIND.AUTH) {
      window.location.href = "./index.html";
      return;
    }
    // Permission / unknown: mostrar el error real sin inventar causa.
    const errorMessage = result.error.message || "Error desconocido";
    console.error("❌ Error cargando clientes:", result.error, "kind:", kind);
    container.innerHTML = `
      <div class="empty-state">
        <p><strong>Error al cargar clientes:</strong></p>
        <p style="color:#d32f2f;margin:8px 0;">${errorMessage}</p>
        <p style="font-size:12px;color:#666;">Código: ${result.error.code || 'N/A'}</p>
      </div>`;
    return;
  }

  const data = result.data || [];

  if (data.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No se encontraron clientes que coincidan con "${searchQuery}"</p></div>`;
    return;
  }

  container.innerHTML = data.map(customer => {
    const authBadge = getAuthProviderBadge(customer.auth_provider, customer.id);
    const safeName = escapeAttr(customer.full_name || "Sin nombre");
    return `
    <div class="customer-card">
      <div class="customer-header">
        <div class="customer-info">
          <h3>
            ${customer.full_name || "Sin nombre"}
            ${customer.customer_number ? `<span class="customer-number">#${customer.customer_number}</span>` : ""}
            <span class="auth-provider-badge ${authBadge.class}" title="${authBadge.text}">
              ${authBadge.icon} ${authBadge.text}
            </span>
          </h3>
          <p>
            ${customer.dni ? `DNI: ${formatDniDisplay(customer.dni)} • ` : ""}
            ${customer.phone ? `Tel: ${customer.phone}` : ""}
          </p>
          <p>
            ${customer.email || ""}
            ${customer.city && customer.province ? ` • ${customer.city}, ${customer.province}` : ""}
          </p>
        </div>
        <div class="actions">
          <button type="button" class="btn-primary customer-btn-edit" data-customer-id="${customer.id}">
            Editar
          </button>
          <div class="customer-menu-wrap" data-customer-id="${customer.id}" data-customer-name="${safeName}">
            <button type="button" class="btn-icon-menu" aria-haspopup="true" aria-expanded="false" aria-label="Más opciones del cliente">⋯</button>
            <div class="customer-menu-dropdown" role="menu">
              <button type="button" class="customer-menu-item customer-menu-delete" role="menuitem">
                Eliminar cliente
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }).join("");
}

// Buscar clientes (con debounce de 300 ms)
function searchCustomers(query) {
  clearTimeout(searchTimeout);

  // Sin query: abortar búsqueda anterior y mostrar placeholder sin red.
  if (!query || query.trim() === "") {
    if (_activeSearchAbortScope) {
      _activeSearchAbortScope.abort("query_cleared");
      _activeSearchAbortScope = null;
    }
    ++_searchSeq; // invalida cualquier resultado en vuelo
    const container = document.getElementById("customers-container");
    if (container) {
      container.innerHTML = '<div class="empty-state"><p>Escribe en el campo de búsqueda para ver los clientes</p></div>';
    }
    return;
  }

  // Con query: esperar 300 ms antes de disparar la búsqueda real.
  searchTimeout = setTimeout(() => {
    loadCustomers(query);
  }, 300);
}

// Abrir modal para crear cliente
function openCreateCustomerModal() {
  editingCustomerId = null;
  const modal = document.getElementById("customer-modal");
  const modalTitle = document.getElementById("modal-title");
  const form = document.getElementById("customer-form");

  if (modalTitle) modalTitle.textContent = "Crear Nuevo Cliente";
  if (form) form.reset();

  // Resetear campos
  const cityInput = document.getElementById("customer-city");
  if (cityInput) {
    cityInput.disabled = true;
    cityInput.placeholder = "Seleccione provincia primero...";
  }

  resetAdditionalNamesPanel();

  if (modal) modal.classList.add("active");
  armCustomerFormAntiAutofill(form);
  initializeAutocomplete();
  bindAllCustomerDniInputs();
}

// Abrir modal para editar cliente
async function editCustomer(customerId) {
  editingCustomerId = customerId;
  const modal = document.getElementById("customer-modal");
  const modalTitle = document.getElementById("modal-title");
  const form = document.getElementById("customer-form");

  if (modalTitle) modalTitle.textContent = "Editar Cliente";
  if (form) form.reset();

  const db = await getSupabase();
  if (!db) {
    showMessage("Error: No se pudo conectar con la base de datos", "error");
    return;
  }

  try {
    const { data: customer, error } = await db
      .from("customers")
      .select("*")
      .eq("id", customerId)
      .single();

    if (error) throw error;

    if (!customer) {
      showMessage("Cliente no encontrado", "error");
      return;
    }

    // Separar nombre y apellido
    const full = (customer.full_name || "").trim();
    let first = "";
    let last = "";
    if (full) {
      const parts = full.split(/\s+/);
      if (parts.length === 1) {
        first = parts[0];
      } else {
        last = parts.pop();
        first = parts.join(" ");
      }
    }

    // Llenar formulario
    const firstNameInput = document.getElementById("customer-first-name");
    const lastNameInput = document.getElementById("customer-last-name");
    const dniInput = document.getElementById("customer-dni");
    const phoneInput = document.getElementById("customer-phone");
    const emailInput = document.getElementById("customer-email");
    const addressInput = document.getElementById("customer-address");
    const provinceInput = document.getElementById("customer-province");
    const cityInput = document.getElementById("customer-city");

    if (firstNameInput) firstNameInput.value = first;
    if (lastNameInput) lastNameInput.value = last;
    if (dniInput) dniInput.value = formatDniDisplay(customer.dni || "");
    if (phoneInput) phoneInput.value = unformatPhone(customer.phone || "");
    if (emailInput) emailInput.value = customer.email || "";
    if (addressInput) addressInput.value = customer.address || "";
    if (provinceInput) provinceInput.value = customer.province || "";
    if (cityInput) {
      cityInput.value = customer.city || "";
      const matchedProvinceKey = findProvinceKey(customer.province);
      if (matchedProvinceKey) {
        cityInput.disabled = false;
        cityInput.placeholder = "Escriba para buscar ciudad...";
        updateCitiesList(matchedProvinceKey);
      } else {
        cityInput.disabled = true;
        cityInput.placeholder = "Seleccione provincia primero...";
      }
    }

    loadAdditionalNamesIntoForm(customer.additional_names);

    const invoiceFullAmountInput = document.getElementById("customer-invoice-full-amount");
    const invoiceAlwaysAInput = document.getElementById("customer-invoice-always-a");
    if (invoiceFullAmountInput) invoiceFullAmountInput.checked = !!customer.invoice_full_amount;
    if (invoiceAlwaysAInput) invoiceAlwaysAInput.checked = !!customer.invoice_always_a;

    if (modal) modal.classList.add("active");
    armCustomerFormAntiAutofill(form, { skipReadonly: true });
    initializeAutocomplete();
    bindAllCustomerDniInputs();

  } catch (error) {
    console.error("Error cargando cliente:", error);
    showMessage(`Error al cargar cliente: ${error.message}`, "error");
  }
}

// Cerrar modal
function closeCustomerModal() {
  const modal = document.getElementById("customer-modal");
  const errorDiv = document.getElementById("customer-form-error");
  const form = document.getElementById("customer-form");

  dismissCustomerFormAutofillPrompt();
  resetCustomerFormInputLocks(form);
  if (modal) modal.classList.remove("active");
  if (errorDiv) {
    errorDiv.style.display = "none";
    errorDiv.textContent = "";
  }

  resetAdditionalNamesPanel();

  editingCustomerId = null;
}

// Guardar cliente (crear o editar)
async function saveCustomer() {
  const errorDiv = document.getElementById("customer-form-error");
  const saveBtn = document.getElementById("save-customer-btn");

  if (errorDiv) {
    errorDiv.style.display = "none";
    errorDiv.textContent = "";
  }

  const firstName = document.getElementById("customer-first-name")?.value?.trim();
  const lastName = document.getElementById("customer-last-name")?.value?.trim();
  const dniRaw = document.getElementById("customer-dni")?.value?.trim();
  const dni = dniRaw ? normalizeDniInput(dniRaw) : "";
  const phone = document.getElementById("customer-phone")?.value?.trim();
  const email = document.getElementById("customer-email")?.value?.trim();
  const address = document.getElementById("customer-address")?.value?.trim();
  const province = document.getElementById("customer-province")?.value?.trim();
  const city = document.getElementById("customer-city")?.value?.trim();

  // Validaciones
  if (!firstName || !lastName) {
    if (errorDiv) {
      errorDiv.textContent = "Nombre y Apellido son obligatorios";
      errorDiv.style.display = "block";
    }
    return;
  }

  if (!phone) {
    if (errorDiv) {
      errorDiv.textContent = "Teléfono es obligatorio";
      errorDiv.style.display = "block";
    }
    return;
  }

  if (!validatePhone(phone)) {
    if (errorDiv) {
      errorDiv.textContent = "El teléfono debe tener entre 8 y 10 dígitos (código de área + número)";
      errorDiv.style.display = "block";
    }
    return;
  }

  if (!address) {
    if (errorDiv) {
      errorDiv.textContent = "Dirección es obligatoria";
      errorDiv.style.display = "block";
    }
    return;
  }

  if (!province) {
    if (errorDiv) {
      errorDiv.textContent = "Provincia es obligatoria";
      errorDiv.style.display = "block";
    }
    return;
  }

  const matchedProvinceKey = findProvinceKey(province);
  if (!matchedProvinceKey) {
    if (errorDiv) {
      errorDiv.textContent = "La provincia seleccionada no es válida";
      errorDiv.style.display = "block";
    }
    return;
  }

  if (!city) {
    if (errorDiv) {
      errorDiv.textContent = "Ciudad es obligatoria";
      errorDiv.style.display = "block";
    }
    return;
  }

  if (!cityBelongsToProvince(city, matchedProvinceKey)) {
    if (errorDiv) {
      errorDiv.textContent = "La ciudad seleccionada no es válida para la provincia elegida";
      errorDiv.style.display = "block";
    }
    return;
  }

  if (dni && !isValidDni(dni)) {
    if (errorDiv) {
      errorDiv.textContent = DNI_VALIDATION_MESSAGE;
      errorDiv.style.display = "block";
    }
    return;
  }

  const additionalNames = collectAdditionalNamesFromForm();
  if (!validateAdditionalNames(additionalNames, errorDiv)) {
    return;
  }

  if (errorDiv) {
    errorDiv.style.display = "none";
  }

  // Deshabilitar botón durante el guardado
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando...";
  }

  const db = await getSupabase();
  if (!db) {
    showMessage("Error: No se pudo conectar con la base de datos", "error");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar Cliente";
    }
    return;
  }

  try {
    const fullName = `${firstName} ${lastName}`.trim();
    const formattedPhone = formatPhone(phone);
    const invoiceFullAmount = !!document.getElementById("customer-invoice-full-amount")?.checked;
    const invoiceAlwaysA = !!document.getElementById("customer-invoice-always-a")?.checked;

    if (editingCustomerId) {
      // Editar cliente existente usando función RPC para evitar problemas de permisos
      const { data, error } = await db.rpc('rpc_update_admin_customer', {
        p_customer_id: editingCustomerId,
        p_full_name: fullName,
        p_email: email || null,
        p_phone: formattedPhone,
        p_dni: dni || null,
        p_address: address,
        p_city: city,
        p_province: province,
        p_additional_names: additionalNames,
        p_invoice_full_amount: invoiceFullAmount,
        p_invoice_always_a: invoiceAlwaysA
      });

      if (error) throw error;

      if (!data || !data.success) {
        throw new Error(data?.message || 'Error desconocido al actualizar cliente');
      }

      showMessage("Cliente actualizado correctamente", "success");
    } else {
      // Crear nuevo cliente
      const { data, error } = await db.rpc('rpc_create_admin_customer', {
        p_full_name: fullName,
        p_email: email || null,
        p_phone: formattedPhone,
        p_dni: dni || null,
        p_address: address,
        p_city: city,
        p_province: province,
        p_additional_names: additionalNames,
        p_invoice_full_amount: invoiceFullAmount,
        p_invoice_always_a: invoiceAlwaysA
      });

      if (error) throw error;

      if (!data || !data.success) {
        throw new Error(data?.message || data?.error || 'Error desconocido');
      }

      showMessage("Cliente creado correctamente", "success");
    }

    dismissCustomerFormAutofillPrompt();
    closeCustomerModal();
    await loadCustomers(lastCustomerSearchQuery);

  } catch (error) {
    console.error("Error guardando cliente:", error);
    if (errorDiv) {
      errorDiv.textContent = `Error: ${error.message}`;
      errorDiv.style.display = "block";
    }
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar Cliente";
    }
  }
}

function closeAllCustomerCardMenus() {
  document.querySelectorAll(".customer-menu-dropdown.is-open").forEach((el) => {
    el.classList.remove("is-open");
  });
  document.querySelectorAll('.btn-icon-menu[aria-expanded="true"]').forEach((btn) => {
    btn.setAttribute("aria-expanded", "false");
  });
}

function handleCustomersContainerClick(e) {
  const editBtn = e.target.closest(".customer-btn-edit");
  if (editBtn) {
    const id = editBtn.dataset.customerId;
    if (id) editCustomer(id);
    return;
  }

  const menuBtn = e.target.closest(".btn-icon-menu");
  if (menuBtn) {
    e.stopPropagation();
    const wrap = menuBtn.closest(".customer-menu-wrap");
    const dropdown = wrap?.querySelector(".customer-menu-dropdown");
    const isThisOpen = dropdown?.classList.contains("is-open");

    document.querySelectorAll(".customer-menu-dropdown.is-open").forEach((el) => {
      if (el !== dropdown) el.classList.remove("is-open");
    });
    document.querySelectorAll('.btn-icon-menu[aria-expanded="true"]').forEach((btn) => {
      if (btn !== menuBtn) btn.setAttribute("aria-expanded", "false");
    });

    if (dropdown) {
      if (isThisOpen) {
        dropdown.classList.remove("is-open");
        menuBtn.setAttribute("aria-expanded", "false");
      } else {
        dropdown.classList.add("is-open");
        menuBtn.setAttribute("aria-expanded", "true");
      }
    }
    return;
  }

  const delBtn = e.target.closest(".customer-menu-delete");
  if (delBtn) {
    e.stopPropagation();
    const wrap = delBtn.closest(".customer-menu-wrap");
    const id = wrap?.dataset.customerId;
    const name = wrap?.dataset.customerName || "este cliente";
    closeAllCustomerCardMenus();
    if (id) void deleteCustomerById(id, name);
  }
}

function onDocumentClickCloseCustomerMenus(e) {
  if (e.target.closest(".customer-menu-wrap")) return;
  closeAllCustomerCardMenus();
}

async function deleteCustomerById(customerId, displayLabel) {
  const label = displayLabel || "este cliente";
  const ok = window.confirm(
    `¿Eliminar a ${label}?\n\nSe borrarán también pedidos, carritos y datos vinculados a este cliente. Esta acción no se puede deshacer.`
  );
  if (!ok) return;

  const db = await getSupabase();
  if (!db) {
    showMessage("Error: No se pudo conectar con la base de datos", "error");
    return;
  }

  try {
    const { data, error } = await db.rpc("rpc_delete_admin_customer", {
      p_customer_id: customerId
    });

    if (error) throw error;

    if (!data || !data.success) {
      throw new Error(data?.message || "No se pudo eliminar el cliente");
    }

    showMessage(data.message || "Cliente eliminado correctamente", "success");
    await loadCustomers(lastCustomerSearchQuery);
  } catch (err) {
    console.error("Error eliminando cliente:", err);
    showMessage(err.message || "Error al eliminar el cliente", "error");
  }
}

// Exponer función globalmente (p. ej. enlaces legacy)
window.editCustomer = editCustomer;

// Función de inicialización
async function initializeCustomersModule() {
  console.log("🚀 Inicializando módulo de clientes...");

  try {
    const db = await getSupabase();
    if (!db) {
      console.error("❌ No se pudo obtener instancia de Supabase");
      const container = document.getElementById("customers-container");
      if (container) {
        container.innerHTML = '<div class="empty-state"><p>Error: No se pudo conectar con Supabase. Recarga la página.</p></div>';
      }
      return;
    }

    console.log("✅ Instancia de Supabase obtenida");

    // Fase 3: resolver auth/permisos desde auth-state en una sola carga.
    const { user } = await preloadAuthState();
    if (!user) {
      console.warn("⚠️ Sin sesión local, redirigiendo a login");
      window.location.href = "./index.html";
      return;
    }
    console.log("✅ Sesión local verificada:", user.email);

    const canViewCustomers = can("customers", "view");
    const hasAdminProfile = isAdminUser();
    if (!canViewCustomers && !hasAdminProfile) {
      console.error("❌ Usuario no es admin");
      const container = document.getElementById("customers-container");
      if (container) {
        container.innerHTML = `<div class="empty-state"><p>No tienes permisos de administrador para acceder a esta página.</p></div>`;
      }
      return;
    }
    console.log("✅ Permisos de customers/admin verificados");

    // La query de test RLS fue eliminada: bloqueaba el boot sin aportar valor en producción.
    // Si hay un problema de RLS, aparecerá en la primera búsqueda real del usuario.

    // No cargar clientes automáticamente, solo cuando se busque
    const container = document.getElementById("customers-container");
    if (container) {
      container.innerHTML = '<div class="empty-state"><p>Escribe en el campo de búsqueda para ver los clientes</p></div>';
    }

    // Event listeners
    console.log("🔧 Configurando event listeners...");
    const searchInput = document.getElementById("customer-search");
    const newCustomerBtn = document.getElementById("new-customer-btn");
    const modalClose = document.getElementById("modal-close");
    const cancelBtn = document.getElementById("cancel-customer-btn");
    const customerForm = document.getElementById("customer-form");

    console.log("🔍 Elementos encontrados:", {
      searchInput: !!searchInput,
      newCustomerBtn: !!newCustomerBtn,
      modalClose: !!modalClose,
      cancelBtn: !!cancelBtn,
      customerForm: !!customerForm
    });

    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        console.log("🔎 Búsqueda:", e.target.value);
        searchCustomers(e.target.value);
      });
      console.log("✅ Event listener de búsqueda configurado");
    } else {
      console.error("❌ No se encontró el input de búsqueda");
    }

    if (newCustomerBtn) {
      newCustomerBtn.addEventListener("click", () => {
        console.log("➕ Botón Nuevo Cliente clickeado");
        openCreateCustomerModal();
      });
      console.log("✅ Event listener de nuevo cliente configurado");
    } else {
      console.error("❌ No se encontró el botón Nuevo Cliente");
    }

    if (modalClose) {
      modalClose.addEventListener("click", closeCustomerModal);
      console.log("✅ Event listener de cerrar modal configurado");
    } else {
      console.warn("⚠️ No se encontró el botón de cerrar modal (puede ser normal si el modal usa otro ID)");
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", closeCustomerModal);
      console.log("✅ Event listener de cancelar configurado");
    } else {
      console.warn("⚠️ No se encontró el botón cancelar");
    }

    if (customerForm) {
      customerForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        console.log("💾 Formulario enviado");
        await saveCustomer();
      });
      console.log("✅ Event listener de formulario configurado");
    } else {
      console.warn("⚠️ No se encontró el formulario de cliente");
    }

    console.log("✅ Todos los event listeners configurados");

    setupAdditionalNamesUI();

    // Primer paint: buscador operativo + listeners activos. Auth ya fue
    // verificado antes de llegar aquí, así que markFirstPaint coincide con
    // el punto donde el usuario puede buscar, crear y ver clientes.
    customersScope.markFirstPaint("search_ready");

    // Cerrar modal al hacer clic fuera
    const modal = document.getElementById("customer-modal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) {
          closeCustomerModal();
        }
      });
    }

    // Cerrar con ESC
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeAllCustomerCardMenus();
        closeCustomerModal();
      }
    });

    const customersContainer = document.getElementById("customers-container");
    if (customersContainer) {
      customersContainer.addEventListener("click", handleCustomersContainerClick);
    }
    document.addEventListener("click", onDocumentClickCloseCustomerMenus);

    // Pantalla lista: auth + permisos verificados, todos los listeners activos.
    customersScope.markReady("auth_and_listeners_ready");

  } catch (error) {
    console.error("❌ Error en inicialización:", error);
    // Emitir first paint aunque sea con error para no dejar el scope colgado.
    customersScope.markFirstPaint("init_error");
    const container = document.getElementById("customers-container");
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <p><strong>Error al inicializar el módulo:</strong></p>
          <p style="color: #d32f2f; margin: 8px 0;">${error.message || 'Error desconocido'}</p>
          <p style="font-size: 12px; color: #666; margin-top: 8px;">
            Revisa la consola del navegador (F12) para más detalles.
          </p>
        </div>
      `;
    }
  }
}

// Inicializar cuando el DOM esté listo o inmediatamente si ya está listo
function startInitialization() {
  console.log("⏳ Estado del DOM:", document.readyState);
  if (document.readyState === 'loading') {
    console.log("⏳ Esperando DOMContentLoaded...");
    document.addEventListener("DOMContentLoaded", initializeCustomersModule);
  } else {
    // DOM ya está listo, ejecutar después de un pequeño delay para asegurar que los módulos estén cargados
    console.log("⏳ DOM listo, ejecutando inicialización...");
    setTimeout(() => {
      initializeCustomersModule();
    }, 100);
  }
}

// Iniciar
startInitialization();

