// admin/order-creator.js
// Funcionalidad para crear y editar pedidos desde el panel de admin

console.log("📦 order-creator.js: Iniciando carga del módulo...");

import { supabase as supabaseClient } from "../scripts/supabase-client.js";

console.log("📦 order-creator.js: Importación de supabase-client completada");

let supabase = supabaseClient;
let currentCustomer = null;
let orderItems = [];
let editingOrderId = null;
// Rastrear cantidades seleccionadas por variante en la búsqueda actual
let selectedQuantities = new Map(); // variant_id -> quantity
// Valores extra del pedido
let shippingAmount = 0;
let discountAmount = 0;
let extrasAmount = 0;
let extrasPercentage = 0;

// Provincias y ciudades argentinas para autocomplete
const ARGENTINA_PROVINCES = [
  "Buenos Aires", "Catamarca", "Chaco", "Chubut", "Córdoba", "Corrientes",
  "Entre Ríos", "Formosa", "Jujuy", "La Pampa", "La Rioja", "Mendoza",
  "Misiones", "Neuquén", "Río Negro", "Salta", "San Juan", "San Luis",
  "Santa Cruz", "Santa Fe", "Santiago del Estero", "Tierra del Fuego",
  "Tucumán", "CABA"
];

const PROVINCE_CITIES = {
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
  "Salta": ["Salta", "San Salvador de Jujuy", "Orán", "Tartagal", "Cafayate", "Metán", "Rosario de la Frontera"],
  "San Juan": ["San Juan", "Rawson", "Rivadavia", "Santa Lucía", "Pocito", "Chimbas", "Caucete"],
  "San Luis": ["San Luis", "Villa Mercedes", "Merlo", "La Toma", "Justo Daract"],
  "Santa Cruz": ["Río Gallegos", "Caleta Olivia", "El Calafate", "Puerto Deseado", "Pico Truncado"],
  "Santa Fe": ["Santa Fe", "Rosario", "Venado Tuerto", "Rafaela", "Reconquista", "Santo Tomé", "Villa Gobernador Gálvez", "San Lorenzo"],
  "Santiago del Estero": ["Santiago del Estero", "La Banda", "Fernández", "Frías", "Termas de Río Hondo"],
  "Tierra del Fuego": ["Ushuaia", "Río Grande", "Tolhuin"],
  "Tucumán": ["San Miguel de Tucumán", "Yerba Buena", "Tafí Viejo", "Concepción", "Banda del Río Salí", "Alderetes"],
  "CABA": ["Ciudad Autónoma de Buenos Aires"]
};

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
  if (customerSearch) customerSearch.value = "";
  if (productSearch) productSearch.value = "";
  
  hideCustomerResults();
  hideProductResults();
  
  currentCustomer = null;
  orderItems = [];
  editingOrderId = null;
  selectedQuantities.clear();
  
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

async function handleCreateCustomer() {
  const firstName = document.getElementById("customer-first-name")?.value?.trim();
  const lastName = document.getElementById("customer-last-name")?.value?.trim();
  const dni = document.getElementById("customer-dni")?.value?.trim();
  const phone = document.getElementById("customer-phone")?.value?.trim();
  const email = document.getElementById("customer-email")?.value?.trim();
  const address = document.getElementById("customer-address")?.value?.trim();
  const province = document.getElementById("customer-province")?.value?.trim();
  const city = document.getElementById("customer-city")?.value?.trim();
  const errorDiv = document.getElementById("customer-form-error");
  
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
  
  if (!city) {
    if (errorDiv) {
      errorDiv.textContent = "Ciudad es obligatoria";
      errorDiv.style.display = "block";
    }
    return;
  }
  
  if (errorDiv) {
    errorDiv.style.display = "none";
  }
  
  const fullName = `${firstName} ${lastName}`.trim();
  
  await createCustomer({
    full_name: fullName,
    dni: dni || null,
    phone: phone,
    email: email || null,
    address: address,
    city: city,
    province: province
  });
  
  // Cerrar modal después de crear
  closeCreateCustomerModal();
}

