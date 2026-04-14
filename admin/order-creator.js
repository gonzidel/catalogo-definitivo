// admin/order-creator.js
// Funcionalidad para crear y editar pedidos desde el panel de admin

console.log("📦 order-creator.js: Iniciando carga del módulo...");

import { supabase as supabaseClient } from "../scripts/supabase-client.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";
import { PROVINCE_CITIES_DATA } from './argentina-cities-data.js';

console.log("📦 order-creator.js: Importación de supabase-client completada");

// Validar formato UUID v4 (formato estándar PostgreSQL/Supabase)
function isValidUUID(uuid) {
  if (typeof uuid !== 'string' || !uuid) return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

let supabase = supabaseClient;
let currentCustomer = null;
let orderItems = [];
let editingOrderId = null;
// Rastrear cantidades seleccionadas por variante y talle en la búsqueda actual
let selectedQuantities = new Map(); // "variant_id|size" -> quantity
// Valores extra del pedido
let shippingAmount = 0;
let discountAmount = 0;
let extrasAmount = 0;
let extrasPercentage = 0;

// Provincias y ciudades argentinas para autocomplete (importadas desde archivo compartido)
const PROVINCE_CITIES = PROVINCE_CITIES_DATA;
const ARGENTINA_PROVINCES = Object.keys(PROVINCE_CITIES).sort();

// Definir función global inmediatamente para que esté disponible desde el inicio
// Esta función será actualizada cuando openCreateOrderModal esté definida
if (typeof window !== 'undefined') {
  window.openEditOrderModal = function(orderId) {
    console.log("🔍 openEditOrderModal llamado con orderId:", orderId);
    console.log("🔍 openCreateOrderModal disponible:", typeof openCreateOrderModal);
    
    if (typeof openCreateOrderModal === 'function') {
      openCreateOrderModal(orderId);
    } else {
      console.warn("⚠️ openCreateOrderModal no está disponible aún, esperando...");
      // Esperar un poco y reintentar
      let attempts = 0;
      const checkFunction = setInterval(() => {
        attempts++;
        if (typeof openCreateOrderModal === 'function') {
          clearInterval(checkFunction);
          openCreateOrderModal(orderId);
        } else if (attempts >= 10) {
          clearInterval(checkFunction);
          console.error("❌ openCreateOrderModal no está disponible después de esperar");
          alert("Error: El módulo de edición no se cargó correctamente. Por favor, recarga la página.");
        }
      }, 100);
    }
  };
  console.log("✅ window.openEditOrderModal definida");
}

// Esperar a que Supabase esté disponible
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

// Inicializar cuando el DOM esté listo
async function initOrderCreator() {
  console.log("🔧 initOrderCreator: Iniciando inicialización...");
  await getSupabase();
  
  const modal = document.getElementById("create-order-modal");
  const createBtn = document.getElementById("create-order-btn");
  const closeBtn = document.getElementById("close-order-modal");
  const cancelBtn = document.getElementById("cancel-order-btn");
  const saveBtn = document.getElementById("save-order-btn");
  const customerSearch = document.getElementById("customer-search");
  const productSearch = document.getElementById("product-search");
  const createCustomerBtn = document.getElementById("create-customer-btn");
  const removeCustomerBtn = document.getElementById("remove-customer-btn");
  
  console.log("🔧 initOrderCreator: Elementos encontrados:");
  console.log("  - modal:", !!modal);
  console.log("  - createBtn:", !!createBtn);
  console.log("  - saveBtn:", !!saveBtn);
  console.log("  - customerSearch:", !!customerSearch);
  console.log("  - productSearch:", !!productSearch);
  
  if (!modal) {
    console.warn("⚠️ Modal no encontrado");
    return;
  }
  
  // Abrir modal solo si existe el botón de crear pedido
  if (createBtn) {
    createBtn.addEventListener("click", () => {
      openCreateOrderModal();
    });
  }
  
  // Cerrar modal - estos botones deben funcionar siempre que exista el modal
  if (closeBtn) {
    closeBtn.setAttribute('data-listener-attached', 'true');
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeModal();
    });
  }
  if (cancelBtn) {
    cancelBtn.setAttribute('data-listener-attached', 'true');
    cancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeModal();
    });
  }
  
  // NO cerrar al hacer clic fuera del modal (solo con la X)
  // modal.addEventListener("click", (e) => {
  //   if (e.target === modal) {
  //     closeModal();
  //   }
  // });
  
  // Cerrar con ESC (mantener esta funcionalidad)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closeModal();
    }
  });
  
  // Búsqueda de clientes
  if (customerSearch) {
    let searchTimeout;
    customerSearch.addEventListener("input", (e) => {
      clearTimeout(searchTimeout);
      const query = e.target.value.trim();
      if (query.length < 2) {
        hideCustomerResults();
        return;
      }
      searchTimeout = setTimeout(() => {
        searchCustomers(query);
      }, 300);
    });
  }
  
  // Búsqueda de productos
  if (productSearch) {
    productSearch.setAttribute('data-listener-attached', 'true');
    let searchTimeout;
    productSearch.addEventListener("input", (e) => {
      clearTimeout(searchTimeout);
      const query = e.target.value.trim();
      if (query.length < 2) {
        hideProductResults();
        return;
      }
      searchTimeout = setTimeout(() => {
        searchProducts(query);
      }, 300);
    });
  }
  
  // Crear cliente
  if (createCustomerBtn) {
    createCustomerBtn.addEventListener("click", () => {
      openCreateCustomerModal();
    });
  }
  
  // Inicializar modal de crear cliente
  initializeCreateCustomerModal();
  
  // Remover cliente seleccionado
  if (removeCustomerBtn) {
    removeCustomerBtn.addEventListener("click", () => {
      currentCustomer = null;
      updateCustomerDisplay();
      updateSaveButton();
    });
  }
  
  // Agregar extra especial
  const addSpecialExtraBtn = document.getElementById("add-special-extra-btn");
  if (addSpecialExtraBtn) {
    addSpecialExtraBtn.addEventListener("click", () => {
      addSpecialExtra();
    });
  }
  
  // Guardar pedido
  if (saveBtn) {
    console.log("✅ Event listener de save-order-btn registrado");
    console.log("🔵 Estado inicial del botón - disabled:", saveBtn.disabled);
    
    // Agregar event listener - también escuchar en el contenedor para capturar clics incluso si está deshabilitado
    const saveBtnHandler = async (e) => {
      console.log("🔵 CLICK en botón Guardar Pedido detectado");
      console.log("🔵 saveBtn.disabled:", saveBtn.disabled);
      console.log("🔵 currentCustomer:", currentCustomer);
      console.log("🔵 orderItems.length:", orderItems.length);
      
      e.preventDefault();
      e.stopPropagation();
      
      // Verificar condiciones antes de guardar
      if (!currentCustomer) {
        alert("Por favor, selecciona un cliente antes de guardar.");
        return;
      }
      
      if (!editingOrderId && orderItems.length === 0) {
        alert("Por favor, agrega al menos un producto al pedido antes de guardar.");
        return;
      }
      
      const mensaje = editingOrderId
        ? "¿Está seguro que desea guardar los cambios del pedido?"
        : "¿Está seguro que desea guardar el pedido?";
      if (!confirm(mensaje)) {
        return;
      }
      
      try {
        await saveOrder();
      } catch (error) {
        console.error("❌ Error en event listener de saveBtn:", error);
        console.error("❌ Stack trace:", error.stack);
        alert(`Error: ${error.message || "Error desconocido"}`);
      }
    };
    
    // Agregar listener al botón
    saveBtn.addEventListener("click", saveBtnHandler);
    
    // También agregar listener al contenedor padre para capturar clics incluso si el botón está deshabilitado
    const footer = saveBtn.closest('.order-modal-footer');
    if (footer) {
      footer.addEventListener("click", (e) => {
        if (e.target === saveBtn || saveBtn.contains(e.target)) {
          saveBtnHandler(e);
        }
      });
    }
  } else {
    console.error("❌ save-order-btn NO ENCONTRADO");
  }
  
  // Event listeners para valores extra
  const shippingInput = document.getElementById("shipping-amount");
  const discountInput = document.getElementById("discount-amount");
  const extrasAmountInput = document.getElementById("extras-amount");
  const extrasPercentageInput = document.getElementById("extras-percentage");
  
  if (shippingInput) {
    shippingInput.addEventListener("input", () => {
      shippingAmount = parseFloat(shippingInput.value) || 0;
      updateOrderTotal();
    });
  }
  
  if (discountInput) {
    discountInput.addEventListener("input", () => {
      discountAmount = parseFloat(discountInput.value) || 0;
      updateOrderTotal();
    });
  }
  
  if (extrasAmountInput) {
    extrasAmountInput.addEventListener("input", () => {
      extrasAmount = parseFloat(extrasAmountInput.value) || 0;
      // Si se ingresa un monto, limpiar el porcentaje
      if (extrasAmount > 0 && extrasPercentageInput) {
        extrasPercentageInput.value = "";
        extrasPercentage = 0;
      }
      updateOrderTotal();
    });
  }
  
  if (extrasPercentageInput) {
    extrasPercentageInput.addEventListener("input", () => {
      extrasPercentage = parseFloat(extrasPercentageInput.value) || 0;
      // Si se ingresa un porcentaje, limpiar el monto
      if (extrasPercentage > 0 && extrasAmountInput) {
        extrasAmountInput.value = "";
        extrasAmount = 0;
      }
      updateOrderTotal();
    });
  }
}

// Función para asegurar que los event listeners estén registrados
function ensureEventListeners() {
  const closeBtn = document.getElementById("close-order-modal");
  const cancelBtn = document.getElementById("cancel-order-btn");
  const productSearch = document.getElementById("product-search");
  const qrSearch = document.getElementById("qr-search");
  
  // Re-registrar listeners de cerrar si no están funcionando
  if (closeBtn && !closeBtn.hasAttribute('data-listener-attached')) {
    closeBtn.setAttribute('data-listener-attached', 'true');
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeModal();
    });
  }
  
  if (cancelBtn && !cancelBtn.hasAttribute('data-listener-attached')) {
    cancelBtn.setAttribute('data-listener-attached', 'true');
    cancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeModal();
    });
  }
  
  // Re-registrar listener de búsqueda de productos si no está funcionando
  if (productSearch && !productSearch.hasAttribute('data-listener-attached')) {
    productSearch.setAttribute('data-listener-attached', 'true');
    let searchTimeout;
    productSearch.addEventListener("input", (e) => {
      clearTimeout(searchTimeout);
      const query = e.target.value.trim();
      if (query.length < 2) {
        hideProductResults();
        return;
      }
      searchTimeout = setTimeout(() => {
        searchProducts(query);
      }, 300);
    });
  }
  
  // Registrar listener de búsqueda por QR
  // Usar solo debounce para leer el código completo: si el lector envía "145" + Enter + "565",
  // no procesar en Enter para no enviar "145"; esperar 250 ms tras el último carácter y procesar "145565".
  if (qrSearch && !qrSearch.hasAttribute('data-listener-attached')) {
    qrSearch.setAttribute('data-listener-attached', 'true');
    let qrDebounceTimer;
    const QR_DEBOUNCE_MS = 250;

    qrSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault(); // Evitar newline y que se procese un fragmento
    });

    qrSearch.addEventListener("input", () => {
      clearTimeout(qrDebounceTimer);
      const value = qrSearch.value.trim();
      if (!/^\d*$/.test(value) || value.length < 3) return;
      qrDebounceTimer = setTimeout(() => {
        const current = qrSearch.value.trim();
        if (/^\d+$/.test(current) && current.length >= 3) {
          addToQrQueue(current);
          qrSearch.value = "";
        }
      }, QR_DEBOUNCE_MS);
    });
  }
}

// Abrir modal para crear pedido
function openCreateOrderModal(orderId = null) {
  editingOrderId = orderId;
  const modal = document.getElementById("create-order-modal");
  const modalTitle = document.getElementById("modal-title");
  const customerSearchInput = document.getElementById("customer-search");
  const customerSearchLabel = document.querySelector('label[for="customer-search"]');
  const customerSearchDiv = customerSearchLabel?.parentElement;
  
  if (!modal) {
    console.error("❌ Modal no encontrado");
    return;
  }
  
  // Asegurar que los event listeners estén registrados (por si se abrió antes de la inicialización)
  ensureEventListeners();
  
  // Resetear estado
  currentCustomer = null;
  orderItems = [];
  selectedQuantities.clear();
  shippingAmount = 0;
  discountAmount = 0;
  extrasAmount = 0;
  extrasPercentage = 0;
  
  // Resetear campos de valores extra
  const shippingInput = document.getElementById("shipping-amount");
  const discountInput = document.getElementById("discount-amount");
  const extrasAmountInput = document.getElementById("extras-amount");
  const extrasPercentageInput = document.getElementById("extras-percentage");
  if (shippingInput) shippingInput.value = "";
  if (discountInput) discountInput.value = "";
  if (extrasAmountInput) extrasAmountInput.value = "";
  if (extrasPercentageInput) extrasPercentageInput.value = "";
  
  if (orderId) {
    modalTitle.textContent = "✏️ Editar Pedido";
    // Ocultar la búsqueda de cliente al editar (el div que contiene label e input)
    if (customerSearchDiv) {
      customerSearchDiv.style.display = "none";
    }
    // También ocultar el botón de crear cliente
    const createCustomerBtn = document.getElementById("create-customer-btn");
    if (createCustomerBtn && createCustomerBtn.parentElement) {
      createCustomerBtn.parentElement.style.display = "none";
    }
    loadOrderForEdit(orderId);
  } else {
    modalTitle.textContent = "➕ Crear Nuevo Pedido";
    // Mostrar la búsqueda de cliente al crear
    if (customerSearchDiv) {
      customerSearchDiv.style.display = "block";
    }
    // Mostrar el botón de crear cliente
    const createCustomerBtn = document.getElementById("create-customer-btn");
    if (createCustomerBtn && createCustomerBtn.parentElement) {
      createCustomerBtn.parentElement.style.display = "block";
    }
  }
  
  modal.classList.add("active");
  modal.style.display = "flex";
  
  updateCustomerDisplay();
  updateOrderItemsList();
  updateSaveButton();
}

// La función ya está definida arriba y funcionará correctamente

