// admin/customers.js
// Gestión de clientes en el panel de admin

console.log("📦 Módulo customers.js cargado");

import { supabase as supabaseClient } from "../scripts/supabase-client.js";
import { requireAdminAuth, isAdmin } from "./permissions-helper.js";

let supabase = supabaseClient;
let editingCustomerId = null;
let searchTimeout = null;
/** Última búsqueda no vacía; sirve para refrescar la lista tras guardar o eliminar. */
let lastCustomerSearchQuery = "";

console.log("📦 Imports de customers.js completados");

// Provincias y ciudades argentinas para autocomplete
// Importar datos completos de ciudades
import { PROVINCE_CITIES_DATA } from './argentina-cities-data.js';

// Provincias y ciudades argentinas para autocomplete
const PROVINCE_CITIES = PROVINCE_CITIES_DATA;

const ARGENTINA_PROVINCES = Object.keys(PROVINCE_CITIES).sort();

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
    const module = await import("../scripts/supabase-client.js");
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

// Cargar lista de clientes
async function loadCustomers(searchQuery = "") {
  console.log("🔍 loadCustomers llamado con query:", searchQuery);
  const container = document.getElementById("customers-container");
  if (!container) {
    console.error("❌ No se encontró el contenedor customers-container");
    return;
  }

  container.innerHTML = '<div class="loading">Cargando clientes...</div>';

  const db = await getSupabase();
  if (!db) {
    console.error("❌ No se pudo obtener instancia de Supabase");
    container.innerHTML = '<div class="empty-state"><p>Error: No se pudo conectar con la base de datos</p></div>';
    return;
  }

  try {
    // Verificar que el usuario es admin antes de consultar
    const { data: { user } } = await db.auth.getUser();
    if (!user) {
      throw new Error("Usuario no autenticado");
    }

    console.log("👤 Usuario autenticado:", user.email);

    // Verificar si es admin
    const { data: adminCheck, error: adminError } = await db
      .from("admins")
      .select("id, role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error("❌ Error verificando admin:", adminError);
    }

    if (!adminCheck) {
      console.warn("⚠️ Usuario no es admin, pero intentando cargar clientes...");
    } else {
      console.log("✅ Usuario es admin:", adminCheck.role);
    }

    // Si no hay query de búsqueda, no hacer consulta
    if (!searchQuery || !searchQuery.trim()) {
      const searchMsg = '<p>Escribe en el campo de búsqueda para ver los clientes</p>';
      container.innerHTML = `<div class="empty-state">${searchMsg}</div>`;
      return;
    }

    lastCustomerSearchQuery = searchQuery.trim();

    console.log("📡 Consultando tabla customers...");
    console.log("🔎 Aplicando filtro de búsqueda:", searchQuery);
    const searchPattern = `%${searchQuery}%`;
    let query = db
      .from("customers")
      .select("id, customer_number, full_name, dni, phone, email, city, province, address, auth_provider")
      .or(`full_name.ilike.${searchPattern},dni.ilike.${searchPattern},phone.ilike.${searchPattern},email.ilike.${searchPattern},customer_number.ilike.${searchPattern}`)
      .order("full_name", { ascending: true })
      .limit(100);

    console.log("🔍 Ejecutando consulta...");
    const { data, error } = await query;

    if (error) {
      console.error("❌ Error en consulta:", error);
      console.error("❌ Código de error:", error.code);
      console.error("❌ Mensaje:", error.message);
      console.error("❌ Detalles:", error.details);
      console.error("❌ Hint:", error.hint);
      throw error;
    }

    console.log("✅ Datos recibidos:", data?.length || 0, "clientes");
    if (data && data.length > 0) {
      console.log("📋 Primer cliente:", data[0]);
    }

    if (!data || data.length === 0) {
      const searchMsg = searchQuery.trim()
        ? `<p>No se encontraron clientes que coincidan con "${searchQuery}"</p>`
        : '<p>Escribe en el campo de búsqueda para ver los clientes</p>';
      container.innerHTML = `<div class="empty-state">${searchMsg}</div>`;
      return;
    }

    container.innerHTML = data.map(customer => {
      const authBadge = getAuthProviderBadge(customer.auth_provider, customer.id);
      const displayName = customer.full_name || "Sin nombre";
      const safeName = escapeAttr(displayName);
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
              ${customer.dni ? `DNI: ${customer.dni} • ` : ""}
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
      </div>
    `;
    }).join("");

    console.log("✅ Clientes renderizados correctamente");

  } catch (error) {
    console.error("❌ Error cargando clientes:", error);
    console.error("❌ Stack trace:", error.stack);
    let errorMessage = error.message || "Error desconocido";

    // Mostrar error más detallado en consola para debugging
    if (error.code === 'PGRST301' || error.message?.includes('permission denied') || error.message?.includes('row-level security') || error.message?.includes('RLS')) {
      console.error("❌ Error de permisos RLS. Verifica que las políticas permitan a los admins ver todos los clientes.");
      console.error("💡 Ejecuta el script: supabase/canonical/36_fix_customers_admin_module.sql");
      errorMessage = `Error de permisos RLS: ${error.message || 'No tienes acceso para ver clientes. Verifica las políticas RLS.'}`;
    } else if (error.code === '23503') {
      console.error("❌ Error de clave foránea. La restricción con auth.users puede estar causando problemas.");
      console.error("💡 Ejecuta el script: supabase/canonical/36_fix_customers_admin_module.sql para eliminar la restricción");
      errorMessage = `Error de base de datos: ${error.message || 'Problema con la estructura de la tabla customers.'}`;
    }

    container.innerHTML = `
      <div class="empty-state">
        <p><strong>Error al cargar clientes:</strong></p>
        <p style="color: #d32f2f; margin: 8px 0;">${errorMessage}</p>
        <p style="font-size: 12px; color: #666; margin-top: 8px;">
          Código: ${error.code || 'N/A'} | 
          Revisa la consola del navegador (F12) para más detalles.
        </p>
        <p style="font-size: 12px; color: #666; margin-top: 4px;">
          💡 Asegúrate de haber ejecutado: <code>supabase/canonical/36_fix_customers_admin_module.sql</code>
        </p>
      </div>
    `;
  }
}

// Buscar clientes
async function searchCustomers(query) {
  clearTimeout(searchTimeout);

  // Si el query está vacío, mostrar mensaje inicial
  if (!query || query.trim() === "") {
    const container = document.getElementById("customers-container");
    if (container) {
      container.innerHTML = '<div class="empty-state"><p>Escribe en el campo de búsqueda para ver los clientes</p></div>';
    }
    return;
  }

  // Si hay query, buscar después de un pequeño delay
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

  if (modal) modal.classList.add("active");
  initializeAutocomplete();
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
    if (dniInput) dniInput.value = customer.dni || "";
    if (phoneInput) phoneInput.value = unformatPhone(customer.phone || "");
    if (emailInput) emailInput.value = customer.email || "";
    if (addressInput) addressInput.value = customer.address || "";
    if (provinceInput) provinceInput.value = customer.province || "";
    if (cityInput) {
      cityInput.value = customer.city || "";
      if (customer.province && PROVINCE_CITIES[customer.province]) {
        cityInput.disabled = false;
        cityInput.placeholder = "Escriba para buscar ciudad...";
        updateCitiesList(customer.province);
      } else {
        cityInput.disabled = true;
        cityInput.placeholder = "Seleccione provincia primero...";
      }
    }

    if (modal) modal.classList.add("active");
    initializeAutocomplete();

  } catch (error) {
    console.error("Error cargando cliente:", error);
    showMessage(`Error al cargar cliente: ${error.message}`, "error");
  }
}

// Cerrar modal
function closeCustomerModal() {
  const modal = document.getElementById("customer-modal");
  const errorDiv = document.getElementById("customer-form-error");

  if (modal) modal.classList.remove("active");
  if (errorDiv) {
    errorDiv.style.display = "none";
    errorDiv.textContent = "";
  }

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
  const dni = document.getElementById("customer-dni")?.value?.trim();
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

  if (!ARGENTINA_PROVINCES.includes(province)) {
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

  const cities = PROVINCE_CITIES[province] || [];
  if (!cities.includes(city)) {
    if (errorDiv) {
      errorDiv.textContent = "La ciudad seleccionada no es válida para la provincia elegida";
      errorDiv.style.display = "block";
    }
    return;
  }

  if (dni && (dni.length < 7 || dni.length > 8 || !/^\d+$/.test(dni))) {
    if (errorDiv) {
      errorDiv.textContent = "El DNI debe tener entre 7 y 8 dígitos numéricos";
      errorDiv.style.display = "block";
    }
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
        p_province: province
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
        p_province: province
      });

      if (error) throw error;

      if (!data || !data.success) {
        throw new Error(data?.message || data?.error || 'Error desconocido');
      }

      showMessage("Cliente creado correctamente", "success");
    }

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

    // Verificar autenticación
    const { data: { user }, error: authError } = await db.auth.getUser();

    if (authError || !user) {
      console.error("❌ Usuario no autenticado:", authError);
      window.location.href = "./index.html";
      return;
    }

    console.log("✅ Usuario autenticado:", user.email);

    // Verificar permisos de admin
    const isUserAdmin = await isAdmin();
    if (!isUserAdmin) {
      console.error("❌ Usuario no es admin");
      const container = document.getElementById("customers-container");
      if (container) {
        container.innerHTML = `<div class="empty-state"><p>Error: No tienes permisos de administrador para acceder a esta página.</p><p style="font-size: 12px; color: #666; margin-top: 8px;">Contacta al administrador del sistema para obtener acceso.</p></div>`;
      }
      return;
    }
    console.log("✅ Permisos de admin verificados");

    // Test directo de consulta antes de cargar
    console.log("🧪 Haciendo test de consulta directa...");
    const testResult = await db
      .from("customers")
      .select("id")
      .limit(1);

    console.log("🧪 Resultado del test:", {
      data: testResult.data,
      error: testResult.error,
      count: testResult.data?.length || 0
    });

    if (testResult.error) {
      console.error("❌ Error en test de consulta:", testResult.error);
      const container = document.getElementById("customers-container");
      if (container) {
        container.innerHTML = `
          <div class="empty-state">
            <p><strong>Error de permisos RLS:</strong></p>
            <p style="color: #d32f2f; margin: 8px 0;">${testResult.error.message}</p>
            <p style="font-size: 12px; color: #666; margin-top: 8px;">
              Código: ${testResult.error.code || 'N/A'}
            </p>
            <p style="font-size: 12px; color: #666; margin-top: 4px;">
              💡 Ejecuta el script: <code>supabase/canonical/38_fix_customers_rls_final.sql</code>
            </p>
          </div>
        `;
      }
      return;
    }

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

  } catch (error) {
    console.error("❌ Error en inicialización:", error);
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