// Cargar IDs de almacenes
let warehouses = { general: null, ventaPublico: null };

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
  
  // Cargar almacenes si no están cargados
  if (!warehouses.general || !warehouses.ventaPublico) {
    await loadWarehouses();
  }
  
  try {
    // Buscar productos por nombre y sus variantes con stock disponible
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
      .ilike("name", `%${query}%`)
      .eq("status", "active")
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
    
    // Filtrar variantes activas (incluyendo las sin stock), luego obtener imágenes
    const productsWithStock = await Promise.all(
      (products || []).flatMap(async (product) => {
        const variantsWithStock = (product.product_variants || [])
          .filter(v => {
            if (!v || !v.active) return false;
            // Incluir todas las variantes activas, incluso sin stock
            return true;
          });
        
        // Obtener imágenes para cada variante
        const variantsWithImages = await Promise.all(
          variantsWithStock.map(async (v) => {
            const { data: imageData } = await supabase
              .from("variant_images")
              .select("url")
              .eq("variant_id", v.id)
              .eq("position", 1)
              .maybeSingle();
            
            const variantStock = stockMap.get(v.id) || new Map();
            const stockGeneral = variantStock.get(warehouses.general) || 0;
            const stockVenta = variantStock.get(warehouses.ventaPublico) || 0;
            const totalStock = stockGeneral + stockVenta;
            
            return {
              articulo: product.name,
              color: v.color,
              talle: v.size,
              precio: v.price,
              stock_general: stockGeneral,
              stock_venta: stockVenta,
              stock_total: totalStock,
              imagen: imageData?.url || null,
              variant_id: v.id
            };
          })
        );
        
        return variantsWithImages;
      })
    );
    
    displayProductResults(productsWithStock.flat());
  } catch (error) {
    console.error("❌ Error en búsqueda de productos:", error);
  }
}

// Mostrar resultados de productos
function displayProductResults(products) {
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
  
  const productsHtml = Object.values(groupedProducts).map(product => `
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
                const currentQty = selectedQuantities.get(variantId) || 0;
                const stockGeneral = t.stock_general || 0;
                const stockVenta = t.stock_venta || 0;
                const stockTotal = t.stock_total || 0;
                const hasNoStock = stockTotal === 0;
                
                // Determinar estilos según stock y selección
                let bgColor, borderColor, textColor, opacity;
                if (hasNoStock) {
                  // Sin stock: fondo gris claro con opacidad reducida y borde rojo/naranja
                  bgColor = '#f5f5f5';
                  borderColor = '#ff9800';
                  textColor = '#999';
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
                       data-articulo="${product.articulo}"
                       data-color="${product.color}"
                       data-talle="${t.talle}"
                       data-precio="${t.precio}"
                       data-stock-general="${stockGeneral}"
                       data-stock-venta="${stockVenta}"
                       data-stock-total="${stockTotal}"
                       data-has-no-stock="${hasNoStock}"
                       title="${tooltipText}">
                    <div style="font-size: 14px; font-weight: 600; color: ${textColor}; ${hasNoStock ? 'text-decoration: line-through;' : ''}">${t.talle}</div>
                    ${hasNoStock ? '<div data-no-stock-badge="true" style="font-size: 8px; font-weight: 600; color: #ff9800; margin-top: 1px;">Sin stock</div>' : ''}
                    ${currentQty > 0 ? `<div style="font-size: 10px; font-weight: 600; color: #CD844D; margin-top: 1px;">${currentQty}</div>` : ''}
                    ${currentQty > 0 ? `
                      <div style="position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; background: #dc3545; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; cursor: pointer; z-index: 10;"
                           data-action="decrease"
                           onclick="event.stopPropagation(); window.decreaseQuantity('${variantId}')">-</div>
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
      // Ignorar clicks en el botón de disminuir
      if (e.target.dataset.action === "decrease") return;
      
      const variantId = square.dataset.variantId;
      const articulo = square.dataset.articulo;
      const color = square.dataset.color;
      const talle = square.dataset.talle;
      const precio = parseFloat(square.dataset.precio);
      const stockGeneral = parseInt(square.dataset.stockGeneral) || 0;
      const stockVenta = parseInt(square.dataset.stockVenta) || 0;
      const stockTotal = parseInt(square.dataset.stockTotal) || 0;
      const hasNoStock = square.dataset.hasNoStock === 'true';
      const currentQty = selectedQuantities.get(variantId) || 0;
      
      // Si no hay stock, mostrar advertencia y permitir agregar de todas formas
      if (hasNoStock) {
        const confirmAdd = confirm(`⚠️ Este producto (${articulo} - ${color} - Talle ${talle}) no tiene stock disponible.\n\n¿Deseas agregarlo de todas formas?`);
        if (confirmAdd) {
          selectedQuantities.set(variantId, currentQty + 1);
          updateProductSquare(variantId);
        }
      } else {
        // Incrementar cantidad si hay stock disponible
        if (currentQty < stockTotal) {
          selectedQuantities.set(variantId, currentQty + 1);
          updateProductSquare(variantId);
        } else {
          alert(`No hay más stock disponible para talle ${talle}. Stock total: ${stockTotal}`);
        }
      }
    });
  });
}