// Cerrar modal
function closeModal() {
  const modal = document.getElementById("create-order-modal");
  if (modal) {
    modal.classList.remove("active");
    modal.style.display = "none";
    console.log("✅ Modal cerrado");
  } else {
    console.warn("⚠️ Modal no encontrado para cerrar");
  }
  
  // También cerrar el modal de cliente si está abierto
  const customerModal = document.getElementById("create-customer-modal");
  if (customerModal) {
    customerModal.classList.remove("active");
    customerModal.style.display = "none";
  }
  
  // Limpiar campos
  const customerSearch = document.getElementById("customer-search");
  const productSearch = document.getElementById("product-search");
  const qrSearch = document.getElementById("qr-search");
  const specialExtraName = document.getElementById("special-extra-name");
  const specialExtraAmount = document.getElementById("special-extra-amount");
  if (customerSearch) customerSearch.value = "";
  if (productSearch) productSearch.value = "";
  if (qrSearch) qrSearch.value = "";
  if (specialExtraName) specialExtraName.value = "";
  if (specialExtraAmount) specialExtraAmount.value = "";
  
  hideCustomerResults();
  hideProductResults();
  
  currentCustomer = null;
  orderItems = [];
  editingOrderId = null;
  selectedQuantities.clear();
  
  // Limpiar cola de QR
  qrProcessingQueue = [];
  isProcessingQr = false;
  
  // Resetear valores extra
  shippingAmount = 0;
  discountAmount = 0;
  extrasAmount = 0;
  extrasPercentage = 0;
  const shippingInput = document.getElementById("shipping-amount");
  const discountInput = document.getElementById("discount-amount");
  const extrasAmountInput = document.getElementById("extras-amount");
  const extrasPercentageInput = document.getElementById("extras-percentage");
  if (shippingInput) shippingInput.value = "";
  if (discountInput) discountInput.value = "";
  if (extrasAmountInput) extrasAmountInput.value = "";
  if (extrasPercentageInput) extrasPercentageInput.value = "";
}

// Buscar clientes
async function searchCustomers(query) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible");
    return;
  }
  
  try {
    const { data, error } = await supabase
      .from("customers")
      .select("id, customer_number, full_name, dni, phone, email, city, province")
      .or(`full_name.ilike.%${query}%,dni.ilike.%${query}%,email.ilike.%${query}%`)
      .limit(10);
    
    if (error) {
      console.error("❌ Error buscando clientes:", error);
      return;
    }
    
    displayCustomerResults(data || []);
  } catch (error) {
    console.error("❌ Error en búsqueda de clientes:", error);
  }
}

// Función auxiliar para formatear nombres de clientes
function formatName(c) {
  const full = (c.full_name || '').trim();
  if (!full) return 'Cliente sin nombre';
  const parts = full.split(/\s+/);
  if (parts.length === 1) return full;
  const last = parts.pop();
  const first = parts.join(' ');
  return `${last}, ${first}`;
}