// Función para actualizar un cuadrado de talle específico
function updateProductSquare(variantId) {
  const square = document.querySelector(`[data-variant-id="${variantId}"]`);
  if (!square) return;
  
  const currentQty = selectedQuantities.get(variantId) || 0;
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
        window.decreaseQuantity(variantId);
      };
      square.appendChild(decreaseBtn);
    }
  } else {
    if (qtyDisplay) qtyDisplay.remove();
    const decreaseBtn = square.querySelector('[data-action="decrease"]');
    if (decreaseBtn) decreaseBtn.remove();
  }
}

// Función global para disminuir cantidad
window.decreaseQuantity = function(variantId) {
  const currentQty = selectedQuantities.get(variantId) || 0;
  if (currentQty > 0) {
    selectedQuantities.set(variantId, currentQty - 1);
    updateProductSquare(variantId);
  }
};

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
  
  for (const [variantId, quantity] of selectedQuantities.entries()) {
    if (quantity <= 0) continue;
    
    const square = resultsDiv.querySelector(`[data-variant-id="${variantId}"]`);
    if (!square) continue;
    
    const articulo = square.dataset.articulo;
    const color = square.dataset.color;
    const talle = square.dataset.talle;
    const precio = parseFloat(square.dataset.precio);
    const stockGeneral = parseInt(square.dataset.stockGeneral) || 0;
    const stockVenta = parseInt(square.dataset.stockVenta) || 0;
    
    // Obtener la imagen del producto
    let imagen = null;
    if (supabase) {
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
    
    // Calcular cuánto viene de cada stock
    const qtyFromGeneral = Math.min(quantity, stockGeneral);
    const qtyFromVenta = Math.max(0, quantity - stockGeneral);
    
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
    resultsDiv.querySelectorAll("[data-variant-id]").forEach(square => {
      updateProductSquare(square.dataset.variantId);
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

// Agregar producto al pedido
async function addProductToOrder(product) {
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
      status: product.status || 'reserved' // Estado del item (reserved, waiting, picked)
    });
  }
  
  // Si hay variant_id y cantidades de stock, actualizar el stock en la base de datos
  if (product.variant_id && (product.qty_from_general > 0 || product.qty_from_venta > 0)) {
    await updateStockForOrder(product.variant_id, product.qty_from_general || 0, product.qty_from_venta || 0);
  }
  
  updateOrderItemsList();
}

// Actualizar stock en la base de datos
async function updateStockForOrder(variantId, qtyFromGeneral, qtyFromVenta) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible para actualizar stock");
    return;
  }
  
  // Cargar almacenes si no están cargados
  if (!warehouses.general || !warehouses.ventaPublico) {
    await loadWarehouses();
  }
  
  try {
    // Actualizar stock general
    if (qtyFromGeneral > 0 && warehouses.general) {
      // Obtener stock actual
      const { data: currentStock, error: stockError } = await supabase
        .from("variant_warehouse_stock")
        .select("stock_qty")
        .eq("variant_id", variantId)
        .eq("warehouse_id", warehouses.general)
        .maybeSingle();
      
      if (stockError && stockError.code !== 'PGRST116') {
        console.error("❌ Error obteniendo stock general:", stockError);
      } else {
        const currentQty = currentStock?.stock_qty || 0;
        const newQty = Math.max(0, currentQty - qtyFromGeneral);
        
        // Actualizar o insertar
        const { error: updateError } = await supabase
          .from("variant_warehouse_stock")
          .upsert({
            variant_id: variantId,
            warehouse_id: warehouses.general,
            stock_qty: newQty
          }, {
            onConflict: 'variant_id,warehouse_id'
          });
        
        if (updateError) {
          console.error("❌ Error actualizando stock general:", updateError);
        }
      }
    }
    
    // Actualizar stock de venta
    if (qtyFromVenta > 0 && warehouses.ventaPublico) {
      // Obtener stock actual
      const { data: currentStock, error: stockError } = await supabase
        .from("variant_warehouse_stock")
        .select("stock_qty")
        .eq("variant_id", variantId)
        .eq("warehouse_id", warehouses.ventaPublico)
        .maybeSingle();
      
      if (stockError && stockError.code !== 'PGRST116') {
        console.error("❌ Error obteniendo stock venta:", stockError);
      } else {
        const currentQty = currentStock?.stock_qty || 0;
        const newQty = Math.max(0, currentQty - qtyFromVenta);
        
        // Actualizar o insertar
        const { error: updateError } = await supabase
          .from("variant_warehouse_stock")
          .upsert({
            variant_id: variantId,
            warehouse_id: warehouses.ventaPublico,
            stock_qty: newQty
          }, {
            onConflict: 'variant_id,warehouse_id'
          });
        
        if (updateError) {
          console.error("❌ Error actualizando stock venta:", updateError);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error actualizando stock:", error);
  }
}

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
      item.quantity = parseInt(newQuantity);
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
    const statusBadge = isWaiting 
      ? '<span style="background: #fff4e6; color: #e65100; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; border: 1px solid #ff9800;">⏳ Espera</span>'
      : isPicked
      ? '<span style="background: #e6f4ea; color: #1b5e20; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; border: 1px solid #28a745;">✓ Apartado</span>'
      : '';
    return `
      <div class="order-item-in-modal" style="${isWaiting ? 'border-left: 4px solid #ff9800; background: #fff9f0;' : isPicked ? 'border-left: 4px solid #28a745; background: #f0f9f4;' : ''}">
        <div class="order-item-in-modal-info">
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong>${item.product_name || 'Producto'}</strong>
            ${statusBadge}
          </div>
          <div style="font-size: 13px; color: #666; margin-top: 4px;">
            Color: ${item.color || '-'} • Talle: ${item.size || '-'}
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
    
    if (editingOrderId) {
      // Editar pedido existente - agregar los nuevos items y actualizar valores extra
      console.log("🔵 saveOrder: Editando pedido existente...");
      await addItemsToExistingOrder(editingOrderId, orderItems, total, extraValues);
      console.log("✅ saveOrder: Pedido editado correctamente");
    } else {
      // Crear nuevo pedido
      console.log("🔵 saveOrder: Creando nuevo pedido...");
      const orderResult = await createNewOrder(currentCustomer.id, orderItems, total, extraValues);
      
      if (!orderResult || orderResult.error) {
        throw new Error(orderResult?.error || "Error desconocido al crear el pedido");
      }
      
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

// Crear nuevo pedido
async function createNewOrder(customerId, items, total, extraValues = {}) {
  console.log("🔵 createNewOrder: Iniciando creación de pedido...");
  console.log("🔵 createNewOrder: customerId:", customerId);
  console.log("🔵 createNewOrder: items:", items);
  console.log("🔵 createNewOrder: total:", total);
  
  // Primero, obtener el variant_id para cada item
  const itemsWithVariants = await Promise.all(items.map(async (item) => {
    // Buscar el producto por nombre
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("id")
      .eq("name", item.product_name)
      .maybeSingle();
    
    if (productError || !product) {
      console.warn(`⚠️ Producto "${item.product_name}" no encontrado:`, productError);
      return {
        ...item,
        variant_id: null
      };
    }
    
    // Buscar la variante por product_id, color y size
    const { data: variant, error: variantError } = await supabase
      .from("product_variants")
      .select("id")
      .eq("product_id", product.id)
      .eq("size", item.size)
      .eq("color", item.color)
      .maybeSingle();
    
    if (variantError || !variant) {
      console.warn(`⚠️ Variante no encontrada para "${item.product_name}" - ${item.color} - ${item.size}:`, variantError);
    }
    
    return {
      ...item,
      variant_id: variant?.id || null
    };
  }));
  
  console.log("🔵 createNewOrder: itemsWithVariants:", itemsWithVariants);
  
  // Preparar notes con valores extra
  const notes = Object.keys(extraValues || {}).length > 0 
    ? JSON.stringify(extraValues) 
    : null;
  
  console.log("🔵 createNewOrder: Creando pedido en base de datos...");
  // Crear el pedido
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      customer_id: customerId,
      status: "active",
      total_amount: total,
      notes: notes
    })
    .select()
    .single();
  
  if (orderError) {
    console.error("❌ createNewOrder: Error creando pedido:", orderError);
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
    status: "reserved"
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
  
  // Actualizar stock reservado
  console.log("🔵 createNewOrder: Actualizando stock reservado...");
  for (const item of itemsWithVariants) {
    if (item.variant_id) {
      // Obtener el stock reservado actual
      const { data: variantData, error: variantError } = await supabase
        .from("product_variants")
        .select("reserved_qty")
        .eq("id", item.variant_id)
        .single();
      
      if (variantError) {
        console.error(`❌ Error obteniendo variant ${item.variant_id}:`, variantError);
        // Continuar con el siguiente item
        continue;
      }
      
      if (variantData) {
        // Actualizar stock reservado
        const { error: updateError } = await supabase
          .from("product_variants")
          .update({ 
            reserved_qty: (variantData.reserved_qty || 0) + item.quantity 
          })
          .eq("id", item.variant_id);
        
        if (updateError) {
          console.error(`❌ Error actualizando stock para variant ${item.variant_id}:`, updateError);
          // No lanzar error, solo loguear - el pedido ya está creado
        }
      }
    }
  }
  
  console.log("✅ createNewOrder: Proceso completado exitosamente");
  
  // Retornar resultado exitoso
  return { success: true, order: order };
}

// Agregar items a pedido existente
async function addItemsToExistingOrder(orderId, items, newTotal = null, extraValues = {}) {
  // Similar a createNewOrder pero actualizando el pedido existente
  const itemsWithVariants = await Promise.all(items.map(async (item) => {
    const { data: product } = await supabase
      .from("products")
      .select("id")
      .eq("name", item.product_name)
      .maybeSingle();
    
    if (!product) {
      throw new Error(`Producto "${item.product_name}" no encontrado`);
    }
    
    const { data: variant } = await supabase
      .from("product_variants")
      .select("id")
      .eq("product_id", product.id)
      .eq("size", item.size)
      .eq("color", item.color)
      .maybeSingle();
    
    return {
      ...item,
      variant_id: variant?.id
    };
  }));
  
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
  
  // Determinar el estado para los nuevos items
  // Cuando se agregan productos manualmente, siempre deben estar "reserved"
  // para que el pedido vuelva a la sección de "Activos" y se pueda seleccionar como apartado
  const newItemStatus = "reserved";
  
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
  // Cuando se agregan productos manualmente, el pedido debe volver a "active"
  // para que se pueda seleccionar como apartado nuevamente
  const updateData = { 
    total_amount: finalTotal,
    status: "active" // Volver a estado activo cuando se agregan nuevos items
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
      
      // Si el pedido está enviado, actualizar sent_at a la fecha actual
      if (currentOrder.status === "sent") {
        updateData.sent_at = new Date().toISOString();
      }
      
      // Si el pedido está en devolución, mantener el estado de devolución
      // No hacer nada adicional, solo preservar el estado
    }
  }
  
  await supabase
    .from("orders")
    .update(updateData)
    .eq("id", orderId);
  
  // Actualizar stock según el estado del item
  for (const item of itemsWithVariants) {
    if (item.variant_id) {
      // Obtener el stock actual
      const { data: variantData } = await supabase
        .from("product_variants")
        .select("stock_qty, reserved_qty")
        .eq("id", item.variant_id)
        .single();
      
      if (variantData) {
        if (newItemStatus === "picked") {
          // Si está "picked", descontar del stock físico (stock_qty)
          await supabase
            .from("product_variants")
            .update({ 
              stock_qty: Math.max(0, (variantData.stock_qty || 0) - item.quantity)
            })
            .eq("id", item.variant_id);
        } else {
          // Si está "reserved", solo reservar (aumentar reserved_qty)
          await supabase
            .from("product_variants")
            .update({ 
              reserved_qty: (variantData.reserved_qty || 0) + item.quantity 
            })
            .eq("id", item.variant_id);
        }
      }
    }
  }
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