// Mostrar resultados de clientes
function displayCustomerResults(customers) {
  const resultsDiv = document.getElementById("customer-results");
  if (!resultsDiv) return;
  
  if (!customers || customers.length === 0) {
    resultsDiv.innerHTML = "<div style='padding: 12px; color: #666;'>No se encontraron clientes</div>";
    resultsDiv.style.display = "block";
    return;
  }

  resultsDiv.innerHTML = customers.map(customer => `
    <div class="customer-result-item" data-customer-id="${customer.id}">
      <strong>${formatName(customer)}</strong>
      ${customer.customer_number ? `<span style="color: #CD844D;">#${customer.customer_number}</span>` : ''}
      <div style="font-size: 12px; color: #666; margin-top: 4px;">
        ${customer.dni ? `DNI: ${customer.dni} • ` : ''}
        ${customer.phone ? `Tel: ${customer.phone}` : ''}
        ${customer.email ? ` • ${customer.email}` : ''}
      </div>
    </div>
  `).join("");
  
  resultsDiv.style.display = "block";
  
  // Agregar event listeners
  resultsDiv.querySelectorAll(".customer-result-item").forEach(item => {
    item.addEventListener("click", async () => {
      const customerId = item.dataset.customerId;
      await selectCustomer(customerId);
    });
  });
}

// Ocultar resultados de clientes
function hideCustomerResults() {
  const resultsDiv = document.getElementById("customer-results");
  if (resultsDiv) {
    resultsDiv.style.display = "none";
  }
}

// Seleccionar cliente
async function selectCustomer(customerId) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible");
    return;
  }
  
  try {
    const { data, error } = await supabase
      .from("customers")
      .select("id, customer_number, full_name, dni, phone, email, city, province")
      .eq("id", customerId)
      .maybeSingle();
    
    if (error || !data) {
      console.error("❌ Error obteniendo cliente:", error);
      alert("No se pudo obtener la información del cliente.");
      return;
    }
    
    currentCustomer = data;
    updateCustomerDisplay();
    hideCustomerResults();
    updateSaveButton();
  } catch (error) {
    console.error("❌ Error seleccionando cliente:", error);
    alert("Error al seleccionar el cliente.");
  }
}

// Actualizar display del cliente seleccionado
function updateCustomerDisplay() {
  const selectedDiv = document.getElementById("selected-customer");
  const customerNameSpan = document.getElementById("selected-customer-name");
  const customerSearch = document.getElementById("customer-search");
  
  if (currentCustomer) {
    if (selectedDiv) selectedDiv.style.display = "block";
    if (customerNameSpan) {
      customerNameSpan.textContent = `${formatName(currentCustomer)}${currentCustomer.customer_number ? ` (Nº ${currentCustomer.customer_number})` : ''}`;
    }
    if (customerSearch) customerSearch.value = "";
  } else {
    if (selectedDiv) selectedDiv.style.display = "none";
    if (customerNameSpan) customerNameSpan.textContent = "";
  }
}

// Crear cliente nuevo
async function createCustomer(customerData) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible");
    alert("No se pudo conectar con la base de datos.");
    return;
  }
  
  try {
    // Verificar si ya existe un cliente con ese DNI
    if (customerData.dni) {
      const { data: existing } = await supabase
        .from("customers")
        .select("id, full_name, customer_number")
        .eq("dni", customerData.dni)
        .maybeSingle();
      
      if (existing) {
        const useExisting = confirm(
          `Ya existe un cliente con DNI ${customerData.dni}: ${existing.full_name}${existing.customer_number ? ` (Nº ${existing.customer_number})` : ''}.\n\n¿Deseas usar este cliente en su lugar?`
        );
        
        if (useExisting) {
          currentCustomer = existing;
          updateCustomerDisplay();
          updateSaveButton();
          return;
        } else {
          return; // El usuario canceló
        }
      }
    }
    
    // Crear el cliente usando la función RPC
    const { data: result, error } = await supabase.rpc('rpc_create_admin_customer', {
      p_full_name: customerData.full_name,
      p_email: customerData.email || null,
      p_phone: customerData.phone || null,
      p_dni: customerData.dni || null,
      p_address: customerData.address || null,
      p_city: customerData.city || null,
      p_province: customerData.province || null
    });
    
    if (error) {
      console.error("❌ Error creando cliente:", error);
      alert(`Error al crear cliente: ${error.message}`);
      return;
    }
    
    if (!result || !result.success) {
      console.error("❌ Error en respuesta RPC:", result);
      alert(`Error al crear cliente: ${result?.message || result?.error || 'Error desconocido'}`);
      return;
    }
    
    // Obtener el cliente creado usando el customer_id retornado
    const { data: newCustomer, error: fetchError } = await supabase
      .from("customers")
      .select("id, customer_number, full_name, dni, phone, email, city, province")
      .eq("id", result.customer_id)
      .single();
    
    if (fetchError || !newCustomer) {
      console.error("❌ Error obteniendo cliente creado:", fetchError);
      alert(`Cliente creado pero hubo un error al cargarlo. ID: ${result.customer_id}`);
      return;
    }
    
    currentCustomer = newCustomer;
    updateCustomerDisplay();
    updateSaveButton();
    alert(`✅ Cliente "${newCustomer.full_name}" creado correctamente.${newCustomer.customer_number ? ` Nº de cliente: ${newCustomer.customer_number}` : ''}`);
  } catch (error) {
    console.error("❌ Error en creación de cliente:", error);
    alert("Error inesperado al crear el cliente.");
  }

}

// Funciones para el modal de crear cliente
function openCreateCustomerModal() {
  const modal = document.getElementById("create-customer-modal");
  if (modal) {
    modal.style.display = "flex";
    // Resetear formulario
    const form = document.getElementById("customer-form");
    if (form) form.reset();
    const errorDiv = document.getElementById("customer-form-error");
    if (errorDiv) errorDiv.style.display = "none";
    // Resetear ciudades
    const cityInput = document.getElementById("customer-city");
    if (cityInput) {
      cityInput.disabled = true;
      cityInput.placeholder = "Seleccione provincia primero...";
    }
    // Inicializar autocomplete de provincias
    initializeProvinceAutocomplete();
  }
}

function closeCreateCustomerModal() {
  const modal = document.getElementById("create-customer-modal");
  if (modal) {
    modal.style.display = "none";
    // Ocultar dropdowns
    const provinceDropdown = document.getElementById("province-dropdown");
    const cityDropdown = document.getElementById("city-dropdown");
    if (provinceDropdown) provinceDropdown.style.display = "none";
    if (cityDropdown) cityDropdown.style.display = "none";
  }
}

function initializeCreateCustomerModal() {
  const closeBtn = document.getElementById("close-customer-modal");
  const cancelBtn = document.getElementById("cancel-customer-btn");
  const saveBtn = document.getElementById("save-customer-btn");
  const customerForm = document.getElementById("customer-form");
  
  if (closeBtn) {
    closeBtn.addEventListener("click", closeCreateCustomerModal);
  }
  
  if (cancelBtn) {
    cancelBtn.addEventListener("click", closeCreateCustomerModal);
  }
  
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      await handleCreateCustomer();
    });
  }
  
  if (customerForm) {
    customerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleCreateCustomer();
    });
  }
  
  // Cerrar modal con ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal = document.getElementById("create-customer-modal");
      if (modal && modal.style.display === "flex") {
        closeCreateCustomerModal();
      }
    }
  });
  
  initializeProvinceAutocomplete();
}

function initializeProvinceAutocomplete() {
  const provinceInput = document.getElementById("customer-province");
  const provinceDropdown = document.getElementById("province-dropdown");
  const cityInput = document.getElementById("customer-city");
  const cityDropdown = document.getElementById("city-dropdown");
  
  if (!provinceInput || !provinceDropdown || !cityInput || !cityDropdown) return;
  
  // Event listener para provincia
  provinceInput.addEventListener("input", (e) => {
    handleProvinceInput(e.target.value);
  });
  
  provinceInput.addEventListener("focus", () => {
    if (provinceInput.value.length > 0) {
      handleProvinceInput(provinceInput.value);
    }
  });
  
  // Event listener para ciudad
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
  
  // Cerrar dropdowns al hacer clic fuera
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
    <div style="padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f0f0f0;" class="custom-dropdown-item" data-value="${province}">${province}</div>
  `).join("");
  
  provinceDropdown.style.display = "block";
  
  // Event listeners para items del dropdown
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
  // Guardar ciudades para usar en el autocomplete
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
    <div style="padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f0f0f0;" class="custom-dropdown-item" data-value="${city}">${city}</div>
  `).join("");
  
  cityDropdown.style.display = "block";
  
  // Event listeners para items del dropdown
  cityDropdown.querySelectorAll(".custom-dropdown-item").forEach(item => {
    item.addEventListener("click", () => {
      cityInput.value = item.dataset.value;
      cityDropdown.style.display = "none";
    });
  });
}

// Funciones de formato de teléfono (idénticas a customers.js)
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

async function handleCreateCustomer() {
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
  
  // Validar formato de teléfono
  if (!validatePhone(phone)) {
    if (errorDiv) {
      errorDiv.textContent = "El formato del teléfono no es válido. Debe tener entre 8 y 10 dígitos.";
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
  
  // Validar que la provincia sea válida
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
  
  // Validar que la ciudad sea válida para la provincia seleccionada
  const cities = PROVINCE_CITIES[province] || [];
  if (!cities.includes(city)) {
    if (errorDiv) {
      errorDiv.textContent = "La ciudad seleccionada no es válida para la provincia elegida";
      errorDiv.style.display = "block";
    }
    return;
  }
  
  // Deshabilitar botón mientras se guarda
  if (saveBtn) {
    saveBtn.disabled = true;
  }
  
  try {
    const fullName = `${firstName} ${lastName}`.trim();
    const formattedPhone = formatPhone(phone);
    
    await createCustomer({
      full_name: fullName,
      dni: dni || null,
      phone: formattedPhone,
      email: email || null,
      address: address,
      city: city,
      province: province
    });
    
    // Cerrar modal después de crear
    closeCreateCustomerModal();
  } catch (error) {
    console.error("Error en handleCreateCustomer:", error);
    if (errorDiv) {
      errorDiv.textContent = `Error: ${error.message}`;
      errorDiv.style.display = "block";
    }
  } finally {
    // Rehabilitar botón
    if (saveBtn) {
      saveBtn.disabled = false;
    }
  }
}

// Cargar IDs de almacenes
let warehouses = { general: null, ventaPublico: null };

// Sistema de cola para procesar múltiples QR seguidos
let qrProcessingQueue = [];
let isProcessingQr = false;

async function loadWarehouses() {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) return;
  
  try {
    const { data, error } = await supabase
      .from("warehouses")
      .select("id, code");
    
    if (error) {
      console.error("❌ Error cargando almacenes:", error);
      return;
    }
    
    if (data) {
      data.forEach(w => {
        if (w.code === "general") warehouses.general = w.id;
        if (w.code === "venta-publico") warehouses.ventaPublico = w.id;
      });
    }
  } catch (error) {
    console.error("❌ Error en loadWarehouses:", error);
  }
}

// Buscar productos en stock
async function searchProducts(query) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible");
    return;
  }

  // Coincidencia por prefijo del nombre (ej. "80" → 80, 801, 800; no "R1801").
  // Quitar % y _ del término para que no actúen como comodines en ILIKE.
  const namePrefix = String(query || "").trim().replace(/[%_]/g, "");
  if (namePrefix.length < 2) {
    hideProductResults();
    return;
  }
  
  // Cargar almacenes si no están cargados
  if (!warehouses.general || !warehouses.ventaPublico) {
    await loadWarehouses();
  }
  
  try {
    // Buscar productos cuyo nombre empieza por el término (variantes con stock se filtran después)
    const { data: products, error: productsError } = await supabase
      .from("products")
      .select(`
        id,
        name,
        product_variants(
          id,
          color,
          size,
          price,
          stock_qty,
          reserved_qty,
          active
        )
      `)
      .ilike("name", `${namePrefix}%`)
      .in("status", ["active", "pending_stock", "draft"]) // Incluir productos activos, con stock pendiente y en borrador
      .limit(20);
    
    if (productsError) {
      console.error("❌ Error buscando productos:", productsError);
      return;
    }
    
    // Obtener todos los variant_ids
    const variantIds = [];
    (products || []).forEach(product => {
      (product.product_variants || []).forEach(v => {
        if (v && v.active) variantIds.push(v.id);
      });
    });
    
    // Obtener stock de almacenes para todas las variantes
    const stockMap = new Map();
    if (variantIds.length > 0 && (warehouses.general || warehouses.ventaPublico)) {
      const warehouseIds = [warehouses.general, warehouses.ventaPublico].filter(Boolean);
      const { data: stockData, error: stockError } = await supabase
        .from("variant_warehouse_stock")
        .select("variant_id, warehouse_id, stock_qty")
        .in("variant_id", variantIds)
        .in("warehouse_id", warehouseIds);
      
      if (!stockError && stockData) {
        stockData.forEach(stock => {
          if (!stockMap.has(stock.variant_id)) {
            stockMap.set(stock.variant_id, new Map());
          }
          stockMap.get(stock.variant_id).set(stock.warehouse_id, stock.stock_qty || 0);
        });
      }
    }
    
    // Filtrar variantes activas (incluyendo las sin stock), luego obtener imágenes y talles
    const productsWithStock = await Promise.all(
      (products || []).flatMap(async (product) => {
        const variantsWithStock = (product.product_variants || [])
          .filter(v => {
            if (!v || !v.active) return false;
            // Incluir todas las variantes activas, incluso sin stock
            return true;
          });
        
        // Obtener imágenes y talles para cada variante
        const variantsWithImages = await Promise.all(
          variantsWithStock.flatMap(async (v) => {
            // Obtener imagen de la variante
            const { data: imageData } = await supabase
              .from("variant_images")
              .select("url")
              .eq("variant_id", v.id)
              .eq("position", 1)
              .maybeSingle();
            
            // Obtener talles desde variant_sizes (TABLA PRINCIPAL)
            // IMPORTANTE: También obtener stock_qty para fallback si no hay stock en warehouses
            // Normalizar los tamaños al cargarlos para asegurar consistencia
            const { data: sizesData, error: sizesError } = await supabase
              .from("variant_sizes")
              .select("size, stock_qty")
              .eq("variant_id", v.id);
            
            if (sizesError) {
              console.warn(`⚠️ Error obteniendo talles para variante ${v.id}:`, sizesError);
            }
            
            // Si no hay talles en variant_sizes, usar el size de product_variants como fallback (legacy)
            // IMPORTANTE: Normalizar los tamaños al cargarlos
            const sizes = (sizesData && sizesData.length > 0) 
              ? sizesData.map(s => ({ size: normalizeSize(s.size), stock_qty: s.stock_qty || 0 })).filter(s => s.size)
              : (v.size ? [{ size: normalizeSize(v.size), stock_qty: 0 }].filter(s => s.size) : []);
            
            // Si no hay talles, crear un item sin talle
            if (sizes.length === 0) {
              const variantStock = stockMap.get(v.id) || new Map();
              const stockGeneral = variantStock.get(warehouses.general) || 0;
              const stockVenta = variantStock.get(warehouses.ventaPublico) || 0;
              const totalStock = stockGeneral + stockVenta;
              
              return [{
                articulo: product.name,
                color: v.color,
                talle: null,
                precio: v.price,
                stock_general: stockGeneral,
                stock_venta: stockVenta,
                stock_total: totalStock,
                imagen: imageData?.url || null,
                variant_id: v.id
              }];
            }
            
            // Obtener stock por talle desde variant_size_warehouse_stock (DISTRIBUCIÓN POR WAREHOUSE)
            // IMPORTANTE: Normalizar los tamaños al crear el mapa y al buscar
            const sizeStockMap = new Map(); // key: `${normalizedSize}_${warehouse_id}` -> stock_qty
            if (sizes.length > 0 && (warehouses.general || warehouses.ventaPublico)) {
              const warehouseIds = [warehouses.general, warehouses.ventaPublico].filter(Boolean);
              // Normalizar los tamaños antes de consultar
              const normalizedSizes = sizes.map(s => s.size).filter(Boolean);
              
              // Cargar todos los registros y normalizar después para evitar problemas de comparación
              const { data: sizeStockData } = await supabase
                .from("variant_size_warehouse_stock")
                .select("size, warehouse_id, stock_qty")
                .eq("variant_id", v.id)
                .in("warehouse_id", warehouseIds);
              
              if (sizeStockData) {
                sizeStockData.forEach(stock => {
                  // Normalizar el tamaño antes de guardarlo en el mapa
                  const normalizedStockSize = normalizeSize(stock.size);
                  if (!normalizedStockSize) return; // Saltar tamaños vacíos
                  
                  // Filtrar solo los tamaños que están en la lista de sizes normalizados
                  if (!normalizedSizes.includes(normalizedStockSize)) return;
                  
                  if (!sizeStockMap.has(normalizedStockSize)) {
                    sizeStockMap.set(normalizedStockSize, new Map());
                  }
                  sizeStockMap.get(normalizedStockSize).set(stock.warehouse_id, stock.stock_qty || 0);
                });
              }
            }
            
            // Crear un item por cada talle usando solo stock canónico por warehouse
            return sizes.map(sizeData => {
              const normalizedSize = sizeData.size;
              if (!normalizedSize) return null; // Saltar tamaños vacíos
              
              const sizeStock = sizeStockMap.get(normalizedSize) || new Map();
              let stockGeneral = sizeStock.get(warehouses.general) || 0;
              let stockVenta = sizeStock.get(warehouses.ventaPublico) || 0;
              
              const totalStock = stockGeneral + stockVenta;
              
              return {
                articulo: product.name,
                color: v.color,
                talle: normalizedSize, // Usar tamaño normalizado
                precio: v.price,
                stock_general: stockGeneral,
                stock_venta: stockVenta,
                stock_total: totalStock,
                imagen: imageData?.url || null,
                variant_id: v.id
              };
            }).filter(Boolean); // Filtrar nulls de tamaños vacíos
          })
        );
        
        return variantsWithImages.flat();
      })
    );
    
    displayProductResults(productsWithStock.flat(), namePrefix);
  } catch (error) {
    console.error("❌ Error en búsqueda de productos:", error);
  }
}

// Sistema de cola para procesar múltiples QR seguidos
function addToQrQueue(qrCode) {
  // Limpiar el input inmediatamente para permitir siguiente escaneo
  const qrSearchInput = document.getElementById("qr-search");
  if (qrSearchInput) {
    qrSearchInput.value = "";
  }
  
  // Agregar a la cola
  qrProcessingQueue.push(qrCode);
  
  // Iniciar procesamiento si no está en proceso
  if (!isProcessingQr) {
    processQrQueue();
  }
}

// Procesar cola de QR
async function processQrQueue() {
  if (qrProcessingQueue.length === 0) {
    isProcessingQr = false;
    return;
  }
  
  isProcessingQr = true;
  const qrCode = qrProcessingQueue.shift();
  
  try {
    await processQrCodeForOrder(qrCode);
  } catch (error) {
    console.error("Error procesando QR:", error);
    alert(`Error al procesar código QR ${qrCode}: ${error.message}`);
  }
  
  // Procesar siguiente en la cola (sin await para no bloquear)
  setTimeout(() => {
    processQrQueue();
  }, 0);
}

// Función optimizada para procesar QR code y agregar al pedido
async function processQrCodeForOrder(qrCode) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible");
    alert("Error: No se pudo conectar con la base de datos.");
    return;
  }

  // Normalizar: siempre string y sin espacios (algunos lectores envían caracteres extra)
  const qrNormalized = String(qrCode).trim().replace(/\s+/g, "");
  if (!qrNormalized || !/^\d+$/.test(qrNormalized)) {
    alert(`Código QR no válido: "${qrCode}". Debe ser solo números.`);
    return;
  }
  
  // Cargar almacenes si no están cargados
  if (!warehouses.general || !warehouses.ventaPublico) {
    await loadWarehouses();
  }
  
  const baseQuery = () =>
    supabase
      .from("variant_sizes")
      .select(`
        variant_id,
        size,
        sku,
        qr_code,
        stock_qty,
        product_variants!inner (
          id,
          sku,
          color,
          price,
          active,
          products!inner (
            id,
            name,
            category,
            status
          )
        )
      `)
      .eq("qr_code", qrNormalized);
  
  try {
    // 1) Buscar solo productos activos y con estado visible
    let { data: sizeData, error: sizeError } = await baseQuery()
      .eq("product_variants.active", true)
      .in("product_variants.products.status", ["active", "pending_stock", "draft"])
      .maybeSingle();
    
    if (sizeError) {
      console.error("❌ Error buscando por QR:", sizeError);
      alert(`Error al buscar producto con código QR "${qrNormalized}": ${sizeError.message}`);
      return;
    }
    
    // 2) Si no hay resultado, buscar sin filtro de activo/estado (por si el producto está inactivo o en otro estado)
    if (!sizeData || !sizeData.product_variants) {
      const fallback = await baseQuery().maybeSingle();
      if (fallback.error) {
        console.error("❌ Error en búsqueda fallback por QR:", fallback.error);
        alert(`No se encontró el producto con el código QR "${qrNormalized}". Verificá que el código exista en variant_sizes.`);
        return;
      }
      if (fallback.data && fallback.data.product_variants) {
        const product = fallback.data.product_variants.products;
        const variant = fallback.data.product_variants;
        const ok = confirm(
          `El producto "${product.name}" (${variant.color}) existe pero está inactivo o no disponible.\n\n¿Agregarlo al pedido igual?`
        );
        if (!ok) return;
        sizeData = fallback.data;
      }
    }
    
    if (!sizeData || !sizeData.product_variants) {
      alert(`No se encontró el producto con el código QR "${qrNormalized}". Revisá que el QR corresponda a un talle de producto cargado y que tenga código asignado.`);
      return;
    }
    
    const variant = {
      ...sizeData.product_variants,
      size: sizeData.size,
    };
    
    const product = sizeData.product_variants.products;
    
    // Obtener stock del talle específico
    const normalizedSize = normalizeSize(variant.size);
    let sizeStock = { general: { stock: 0 }, ventaPublico: { stock: 0 }, total: 0 };
    
    // Obtener stock desde variant_size_warehouse_stock
    if (normalizedSize && warehouses.general && warehouses.ventaPublico) {
      const { data: sizeWarehouseStocks } = await supabase
        .from("variant_size_warehouse_stock")
        .select("size, warehouse_id, stock_qty")
        .eq("variant_id", variant.id)
        .in("warehouse_id", [warehouses.general, warehouses.ventaPublico]);
      
      if (sizeWarehouseStocks) {
        sizeWarehouseStocks.forEach(sws => {
          const swsNormalizedSize = normalizeSize(sws.size);
          if (swsNormalizedSize !== normalizedSize) return;
          
          if (sws.warehouse_id === warehouses.general) {
            sizeStock.general.stock += sws.stock_qty || 0;
          } else if (sws.warehouse_id === warehouses.ventaPublico) {
            sizeStock.ventaPublico.stock += sws.stock_qty || 0;
          }
        });
        sizeStock.total = sizeStock.general.stock + sizeStock.ventaPublico.stock;
      }
    }
    
    // Sin fallback: decisiones operativas solo con variant_size_warehouse_stock
    
    // Por QR el producto se asume físico (se escaneó), no pedir confirmación si no hay stock; agregar directo.
    // La carga manual sigue usando el modal de confirmación en la grilla de talles.

    // Obtener imagen de la variante
    const { data: imageData } = await supabase
      .from("variant_images")
      .select("url")
      .eq("variant_id", variant.id)
      .eq("position", 1)
      .maybeSingle();
    
    // Determinar de qué almacén tomar el stock (priorizar venta público si hay, sino general)
    let qtyFromGeneral = 0;
    let qtyFromVenta = 0;
    const quantity = 1;
    
    if (sizeStock.ventaPublico.stock > 0) {
      qtyFromVenta = Math.min(quantity, sizeStock.ventaPublico.stock);
      const remaining = quantity - qtyFromVenta;
      if (remaining > 0 && sizeStock.general.stock > 0) {
        qtyFromGeneral = Math.min(remaining, sizeStock.general.stock);
      }
    } else if (sizeStock.general.stock > 0) {
      qtyFromGeneral = Math.min(quantity, sizeStock.general.stock);
    }
    
    // Agregar producto al pedido
    const productToAdd = {
      product_name: product.name,
      color: variant.color,
      size: normalizedSize,
      quantity: quantity,
      price_snapshot: variant.price,
      imagen: imageData?.url || null,
      variant_id: variant.id,
      qty_from_general: qtyFromGeneral,
      qty_from_venta: qtyFromVenta
    };
    
    await addProductToOrder(productToAdd);
    
    // Mostrar mensaje de éxito
    console.log(`✅ Producto agregado al pedido: ${product.name} - ${variant.color} - ${normalizedSize || 'N/A'}`);
    
  } catch (error) {
    console.error("❌ Error procesando QR code:", error);
    alert(`Error al procesar código QR ${qrCode}: ${error.message}`);
  }
}

// Función para ordenar talles de menor a mayor
function sortSizes(sizes) {
  // Orden estándar para tallas de ropa
  const sizeOrder = {
    'XS': 1, 'S': 2, 'M': 3, 'L': 4, 'XL': 5, 
    'XXL': 6, '2XL': 6, '3XL': 7, '4XL': 8, '5XL': 9,
    'UNICO': 10, 'ÚNICO': 10, 'U': 10
  };
  
  return sizes.sort((a, b) => {
    const talleA = String(a.talle || '').trim().toUpperCase();
    const talleB = String(b.talle || '').trim().toUpperCase();
    
    // Si ambos son números, ordenar numéricamente de menor a mayor
    const numA = parseFloat(talleA);
    const numB = parseFloat(talleB);
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA - numB;
    }
    
    // Si ambos están en el orden de tallas de ropa, usar ese orden
    if (sizeOrder[talleA] !== undefined && sizeOrder[talleB] !== undefined) {
      return sizeOrder[talleA] - sizeOrder[talleB];
    }
    
    // Si solo A está en el orden de ropa, A va después
    if (sizeOrder[talleA] !== undefined) return 1;
    
    // Si solo B está en el orden de ropa, B va después
    if (sizeOrder[talleB] !== undefined) return -1;
    
    // Si ninguno es número ni está en el orden, ordenar alfabéticamente
    return talleA.localeCompare(talleB);
  });
}

function normalizeSearchText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getProductSimilarityRank(productName, query) {
  const normalizedName = normalizeSearchText(productName);
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedQuery) {
    return { bucket: 3, extra: 0, name: normalizedName };
  }

  if (normalizedName === normalizedQuery) {
    return { bucket: 0, extra: 0, name: normalizedName };
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    // Prefijos más cortos primero: 800 antes que 8005.
    return { bucket: 1, extra: normalizedName.length - normalizedQuery.length, name: normalizedName };
  }

  const containsAt = normalizedName.indexOf(normalizedQuery);
  if (containsAt >= 0) {
    return { bucket: 2, extra: containsAt, name: normalizedName };
  }

  return { bucket: 3, extra: Number.MAX_SAFE_INTEGER, name: normalizedName };
}

// Mostrar resultados de productos
function displayProductResults(products, query = "") {
  const resultsDiv = document.getElementById("product-results");
  if (!resultsDiv) return;
  
  if (!products || products.length === 0) {
    resultsDiv.innerHTML = "<div style='padding: 12px; color: #666;'>No se encontraron productos</div>";
    resultsDiv.style.display = "block";
    return;
  }
  
  // Agrupar por artículo y color
  const groupedProducts = {};
  products.forEach(product => {
    const key = `${product.articulo}-${product.color}`;
    if (!groupedProducts[key]) {
      groupedProducts[key] = {
        articulo: product.articulo,
        color: product.color,
        imagen: product.imagen,
        talles: []
      };
    }
    groupedProducts[key].talles.push({
      talle: product.talle,
      precio: product.precio,
      stock_general: product.stock_general || 0,
      stock_venta: product.stock_venta || 0,
      stock_total: product.stock_total || 0,
      variant_id: product.variant_id
    });
  });
  
  // Ordenar los talles de cada producto
  Object.values(groupedProducts).forEach(product => {
    product.talles = sortSizes(product.talles);
  });

  // Priorizar por similitud con el término de búsqueda (exacto > prefijo corto > resto).
  const groupedList = Object.values(groupedProducts).sort((a, b) => {
    const rankA = getProductSimilarityRank(a.articulo, query);
    const rankB = getProductSimilarityRank(b.articulo, query);

    if (rankA.bucket !== rankB.bucket) return rankA.bucket - rankB.bucket;
    if (rankA.extra !== rankB.extra) return rankA.extra - rankB.extra;
    return rankA.name.localeCompare(rankB.name, "es", { sensitivity: "base" });
  });

  const productsHtml = groupedList.map(product => `
    <div class="product-result-item">
      <div style="display: flex; gap: 12px; align-items: start;">
        ${product.imagen ? `<img src="${product.imagen}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px;" onerror="this.style.display='none'">` : '<div style="width: 60px; height: 60px; background: #f0f0f0; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #999; font-size: 12px;">Sin img</div>'}
        <div style="flex: 1;">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
            <div>
              <strong>${product.articulo}</strong>
              <div style="font-size: 13px; color: #666; margin-top: 4px;">Color: ${product.color}</div>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">
              ${product.talles.map(t => {
                const variantId = t.variant_id;
                const size = t.talle || '';
                const quantityKey = `${variantId}|${size}`;
                const currentQty = selectedQuantities.get(quantityKey) || 0;
                const stockGeneral = t.stock_general || 0;
                const stockVenta = t.stock_venta || 0;
                const stockTotal = t.stock_total || 0;
                const hasNoStock = stockTotal === 0;
                
                // Determinar estilos según stock y selección
                let bgColor, borderColor, textColor, opacity;
                if (hasNoStock) {
                  // Sin stock: fondo gris claro con opacidad reducida y borde rojo
                  bgColor = '#f5f5f5';
                  borderColor = '#dc3545';  // Rojo en lugar de naranja
                  textColor = '#dc3545';    // Texto en rojo
                  opacity = '0.7';
                } else {
                  // Con stock: determinar si se está usando stock de venta
                  const usingVentaStock = currentQty > stockGeneral;
                  bgColor = usingVentaStock ? '#d4edda' : '#e9ecef';
                  borderColor = usingVentaStock ? '#28a745' : 'transparent';
                  textColor = '#333';
                  opacity = '1';
                }
                
                const tooltipText = hasNoStock 
                  ? `Talle: ${t.talle} | ⚠️ Sin stock | Precio: $${(t.precio || 0).toLocaleString('es-AR')}`
                  : `Talle: ${t.talle} | General: ${stockGeneral} | Venta: ${stockVenta} | Precio: $${(t.precio || 0).toLocaleString('es-AR')}`;
                
                return `
                  <div style="position: relative; width: 45px; height: 45px; background: ${bgColor}; border: 2px solid ${borderColor}; border-radius: 6px; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: all 0.2s; opacity: ${opacity};"
                       data-variant-id="${variantId}"
                       data-quantity-key="${quantityKey}"
                       data-articulo="${product.articulo}"
                       data-color="${product.color}"
                       data-talle="${t.talle}"
                       data-precio="${t.precio}"
                       data-stock-general="${stockGeneral}"
                       data-stock-venta="${stockVenta}"
                       data-stock-total="${stockTotal}"
                       data-has-no-stock="${hasNoStock}"
                       title="${tooltipText}">
                    <div style="font-size: 14px; font-weight: 600; color: ${textColor}; ${hasNoStock ? 'text-decoration: line-through; text-decoration-color: #dc3545;' : ''}">${t.talle}</div>
                    ${hasNoStock ? '<div data-no-stock-badge="true" style="font-size: 8px; font-weight: 600; color: #dc3545; margin-top: 1px;">Sin stock</div>' : ''}
                    ${currentQty > 0 ? `<div style="font-size: 10px; font-weight: 600; color: #CD844D; margin-top: 1px;">${currentQty}</div>` : ''}
                    ${currentQty > 0 ? `
                      <div style="position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; background: #dc3545; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; cursor: pointer; z-index: 10;"
                           data-action="decrease"
                           onclick="event.stopPropagation(); window.decreaseQuantity('${quantityKey}')">-</div>
                    ` : ''}
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        </div>
      </div>
    </div>
  `).join("");
  
  resultsDiv.innerHTML = productsHtml + `
    <div style="margin-top: 16px; padding: 12px; background: #f8f9fa; border-radius: 8px; text-align: center; display: flex; flex-direction: column; gap: 8px;">
      <button onclick="window.addSelectedProductsToOrder()" 
              style="padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 15px;">
        Agregar productos seleccionados
      </button>
      <button onclick="window.hideProductResults()" 
              style="padding: 10px 20px; background: #dc3545; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 15px;">
        Cerrar búsqueda
      </button>
    </div>
  `;
  
  resultsDiv.style.display = "block";
  
  // Agregar event listeners a los cuadrados de talles
  resultsDiv.querySelectorAll("[data-variant-id]").forEach(square => {
    square.addEventListener("click", (e) => {
      // Ignorar clicks en el botón de disminuir o en sus elementos hijos
      if (e.target.dataset.action === "decrease" || e.target.closest('[data-action="decrease"]')) {
        return;
      }
      
      const variantId = square.dataset.variantId;
      const quantityKey = square.dataset.quantityKey || `${variantId}|${square.dataset.talle}`;
      const articulo = square.dataset.articulo;
      const color = square.dataset.color;
      const talle = square.dataset.talle;
      const precio = parseFloat(square.dataset.precio);
      const stockGeneral = parseInt(square.dataset.stockGeneral) || 0;
      const stockVenta = parseInt(square.dataset.stockVenta) || 0;
      const stockTotal = parseInt(square.dataset.stockTotal) || 0;
      const hasNoStock = square.dataset.hasNoStock === 'true';
      const currentQty = selectedQuantities.get(quantityKey) || 0;
      
      // Si no hay stock, mostrar modal de confirmación
      if (hasNoStock) {
        showStockMaxConfirmModal(articulo, color, talle, 0, stockGeneral, stockVenta, quantityKey, currentQty, true);
      } else {
        // Incrementar cantidad si hay stock disponible
        if (currentQty < stockTotal) {
          selectedQuantities.set(quantityKey, currentQty + 1);
          updateProductSquare(quantityKey);
        } else {
          // Stock máximo alcanzado: mostrar modal de confirmación
          showStockMaxConfirmModal(articulo, color, talle, stockTotal, stockGeneral, stockVenta, quantityKey, currentQty);
        }
      }
    });
  });
}

// Función para actualizar un cuadrado de talle específico
function updateProductSquare(quantityKey) {
  const square = document.querySelector(`[data-quantity-key="${quantityKey}"]`);
  if (!square) return;
  
  const currentQty = selectedQuantities.get(quantityKey) || 0;
  const stockGeneral = parseInt(square.dataset.stockGeneral) || 0;
  const stockVenta = parseInt(square.dataset.stockVenta) || 0;
  const stockTotal = parseInt(square.dataset.stockTotal) || 0;
  const hasNoStock = square.dataset.hasNoStock === 'true';
  const talle = square.dataset.talle;
  
  // Determinar estilos según stock y selección
  let bgColor, borderColor, opacity, textColor;
  if (hasNoStock) {
    // Mantener estilo de sin stock incluso con cantidad seleccionada
    bgColor = '#f5f5f5';
    borderColor = '#ff9800';
    opacity = '0.7';
    textColor = '#999';
  } else {
    // Determinar si se está usando stock de venta
    const usingVentaStock = currentQty > stockGeneral;
    bgColor = usingVentaStock ? '#d4edda' : '#e9ecef';
    borderColor = usingVentaStock ? '#28a745' : 'transparent';
    opacity = '1';
    textColor = '#333';
  }
  
  // Actualizar el cuadrado
  square.style.background = bgColor;
  square.style.borderColor = borderColor;
  square.style.opacity = opacity;
  
  // Actualizar color del texto del talle si es necesario
  const talleDiv = square.querySelector('div[style*="font-size: 14px"]');
  if (talleDiv && hasNoStock) {
    talleDiv.style.color = textColor;
    talleDiv.style.textDecoration = 'line-through';
  } else if (talleDiv && !hasNoStock) {
    talleDiv.style.color = textColor;
    talleDiv.style.textDecoration = 'none';
  }
  
  // Asegurar que el badge "Sin stock" se mantenga visible si corresponde
  const noStockBadge = square.querySelector('[data-no-stock-badge]');
  if (hasNoStock && !noStockBadge) {
    // Agregar badge "Sin stock" si no existe
    const badge = document.createElement('div');
    badge.setAttribute('data-no-stock-badge', 'true');
    badge.style.cssText = 'font-size: 8px; font-weight: 600; color: #ff9800; margin-top: 1px;';
    badge.textContent = 'Sin stock';
    const talleDiv = square.querySelector('div[style*="font-size: 14px"]');
    if (talleDiv) {
      // Insertar después del talle pero antes de la cantidad si existe
      const qtyDiv = square.querySelector('div[style*="font-size: 10px"][style*="color: #CD844D"]');
      if (qtyDiv) {
        talleDiv.parentNode.insertBefore(badge, qtyDiv);
      } else {
        talleDiv.parentNode.insertBefore(badge, talleDiv.nextSibling);
      }
    }
  } else if (!hasNoStock && noStockBadge) {
    // Remover badge si ya no corresponde
    noStockBadge.remove();
  } else if (hasNoStock && noStockBadge) {
    // Asegurar que el badge esté visible
    noStockBadge.style.display = 'block';
  }
  
  // Actualizar el contenido
  const qtyDisplay = square.querySelector('div[style*="font-size: 10px"]');
  if (currentQty > 0) {
    if (!qtyDisplay) {
      const talleDiv = square.querySelector('div[style*="font-size: 14px"]');
      const qtyDiv = document.createElement('div');
      qtyDiv.style.cssText = 'font-size: 10px; font-weight: 600; color: #CD844D; margin-top: 1px;';
      qtyDiv.textContent = currentQty;
      talleDiv.parentNode.insertBefore(qtyDiv, talleDiv.nextSibling);
    } else {
      qtyDisplay.textContent = currentQty;
    }
    
    // Agregar o actualizar botón de disminuir
    let decreaseBtn = square.querySelector('[data-action="decrease"]');
    if (!decreaseBtn) {
      decreaseBtn = document.createElement('div');
      decreaseBtn.style.cssText = 'position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; background: #dc3545; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; cursor: pointer; z-index: 10;';
      decreaseBtn.dataset.action = 'decrease';
      decreaseBtn.textContent = '-';
      decreaseBtn.onclick = (e) => {
        e.stopPropagation();
        window.decreaseQuantity(quantityKey);
      };
      square.appendChild(decreaseBtn);
    } else {
      // Actualizar el onclick del botón existente para asegurar que use el quantityKey correcto
      decreaseBtn.onclick = (e) => {
        e.stopPropagation();
        window.decreaseQuantity(quantityKey);
      };
    }
  } else {
    if (qtyDisplay) qtyDisplay.remove();
    const decreaseBtn = square.querySelector('[data-action="decrease"]');
    if (decreaseBtn) decreaseBtn.remove();
  }
}

// Función global para disminuir cantidad
window.decreaseQuantity = function(quantityKey) {
  const currentQty = selectedQuantities.get(quantityKey) || 0;
  if (currentQty > 0) {
    const newQty = currentQty - 1;
    if (newQty === 0) {
      selectedQuantities.delete(quantityKey);
    } else {
      selectedQuantities.set(quantityKey, newQty);
    }
    updateProductSquare(quantityKey);
  }
};

// Función para mostrar modal de confirmación cuando el stock está agotado o máximo alcanzado
async function showStockMaxConfirmModal(articulo, color, talle, stockTotal, stockGeneral, stockVenta, quantityKey, currentQty, isNoStock = false) {
  const modal = document.getElementById("no-stock-confirm-modal");
  const confirmYes = document.getElementById("no-stock-confirm-yes");
  const confirmNo = document.getElementById("no-stock-confirm-no");
  const modalMessage = document.getElementById("no-stock-confirm-message");

  if (!modal || !confirmYes || !confirmNo || !modalMessage) {
    // Fallback a confirm si el modal no existe
    const message = isNoStock 
      ? `⚠️ Este producto (${articulo} - ${color} - Talle ${talle}) no tiene stock disponible.\n\n¿Deseas agregarlo de todas formas?`
      : `Stock máximo alcanzado para talle ${talle}. Disponible: ${stockTotal} (Venta Público: ${stockVenta}, General: ${stockGeneral}). ¿Desea agregarlo de todas formas? (Útil en caso de mal conteo de stock)`;
    const confirmAdd = confirm(message);
    if (confirmAdd) {
      selectedQuantities.set(quantityKey, currentQty + 1);
      updateProductSquare(quantityKey);
    }
    return;
  }

  // Actualizar mensaje del modal
  if (isNoStock) {
    modalMessage.textContent = `Este producto (${articulo} - ${color} - Talle ${talle}) no tiene stock disponible. ¿Está seguro de que desea agregarlo de todas formas?`;
  } else {
    modalMessage.textContent = `Stock máximo alcanzado para talle ${talle}. Disponible: ${stockTotal} (Venta Público: ${stockVenta}, General: ${stockGeneral}). ¿Desea agregarlo de todas formas? (Útil en caso de mal conteo de stock)`;
  }

  modal.classList.add("active");

  // Esperar respuesta del usuario
  const userConfirmed = await new Promise((resolve) => {
    const handleYes = () => {
      modal.classList.remove("active");
      // Restaurar mensaje original del modal
      modalMessage.textContent = "Este producto no tiene stock disponible. ¿Está seguro de que desea agregarlo de todas formas?";
      confirmYes.removeEventListener("click", handleYes);
      confirmNo.removeEventListener("click", handleNo);
      resolve(true);
    };

    const handleNo = () => {
      modal.classList.remove("active");
      // Restaurar mensaje original del modal
      modalMessage.textContent = "Este producto no tiene stock disponible. ¿Está seguro de que desea agregarlo de todas formas?";
      confirmYes.removeEventListener("click", handleYes);
      confirmNo.removeEventListener("click", handleNo);
      resolve(false);
    };

    confirmYes.addEventListener("click", handleYes);
    confirmNo.addEventListener("click", handleNo);
  });

  if (userConfirmed) {
    // Agregar talle como si tuviera stock (para casos de mal conteo)
    selectedQuantities.set(quantityKey, currentQty + 1);
    updateProductSquare(quantityKey);
  }
}

// Agregar productos seleccionados al pedido
async function addSelectedProductsToOrder() {
  if (selectedQuantities.size === 0) {
    alert("No hay productos seleccionados. Haz clic en los talles para seleccionar cantidades.");
    return;
  }
  
  // Cargar almacenes si no están cargados
  if (!warehouses.general || !warehouses.ventaPublico) {
    await loadWarehouses();
  }
  
  const resultsDiv = document.getElementById("product-results");
  if (!resultsDiv) return;
  
  // Obtener información de cada variante seleccionada
  const productsToAdd = [];
  
  for (const [quantityKey, quantity] of selectedQuantities.entries()) {
    if (quantity <= 0) continue;
    
    const square = resultsDiv.querySelector(`[data-quantity-key="${quantityKey}"]`);
    if (!square) continue;
    
    const articulo = square.dataset.articulo;
    const color = square.dataset.color;
    const talle = square.dataset.talle;
    const precio = parseFloat(square.dataset.precio);
    const stockGeneral = parseInt(square.dataset.stockGeneral) || 0;
    const stockVenta = parseInt(square.dataset.stockVenta) || 0;
    const variantId = square.dataset.variantId;
    
    // VALIDACIÓN: Verificar stock disponible antes de agregar
    const stockTotal = stockGeneral + stockVenta;
    
    // Verificar si ya existe este producto en el pedido para calcular cantidad total
    const existingItem = orderItems.find(item => 
      item.product_name === articulo &&
      item.color === color &&
      item.size === talle
    );
    const totalQuantity = (existingItem?.quantity || 0) + quantity;
    
    // Inicializar variables para cantidad de cada stock
    let qtyFromGeneral = 0;
    let qtyFromVenta = 0;
    
    if (totalQuantity > stockTotal) {
      const available = Math.max(0, stockTotal - (existingItem?.quantity || 0));
      if (available <= 0) {
        const confirmAdd = confirm(
          `⚠️ No hay stock disponible para ${articulo} - ${color} - Talle ${talle}.\n\n` +
          `Stock disponible: ${stockTotal} (General: ${stockGeneral}, Venta: ${stockVenta})\n\n` +
          `¿Desea agregarlo de todas formas? (Útil en caso de mal conteo de stock)`
        );
        
        if (!confirmAdd) {
          continue; // Saltar este producto
        }
        
        // Permitir agregar con cantidad solicitada pero sin stock
        qtyFromGeneral = 0;
        qtyFromVenta = 0;
        // Continuar con el flujo normal (no ajustar quantity, usar la cantidad solicitada)
      } else {
        const confirmAdd = confirm(
          `⚠️ Stock insuficiente para ${articulo} - ${color} - Talle ${talle}.\n\n` +
          `Stock disponible: ${stockTotal} (General: ${stockGeneral}, Venta: ${stockVenta})\n` +
          `Ya en pedido: ${existingItem?.quantity || 0}\n` +
          `Cantidad a agregar: ${quantity}\n` +
          `Total sería: ${totalQuantity}\n\n` +
          `¿Desea agregar solo ${available} unidades disponibles?`
        );
        
        if (!confirmAdd) {
          continue;
        }
        
        // Ajustar cantidad al stock disponible
        quantity = available;
        
        // Calcular cuánto viene de cada stock (priorizar venta-publico, luego general)
        if (stockVenta > 0) {
          qtyFromVenta = Math.min(quantity, stockVenta);
          const remaining = quantity - qtyFromVenta;
          if (remaining > 0 && stockGeneral > 0) {
            qtyFromGeneral = Math.min(remaining, stockGeneral);
          }
        } else if (stockGeneral > 0) {
          qtyFromGeneral = Math.min(quantity, stockGeneral);
        }
      }
    } else {
      // Calcular cuánto viene de cada stock (priorizar venta-publico, luego general)
      // Solo si no se excedió el stock
      if (stockVenta > 0) {
        qtyFromVenta = Math.min(quantity, stockVenta);
        const remaining = quantity - qtyFromVenta;
        if (remaining > 0 && stockGeneral > 0) {
          qtyFromGeneral = Math.min(remaining, stockGeneral);
        }
      } else if (stockGeneral > 0) {
        qtyFromGeneral = Math.min(quantity, stockGeneral);
      }
    }
    
    // Obtener la imagen del producto
    let imagen = null;
    if (supabase && variantId) {
      try {
        const { data: imageData } = await supabase
          .from("variant_images")
          .select("url")
          .eq("variant_id", variantId)
          .eq("position", 1)
          .maybeSingle();
        
        if (imageData) {
          imagen = imageData.url;
        }
      } catch (error) {
        console.warn("⚠️ No se pudo obtener la imagen:", error);
      }
    }
    
    productsToAdd.push({
      product_name: articulo,
      color: color,
      size: talle,
      quantity: quantity,
      price_snapshot: precio,
      imagen: imagen,
      variant_id: variantId,
      qty_from_general: qtyFromGeneral,
      qty_from_venta: qtyFromVenta
    });
  }
  
  // Agregar cada producto al pedido
  for (const product of productsToAdd) {
    await addProductToOrder(product);
  }
  
  // Limpiar selecciones y actualizar visualización
  selectedQuantities.clear();
  if (resultsDiv) {
    resultsDiv.querySelectorAll("[data-quantity-key]").forEach(square => {
      updateProductSquare(square.dataset.quantityKey);
    });
  }
  
  // Cerrar el panel de búsqueda después de agregar los productos
  hideProductResults();
  
  // Limpiar el campo de búsqueda solo después de agregar productos
  const searchInput = document.getElementById("product-search");
  if (searchInput) {
    searchInput.value = "";
  }
  
  // El aviso de confirmación fue removido según solicitud del usuario
}

// Agregar extra especial al pedido
function addSpecialExtra() {
  const nameInput = document.getElementById("special-extra-name");
  const amountInput = document.getElementById("special-extra-amount");
  
  const name = nameInput?.value?.trim();
  const amount = parseFloat(amountInput?.value);
  
  // Validaciones
  if (!name) {
    alert("Por favor ingrese un nombre para el extra especial");
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    alert("Por favor ingrese un monto válido mayor a 0");
    return;
  }
  
  // Crear item de extra especial
  const specialExtra = {
    id: `special-${Date.now()}-${Math.random()}`,
    product_name: name,
    color: null,
    size: null,
    quantity: 1,
    price_snapshot: amount,
    imagen: null,
    variant_id: null,
    qty_from_general: 0,
    qty_from_venta: 0,
    status: 'picked',
    is_special_extra: true
  };
  
  // Agregar a orderItems
  orderItems.push(specialExtra);
  
  // Limpiar campos
  if (nameInput) nameInput.value = "";
  if (amountInput) amountInput.value = "";
  
  // Actualizar lista
  updateOrderItemsList();
  
  console.log(`✅ Extra especial agregado: ${name} - $${amount}`);
}

// Agregar producto al pedido
async function addProductToOrder(product) {
  // VALIDACIÓN: Verificar stock disponible si se proporciona información de stock
  if (product.variant_id && product.size && !product.is_special_extra) {
    // Obtener stock actual desde la base de datos para validación
    if (!warehouses.general || !warehouses.ventaPublico) {
      await loadWarehouses();
    }
    
    try {
      const normalizedSize = normalizeSize(product.size);
      if (normalizedSize) {
        // Obtener stock actual por talle
        const { data: sizeStocks } = await supabase
          .from("variant_size_warehouse_stock")
          .select("warehouse_id, stock_qty")
          .eq("variant_id", product.variant_id)
          .eq("size", normalizedSize)
          .in("warehouse_id", [warehouses.general, warehouses.ventaPublico]);
        
        let stockGeneral = 0;
        let stockVenta = 0;
        
        if (sizeStocks) {
          sizeStocks.forEach(s => {
            if (String(s.warehouse_id) === String(warehouses.general)) {
              stockGeneral = s.stock_qty || 0;
            } else if (String(s.warehouse_id) === String(warehouses.ventaPublico)) {
              stockVenta = s.stock_qty || 0;
            }
          });
        }
        
        const stockTotal = stockGeneral + stockVenta;
        
        // Verificar si ya existe este producto en el pedido
        const existingItem = orderItems.find(item => 
          item.product_name === product.product_name &&
          item.color === product.color &&
          item.size === product.size
        );
        const totalQuantity = (existingItem?.quantity || 0) + product.quantity;
        
        // Validar que no se exceda el stock disponible
        if (totalQuantity > stockTotal) {
          const available = Math.max(0, stockTotal - (existingItem?.quantity || 0));
          if (available <= 0) {
            // Si el stock es 0, permitir agregar si el usuario confirma
            const confirmAdd = confirm(
              `⚠️ No hay stock disponible para ${product.product_name} - ${product.color} - Talle ${product.size}.\n\n` +
              `Stock disponible: ${stockTotal} (General: ${stockGeneral}, Venta: ${stockVenta})\n\n` +
              `¿Desea agregarlo de todas formas? (Útil en caso de mal conteo de stock)`
            );
            
            if (!confirmAdd) {
              return;
            }
            
            // Permitir agregar con cantidad solicitada pero sin stock (qty_from_general = 0, qty_from_venta = 0)
            product.qty_from_general = 0;
            product.qty_from_venta = 0;
            // Continuar con el flujo normal para agregar el producto
          } else {
            const confirmAdd = confirm(
              `⚠️ Stock insuficiente para ${product.product_name} - ${product.color} - Talle ${product.size}.\n\n` +
              `Stock disponible: ${stockTotal} (General: ${stockGeneral}, Venta: ${stockVenta})\n` +
              `Ya en pedido: ${existingItem?.quantity || 0}\n` +
              `Cantidad a agregar: ${product.quantity}\n` +
              `Total sería: ${totalQuantity}\n\n` +
              `¿Desea agregar solo ${available} unidades disponibles?`
            );
            
            if (!confirmAdd) {
              return;
            }
            
            // Ajustar cantidad al stock disponible
            product.quantity = available;
            
            // Recalcular qty_from_general y qty_from_venta
            if (stockVenta > 0) {
              product.qty_from_venta = Math.min(product.quantity, stockVenta);
              const remaining = product.quantity - product.qty_from_venta;
              if (remaining > 0 && stockGeneral > 0) {
                product.qty_from_general = Math.min(remaining, stockGeneral);
              } else {
                product.qty_from_general = 0;
              }
            } else if (stockGeneral > 0) {
              product.qty_from_general = Math.min(product.quantity, stockGeneral);
              product.qty_from_venta = 0;
            }
          }
        }
      }
    } catch (error) {
      console.warn("⚠️ Error validando stock al agregar producto:", error);
      // Continuar agregando el producto aunque falle la validación
    }
  }
  
  // Verificar si ya existe en el pedido
  const existingIndex = orderItems.findIndex(item => 
    item.product_name === product.product_name &&
    item.color === product.color &&
    item.size === product.size
  );
  
  if (existingIndex >= 0) {
    // Actualizar cantidad
    orderItems[existingIndex].quantity += product.quantity;
    // Actualizar cantidades de stock si existen
    if (product.qty_from_general !== undefined) {
      orderItems[existingIndex].qty_from_general = (orderItems[existingIndex].qty_from_general || 0) + product.qty_from_general;
      orderItems[existingIndex].qty_from_venta = (orderItems[existingIndex].qty_from_venta || 0) + product.qty_from_venta;
    }
  } else {
    // Agregar nuevo item con estado por defecto "reserved"
    orderItems.push({
      ...product,
      id: `temp-${Date.now()}-${Math.random()}`,
      qty_from_general: product.qty_from_general || 0,
      qty_from_venta: product.qty_from_venta || 0,
      status: product.status || 'picked' // Admin: por defecto "apartado"
    });
  }
  
  // NOTA: El stock NO se descuenta aquí al agregar productos.
  // El stock se descuenta solo cuando se guarda el pedido mediante updateStockBatch().
  // Esto evita descontar stock si el usuario cancela o no guarda el pedido.
  
  updateOrderItemsList();
}

// NOTA: La función updateStockForOrder fue eliminada porque:
// 1. No se usa (el stock se descuenta mediante updateStockBatch cuando se guarda el pedido)
// 2. Usaba variant_warehouse_stock (obsoleto) en lugar de variant_size_warehouse_stock (actual)
// 3. No manejaba stock por talle individual, solo por variante completa
// El descuento de stock ahora se maneja exclusivamente mediante updateStockBatch() que:
// - Se ejecuta solo cuando se guarda el pedido (createNewOrder/addItemsToExistingOrder)
// - Maneja stock por talle individual usando variant_size_warehouse_stock
// - Usa qty_from_general y qty_from_venta de cada item para descontar correctamente

// Función global para agregar productos seleccionados
window.addSelectedProductsToOrder = addSelectedProductsToOrder;

// Remover producto del pedido
function removeProductFromOrder(itemId) {
  orderItems = orderItems.filter(item => item.id !== itemId);
  updateOrderItemsList();
}

// Actualizar cantidad de producto
function updateProductQuantity(itemId, newQuantity) {
  const item = orderItems.find(item => item.id === itemId);
  if (item) {
    if (newQuantity <= 0) {
      removeProductFromOrder(itemId);
    } else {
      // Actualizar cantidad total
      item.quantity = parseInt(newQuantity);

      // Si el item tenía cantidades específicas por almacén (qty_from_general / qty_from_venta),
      // dejarlas en cero para que updateStockBatch recalcule desde cero según el stock actual.
      // Esto evita que se descuente solo la cantidad original cuando el admin cambia la cantidad manualmente.
      if (item.qty_from_general || item.qty_from_venta) {
        item.qty_from_general = 0;
        item.qty_from_venta = 0;
      }

      updateOrderItemsList();
    }
  }
}

// Cambiar estado de producto entre "reserved" y "waiting"
function toggleProductWaitingStatus(itemId) {
  const item = orderItems.find(item => item.id === itemId);
  if (item) {
    // Alternar entre 'reserved' y 'waiting'
    item.status = item.status === 'waiting' ? 'reserved' : 'waiting';
    updateOrderItemsList();
  }
}

// Marcar producto como "Apartado" (picked)
function setProductAsPicked(itemId) {
  const item = orderItems.find(item => item.id === itemId);
  if (item) {
    item.status = 'picked';
    updateOrderItemsList();
  }
}

// Exponer funciones globalmente
window.toggleProductWaitingStatus = toggleProductWaitingStatus;
window.setProductAsPicked = setProductAsPicked;

// Actualizar contador de productos
function updateProductsCounter() {
  const counterElement = document.getElementById("products-count");
  if (!counterElement) return;
  
  // Sumar la cantidad total de productos (sumando las cantidades de cada item)
  const totalProducts = orderItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
  counterElement.textContent = totalProducts;
}

// Actualizar lista de productos del pedido
function updateOrderItemsList() {
  const itemsList = document.getElementById("order-items-list");
  if (!itemsList) return;
  
  // Construir HTML de productos
  const productsHtml = orderItems.map(item => {
    const subtotal = (item.price_snapshot || 0) * (item.quantity || 0);
    const itemStatus = item.status || 'reserved';
    const isWaiting = itemStatus === 'waiting';
    const isPicked = itemStatus === 'picked';
    const isSpecialExtra = item.is_special_extra === true;
    
    // Construir badge de estado
    let statusBadge = '';
    if (isSpecialExtra) {
      statusBadge = '<span style="background: #9c27b0; color: white; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;">⭐ EXTRA</span>';
    } else if (isWaiting) {
      statusBadge = '<span style="background: #fff4e6; color: #e65100; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; border: 1px solid #ff9800;">⏳ Espera</span>';
    } else if (isPicked) {
      statusBadge = '<span style="background: #e6f4ea; color: #1b5e20; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; border: 1px solid #28a745;">✓ Apartado</span>';
    }
    
    // Determinar estilo del contenedor
    let containerStyle = '';
    if (isSpecialExtra) {
      containerStyle = 'border-left: 4px solid #9c27b0; background: #f3e5f5;';
    } else if (isWaiting) {
      containerStyle = 'border-left: 4px solid #ff9800; background: #fff9f0;';
    } else if (isPicked) {
      containerStyle = 'border-left: 4px solid #28a745; background: #f0f9f4;';
    }
    
    return `
      <div class="order-item-in-modal" style="${containerStyle}">
        <div class="order-item-in-modal-info">
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong>${item.product_name || 'Producto'}</strong>
            ${statusBadge}
          </div>
          <div style="font-size: 13px; color: #666; margin-top: 4px;">
            ${isSpecialExtra ? 'Extra personalizado' : `Color: ${item.color || '-'} • Talle: ${item.size || '-'}`}
          </div>
          <div style="font-size: 14px; color: #CD844D; margin-top: 8px; font-weight: 600;">
            $${(item.price_snapshot || 0).toLocaleString('es-AR')} x ${item.quantity || 0} = $${subtotal.toLocaleString('es-AR')}
          </div>
        </div>
        <div class="order-item-in-modal-actions" style="display: flex; gap: 8px; align-items: center;">
          <button onclick="window.toggleProductWaitingStatus('${item.id}')" 
                  title="${isWaiting ? 'Marcar como Reservado' : 'Marcar como Espera'}"
                  style="padding: 6px 12px; background: ${isWaiting ? '#6c757d' : '#ff9800'}; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
            ${isWaiting ? '↺ Reservado' : '⏳ Espera'}
          </button>
          <button onclick="window.setProductAsPicked('${item.id}')" 
                  title="Marcar como Apartado"
                  style="padding: 6px 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;">
            ✓ Apartado
          </button>
          <input type="number" 
                 min="1" 
                 value="${item.quantity || 1}" 
                 style="width: 60px; padding: 4px; border: 1px solid #ddd; border-radius: 4px; text-align: center;"
                 onchange="window.updateProductQuantity('${item.id}', this.value)">
          <button onclick="window.removeProductFromOrder('${item.id}')" 
                  style="padding: 6px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">
            ✕
          </button>
        </div>
      </div>
    `;
  }).join("");
  
  // Construir HTML de valores extra
  const extraValuesHtml = [];
  
  if (shippingAmount > 0) {
    extraValuesHtml.push(`
      <div class="order-item-in-modal" style="background: #e3f2fd; border-left: 4px solid #2196f3;">
        <div class="order-item-in-modal-info">
          <strong>🚚 Envío</strong>
          <div style="font-size: 14px; color: #2196f3; margin-top: 8px; font-weight: 600;">
            $${shippingAmount.toLocaleString('es-AR')}
          </div>
        </div>
        <div class="order-item-in-modal-actions">
          <button onclick="window.removeExtraValue('shipping')" 
                  style="padding: 6px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">
            ✕
          </button>
        </div>
      </div>
    `);
  }
  
  if (discountAmount > 0) {
    extraValuesHtml.push(`
      <div class="order-item-in-modal" style="background: #ffebee; border-left: 4px solid #f44336;">
        <div class="order-item-in-modal-info">
          <strong>💸 Descuento</strong>
          <div style="font-size: 14px; color: #f44336; margin-top: 8px; font-weight: 600;">
            -$${discountAmount.toLocaleString('es-AR')}
          </div>
        </div>
        <div class="order-item-in-modal-actions">
          <button onclick="window.removeExtraValue('discount')" 
                  style="padding: 6px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">
            ✕
          </button>
        </div>
      </div>
    `);
  }
  
  if (extrasAmount > 0) {
    extraValuesHtml.push(`
      <div class="order-item-in-modal" style="background: #f3e5f5; border-left: 4px solid #9c27b0;">
        <div class="order-item-in-modal-info">
          <strong>➕ Extras</strong>
          <div style="font-size: 14px; color: #9c27b0; margin-top: 8px; font-weight: 600;">
            $${extrasAmount.toLocaleString('es-AR')}
          </div>
        </div>
        <div class="order-item-in-modal-actions">
          <button onclick="window.removeExtraValue('extras_amount')" 
                  style="padding: 6px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">
            ✕
          </button>
        </div>
      </div>
    `);
  }
  
  if (extrasPercentage > 0) {
    // Calcular el subtotal para el porcentaje
    const subtotal = orderItems.reduce((sum, item) => {
      return sum + ((item.price_snapshot || 0) * (item.quantity || 0));
    }, 0);
    const extrasFromPercentage = subtotal * extrasPercentage / 100;
    
    extraValuesHtml.push(`
      <div class="order-item-in-modal" style="background: #f3e5f5; border-left: 4px solid #9c27b0;">
        <div class="order-item-in-modal-info">
          <strong>➕ Extras (${extrasPercentage}%)</strong>
          <div style="font-size: 14px; color: #9c27b0; margin-top: 8px; font-weight: 600;">
            $${extrasFromPercentage.toLocaleString('es-AR')}
          </div>
        </div>
        <div class="order-item-in-modal-actions">
          <button onclick="window.removeExtraValue('extras_percentage')" 
                  style="padding: 6px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">
            ✕
          </button>
        </div>
      </div>
    `);
  }
  
  // Combinar productos y valores extra
  if (orderItems.length === 0 && extraValuesHtml.length === 0) {
    itemsList.innerHTML = "<p style='color: #666; text-align: center; padding: 20px;'>No hay productos agregados aún</p>";
  } else {
    itemsList.innerHTML = productsHtml + extraValuesHtml.join("");
  }
  
  updateOrderTotal();
  updateSaveButton(); // Actualizar estado del botón de guardar
  updateProductsCounter(); // Actualizar contador de productos
}

// Función para remover valores extra
window.removeExtraValue = function(type) {
  const shippingInput = document.getElementById("shipping-amount");
  const discountInput = document.getElementById("discount-amount");
  const extrasAmountInput = document.getElementById("extras-amount");
  const extrasPercentageInput = document.getElementById("extras-percentage");
  
  switch(type) {
    case 'shipping':
      shippingAmount = 0;
      if (shippingInput) shippingInput.value = "";
      break;
    case 'discount':
      discountAmount = 0;
      if (discountInput) discountInput.value = "";
      break;
    case 'extras_amount':
      extrasAmount = 0;
      if (extrasAmountInput) extrasAmountInput.value = "";
      break;
    case 'extras_percentage':
      extrasPercentage = 0;
      if (extrasPercentageInput) extrasPercentageInput.value = "";
      break;
  }
  
  updateOrderItemsList();
};

// Actualizar total del pedido
function updateOrderTotal() {
  const totalElement = document.getElementById("order-total");
  if (!totalElement) return;
  
  // Calcular subtotal de productos
  const subtotal = orderItems.reduce((sum, item) => {
    return sum + ((item.price_snapshot || 0) * (item.quantity || 0));
  }, 0);
  
  // Calcular extras por porcentaje si existe
  const extrasFromPercentage = extrasPercentage > 0 ? (subtotal * extrasPercentage / 100) : 0;
  
  // Calcular total final
  const total = subtotal + shippingAmount - discountAmount + extrasAmount + extrasFromPercentage;
  
  // Mostrar desglose si hay valores extra
  if (shippingAmount > 0 || discountAmount > 0 || extrasAmount > 0 || extrasPercentage > 0) {
    const breakdown = [];
    breakdown.push(`Subtotal: $${subtotal.toLocaleString('es-AR')}`);
    if (shippingAmount > 0) breakdown.push(`Envío: $${shippingAmount.toLocaleString('es-AR')}`);
    if (discountAmount > 0) breakdown.push(`Descuento: -$${discountAmount.toLocaleString('es-AR')}`);
    if (extrasAmount > 0) breakdown.push(`Extras: $${extrasAmount.toLocaleString('es-AR')}`);
    if (extrasPercentage > 0) breakdown.push(`Extras (${extrasPercentage}%): $${extrasFromPercentage.toLocaleString('es-AR')}`);
    breakdown.push(`<strong>Total: $${Math.max(0, total).toLocaleString('es-AR')}</strong>`);
    
    totalElement.innerHTML = breakdown.join('<br>');
  } else {
    totalElement.textContent = `$${Math.max(0, total).toLocaleString('es-AR')}`;
  }
}

// Habilitar funciones globales para los event handlers inline
window.updateProductQuantity = updateProductQuantity;
window.removeProductFromOrder = removeProductFromOrder;

// Ocultar resultados de productos
function hideProductResults() {
  const resultsDiv = document.getElementById("product-results");
  if (resultsDiv) {
    resultsDiv.style.display = "none";
  }
  // Limpiar selecciones cuando se ocultan los resultados
  selectedQuantities.clear();
}

// Hacer la función disponible globalmente
window.hideProductResults = hideProductResults;

// Actualizar botón de guardar
function updateSaveButton() {
  const saveBtn = document.getElementById("save-order-btn");
  if (!saveBtn) {
    console.warn("⚠️ updateSaveButton: save-order-btn no encontrado");
    return;
  }
  
  if (editingOrderId) {
    // Al editar, solo necesitas cliente (los productos nuevos son opcionales pero se valida antes de guardar)
    const canSave = currentCustomer !== null;
    saveBtn.disabled = !canSave;
    saveBtn.textContent = "Agregar Productos al Pedido";
    console.log(`🔧 updateSaveButton (edición): canSave=${canSave}, disabled=${!canSave}`);
    if (!canSave) {
      saveBtn.title = "Selecciona un cliente";
    } else {
      saveBtn.title = "";
    }
  } else {
    // Al crear, necesitas cliente y al menos un producto
    const canSave = currentCustomer && orderItems.length > 0;
    saveBtn.disabled = !canSave;
    saveBtn.textContent = "Guardar Pedido";
    console.log(`🔧 updateSaveButton (creación): currentCustomer=${!!currentCustomer}, orderItems.length=${orderItems.length}, canSave=${canSave}, disabled=${!canSave}`);
    if (!canSave) {
      saveBtn.title = "Selecciona un cliente y agrega al menos un producto";
    } else {
      saveBtn.title = "";
    }
  }
}

// Guardar pedido
async function saveOrder() {
  // Obtener el botón de guardar
  const saveBtn = document.getElementById("save-order-btn");
  const originalText = saveBtn ? saveBtn.textContent : "";
  
  // Deshabilitar el botón para evitar múltiples clics
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando...";
    saveBtn.style.cursor = "not-allowed";
  }
  
  try {
    console.log("🔵 saveOrder: Iniciando guardado de pedido...");
    console.log("🔵 saveOrder: currentCustomer:", currentCustomer);
    console.log("🔵 saveOrder: orderItems.length:", orderItems.length);
    console.log("🔵 saveOrder: editingOrderId:", editingOrderId);
    
    if (!currentCustomer) {
      console.warn("⚠️ saveOrder: No hay cliente seleccionado");
      alert("Por favor, selecciona un cliente.");
      return;
    }
    
    // Validar que currentCustomer tenga un id válido
    if (!currentCustomer.id || !isValidUUID(currentCustomer.id)) {
      console.error("❌ saveOrder: currentCustomer no tiene id válido:", currentCustomer);
      alert("Error: El cliente seleccionado no tiene un ID válido. Por favor, selecciona un cliente nuevamente.");
      return;
    }
    
    if (!editingOrderId && orderItems.length === 0) {
      console.warn("⚠️ saveOrder: No hay productos en el pedido");
      alert("Por favor, agrega al menos un producto al pedido.");
      return;
    }
    
    if (editingOrderId && orderItems.length === 0) {
      // Si hay valores extra, permitir guardar aunque no haya productos nuevos
      const hasExtraValues = shippingAmount > 0 || discountAmount > 0 || extrasAmount > 0 || extrasPercentage > 0;
      if (!hasExtraValues) {
        console.warn("⚠️ saveOrder: No hay productos nuevos ni valores extra");
        alert("No hay productos nuevos ni valores extra para agregar al pedido.");
        return;
      }
    }
    
    if (!supabase) {
      console.log("🔵 saveOrder: Obteniendo Supabase...");
      supabase = await getSupabase();
    }
    if (!supabase) {
      console.error("❌ saveOrder: Supabase no disponible");
      alert("No se pudo conectar con la base de datos.");
      return;
    }
    
    console.log("✅ saveOrder: Supabase disponible, iniciando proceso...");
    // Calcular subtotal de productos nuevos
    const subtotalNewItems = orderItems.reduce((sum, item) => {
      return sum + ((item.price_snapshot || 0) * (item.quantity || 0));
    }, 0);
    
    // Si estamos editando, necesitamos obtener el total actual del pedido
    let currentOrderTotal = 0;
    let currentOrderSubtotal = 0;
    if (editingOrderId) {
      const { data: currentOrder } = await supabase
        .from("orders")
        .select("total_amount, notes")
        .eq("id", editingOrderId)
        .maybeSingle();
      
      if (currentOrder) {
        currentOrderTotal = parseFloat(currentOrder.total_amount) || 0;
        
        // Obtener el subtotal de items existentes
        const { data: existingItems } = await supabase
          .from("order_items")
          .select("quantity, price_snapshot")
          .eq("order_id", editingOrderId);
        
        if (existingItems) {
          currentOrderSubtotal = existingItems.reduce((sum, item) => {
            return sum + ((item.price_snapshot || 0) * (item.quantity || 0));
          }, 0);
        }
        
        // Si hay valores extra existentes, extraerlos para recalcular
        if (currentOrder.notes) {
          try {
            const existingExtras = JSON.parse(currentOrder.notes);
            // Restar los valores extra anteriores del total para obtener el subtotal real
            const existingShipping = parseFloat(existingExtras.shipping) || 0;
            const existingDiscount = parseFloat(existingExtras.discount) || 0;
            const existingExtrasAmount = parseFloat(existingExtras.extras_amount) || 0;
            const existingExtrasPercentage = parseFloat(existingExtras.extras_percentage) || 0;
            const existingExtrasFromPercentage = existingExtrasPercentage > 0 ? (currentOrderSubtotal * existingExtrasPercentage / 100) : 0;
            
            // El subtotal real es el total menos los valores extra anteriores
            currentOrderSubtotal = currentOrderTotal - existingShipping + existingDiscount - existingExtrasAmount - existingExtrasFromPercentage;
          } catch (e) {
            // Si no se pueden parsear notes, usar el total como subtotal aproximado
            currentOrderSubtotal = currentOrderTotal;
          }
        } else {
          currentOrderSubtotal = currentOrderTotal;
        }
      }
    }
    
    // Calcular el nuevo subtotal (items existentes + items nuevos)
    const totalSubtotal = currentOrderSubtotal + subtotalNewItems;
    
    // Calcular extras por porcentaje si existe (sobre el subtotal total)
    const extrasFromPercentage = extrasPercentage > 0 ? (totalSubtotal * extrasPercentage / 100) : 0;
    
    // Calcular total final con valores extra
    const total = totalSubtotal + shippingAmount - discountAmount + extrasAmount + extrasFromPercentage;
    
    // Preparar datos de valores extra para guardar en notes
    const extraValues = {
      shipping: shippingAmount,
      discount: discountAmount,
      extras_amount: extrasAmount,
      extras_percentage: extrasPercentage
    };
    
    let updatedOrderId = null;
    if (editingOrderId) {
      // Editar pedido existente - agregar los nuevos items y actualizar valores extra
      console.log("🔵 saveOrder: Editando pedido existente...");
      await addItemsToExistingOrder(editingOrderId, orderItems, total, extraValues);
      updatedOrderId = editingOrderId;
      console.log("✅ saveOrder: Pedido editado correctamente");
    } else {
      // Crear nuevo pedido
      console.log("🔵 saveOrder: Creando nuevo pedido...");
      const orderResult = await createNewOrder(currentCustomer.id, orderItems, total, extraValues);
      
      if (!orderResult || orderResult.error) {
        throw new Error(orderResult?.error || "Error desconocido al crear el pedido");
      }
      updatedOrderId = orderResult?.order?.id || null;
      
      console.log("✅ saveOrder: Pedido creado correctamente:", orderResult);
    }
    
    // Cerrar modal
    console.log("🔵 saveOrder: Cerrando modal...");
    closeModal();
    
    // Recargar la lista de pedidos
    console.log("🔵 saveOrder: Recargando lista de pedidos...");
    
    // Detectar si estamos en sent-orders.html y recargar esa lista
    const isSentOrdersPage = window.location.pathname.includes('sent-orders.html');
    
    if (isSentOrdersPage && typeof window.loadSentOrders === 'function') {
      try {
        await window.loadSentOrders();
        console.log("✅ saveOrder: Lista de pedidos enviados recargada");
      } catch (reloadError) {
        console.error("❌ saveOrder: Error recargando pedidos enviados:", reloadError);
      }
    } else if (updatedOrderId && typeof window.refreshOneOrder === 'function') {
      try {
        await window.refreshOneOrder(updatedOrderId);
        console.log("✅ saveOrder: Pedido actualizado sin recarga completa:", updatedOrderId);
      } catch (reloadError) {
        console.error("❌ saveOrder: Error refrescando pedido puntual:", reloadError);
      }
    } else if (typeof window.loadOrders === 'function') {
      try {
        await window.loadOrders();
        console.log("✅ saveOrder: Lista de pedidos recargada");
      } catch (reloadError) {
        console.error("❌ saveOrder: Error recargando pedidos:", reloadError);
        // No mostrar error al usuario, solo loguear
      }
    } else {
      console.warn("⚠️ saveOrder: window.loadOrders no está disponible");
    }
    
    // Actualizar badges
    if (typeof window.updateActiveOrdersBadge === 'function') {
      window.updateActiveOrdersBadge();
    }
    if (typeof window.updatePickedOrdersBadge === 'function') {
      window.updatePickedOrdersBadge();
    }
    if (typeof window.updateClosedOrdersBadge === 'function') {
      window.updateClosedOrdersBadge();
    }
    if (typeof window.updateCancelledOrdersBadge === 'function') {
      window.updateCancelledOrdersBadge();
    }
  } catch (error) {
    console.error("❌ Error guardando pedido:", error);
    console.error("❌ Stack trace:", error.stack);
    alert(`Error al guardar el pedido: ${error.message || "Error desconocido"}`);
    // NO cerrar el modal si hay error para que el usuario pueda corregir
  } finally {
    // Rehabilitar el botón siempre, incluso si hubo error
    const saveBtn = document.getElementById("save-order-btn");
    if (saveBtn) {
      saveBtn.disabled = false;
      // Restaurar el texto original del botón
      if (editingOrderId) {
        saveBtn.textContent = "Agregar Productos al Pedido";
      } else {
        saveBtn.textContent = "Guardar Pedido";
      }
      saveBtn.style.cursor = "pointer";
    }
  }
}

// Función auxiliar para obtener variant_ids en batch (OPTIMIZACIÓN)
async function getVariantIdsForItems(items) {
  if (!items || items.length === 0) return [];
  
  // Recolectar nombres únicos de productos
  const uniqueProductNames = [...new Set(items.map(i => i.product_name))];
  
  // Consulta 1: Obtener todos los productos
  const { data: allProducts, error: productsError } = await supabase
    .from("products")
    .select("id, name")
    .in("name", uniqueProductNames);
  
  if (productsError || !allProducts || allProducts.length === 0) {
    console.warn("⚠️ No se encontraron productos:", productsError);
    return items.map(item => ({ ...item, variant_id: null }));
  }
  
  // Crear mapa de productos
  const productsMap = new Map(allProducts.map(p => [p.name, p]));
  const productIds = allProducts.map(p => p.id);
  
  // Consulta 2: Obtener todas las variantes
  const { data: allVariants, error: variantsError } = await supabase
    .from("product_variants")
    .select("id, product_id, color")
    .in("product_id", productIds);
  
  if (variantsError || !allVariants) {
    console.warn("⚠️ Error obteniendo variantes:", variantsError);
    return items.map(item => ({ ...item, variant_id: null }));
  }
  
  // Crear mapa de variantes: "product_id|color" -> variant
  const variantsMap = new Map(
    allVariants.map(v => [`${v.product_id}|${v.color}`, v])
  );
  
  // Consulta 3: Obtener todos los sizes (solo si hay items con size)
  const itemsWithSizes = items.filter(i => i.size);
  let sizesMap = new Map();
  
  if (itemsWithSizes.length > 0) {
    const variantIds = allVariants.map(v => v.id);
    const { data: allSizes } = await supabase
      .from("variant_sizes")
      .select("variant_id, size")
      .in("variant_id", variantIds);
    
    if (allSizes) {
      allSizes.forEach(s => {
        const normalizedSize = normalizeSize(s.size);
        if (!sizesMap.has(s.variant_id)) {
          sizesMap.set(s.variant_id, new Set());
        }
        sizesMap.get(s.variant_id).add(normalizedSize);
      });
    }
  }
  
  // Mapear items con variant_ids
  return items.map(item => {
    const product = productsMap.get(item.product_name);
    if (!product) {
      console.warn(`⚠️ Producto "${item.product_name}" no encontrado`);
      return { ...item, variant_id: null };
    }
    
    const variant = variantsMap.get(`${product.id}|${item.color}`);
    if (!variant) {
      console.warn(`⚠️ Variante no encontrada: ${item.product_name} - ${item.color}`);
      return { ...item, variant_id: null };
    }
    
    // Validar size si existe
    if (item.size) {
      const normalizedSize = normalizeSize(item.size);
      const validSizes = sizesMap.get(variant.id);
      if (validSizes && !validSizes.has(normalizedSize)) {
        console.warn(`⚠️ Talle "${normalizedSize}" no encontrado para ${item.product_name}`);
      }
    }
    
    return { ...item, variant_id: variant.id };
  });
}

// Función auxiliar para actualizar stock en batch (OPTIMIZACIÓN)
async function updateStockBatch(itemsWithVariants) {
  if (!itemsWithVariants || itemsWithVariants.length === 0) {
    console.warn("⚠️ updateStockBatch: No hay items para actualizar stock");
    return;
  }
  
  console.log("🔵 updateStockBatch: Iniciando actualización de stock para", itemsWithVariants.length, "items");
  console.log("🔵 updateStockBatch: Primer item ejemplo:", JSON.stringify(itemsWithVariants[0], null, 2));
  
  // Cargar warehouses
  if (!warehouses.general || !warehouses.ventaPublico) {
    await loadWarehouses();
  }
  
  const warehouseIds = [warehouses.general, warehouses.ventaPublico].filter(Boolean);
  if (warehouseIds.length === 0) {
    console.error("❌ updateStockBatch: No se encontraron warehouses");
    return;
  }
  
  // Filtrar items con variant_id y size
  const itemsToUpdate = itemsWithVariants.filter(i => i.variant_id && i.size);
  if (itemsToUpdate.length === 0) {
    console.warn("⚠️ updateStockBatch: No hay items con variant_id y size para actualizar");
    return;
  }
  
  console.log("🔵 updateStockBatch: Items a actualizar:", itemsToUpdate.length);
  
  const variantIds = [...new Set(itemsToUpdate.map(i => i.variant_id))];
  console.log("🔵 updateStockBatch: Variant IDs únicos:", variantIds.length, variantIds);
  
  // Validar que variantIds tenga valores
  if (!variantIds || variantIds.length === 0) {
    console.error("❌ updateStockBatch: No hay variant IDs para consultar");
    return;
  }
  
  // Consulta 1: Obtener stocks actuales de variant_size_warehouse_stock
  console.log("🔵 updateStockBatch: Consultando stocks actuales...");
  console.log("🔵 updateStockBatch: Warehouse IDs:", warehouseIds);
  const { data: currentStocks, error: stocksError } = await supabase
    .from("variant_size_warehouse_stock")
    .select("variant_id, size, warehouse_id, stock_qty")
    .in("variant_id", variantIds)
    .in("warehouse_id", warehouseIds);
  
  if (stocksError) {
    console.error("❌ updateStockBatch: Error obteniendo stocks actuales:", stocksError);
    return;
  }
  
  console.log("🔵 updateStockBatch: Stocks actuales obtenidos:", currentStocks?.length || 0);
  if (currentStocks && currentStocks.length > 0) {
    console.log("🔵 updateStockBatch: Primer stock ejemplo:", JSON.stringify(currentStocks[0], null, 2));
  } else {
    console.log("🔵 updateStockBatch: currentStocks es null o vacío");
  }
  
  // Crear mapa de stock actual desde variant_size_warehouse_stock
  const stockMap = new Map(
    (currentStocks || []).map(s => [
      `${s.variant_id}|${normalizeSize(s.size)}|${s.warehouse_id}`,
      s.stock_qty || 0
    ])
  );
  
  console.log("🔵 updateStockBatch: Stock map creado con", stockMap.size, "entradas");
  
  // Preparar actualizaciones
  const stockChanges = [];
  // variant_sizes se actualiza automáticamente via trigger 84
  
  itemsToUpdate.forEach((item, index) => {
    const normalizedSize = normalizeSize(item.size);
    if (!normalizedSize) {
      console.warn(`⚠️ updateStockBatch: Item ${index} sin tamaño normalizado:`, item.size);
      return;
    }
    
    // Obtener cantidades de cada almacén (si están definidas)
    let qtyFromGeneral = Number(item.qty_from_general) || 0;
    let qtyFromVenta = Number(item.qty_from_venta) || 0;
    const quantity = item.quantity || 0;
    
    console.log(`🔵 updateStockBatch: Item ${index} - Variant: ${item.variant_id}, Size: ${normalizedSize}, Qty: ${quantity}, From General: ${qtyFromGeneral}, From Venta: ${qtyFromVenta}`);
    
    // Validar consistencia: si tiene qty_from_general o qty_from_venta, deben sumar quantity
    let hasSpecificQuantities = qtyFromGeneral > 0 || qtyFromVenta > 0;
    if (hasSpecificQuantities && (qtyFromGeneral + qtyFromVenta) !== quantity) {
      console.warn(`⚠️ Inconsistencia en cantidades para item ${item.variant_id} talle ${normalizedSize}: qty_from_general=${qtyFromGeneral}, qty_from_venta=${qtyFromVenta}, quantity=${quantity}. Se recalculará automáticamente por cantidad total.`);
      // Si los "source qty" están desfasados (ej. suman más que quantity), no confiar en esos valores.
      // Forzamos recálculo por cantidad para evitar sobre-descontar stock.
      hasSpecificQuantities = false;
      qtyFromGeneral = 0;
      qtyFromVenta = 0;
    }
    
    // Si tiene cantidades específicas por almacén, usarlas
    if (hasSpecificQuantities) {
      // Descontar del almacén general si corresponde
      if (qtyFromGeneral > 0 && warehouses.general) {
        const key = `${item.variant_id}|${normalizedSize}|${warehouses.general}`;
        let currentQty = stockMap.get(key) || 0;
        
        console.log(`🔵 updateStockBatch: Stock inicial para ${item.variant_id} talle ${normalizedSize} en general: ${currentQty}`);
        // Sin fallback desde variant_sizes: si no hay stock por warehouse, queda en 0 y se aplican validaciones aguas arriba.
        
        const newQty = Math.max(0, currentQty - qtyFromGeneral);
        console.log(`🔵 updateStockBatch: Descontando ${qtyFromGeneral} de general. Stock actual: ${currentQty}, Nuevo stock: ${newQty}`);
        
        if (newQty === 0 && currentQty > 0) {
          console.log(`✅ updateStockBatch: Stock se descontará correctamente de ${currentQty} a ${newQty}`);
        } else if (newQty === 0 && currentQty === 0) {
          console.warn(`⚠️ updateStockBatch: ADVERTENCIA - Intentando descontar ${qtyFromGeneral} pero el stock actual es 0`);
        }
        
        stockChanges.push({
          variant_id: item.variant_id,
          size: normalizedSize,
          warehouse_id: warehouses.general,
          stock_qty: newQty
        });
        stockMap.set(key, newQty);
        
        // variant_sizes se actualiza automáticamente via trigger 84
      }
      
      // Descontar del almacén venta-publico si corresponde
      if (qtyFromVenta > 0 && warehouses.ventaPublico) {
        const key = `${item.variant_id}|${normalizedSize}|${warehouses.ventaPublico}`;
        const currentQty = stockMap.get(key) || 0;
        const newQty = Math.max(0, currentQty - qtyFromVenta);
        
        stockChanges.push({
          variant_id: item.variant_id,
          size: normalizedSize,
          warehouse_id: warehouses.ventaPublico,
          stock_qty: newQty
        });
        stockMap.set(key, newQty);
      }
    } else {
      // FALLBACK: Si no tiene cantidades específicas, usar lógica de prioridad
      // Priorizar venta-publico si hay stock, sino general
      let remainingQty = quantity;
      
      // Intentar primero desde venta-publico
      if (warehouses.ventaPublico && remainingQty > 0) {
        const key = `${item.variant_id}|${normalizedSize}|${warehouses.ventaPublico}`;
        const currentQty = stockMap.get(key) || 0;
        const qtyToDeduct = Math.min(remainingQty, currentQty);
        
        if (qtyToDeduct > 0) {
          const newQty = Math.max(0, currentQty - qtyToDeduct);
          stockChanges.push({
            variant_id: item.variant_id,
            size: normalizedSize,
            warehouse_id: warehouses.ventaPublico,
            stock_qty: newQty
          });
          stockMap.set(key, newQty);
          remainingQty -= qtyToDeduct;
        }
      }
      
      // Si aún queda cantidad, descontar de general
      if (warehouses.general && remainingQty > 0) {
        const key = `${item.variant_id}|${normalizedSize}|${warehouses.general}`;
        const currentQty = stockMap.get(key) || 0;
        const qtyToDeduct = Math.min(remainingQty, currentQty);
        
        if (qtyToDeduct > 0) {
          const newQty = Math.max(0, currentQty - qtyToDeduct);
          stockChanges.push({
            variant_id: item.variant_id,
            size: normalizedSize,
            warehouse_id: warehouses.general,
            stock_qty: newQty
          });
          stockMap.set(key, newQty);
          remainingQty -= qtyToDeduct;
        }
      }
      
      // Si aún queda cantidad sin descontar, registrar advertencia
      if (remainingQty > 0) {
        console.warn(`⚠️ No hay suficiente stock para descontar ${remainingQty} unidades de ${item.variant_id} talle ${normalizedSize}`);
      }
    }
  });
  
  // Consulta 2: Actualizar todos los stocks de una vez
  console.log("🔵 updateStockBatch: Total cambios preparados:", stockChanges.length);
  if (stockChanges.length > 0) {
    console.log(`🔵 updateStockBatch: Actualizando ${stockChanges.length} registros de stock`);
    console.log("🔵 updateStockBatch: Primer cambio ejemplo:", JSON.stringify(stockChanges[0], null, 2));
    
    try {
      const { data, error } = await supabase
        .from("variant_size_warehouse_stock")
        .upsert(stockChanges, {
          onConflict: 'variant_id,size,warehouse_id'
        });
      
      if (error) {
        console.error("❌ updateStockBatch: Error actualizando stock batch:", error);
        console.error("❌ updateStockBatch: Detalles del error:", JSON.stringify(error, null, 2));
        throw error;
      } else {
        console.log("✅ updateStockBatch: Stock actualizado correctamente para", stockChanges.length, "registros en variant_size_warehouse_stock");
        if (data) {
          console.log("✅ updateStockBatch: Datos retornados:", data.length || 0, "registros");
        }
      }
      
      // variant_sizes se actualiza automáticamente via trigger 84
      // al escribir en variant_size_warehouse_stock.
    } catch (error) {
      console.error("❌ updateStockBatch: Excepción al actualizar stock:", error);
      throw error;
    }
  } else {
    console.warn("⚠️ updateStockBatch: No hay cambios de stock para aplicar");
    console.warn("⚠️ updateStockBatch: Esto puede indicar que los items no tienen qty_from_general/qty_from_venta o que hay un problema con el procesamiento");
  }
}

// Crear nuevo pedido
async function createNewOrder(customerId, items, total, extraValues = {}) {
  console.log("🔵 createNewOrder: Iniciando creación de pedido...");
  console.log("🔵 createNewOrder: customerId:", customerId);
  console.log("🔵 createNewOrder: items:", items);
  console.log("🔵 createNewOrder: total:", total);
  
  // Validar que customerId sea válido
  if (!customerId || !isValidUUID(customerId)) {
    const errorMsg = "Error: No se proporcionó un ID de cliente válido para crear el pedido.";
    console.error("❌ createNewOrder:", errorMsg);
    throw new Error(errorMsg);
  }
  
  // Verificar que el cliente existe en la base de datos antes de crear el pedido
  try {
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customerId)
      .maybeSingle();
    
    if (customerError) {
      console.error("❌ createNewOrder: Error verificando cliente:", customerError);
      throw new Error(`Error al verificar el cliente: ${customerError.message}`);
    }
    
    if (!customer || !customer.id) {
      const errorMsg = `Error: No se encontró el cliente con ID "${customerId}" en la base de datos. Por favor, selecciona un cliente válido.`;
      console.error("❌ createNewOrder:", errorMsg);
      throw new Error(errorMsg);
    }
    
    console.log("✅ createNewOrder: Cliente verificado en customers:", customer.id);
    
    // Verificar que el cliente tiene un formato UUID válido (ya validado arriba, pero confirmar)
    if (!isValidUUID(customer.id)) {
      const errorMsg = `Error: El ID del cliente "${customer.id}" tiene formato UUID inválido. Por favor, selecciona un cliente válido.`;
      console.error("❌ createNewOrder:", errorMsg);
      throw new Error(errorMsg);
    }
  } catch (error) {
    // Si es un error que ya tiene mensaje, re-lanzarlo
    if (error.message && error.message.startsWith("Error:")) {
      throw error;
    }
    // Si es otro error, envolverlo
    console.error("❌ createNewOrder: Error inesperado verificando cliente:", error);
    throw new Error(`Error al verificar el cliente: ${error.message || "Error desconocido"}`);
  }
  
  // OPTIMIZACIÓN: Obtener variant_ids en batch (una sola consulta en lugar de N consultas)
  const itemsWithVariants = await getVariantIdsForItems(items);
  
  console.log("🔵 createNewOrder: itemsWithVariants:", itemsWithVariants);
  
  // Preparar notes con valores extra
  const notes = Object.keys(extraValues || {}).length > 0 
    ? JSON.stringify(extraValues) 
    : null;
  
  console.log("🔵 createNewOrder: Creando pedido en base de datos...");
  console.log("🔵 createNewOrder: customer_id a insertar:", customerId, "tipo:", typeof customerId, "formato válido:", isValidUUID(customerId));

  const { data: existingOpen, error: openErr } = await supabase
    .from("orders")
    .select("id, order_number, status")
    .eq("customer_id", customerId)
    .in("status", ["active", "closing_soon"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!openErr && existingOpen?.id) {
    const label = existingOpen.order_number || String(existingOpen.id).slice(0, 8);
    const reuse = confirm(
      `El cliente ya tiene un pedido abierto (#${label}). ¿Agregar estos productos a ese pedido en lugar de crear uno nuevo?\n\nAceptar = agregar al pedido existente.\nCancelar = no crear (revisá el pedido en el panel).`
    );
    if (reuse) {
      await addItemsToExistingOrder(existingOpen.id, items, total, extraValues);
      return { success: true, order: existingOpen, reusedExisting: true };
    }
    throw new Error("Creación cancelada: el cliente ya tiene un pedido abierto.");
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      customer_id: customerId,
      status: "active",
      total_amount: total,
      notes: notes,
      source: "admin"
    })
    .select()
    .single();
  
  if (orderError) {
    console.error("❌ createNewOrder: Error creando pedido:", orderError);
    console.error("❌ createNewOrder: customer_id que causó el error:", customerId);
    console.error("❌ createNewOrder: Detalles del error:", JSON.stringify(orderError, null, 2));

    const msg = String(orderError.message || "");
    if (orderError.code === "23505" || /duplicate key|unique constraint/i.test(msg)) {
      throw new Error(
        "Ya existe un pedido abierto para este cliente (concurrencia o índice único). Recargá la página, abrí ese pedido y agregá los productos allí."
      );
    }
    
    if (orderError.message && orderError.message.includes("foreign key constraint")) {
      throw new Error(`Error: El cliente con ID "${customerId}" no puede ser usado porque su ID no existe en auth.users. Esto suele pasar con clientes importados. Por favor, verifica que el cliente tenga un usuario asociado válido.`);
    }
    
    throw new Error(`Error creando pedido: ${orderError.message}`);
  }
  
  if (!order) {
    console.error("❌ createNewOrder: Pedido creado pero no se retornó data");
    throw new Error("Error: El pedido no se creó correctamente");
  }
  
  console.log("✅ createNewOrder: Pedido creado:", order.id, "Número:", order.order_number);
  
  // Crear los items del pedido
  const orderItemsData = itemsWithVariants.map(item => ({
    order_id: order.id,
    variant_id: item.variant_id,
    product_name: item.product_name,
    color: item.color,
    size: item.size,
    quantity: item.quantity,
    price_snapshot: item.price_snapshot,
    imagen: item.imagen,
    status: item.status || "picked" // Admin: por defecto "apartado"
  }));
  
  console.log("🔵 createNewOrder: Creando items del pedido...");
  const { error: itemsError } = await supabase
    .from("order_items")
    .insert(orderItemsData);
  
  if (itemsError) {
    console.error("❌ createNewOrder: Error creando items:", itemsError);
    // Si falla, intentar eliminar el pedido creado
    await supabase.from("orders").delete().eq("id", order.id);
    throw new Error(`Error agregando productos: ${itemsError.message}`);
  }
  
  console.log("✅ createNewOrder: Items del pedido creados correctamente");
  
  // OPTIMIZACIÓN: Actualizar stock en batch (una sola consulta en lugar de N*M consultas)
  console.log("🔵 createNewOrder: Actualizando stock...");
  await updateStockBatch(itemsWithVariants);
  
  console.log("✅ createNewOrder: Proceso completado exitosamente");
  
  // Retornar resultado exitoso
  return { success: true, order: order };
}

// Agregar items a pedido existente
async function addItemsToExistingOrder(orderId, items, newTotal = null, extraValues = {}) {
  // OPTIMIZACIÓN: Obtener variant_ids en batch (una sola consulta en lugar de N consultas)
  const itemsWithVariants = await getVariantIdsForItems(items);
  
  // Obtener el pedido con sus items para verificar el estado
  const { data: order } = await supabase
    .from("orders")
    .select(`
      total_amount,
      notes,
      order_items(status)
    `)
    .eq("id", orderId)
    .single();
  
  // Verificar si todos los items existentes están en estado "picked" (apartado)
  const existingItems = order?.order_items || [];
  const allItemsPicked = existingItems.length > 0 && existingItems.every(item => item.status === 'picked');
  
  // Admin: al agregar productos manualmente, por defecto quedan "picked" (apartado)
  const newItemStatus = "picked";
  
  // Calcular el nuevo total
  let finalTotal;
  if (newTotal !== null) {
    // Si se proporciona un nuevo total (con valores extra), usarlo
    finalTotal = newTotal;
  } else {
    // Si no, calcular solo sumando los nuevos items
    const newItemsTotal = itemsWithVariants.reduce((sum, item) => {
      return sum + ((item.price_snapshot || 0) * (item.quantity || 0));
    }, 0);
    finalTotal = (order?.total_amount || 0) + newItemsTotal;
  }
  
  // Crear los items del pedido con el estado apropiado
  // Usar el estado que tiene cada item (puede ser 'reserved' o 'waiting')
  const orderItemsData = itemsWithVariants.map(item => ({
    order_id: orderId,
    variant_id: item.variant_id,
    product_name: item.product_name,
    color: item.color,
    size: item.size,
    quantity: item.quantity,
    price_snapshot: item.price_snapshot,
    imagen: item.imagen,
    status: item.status || newItemStatus // Usar el estado del item si existe, sino usar el estado por defecto
  }));
  
  const { error: itemsError } = await supabase
    .from("order_items")
    .insert(orderItemsData);
  
  if (itemsError) {
    throw new Error(`Error agregando productos: ${itemsError.message}`);
  }
  
  // Preparar notes con valores extra (combinar con valores existentes si hay)
  let notes = null;
  if (Object.keys(extraValues || {}).length > 0) {
    try {
      const existingNotes = order?.notes ? JSON.parse(order.notes) : {};
      const combinedNotes = { ...existingNotes, ...extraValues };
      notes = JSON.stringify(combinedNotes);
    } catch (e) {
      // Si hay error parseando notes existentes, usar solo los nuevos valores
      notes = JSON.stringify(extraValues);
    }
  } else if (order?.notes) {
    // Mantener notes existentes si no hay nuevos valores
    notes = order.notes;
  }
  
  // Actualizar total del pedido, notes y estado
  // Admin: mantener "active" (constraint BD). Los items en "picked" hacen que el pedido aparezca en Apartados.
  const updateData = { 
    total_amount: finalTotal,
    status: "active"
  };
  if (notes !== null) {
    updateData.notes = notes;
  }
  
  // Verificar el estado actual del pedido
  const { data: currentOrder } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .single();
  
  if (currentOrder) {
    if (currentOrder.status === "closed" || currentOrder.status === "sent" || currentOrder.status === "devolución") {
      // Si está cerrado, enviado o en devolución, no cambiar el estado
      delete updateData.status;
      
      // Si el pedido está enviado, dejar que el backend mantenga/actualice sent_at
      
      // Si el pedido está en devolución, mantener el estado de devolución
      // No hacer nada adicional, solo preservar el estado
    }
  }
  
  await supabase
    .from("orders")
    .update(updateData)
    .eq("id", orderId);
  
  // OPTIMIZACIÓN: Actualizar stock en batch (una sola consulta en lugar de N*M consultas)
  await updateStockBatch(itemsWithVariants);
}

// Cargar pedido para editar
async function loadOrderForEdit(orderId) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    alert("No se pudo conectar con la base de datos.");
    return;
  }
  
  try {
    // Obtener el pedido
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        id,
        customer_id,
        notes,
        order_items(id, product_name, color, size, quantity, price_snapshot, imagen)
      `)
      .eq("id", orderId)
      .single();
    
    if (orderError || !order) {
      alert("No se pudo cargar el pedido.");
      return;
    }
    
    // Obtener el cliente por separado (evitar problemas de foreign keys)
    if (order.customer_id) {
      const { data: customer, error: customerError } = await supabase
        .from("customers")
        .select("id, customer_number, full_name, dni, phone, email, city, province")
        .eq("id", order.customer_id)
        .maybeSingle();
      
      if (!customerError && customer) {
        currentCustomer = customer;
      }
    }
    
    // Cargar valores extra desde notes si existen
    if (order.notes) {
      try {
        const extraValues = JSON.parse(order.notes);
        shippingAmount = parseFloat(extraValues.shipping) || 0;
        discountAmount = parseFloat(extraValues.discount) || 0;
        extrasAmount = parseFloat(extraValues.extras_amount) || 0;
        extrasPercentage = parseFloat(extraValues.extras_percentage) || 0;
        
        // Actualizar campos en el formulario
        const shippingInput = document.getElementById("shipping-amount");
        const discountInput = document.getElementById("discount-amount");
        const extrasAmountInput = document.getElementById("extras-amount");
        const extrasPercentageInput = document.getElementById("extras-percentage");
        
        if (shippingInput) shippingInput.value = shippingAmount > 0 ? shippingAmount : "";
        if (discountInput) discountInput.value = discountAmount > 0 ? discountAmount : "";
        if (extrasAmountInput) extrasAmountInput.value = extrasAmount > 0 ? extrasAmount : "";
        if (extrasPercentageInput) extrasPercentageInput.value = extrasPercentage > 0 ? extrasPercentage : "";
      } catch (e) {
        console.warn("⚠️ No se pudieron cargar valores extra del pedido:", e);
      }
    }
    
    // NO establecer items existentes cuando se edita
    // Solo agregar nuevos items, los existentes ya están en el pedido
    orderItems = [];
    
    updateCustomerDisplay();
    updateOrderItemsList();
    updateSaveButton();
  } catch (error) {
    console.error("❌ Error cargando pedido:", error);
    alert("Error al cargar el pedido.");
  }
}

// Inicializar cuando el DOM esté listo
console.log("📦 order-creator.js: Estado del DOM:", document.readyState);

if (document.readyState === "loading") {
  console.log("📦 order-creator.js: Esperando DOMContentLoaded...");
  document.addEventListener("DOMContentLoaded", () => {
    console.log("📦 order-creator.js: DOMContentLoaded disparado, inicializando...");
    initOrderCreator();
  });
} else {
  console.log("📦 order-creator.js: DOM ya listo, inicializando inmediatamente...");
  initOrderCreator();
}


