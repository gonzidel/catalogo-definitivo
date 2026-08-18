// Importar dinámicamente para asegurar que se cargue después
import { qzConnect } from "./qz-printing.js?v=m260607";
import { parseARSNumber, resolveOrderItemUnitPrice } from "../scripts/utils/price.js?v=m260607";
import { formatDniDisplay } from "../scripts/utils/dni.js?v=m260607";
import {
  buildCustomerLabelNamePoolDetailed,
  getOrderActiveLabelButtonIndex,
  getOrderLabelDisplayName,
} from "../scripts/utils/label-names.js?v=m260607";

function generateOperationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const nowHex = Date.now().toString(16).padStart(12, "0");
  const randHex = Math.random().toString(16).slice(2).padEnd(20, "0").slice(0, 20);
  return `${nowHex.slice(0, 8)}-${nowHex.slice(8, 12)}-4${randHex.slice(0, 3)}-a${randHex.slice(3, 6)}-${randHex.slice(6, 18)}`;
}

let supabase = null;

// Función para obtener supabase, esperando a que esté disponible
async function getSupabase() {
  // Si ya está disponible, retornarlo
  if (supabase) {
    return supabase;
  }
  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }

  // Esperar hasta que window.supabase esté disponible (supabase-client.js lo asigna)
  let attempts = 0;
  const maxAttempts = 50; // 5 segundos máximo
  while (!window.supabase && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }

  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }

  // Si aún no está disponible, intentar importar
  try {
    const module = await import("../scripts/supabase-client.js?v=m260607");
    supabase = module.supabase || window.supabase;

    // Esperar un poco más
    if (!supabase) {
      await new Promise(resolve => setTimeout(resolve, 500));
      supabase = module.supabase || window.supabase;
    }

    if (supabase) {
      if (!window.supabase) {
        window.supabase = supabase;
      }
      return supabase;
    }

    console.error("❌ Supabase no disponible");
    return null;
  } catch (error) {
    console.error("❌ Error importando supabase-client:", error);
    return null;
  }
}

let currentAdminUser = null;
let allCustomersData = [];
let searchTerm = "";
let selectedCustomerId = null;
let autocompleteCustomers = [];
let autocompleteRequestToken = 0;
let scheduledTransports = [];
let warehouses = { general: null, ventaPublico: null };
let processingDevolucion = new Set(); // Rastrear pedidos en proceso de devolución
const sentOrdersVariantPriceMap = new Map(); // variant_id -> price de catálogo (raw)
const CUSTOMER_NOTIFICATION_ORDER_DEVOLUCION = "ORDER_MARKED_DEVOLUCION";

async function emitCustomerNotification({ customerId, orderId, type, message, payload }) {
  if (!customerId || !type || !message) return;
  if (!supabase) supabase = await getSupabase();
  if (!supabase) return;

  try {
    await supabase.from("customer_notifications").insert({
      customer_id: customerId,
      order_id: orderId || null,
      type: String(type),
      message: String(message),
      payload: payload && typeof payload === "object" ? payload : {},
      read: false,
      read_at: null,
    });
  } catch (_) {
    /* ignore */
  }
}

function getSentOrderUnitPrice(item) {
  const variantId = item?.variant_id != null ? String(item.variant_id).trim() : "";
  const variantPrice = variantId ? sentOrdersVariantPriceMap.get(variantId) : null;
  return resolveOrderItemUnitPrice(item?.price_snapshot, variantPrice);
}

async function initSentOrders() {
  try {
    // Obtener Supabase, esperando a que esté disponible
    supabase = await getSupabase();

    if (!supabase) {
      // Intentar una vez más después de un delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      supabase = window.supabase;

      if (!supabase) {
        console.error("❌ Supabase no disponible");
        alert("Error: Supabase no disponible. Por favor, recarga la página.");
        return;
      }
    }

    // Verificar autenticación primero
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      // Usuario no autenticado: redirigir a index.html para login
      window.location.href = "index.html";
      return;
    }

    // Usuario autenticado, verificar si es admin
    const isAdmin = await verifyAdminAuth();

    if (!isAdmin) {
      // Usuario autenticado pero no es admin: redirigir
      window.location.href = "index.html";
      return;
    }

    // Usuario es admin, continuar con la carga
    setupSearch();
    setupModal();
    setupPaymentMethodModalForLabel();
    await loadWarehouses();
    await loadScheduledTransports();
    renderSearchEmptyState();
    setupPrintLabelsButtons();
    setupPrintTicketButtons();
    setupDeleteItemButtons();
    setupDevolucionButtons();
    setupFacturarButtons();
  } catch (error) {
    console.error("❌ Error inicializando pedidos enviados:", error);
    window.location.href = "index.html";
  }
}

async function verifyAdminAuth() {
  try {
    // Asegurar que supabase esté disponible
    if (!supabase) {
      supabase = await getSupabase();
    }

    if (!supabase) {
      return false;
    }

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user) {
      return false;
    }

    const { data: adminRow, error: adminError } = await supabase
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error("❌ Error consultando tabla de admins:", adminError);
      return false;
    }

    if (!adminRow) {
      return false;
    }

    currentAdminUser = user;
    return true;
  } catch (error) {
    console.error("❌ Error en verifyAdminAuth:", error);
    return false;
  }
}

function renderSearchEmptyState() {
  const customersContent = document.getElementById("customers-content");
  if (!customersContent) return;
  customersContent.innerHTML = `
    <div class="empty-state">
      <h2>Buscá un cliente</h2>
      <p>Solo aparecen clientes que ya tienen pedidos enviados. Escribí un nombre y elegí una sugerencia.</p>
    </div>
  `;
}

async function loadSentOrders(customerIds = []) {
  const customersContent = document.getElementById("customers-content");
  if (!customersContent) return;

  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en loadSentOrders");
    customersContent.innerHTML = `
      <div class="empty-state">
        <h2>Error</h2>
        <p>No se pudo conectar con la base de datos.</p>
      </div>
    `;
    return;
  }

  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    renderSearchEmptyState();
    return;
  }

  try {
    // Obtener todos los pedidos enviados con sus items en lotes para evitar
    // cortes por límite implícito de filas en una sola consulta.
    const PAGE_SIZE = 500;
    const orders = [];
    const CUSTOMER_BATCH_SIZE = 100;

    for (let i = 0; i < customerIds.length; i += CUSTOMER_BATCH_SIZE) {
      const idsBatch = customerIds.slice(i, i + CUSTOMER_BATCH_SIZE);
      let from = 0;
      let keepFetching = true;

      while (keepFetching) {
        const to = from + PAGE_SIZE - 1;
        const { data: pageOrders, error: ordersError } = await supabase
          .from("orders")
          .select(
            `
            id,
            order_number,
            customer_id,
            updated_at,
            sent_at,
            total_amount,
            notes,
            transport_id,
            status,
            payment_method,
            label_customer_name,
            label_customer_dni,
            invoice_status,
            facturante_id,
            invoice_prefix,
            invoice_number,
            invoice_pdf_url,
            invoice_created_at,
            invoice_error,
            order_items (
              id,
              product_name,
              color,
              size,
              quantity,
              price_snapshot,
              imagen,
              status,
              variant_id,
              sku
            )
            `
          )
          .in("status", ["sent", "devolución"])
          .in("customer_id", idsBatch)
          .order("sent_at", { ascending: false })
          .range(from, to);

        if (ordersError) {
          console.error("❌ Error cargando pedidos enviados:", ordersError);
          customersContent.innerHTML = `
            <div class="empty-state">
              <h2>Error</h2>
              <p>No se pudieron cargar los pedidos enviados.</p>
            </div>
          `;
          return;
        }

        const currentPage = pageOrders || [];
        orders.push(...currentPage);

        if (currentPage.length < PAGE_SIZE) {
          keepFetching = false;
        } else {
          from += PAGE_SIZE;
        }
      }
    }

    if (!orders || orders.length === 0) {
      customersContent.innerHTML = `
        <div class="empty-state">
          <h2>No hay pedidos enviados</h2>
          <p>Cuando marques pedidos como terminados, aparecerán aquí.</p>
        </div>
      `;
      return;
    }

    // Cargar precio de catálogo por variante para corregir snapshots legacy corruptos.
    sentOrdersVariantPriceMap.clear();
    const variantIds = Array.from(
      new Set(
        (orders || [])
          .flatMap((o) => o?.order_items || [])
          .map((it) => (it?.variant_id != null ? String(it.variant_id).trim() : ""))
          .filter(Boolean)
      )
    );
    if (variantIds.length > 0) {
      const { data: variantsData, error: variantsError } = await supabase
        .from("product_variants")
        .select("id, price")
        .in("id", variantIds);
      if (!variantsError) {
        (variantsData || []).forEach((v) => {
          const id = v?.id != null ? String(v.id).trim() : "";
          if (id) sentOrdersVariantPriceMap.set(id, v?.price ?? null);
        });
      } else {
        console.warn("⚠️ No se pudieron cargar precios de variantes para fallback legacy:", variantsError.message || variantsError);
      }
    }

    // Obtener customer_ids únicos para cargar datos de clientes
    const uniqueCustomerIds = [...new Set(orders.map(order => order.customer_id).filter(Boolean))];

    // Obtener información de customers (incluyendo transport_id y sub-nombres)
    let customerSelectFields =
      "id, customer_number, full_name, phone, city, province, dni, email, address, transport_id, additional_names, label_name_cursor";
    let { data: customersData, error: customersError } = await supabase
      .from("customers")
      .select(customerSelectFields)
      .in("id", uniqueCustomerIds);

    if (customersError) {
      console.warn("⚠️ Reintentando customers sin additional_names:", customersError.message || customersError);
      customerSelectFields =
        "id, customer_number, full_name, phone, city, province, dni, email, address, transport_id";
      ({ data: customersData, error: customersError } = await supabase
        .from("customers")
        .select(customerSelectFields)
        .in("id", uniqueCustomerIds));
    }

    if (customersError) {
      console.error("❌ Error obteniendo datos de customers:", customersError);
      customersContent.innerHTML = `
        <div class="empty-state">
          <h2>Error</h2>
          <p>No se pudieron cargar los datos de los clientes.</p>
        </div>
      `;
      return;
    }

    // Agrupar pedidos por cliente y obtener la fecha más reciente
    const customersMap = new Map();

    // Inicializar mapa de clientes
    if (customersData) {
      customersData.forEach(customer => {
        customersMap.set(customer.id, {
          ...customer,
          orders: [],
          latestOrderDate: null
        });
      });
    }

    // Agregar pedidos a cada cliente (incluyendo datos del cliente en cada pedido)
    orders.forEach(order => {
      const customer = customersMap.get(order.customer_id);
      if (customer) {
        // Agregar datos del cliente al pedido para facilitar el acceso
        const orderWithCustomer = {
          ...order,
          customer_data: customer
        };
        customer.orders.push(orderWithCustomer);
        // Actualizar fecha más reciente usando sent_at, o updated_at como fallback
        const orderDate = order.sent_at ? new Date(order.sent_at) : new Date(order.updated_at);
        const dateToCompare = order.sent_at || order.updated_at;
        if (!customer.latestOrderDate || orderDate > new Date(customer.latestOrderDate)) {
          customer.latestOrderDate = dateToCompare;
        }
      }
    });

    // Convertir a array y ordenar por fecha más reciente
    allCustomersData = Array.from(customersMap.values())
      .filter(customer => customer.orders.length > 0)
      .sort((a, b) => {
        const dateA = new Date(a.latestOrderDate);
        const dateB = new Date(b.latestOrderDate);
        return dateB - dateA; // Más reciente primero
      });

    // Renderizar clientes
    renderCustomers(allCustomersData);
  } catch (error) {
    console.error("❌ Error cargando pedidos enviados:", error);
    customersContent.innerHTML = `
      <div class="empty-state">
        <h2>Error</h2>
        <p>Ocurrió un error al cargar los pedidos enviados.</p>
      </div>
    `;
  }
}

/**
 * Deja solo clientes que tienen al menos un pedido enviado (o en devolución).
 * Así el buscador de "Pedidos Enviados" no sugiere clientas sin envíos.
 */
async function filterCustomersWithSentOrders(customers) {
  const list = Array.isArray(customers) ? customers.filter((c) => c?.id) : [];
  if (!list.length) return [];

  if (!supabase) supabase = await getSupabase();
  if (!supabase) return [];

  const ids = [...new Set(list.map((c) => c.id))];
  const withSent = new Set();
  const BATCH = 100;

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("orders")
      .select("customer_id")
      .in("customer_id", batch)
      .in("status", ["sent", "devolución"]);

    if (error) {
      console.error("❌ Error filtrando clientes con pedidos enviados:", error);
      throw error;
    }

    for (const row of data || []) {
      if (row?.customer_id) withSent.add(row.customer_id);
    }
  }

  return list.filter((c) => withSent.has(c.id));
}

async function resolveCustomerIdsForSearch(rawTerm) {
  const term = (rawTerm || "").trim();
  if (!term) return [];

  if (selectedCustomerId) {
    // Igual validamos: si la clienta no tiene enviados, no devolvemos el id.
    const filtered = await filterCustomersWithSentOrders([{ id: selectedCustomerId }]);
    return filtered.map((c) => c.id);
  }

  const safeTerm = term.replace(/[%_]/g, "").slice(0, 80);
  const { data: matchedCustomers, error: customerSearchError } = await supabase
    .from("customers")
    .select("id")
    .or(`full_name.ilike.%${safeTerm}%,customer_number.ilike.%${safeTerm}%`)
    .limit(200);

  if (customerSearchError) {
    throw customerSearchError;
  }

  const withSent = await filterCustomersWithSentOrders(matchedCustomers || []);
  return withSent.map((c) => c.id).filter(Boolean);
}

async function runSentOrdersSearch() {
  const searchInput = document.getElementById("search-input");
  const customersContent = document.getElementById("customers-content");
  searchTerm = (searchInput?.value || "").trim();

  if (!searchTerm) {
    selectedCustomerId = null;
    allCustomersData = [];
    renderSearchEmptyState();
    return;
  }

  if (customersContent) {
    customersContent.innerHTML = `
      <div class="loading">
        <p>Buscando pedidos enviados...</p>
      </div>
    `;
  }

  try {
    const customerIds = await resolveCustomerIdsForSearch(searchTerm);
    await loadSentOrders(customerIds);
  } catch (error) {
    console.error("❌ Error buscando clientes:", error);
    if (customersContent) {
      customersContent.innerHTML = `
        <div class="empty-state">
          <h2>Error</h2>
          <p>No se pudo buscar el cliente ingresado.</p>
        </div>
      `;
    }
  }
}

function renderCustomers(customers) {
  const customersContent = document.getElementById("customers-content");
  if (!customersContent) return;

  if (customers.length === 0) {
    customersContent.innerHTML = `
      <div class="empty-state">
        <h2>Sin resultados</h2>
        <p>No se encontraron pedidos enviados para la búsqueda ingresada.</p>
      </div>
    `;
    return;
  }

  const customersHtml = customers
    .map(customer => {
      const location = [customer.city, customer.province].filter(Boolean).join(" - ") || "Sin ubicación";
      const ordersCount = customer.orders.length;

      return `
        <div class="customer-card" data-customer-id="${customer.id}">
          <div class="customer-card-header">
            <span class="customer-number">#${customer.customer_number || "N/A"}</span>
            <span class="customer-orders-count">${ordersCount} pedido${ordersCount !== 1 ? "s" : ""}</span>
          </div>
          <div class="customer-name">${customer.full_name || "Cliente sin nombre"}</div>
          <div class="customer-location">📍 ${location}</div>
        </div>
      `;
    })
    .join("");

  customersContent.innerHTML = `<div class="customers-grid">${customersHtml}</div>`;

  // Agregar event listeners a las tarjetas
  document.querySelectorAll(".customer-card").forEach(card => {
    card.addEventListener("click", () => {
      const customerId = card.dataset.customerId;
      const customer = allCustomersData.find(c => c.id === customerId);
      if (customer) {
        openCustomerModal(customer);
      }
    });
  });
}

function setupSearch() {
  const searchInput = document.getElementById("search-input");
  const searchBtn = document.getElementById("search-btn");
  const suggestionsBox = document.getElementById("search-suggestions");
  if (!searchInput || !searchBtn || !suggestionsBox) return;

  const hideSuggestions = () => {
    suggestionsBox.style.display = "none";
    suggestionsBox.innerHTML = "";
  };

  const renderSuggestions = (customers) => {
    autocompleteCustomers = customers || [];
    if (!autocompleteCustomers.length) {
      hideSuggestions();
      return;
    }
    suggestionsBox.innerHTML = autocompleteCustomers
      .map((customer) => {
        const customerName = customer.full_name || "Cliente sin nombre";
        const customerNumber = customer.customer_number ? `#${customer.customer_number}` : "Sin número";
        return `
          <div class="search-suggestion-item" data-customer-id="${customer.id}">
            ${customerName} (${customerNumber})
          </div>
        `;
      })
      .join("");
    suggestionsBox.style.display = "block";
  };

  const searchCustomersAutocomplete = async (rawTerm) => {
    const term = (rawTerm || "").trim();
    if (term.length < 2) {
      renderSuggestions([]);
      return;
    }
    const token = ++autocompleteRequestToken;
    const safeTerm = term.replace(/[%_]/g, "").slice(0, 80);

    // Pedimos de más y después filtramos a quienes tienen pedidos enviados.
    const { data, error } = await supabase
      .from("customers")
      .select("id, customer_number, full_name")
      .or(`full_name.ilike.%${safeTerm}%,customer_number.ilike.%${safeTerm}%`)
      .order("full_name", { ascending: true })
      .limit(40);

    if (token !== autocompleteRequestToken) return;
    if (error) {
      console.error("❌ Error buscando sugerencias de clientes:", error);
      renderSuggestions([]);
      return;
    }

    let withSent = [];
    try {
      withSent = await filterCustomersWithSentOrders(data || []);
    } catch (_) {
      renderSuggestions([]);
      return;
    }
    if (token !== autocompleteRequestToken) return;

    renderSuggestions(withSent.slice(0, 12));
  };

  searchInput.addEventListener("input", async (e) => {
    const value = e.target.value.trim();
    searchTerm = value;
    selectedCustomerId = null;
    await searchCustomersAutocomplete(value);
  });

  searchInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await runSentOrdersSearch();
    }
  });

  searchBtn.addEventListener("click", async () => {
    await runSentOrdersSearch();
  });

  suggestionsBox.addEventListener("click", async (e) => {
    const item = e.target.closest("[data-customer-id]");
    if (!item) return;
    const customerId = item.getAttribute("data-customer-id");
    const customer = autocompleteCustomers.find((c) => c.id === customerId);
    if (!customer) return;

    selectedCustomerId = customer.id;
    searchInput.value = customer.full_name || "";
    searchTerm = searchInput.value.trim();
    hideSuggestions();
    await runSentOrdersSearch();
  });

  document.addEventListener("click", (e) => {
    if (e.target === searchInput || suggestionsBox.contains(e.target)) return;
    hideSuggestions();
  });
}

function setupModal() {
  const modal = document.getElementById("customer-modal");
  const closeBtn = document.getElementById("modal-close-btn");

  if (!modal || !closeBtn) return;

  // Cerrar modal al hacer click en el botón de cerrar
  closeBtn.addEventListener("click", () => {
    closeModal();
  });

  // Cerrar modal al hacer click fuera del contenido
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  // Cerrar modal con tecla ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closeModal();
    }
  });
}

function openCustomerModal(customer) {
  const modal = document.getElementById("customer-modal");
  const modalCustomerName = document.getElementById("modal-customer-name");
  const modalCustomerInfo = document.getElementById("modal-customer-info");
  const modalOrdersList = document.getElementById("modal-orders-list");

  if (!modal || !modalCustomerName || !modalCustomerInfo || !modalOrdersList) return;

  // Mostrar información del cliente
  modalCustomerName.textContent = formatCustomerDisplayName(customer);

  const location = [customer.city, customer.province].filter(Boolean).join(" - ") || "Sin ubicación";
  
  // Preparar selector de transporte
  const transportOptions = scheduledTransports.map(t => 
    `<option value="${t.id}" ${customer.transport_id === t.id ? 'selected' : ''}>${t.name}</option>`
  ).join('');
  
  modalCustomerInfo.innerHTML = `
    <div class="modal-customer-meta">
      <div class="modal-customer-meta__item">
        <span class="modal-customer-meta__label">Nº cliente</span>
        <span class="modal-customer-meta__value">#${customer.customer_number || "N/A"}</span>
      </div>
      <div class="modal-customer-meta__item">
        <span class="modal-customer-meta__label">DNI</span>
        <span class="modal-customer-meta__value">${customer.dni || "—"}</span>
      </div>
      <div class="modal-customer-meta__item modal-customer-meta__item--full">
        <span class="modal-customer-meta__label">Email</span>
        <span class="modal-customer-meta__value">${customer.email || "Sin email"}</span>
      </div>
      <div class="modal-customer-meta__item">
        <span class="modal-customer-meta__label">Teléfono</span>
        <span class="modal-customer-meta__value">${customer.phone || "—"}</span>
      </div>
      <div class="modal-customer-meta__item">
        <span class="modal-customer-meta__label">Ubicación</span>
        <span class="modal-customer-meta__value">${location}</span>
      </div>
    </div>
    <div class="transport-section">
      <label class="transport-section__label" for="transport-select-${customer.id}">🚚 Transporte</label>
      <select id="transport-select-${customer.id}" class="transport-select" data-customer-id="${customer.id}">
        <option value="">Sin transporte</option>
        ${transportOptions}
      </select>
    </div>
  `;

  // Event listener para selector de transporte
  const transportSelect = modal.querySelector('.transport-select');
  if (transportSelect) {
    transportSelect.addEventListener('change', async (e) => {
      const customerId = e.target.dataset.customerId;
      const transportId = e.target.value || null;
      
      e.target.disabled = true;
      const originalValue = e.target.value;
      
      try {
        const success = await saveTransportForCustomer(customerId, transportId);
        if (!success) {
          e.target.value = originalValue;
        } else {
          console.log(`✅ Transporte actualizado para cliente ${customerId}`);
        }
      } catch (error) {
        console.error("❌ Error al guardar transporte:", error);
        e.target.value = originalValue;
        alert("Error al guardar el transporte: " + (error.message || 'Error desconocido'));
      } finally {
        e.target.disabled = false;
      }
    });
  }

  // Ordenar pedidos por fecha más reciente primero (usar sent_at, o updated_at como fallback)
  const sortedOrders = [...customer.orders].sort((a, b) => {
    const dateA = new Date(a.sent_at || a.updated_at);
    const dateB = new Date(b.sent_at || b.updated_at);
    return dateB - dateA; // Más reciente primero
  });

  // Mostrar lista de pedidos
  if (sortedOrders.length === 0) {
    modalOrdersList.innerHTML = `
      <div class="empty-state">
        <p>No hay pedidos para este cliente.</p>
      </div>
    `;
  } else {
    const ordersHtml = sortedOrders
      .map(order => {
        // Usar sent_at si existe, sino updated_at como fallback
        const orderDate = new Date(order.sent_at || order.updated_at);
        const formattedDate = orderDate.toLocaleDateString("es-AR", {
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
        const orderNumber = order.order_number || order.id.substring(0, 8);
        const orderItems = order.order_items || [];

        // Calcular subtotal excluyendo items faltantes
        const validItems = orderItems.filter(item => item.status !== 'missing');
        const subtotal = validItems.reduce((sum, item) => {
          const quantity = Number(item.quantity || 0);
          const price = getSentOrderUnitPrice(item);
          return sum + (quantity * price);
        }, 0);

        // Calcular extras desde notes si existen
        let extrasTotal = 0;
        if (order.notes) {
          try {
            const extraValues = JSON.parse(order.notes);
            const shipping = parseFloat(extraValues.shipping) || 0;
            const discount = parseFloat(extraValues.discount) || 0;
            const extrasAmount = parseFloat(extraValues.extras_amount) || 0;
            const extrasPercentage = parseFloat(extraValues.extras_percentage) || 0;
            const extrasFromPercentage = extrasPercentage > 0 ? (subtotal * extrasPercentage / 100) : 0;

            extrasTotal = shipping - discount + extrasAmount + extrasFromPercentage;
          } catch (e) {
            console.warn("⚠️ Error parseando notes del pedido:", e);
          }
        }

        // Usar total_amount del pedido (que incluye extras) o calcularlo
        const hasStoredTotal = order.total_amount != null && String(order.total_amount).trim() !== "";
        const total = hasStoredTotal ? parseARSNumber(order.total_amount) : (subtotal + extrasTotal);
        const totalProducts = validItems.reduce(
          (sum, item) => sum + Number(item.quantity || 0),
          0
        );

        // Generar HTML de items del pedido
        const itemsHtml = orderItems.length > 0
          ? orderItems.map(item => {
            const itemImage = item.imagen || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23f2f2f2'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23999' font-size='12'%3ESin imagen%3C/text%3E%3C/svg%3E";
            const itemQuantity = Number(item.quantity || 0);
            const itemPrice = getSentOrderUnitPrice(item);
            const itemSubtotal = itemQuantity * itemPrice;
            const isMissing = item.status === 'missing';
            const itemClass = isMissing ? 'order-item-detail missing' : 'order-item-detail';

            return `
                <div class="${itemClass}">
                  <img src="${itemImage}" alt="${item.product_name || 'Producto'}" class="order-item-detail-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'64\\' height=\\'64\\' viewBox=\\'0 0 64 64\\'%3E%3Crect width=\\'64\\' height=\\'64\\' fill=\\'%23f2f2f2\\'/%3E%3Ctext x=\\'50%25\\' y=\\'50%25\\' text-anchor=\\'middle\\' dy=\\'.3em\\' fill=\\'%23999\\' font-size=\\'12\\'%3ESin imagen%3C/text%3E%3C/svg%3E'">
                  <div class="order-item-detail-info">
                    <div class="order-item-detail-name">${item.product_name || "Producto sin nombre"} ${isMissing ? '<span class="order-item-detail-missing-tag">(Faltante)</span>' : ''}</div>
                    <div class="order-item-detail-meta">
                      <span>${item.color || "-"}</span>
                      <span class="order-item-detail-sep">·</span>
                      <span>T${item.size || "-"}</span>
                      <span class="order-item-detail-sep">·</span>
                      <span>×${itemQuantity}</span>
                    </div>
                  </div>
                  <div class="order-item-detail-side">
                    <div class="order-item-detail-price" style="${isMissing ? 'text-decoration: line-through; opacity: 0.5;' : ''}">$${itemSubtotal.toLocaleString("es-AR")}</div>
                    ${!isMissing ? `<button class="delete-item-btn" data-delete-item="${item.id}" data-order-id="${order.id}" title="Eliminar producto">🗑️</button>` : ''}
                  </div>
                </div>
              `;
          }).join("")
          : "<p style='color: #666; font-size: 14px;'>No hay productos en este pedido.</p>";

        // Determinar si el pedido está en devolución
        const isDevolucion = order.status === 'devolución';
        const orderItemClass = isDevolucion ? 'order-date-item devolucion' : 'order-date-item';

        return `
          <div class="${orderItemClass}" data-order-id="${order.id}">
            <div class="order-card-layout">
              <div class="order-card-left">
                <div class="order-date-item-header" data-order-toggle="${order.id}">
                  <div class="order-date-item-header-main">
                    <span class="order-number">#${orderNumber}</span>
                    <span class="order-date">${formattedDate}</span>
                  </div>
                  <span class="order-expand-icon" aria-hidden="true">▼</span>
                </div>
                <div class="order-total">
                  <span>Total: $${total.toLocaleString("es-AR")}</span>
                  <span class="order-total-products">· ${totalProducts} producto${totalProducts === 1 ? "" : "s"}</span>
                </div>
                <div class="order-card-actions">
                  <button class="modify-order-btn" data-modify-order="${order.id}">✏️ Modificar</button>
                  <button class="devolucion-btn" data-devolucion-order="${order.id}" ${isDevolucion ? 'style="opacity: 0.5; cursor: not-allowed;"' : ''}>Devolución</button>
                  <button class="btn btn-warning order-action--desktop-only" data-print-labels="${order.id}" style="background: #ffc107; color: #000; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: background 0.2s;">Imprimir rótulos</button>
                  <button class="btn btn-primary order-action--desktop-only" data-print-ticket="${order.id}" style="background: #17a2b8; color: #000; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: background 0.2s;">Imprimir ticket</button>
                  ${renderInvoiceButton(order)}
                </div>
              </div>
            </div>
            <div class="order-items-detail" id="order-items-${order.id}">
              ${itemsHtml}
              ${orderItems.length > 0 || extrasTotal !== 0 ? `
                <div class="order-items-summary">
                  ${orderItems.length > 0 ? `<div>Subtotal productos: $${subtotal.toLocaleString("es-AR")}</div>` : ""}
                  ${extrasTotal !== 0 ? `<div style="color: #CD844D; font-weight: 600;">Extras: $${extrasTotal.toLocaleString("es-AR")}</div>` : ""}
                  <div style="font-weight: 600; margin-top: 8px; padding-top: 8px; border-top: 1px solid #ddd;">Total del pedido: $${total.toLocaleString("es-AR")}</div>
                </div>
              ` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    modalOrdersList.innerHTML = ordersHtml;

    // Agregar event listeners para expandir/contraer pedidos
    document.querySelectorAll("[data-order-toggle]").forEach(toggleBtn => {
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // Evitar que se propague el evento

        const orderId = toggleBtn.dataset.orderToggle;
        const orderItem = document.querySelector(`[data-order-id="${orderId}"]`);
        const itemsDetail = document.getElementById(`order-items-${orderId}`);

        if (orderItem && itemsDetail) {
          // Toggle expanded
          if (orderItem.classList.contains("expanded")) {
            orderItem.classList.remove("expanded");
            itemsDetail.classList.remove("visible");
          } else {
            // Cerrar otros pedidos expandidos
            document.querySelectorAll(".order-date-item.expanded").forEach(expanded => {
              expanded.classList.remove("expanded");
              const expandedId = expanded.dataset.orderId;
              const expandedDetail = document.getElementById(`order-items-${expandedId}`);
              if (expandedDetail) {
                expandedDetail.classList.remove("visible");
              }
            });

            // Expandir este pedido
            orderItem.classList.add("expanded");
            itemsDetail.classList.add("visible");
          }
        }
      });
    });

    // Agregar event listeners para botones Modificar
    document.querySelectorAll("[data-modify-order]").forEach(modifyBtn => {
      modifyBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // Evitar que se propague el evento
        const orderId = modifyBtn.dataset.modifyOrder;
        handleModifyOrder(orderId);
      });
    });
  }

  // Mostrar modal
  modal.classList.add("active");
}

// =============================================================================
// FACTURACIÓN ELECTRÓNICA — Facturante (Factura B / Consumidor Final)
// =============================================================================

/**
 * Renderiza el botón de Facturar según el invoice_status del pedido.
 * Retorna HTML string listo para insertarse en el template del pedido.
 */
function renderInvoiceButton(order) {
  const status = order.invoice_status || "sin_facturar";
  const invoicePrefix = order.invoice_prefix || "";
  const invoiceNumber = order.invoice_number || "";
  const pdfUrl = order.invoice_pdf_url || "";
  const invoiceError = order.invoice_error || "Error desconocido";
  const orderId = order.id;

  const baseStyle = "border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; min-height: 32px; white-space: nowrap; transition: background 0.2s;";

  switch (status) {
    case "sin_facturar":
      return `<button
        class="btn-invoice order-action--desktop-only"
        data-facturar="${orderId}"
        style="${baseStyle} background: #6c757d; color: #fff;"
        title="Emitir Factura B para este pedido">
        🧾 Facturar
      </button>`;

    case "processing":
      return `<button
        class="btn-invoice-processing order-action--desktop-only"
        disabled
        style="${baseStyle} background: #b8d4f0; color: #555; cursor: not-allowed; opacity: 0.8;"
        title="Esperando autorización de AFIP...">
        ⏳ Pendiente AFIP
      </button>`;

    case "approved": {
      const numDisplay = invoicePrefix && invoiceNumber
        ? `${invoicePrefix}-${String(invoiceNumber).padStart(8, "0")}`
        : "Facturado";
      return `<button
        class="btn-invoice-approved order-action--desktop-only"
        data-invoice-pdf="${encodeURIComponent(pdfUrl)}"
        style="${baseStyle} background: #28a745; color: #fff;"
        title="Factura ${numDisplay} — clic para ver PDF">
        ✓ ${numDisplay}
      </button>`;
    }

    case "error":
      return `<button
        class="btn-invoice-error order-action--desktop-only"
        data-invoice-error="${encodeURIComponent(invoiceError)}"
        data-facturar-retry="${orderId}"
        style="${baseStyle} background: #dc3545; color: #fff;"
        title="${invoiceError}">
        ⚠ Error
      </button>`;

    default:
      return "";
  }
}

/**
 * Formatea una fecha ISO como dd/mm/aaaa.
 */
function formatInvoiceDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Configura todos los botones de facturación en el DOM actual.
 * Se llama desde initSentOrders (configuración global via delegación de eventos).
 */
function setupFacturarButtons() {
  // Delegación de eventos en el documento para capturar botones generados dinámicamente
  document.addEventListener("click", handleInvoiceClick, { capture: false });
}

async function handleInvoiceClick(e) {
  const btn = e.target.closest("[data-facturar], [data-facturar-retry], [data-invoice-pdf], [data-invoice-error]");
  if (!btn) return;

  // -----------------------------------------------------------------------
  // Botón "Ver PDF" (estado approved)
  // -----------------------------------------------------------------------
  if (btn.dataset.invoicePdf !== undefined) {
    const url = decodeURIComponent(btn.dataset.invoicePdf || "");
    if (url) {
      window.open(url, "_blank");
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Botón "⚠ Error" — mostrar popover con mensaje y opción de reintentar
  // -----------------------------------------------------------------------
  if (btn.dataset.invoiceError !== undefined && !btn.dataset.facturarRetry) {
    const errMsg = decodeURIComponent(btn.dataset.invoiceError || "Error desconocido");
    showInvoiceErrorPopover(btn, errMsg, null);
    return;
  }

  // -----------------------------------------------------------------------
  // Botón "Facturar" (estado sin_facturar) — con confirm de seguridad
  // -----------------------------------------------------------------------
  const orderId = btn.dataset.facturar || btn.dataset.facturarRetry;
  if (!orderId) return;

  // Error con retry: mostrar popover antes de reintentar
  if (btn.dataset.invoiceError !== undefined && btn.dataset.facturarRetry) {
    const errMsg = decodeURIComponent(btn.dataset.invoiceError || "Error desconocido");
    showInvoiceErrorPopover(btn, errMsg, orderId);
    return;
  }

  // CAPA 1 — Prevenir doble clic: deshabilitar inmediatamente
  if (btn.disabled || btn.dataset.invoicing === "true") return;
  btn.dataset.invoicing = "true";

  // Buscar el order_number para el confirm
  const orderEl = btn.closest("[data-order-id]");
  const orderCard = orderEl ? orderEl.querySelector(".order-number") : null;
  const orderLabel = orderCard ? orderCard.textContent.trim() : "este pedido";

  // Confirm deliberado — fricción intencional contra doble facturación
  const confirmed = window.confirm(
    `¿Confirmar emisión de Factura B para ${orderLabel}?\n\nEsta acción genera un comprobante legal ante AFIP y consume un crédito de Facturante.`
  );

  if (!confirmed) {
    btn.dataset.invoicing = "false";
    return;
  }

  await executeFacturar(btn, orderId);
}

async function executeFacturar(btn, orderId) {
  // Feedback visual inmediato — CAPA 1 UI
  btn.textContent = "Facturando...";
  btn.disabled = true;
  btn.style.background = "#5a9fd4";
  btn.style.cursor = "not-allowed";

  try {
    const { data: invokeData, error: invokeError } = await supabase.functions.invoke(
      "facturante-invoice",
      { body: { order_id: orderId } }
    );

    // supabase.functions.invoke lanza error en respuestas no-2xx
    const result = invokeData || {};
    const isConflict = invokeError?.context?.status === 409;
    const isError = !!invokeError && !isConflict;

    if (!invokeError && result.success) {
      // Actualizar botón a estado "processing" sin recargar toda la lista
      btn.outerHTML = `<button
        class="btn-invoice-processing"
        disabled
        style="border:none;padding:6px 12px;border-radius:6px;cursor:not-allowed;font-size:13px;min-height:32px;white-space:nowrap;background:#b8d4f0;color:#555;opacity:0.8;"
        title="Esperando autorización de AFIP...">
        ⏳ Pendiente AFIP
      </button>`;
      showInvoiceToast("✅ Factura enviada a AFIP. El botón se actualizará automáticamente al recibir la respuesta.", "success");
    } else if (isConflict) {
      // Ya facturado o en proceso — refrescar para mostrar estado real
      const conflictMsg = invokeError?.message || result.error || "Este pedido ya está en proceso de facturación.";
      showInvoiceToast(`ℹ️ ${conflictMsg}`, "info");
      if (typeof runSentOrdersSearch === "function") runSentOrdersSearch();
    } else {
      const errMsg = (invokeError?.message) || result.error || "Error al facturar";
      btn.outerHTML = `<button
        class="btn-invoice-error"
        data-invoice-error="${encodeURIComponent(errMsg)}"
        data-facturar-retry="${orderId}"
        style="border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px;min-height:32px;white-space:nowrap;background:#dc3545;color:#fff;"
        title="${encodeURIComponent(errMsg)}">
        ⚠ Error
      </button>`;
      showInvoiceToast(`❌ ${errMsg}`, "error");
    }
  } catch (err) {
    console.error("❌ Error inesperado en executeFacturar:", err);
    const errMsg = `Error de conexión: ${err?.message || "Timeout"}`;
    resetInvoiceButton(btn, orderId, errMsg);
    showInvoiceToast(`❌ ${errMsg}`, "error");
  }
}

function resetInvoiceButton(btn, orderId, errorMsg) {
  btn.disabled = false;
  btn.dataset.invoicing = "false";
  if (errorMsg) {
    btn.outerHTML = `<button
      class="btn-invoice-error"
      data-invoice-error="${encodeURIComponent(errorMsg)}"
      data-facturar-retry="${orderId}"
      style="border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px;min-height:32px;white-space:nowrap;background:#dc3545;color:#fff;">
      ⚠ Error
    </button>`;
  } else {
    btn.textContent = "🧾 Facturar";
    btn.disabled = false;
    btn.style.background = "#6c757d";
    btn.style.cursor = "pointer";
  }
}

/**
 * Muestra un popover en el botón de error con el mensaje y opción de reintentar.
 */
function showInvoiceErrorPopover(btn, errMsg, retryOrderId) {
  // Cerrar popover existente si hay uno
  const existing = document.getElementById("invoice-error-popover");
  if (existing) existing.remove();

  const popover = document.createElement("div");
  popover.id = "invoice-error-popover";
  popover.className = "invoice-error-popover";
  popover.innerHTML = `
    <div class="invoice-error-popover-header">Error de facturación</div>
    <div class="invoice-error-popover-msg">${errMsg.substring(0, 200)}</div>
    <div class="invoice-error-popover-actions">
      ${retryOrderId ? `<button class="invoice-popover-retry" data-retry-order="${retryOrderId}">Reintentar</button>` : ""}
      <button class="invoice-popover-close">Cerrar</button>
    </div>
  `;

  // Posicionar cerca del botón
  document.body.appendChild(popover);
  const rect = btn.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 4;
  const left = Math.min(rect.left + window.scrollX, window.innerWidth - 260);
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  // Cerrar
  popover.querySelector(".invoice-popover-close").addEventListener("click", () => popover.remove());

  // Reintentar
  if (retryOrderId) {
    popover.querySelector(".invoice-popover-retry").addEventListener("click", async () => {
      popover.remove();
      // Encontrar el botón de error del pedido y ejecutar el flujo de facturación
      const retryBtn = document.querySelector(`[data-facturar-retry="${retryOrderId}"]`);
      if (retryBtn) {
        await executeFacturar(retryBtn, retryOrderId);
      }
    });
  }

  // Auto-cerrar al clic fuera
  setTimeout(() => {
    document.addEventListener("click", function closePopover(ev) {
      if (!popover.contains(ev.target)) {
        popover.remove();
        document.removeEventListener("click", closePopover);
      }
    });
  }, 100);
}

/**
 * Muestra un toast de notificación temporal para feedback de facturación.
 */
function showInvoiceToast(message, type = "info") {
  const existing = document.getElementById("invoice-toast");
  if (existing) existing.remove();

  const colors = { success: "#28a745", error: "#dc3545", info: "#17a2b8" };
  const toast = document.createElement("div");
  toast.id = "invoice-toast";
  toast.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 9999;
    background: ${colors[type] || colors.info}; color: #fff;
    padding: 12px 18px; border-radius: 8px; font-size: 14px;
    max-width: 360px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    animation: fadeInUp 0.3s ease;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// =============================================================================
// FIN FACTURACIÓN ELECTRÓNICA
// =============================================================================

function closeModal() {
  const modal = document.getElementById("customer-modal");
  if (modal) {
    modal.classList.remove("active");
  }
}

function formatCustomerDisplayName(customer) {
  const full = (customer?.full_name || '').trim();
  if (!full) return 'Cliente sin nombre';
  const parts = full.split(/\s+/);
  if (parts.length === 1) return full;
  const last = parts.pop();
  const first = parts.join(' ');
  return `${last}, ${first}`;
}

// Función para inicializar cuando el DOM y Supabase estén listos
async function initWhenReady() {
  // Esperar a que el DOM esté listo
  if (document.readyState === "loading") {
    await new Promise(resolve => {
      document.addEventListener("DOMContentLoaded", resolve);
    });
  }

  // Esperar a que Supabase esté disponible
  supabase = await getSupabase();

  if (!supabase) {
    console.error("❌ No se pudo obtener Supabase");
    alert("Error: No se pudo conectar con Supabase. Por favor, recarga la página.");
    return;
  }

  await initSentOrders();
}

// Función para manejar el clic en el botón Modificar
function handleModifyOrder(orderId) {
  console.log("🔵 handleModifyOrder: orderId:", orderId);

  // Esperar a que window.openEditOrderModal esté disponible
  if (typeof window.openEditOrderModal === 'function') {
    window.openEditOrderModal(orderId);
  } else {
    console.warn("⚠️ window.openEditOrderModal no está disponible aún, esperando...");
    let attempts = 0;
    const checkFunction = setInterval(() => {
      attempts++;
      if (typeof window.openEditOrderModal === 'function') {
        clearInterval(checkFunction);
        window.openEditOrderModal(orderId);
      } else if (attempts >= 50) {
        clearInterval(checkFunction);
        console.error("❌ window.openEditOrderModal no está disponible después de esperar");
        alert("Error: El módulo de edición no se cargó correctamente. Por favor, recarga la página.");
      }
    }, 100);
  }
}

// Función para recargar pedidos enviados después de editar
// Exponer globalmente para que order-creator.js pueda llamarla
window.loadSentOrders = async function () {
  console.log("🔄 Recargando pedidos enviados...");
  await runSentOrdersSearch();

  // Si hay un modal abierto, cerrarlo y reabrirlo para mostrar los cambios
  const modal = document.getElementById("customer-modal");
  if (modal && modal.classList.contains("active")) {
    // Obtener el cliente actual del modal
    const modalCustomerName = document.getElementById("modal-customer-name");
    if (modalCustomerName) {
      const customerName = modalCustomerName.textContent;
      // Buscar el cliente en allCustomersData
      const customer = allCustomersData.find(c => formatCustomerDisplayName(c) === customerName);
      if (customer) {
        // Cerrar y reabrir el modal con datos actualizados
        closeModal();
        setTimeout(() => {
          openCustomerModal(customer);
        }, 100);
      }
    }
  }
};

// QZ Tray: conexión vía qz-printing.js

async function qzGetPrinterConfigTsc() {
  await qzConnect();

  const printers = await qz.printers.find();
  console.log("Impresoras disponibles en QZ:", printers);

  const preferredNames = [
    "TSC TE210",
    "TE210",
    "TSC TE200",
    "TSC"
  ];

  const printerName = printers.find(p =>
    preferredNames.some(name => p.toLowerCase().includes(name.toLowerCase()))
  );

  if (!printerName) {
    throw new Error("No se encontró la impresora TSC TE210. Verificá que el driver esté instalado y QZ Tray en ejecución.");
  }

  console.log("Impresora TSC seleccionada:", printerName);
  return qz.configs.create(printerName);
}

/**
 * Obtiene la configuración de la impresora POS-80 específicamente para tickets
 * @returns {Promise<Object>} Configuración de QZ para la impresora POS-80
 */
async function qzGetPrinterConfigPos80() {
  await qzConnect();

  const printers = await qz.printers.find();
  console.log("🖨️ Impresoras disponibles en QZ:", printers);

  // Buscar impresora POS-80 (case-insensitive)
  const printerName = printers.find(p => /pos-80/i.test(p) || /pos80/i.test(p));

  if (!printerName) {
    console.error("❌ No se encontró la impresora POS-80 en la lista:", printers);
    throw new Error(
      "No se encontró la impresora POS-80 en la lista de QZ Tray. " +
      "Verificá que la POS-80 aparezca en el menú Printers de QZ."
    );
  }

  console.log("✅ Impresora POS-80 seleccionada:", printerName);
  return qz.configs.create(printerName);
}

// ============================================================================
// Funciones helper para formateo de tickets
// ============================================================================

const TICKET_WIDTH = 42;

/**
 * Convierte un valor a string de forma segura
 * @param {any} text - Valor a convertir
 * @returns {string}
 */
function toStr(text) {
  return (text === null || text === undefined) ? "" : text.toString();
}

/**
 * Rellena texto a la derecha hasta el ancho especificado
 * @param {string} text - Texto a rellenar
 * @param {number} width - Ancho deseado
 * @returns {string}
 */
function padRight(text, width) {
  text = toStr(text);
  if (width <= 0) return "";
  if (text.length >= width) {
    return text.slice(0, width);
  }
  return text + " ".repeat(width - text.length);
}

/**
 * Rellena texto a la izquierda hasta el ancho especificado
 * @param {string} text - Texto a rellenar
 * @param {number} width - Ancho deseado
 * @returns {string}
 */
function padLeft(text, width) {
  text = toStr(text);
  if (width <= 0) return "";
  if (text.length >= width) {
    return text.slice(0, width);
  }
  return " ".repeat(width - text.length) + text;
}

/**
 * Centra texto en el ancho especificado
 * @param {string} text - Texto a centrar
 * @param {number} width - Ancho deseado (por defecto TICKET_WIDTH)
 * @returns {string}
 */
function center(text, width = TICKET_WIDTH) {
  text = toStr(text);
  if (width <= 0) return "";
  if (text.length >= width) {
    return text.slice(0, width);
  }
  const left = Math.floor((width - text.length) / 2);
  return " ".repeat(left) + text;
}

function buildTsplShippingLabel(shippingLabel, packageNumber = 1, totalPackages = 1) {
  const clean = (v) =>
    (v ?? "")
      .toString()
      .replace(/[\r\n]+/g, " ")
      .replace(/"/g, "'");

  const fullName = clean(shippingLabel.fullName).toUpperCase();
  const address = clean(shippingLabel.address);
  const locality = clean(shippingLabel.locality);
  const province = clean(shippingLabel.province);
  const phone = clean(shippingLabel.phone);
  const carrier = clean(shippingLabel.carrier);
  const itemsCount = clean(shippingLabel.itemsCount);
  const amount = clean(shippingLabel.amount);
  const paymentMethod = clean(shippingLabel.paymentMethod || '');
  const packagesText = totalPackages > 1 ? `${packageNumber} / ${totalPackages}` : "1";

  // Dividir nombre en dos líneas si es muy largo
  let nameLine1 = fullName;
  let nameLine2 = "";
  if (fullName.length > 28) {
    const cutPoint = fullName.lastIndexOf(" ", 28);
    if (cutPoint > 0) {
      nameLine1 = fullName.slice(0, cutPoint);
      nameLine2 = fullName.slice(cutPoint + 1);
    } else {
      nameLine1 = fullName.slice(0, 28);
      nameLine2 = fullName.slice(28);
    }
  }

  // Dividir dirección en dos líneas si es muy larga
  let addressLine1 = address;
  let addressLine2 = "";
  if (address.length > 22) {
    const cutPoint = address.lastIndexOf(" ", 22);
    if (cutPoint > 0) {
      addressLine1 = address.slice(0, cutPoint);
      addressLine2 = address.slice(cutPoint + 1);
    } else {
      addressLine1 = address.slice(0, 22);
      addressLine2 = address.slice(22);
    }
  }

  const lines = [
    'SIZE 98 mm, 80 mm',
    'GAP 3 mm, 0 mm',
    'DIRECTION 1',
    'REFERENCE 0,0',
    'CLS',
  ];

  let currentY = 30;
  lines.push(`TEXT 20,${currentY},"3",0,2.0,2.0,"${nameLine1}"`);

  if (nameLine2) {
    currentY += 40;
    lines.push(`TEXT 20,${currentY},"3",0,2.0,2.0,"${nameLine2}"`);
    currentY += 40;
  } else {
    currentY += 40;
  }

  currentY += 20;
  lines.push(`TEXT 20,${currentY},"3",0,2,2,"${addressLine1}"`);

  if (addressLine2) {
    currentY += 45;
    lines.push(`TEXT 20,${currentY},"3",0,2,2,"${addressLine2}"`);
    currentY += 45;
  } else {
    currentY += 45;
  }

  // Línea horizontal después de la dirección (usando guiones)
  currentY += 10; // Espacio pequeño antes de la línea
  const lineDashes = "-".repeat(50); // Crear línea con guiones (ajustar cantidad según necesidad)
  lines.push(`TEXT 20,${currentY},"1",0,1,1,"${lineDashes}"`);
  currentY += 15; // Espacio después de la línea

  currentY += 10; // Espacio adicional después de línea
  const cityProvText = `${locality} - ${province}`;
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"${cityProvText}"`);

  currentY += 50;
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Tel: ${phone}"`);

  // Línea horizontal después del teléfono (usando guiones)
  currentY += 40; // Espacio más grande antes de la línea para no atravesar el teléfono
  const lineDashes2 = "-".repeat(50); // Crear línea con guiones
  lines.push(`TEXT 20,${currentY},"1",0,1,1,"${lineDashes2}"`);
  currentY += 15; // Espacio después de la línea

  currentY += 75; // Espacio después de la línea (ajustado desde 100)
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Transporte: ${carrier}"`);

  currentY += 50;
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Productos: ${itemsCount}"`);

  currentY += 50;
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Total: $${amount}"`);

  currentY += 100;
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Paquetes: ${packagesText}"`);

  const remitenteX = 550;
  const remitenteY = 550;

  // Método de pago arriba de Rte. (sin etiqueta, solo el método, en mayúsculas y letra más grande)
  if (paymentMethod) {
    const paymentMethodUpper = paymentMethod.toUpperCase();

    // Si es "Contra Reembolso", dividir en dos líneas
    if (paymentMethodUpper.includes("CONTRA") && paymentMethodUpper.includes("REEMBOLSO")) {
      // Dividir "CONTRA REEMBOLSO" en dos líneas con más separación
      const contraY = remitenteY - 100; // Más arriba para no tapar Rte. y separar de REEMBOLSO
      const reembolsoY = remitenteY - 45; // Más separado de CONTRA
      lines.push(`TEXT ${remitenteX},${contraY},"2",0,2.2,2.2,"CONTRA"`);
      lines.push(`TEXT ${remitenteX},${reembolsoY},"2",0,2.2,2.2,"REEMBOLSO"`);
    } else {
      // Para otros métodos de pago, mostrar en una sola línea
      lines.push(`TEXT ${remitenteX},${remitenteY - 80},"3",0,2.0,2.0,"${paymentMethodUpper}"`);
    }
  }

  lines.push(`TEXT ${remitenteX},${remitenteY},"1",0,1,1,"Rte. FyL Moda"`);
  lines.push(`TEXT ${remitenteX},${remitenteY + 25},"1",0,1,1,"Av. Alberdi 1099"`);
  lines.push(`TEXT ${remitenteX},${remitenteY + 50},"1",0,1,1,"Resistencia - Chaco"`);

  lines.push('PRINT 1');

  return lines.join('\r\n') + '\r\n';
}

async function printTscShippingLabel(shippingLabel, copies = 1) {
  copies = parseInt(copies, 10);
  if (!copies || copies < 1) {
    console.warn("⚠️ Cantidad de copias inválida:", copies);
    return false;
  }

  try {
    await qzConnect();
    const cfg = await qzGetPrinterConfigTsc();

    const jobs = [];
    for (let i = 0; i < copies; i++) {
      const packageNumber = i + 1;
      const tspl = buildTsplShippingLabel(shippingLabel, packageNumber, copies);

      if (i === 0) {
        console.log("📄 TSPL generado (primeras líneas):");
        console.log(tspl.split('\r\n').slice(0, 10));
      }

      jobs.push({
        type: "raw",
        format: "command",
        data: tspl,
      });
    }

    console.log(`🖨️ Enviando ${copies} trabajo(s) de impresión a TSC...`);
    console.log("[QZ] print requested");
    await qz.print(cfg, jobs);
    console.log(`✅ ${copies} rótulo(s) enviado(s) a la impresora TSC`);
    return true;
  } catch (err) {
    console.error("❌ Error imprimiendo rótulo TSC:", err);
    alert("No se pudo imprimir el rótulo en la impresora TSC. Verifica que QZ Tray esté instalado y la impresora esté conectada.\n\nError: " + (err.message || 'Error desconocido'));
    return false;
  }
}

function prepareShippingLabelFromOrder(order, customer) {
  // Obtener transporte asignado
  const transportId = (customer.transport_id !== undefined ? customer.transport_id : null) ||
    (order.transport_id !== undefined ? order.transport_id : null);
  const transport = scheduledTransports.find(t => t.id === transportId);
  const carrier = transport ? transport.name : (customer.transport_id ? 'Sin transporte' : 'Sin transporte asignado');

  // Calcular cantidad total de productos
  const itemsCount = (order.order_items || []).reduce(
    (sum, item) => sum + (item.quantity || 0),
    0
  );

  // Obtener monto total
  const hasStoredTotal = order.total_amount != null && String(order.total_amount).trim() !== "";
  const total = hasStoredTotal
    ? parseARSNumber(order.total_amount)
    : (order.order_items || []).reduce(
      (sum, item) => sum + (item.quantity || 0) * getSentOrderUnitPrice(item),
      0
    );

  // Formatear monto sin símbolo de moneda para el rótulo
  const amount = total.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return {
    fullName: getOrderLabelDisplayName(order, customer),
    address: customer.address || "Sin dirección",
    locality: customer.city || "Sin localidad",
    province: customer.province || "Sin provincia",
    phone: customer.phone || "Sin teléfono",
    carrier: carrier,
    itemsCount: itemsCount.toString(),
    amount: amount,
    orderCode: order.order_number || order.id.substring(0, 8),
    paymentMethod: order.payment_method || ''
  };
}

// Función para guardar transporte del cliente
async function saveTransportForCustomer(customerId, transportId) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible");
    return false;
  }

  try {
    console.log(`💾 Guardando transporte para cliente ${customerId}: ${transportId || 'null'}`);
    
    // Usar función RPC rpc_update_customer_transport
    const { data, error } = await supabase.rpc('rpc_update_customer_transport', {
      p_customer_id: customerId,
      p_transport_id: transportId || null
    });
    
    if (error) {
      console.error("❌ Error guardando transporte:", error);
      alert("No se pudo guardar el transporte: " + (error.message || 'Error desconocido'));
      return false;
    }
    
    // Actualizar datos en memoria
    const customer = allCustomersData.find(c => c.id === customerId);
    if (customer) {
      customer.transport_id = transportId;
      console.log(`✅ Transporte actualizado en memoria para cliente ${customerId}`);
    }
    
    return true;
  } catch (error) {
    console.error("❌ Error en saveTransportForCustomer:", error);
    alert("Error al guardar el transporte: " + (error.message || 'Error desconocido'));
    return false;
  }
}

// Función para reprogramar fecha de envío de un pedido
async function rescheduleOrder(orderId, newDate) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible");
    return false;
  }

  try {
    // Convertir fecha a ISO timestamp (asumiendo que newDate es YYYY-MM-DD)
    // Mantener la hora actual o usar mediodía para evitar problemas de zona horaria
    const [year, month, day] = newDate.split('-').map(Number);
    const timestamp = new Date(year, month - 1, day, 12, 0, 0).toISOString();
    
    console.log(`📅 Reprogramando pedido ${orderId} para ${newDate} (${timestamp})`);
    
    const { error } = await supabase.rpc('rpc_reschedule_sent_order', {
      p_order_id: orderId,
      p_new_sent_at: timestamp
    });
    
    if (error) {
      console.error("❌ Error reprogramando pedido:", error);
      alert("No se pudo reprogramar la fecha de envío: " + (error.message || 'Error desconocido'));
      return false;
    }
    
    console.log(`✅ Pedido ${orderId} reprogramado para ${newDate}`);
    return true;
  } catch (error) {
    console.error("❌ Error en rescheduleOrder:", error);
    alert("Error al reprogramar el pedido: " + (error.message || 'Error desconocido'));
    return false;
  }
}

// Función para cargar almacenes
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
      console.log("✅ Almacenes cargados:", warehouses);
    }
  } catch (error) {
    console.error("❌ Error en loadWarehouses:", error);
  }
}

// ============================================================================
// Métodos de pago (para modal al reimprimir rótulo)
// ============================================================================

async function loadPaymentMethods() {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en loadPaymentMethods");
    return [];
  }
  try {
    const { data, error } = await supabase
      .from("payment_methods")
      .select("id, name")
      .order("name", { ascending: true });
    if (error) {
      console.error("❌ Error cargando métodos de pago:", error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error("❌ Error al cargar métodos de pago:", err);
    return [];
  }
}

async function createPaymentMethod(name) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) return null;
  if (!name || !name.trim()) return null;
  try {
    const { data, error } = await supabase
      .from("payment_methods")
      .insert({ name: name.trim() })
      .select()
      .single();
    if (error) {
      console.error("❌ Error creando método de pago:", error);
      return null;
    }
    return data;
  } catch (err) {
    console.error("❌ Error al crear método de pago:", err);
    return null;
  }
}

/**
 * Muestra modal web para elegir titular o sub-nombre del rótulo.
 * @returns {Promise<{buttonIndex: number, entry: object}|null>}
 */
function showLabelNameModalForPrint(order, customer) {
  return new Promise((resolve) => {
    const pool = buildCustomerLabelNamePoolDetailed(customer);
    if (pool.length <= 1) {
      resolve({ buttonIndex: 1, entry: pool[0] });
      return;
    }

    const modal = document.getElementById("label-name-modal");
    const optionsEl = document.getElementById("label-name-options");
    const subtitleEl = document.getElementById("label-name-modal-subtitle");
    const closeBtn = document.getElementById("close-label-name-modal");
    const cancelBtn = document.getElementById("cancel-label-name-btn");
    const confirmBtn = document.getElementById("confirm-label-name-btn");

    if (!modal || !optionsEl) {
      resolve({ buttonIndex: 1, entry: pool[0] });
      return;
    }

    let selectedIndex = getOrderActiveLabelButtonIndex(order, customer);

    const closeModal = (result = null) => {
      modal.style.display = "none";
      modal.classList.remove("active");
      modal.onclick = null;
      resolve(result);
    };

    const renderOptions = () => {
      optionsEl.innerHTML = pool
        .map((entry) => {
          const isActive = entry.button === selectedIndex;
          const tag = entry.isMain ? "Titular" : `Sub-nombre ${entry.button - 1}`;
          const dniLine = entry.dni ? `DNI: ${formatDniDisplay(entry.dni)}` : "";
          return `
            <button type="button" class="label-name-option${isActive ? " is-selected" : ""}" data-name-index="${entry.button}">
              <span class="label-name-option-num">${entry.button}</span>
              <span class="label-name-option-body">
                <strong>${escapeHtmlLabel(entry.full_name)}</strong>
                <span class="label-name-option-tag">${tag}</span>
                ${dniLine ? `<span class="label-name-option-dni">${escapeHtmlLabel(dniLine)}</span>` : ""}
              </span>
            </button>
          `;
        })
        .join("");

      optionsEl.querySelectorAll(".label-name-option").forEach((btn) => {
        btn.addEventListener("click", () => {
          selectedIndex = Number(btn.dataset.nameIndex);
          renderOptions();
        });
      });
    };

    closeBtn.onclick = () => closeModal(null);
    cancelBtn.onclick = () => closeModal(null);
    confirmBtn.onclick = () => {
      const entry = pool.find((item) => item.button === selectedIndex) || pool[0];
      closeModal({ buttonIndex: entry.button, entry });
    };
    modal.onclick = (e) => {
      if (e.target === modal) closeModal(null);
    };

    if (subtitleEl) {
      const orderCode = order.order_number || order.id.substring(0, 8);
      subtitleEl.textContent = `Pedido #${orderCode}`;
    }

    renderOptions();
    modal.style.display = "flex";
    modal.classList.add("active");
  });
}

function escapeHtmlLabel(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function setOrderLabelNameSelection(orderId, buttonIndex, customer) {
  const pool = buildCustomerLabelNamePoolDetailed(customer);
  const entry = pool.find((item) => item.button === buttonIndex);
  if (!entry) throw new Error("Nombre no disponible para este cliente.");

  if (!supabase) supabase = await getSupabase();
  if (!supabase) throw new Error("No se pudo conectar con la base de datos.");

  const { error } = await supabase
    .from("orders")
    .update({
      label_customer_name: entry.full_name,
      label_customer_dni: entry.dni || null,
    })
    .eq("id", orderId);

  if (error) throw error;

  for (const cust of allCustomersData) {
    const order = cust.orders.find((o) => o.id === orderId);
    if (order) {
      order.label_customer_name = entry.full_name;
      order.label_customer_dni = entry.dni || null;
      break;
    }
  }
}

function buildShippingLabelFromSelection(order, customer, entry) {
  const base = prepareShippingLabelFromOrder(order, customer);
  if (!entry) return base;
  return {
    ...base,
    fullName: entry.full_name,
  };
}

/**
 * Muestra el modal de método de pago y retorna una Promise con el método seleccionado
 * @param {string} currentPaymentMethod - Método actual del pedido (para preseleccionar)
 * @returns {Promise<string|null>} - Nombre del método seleccionado, o null si canceló
 */
function showPaymentMethodModalForLabel(currentPaymentMethod = "") {
  return new Promise((resolve) => {
    const modal = document.getElementById("payment-method-modal");
    const select = document.getElementById("payment-method-select");
    const createNewCheckbox = document.getElementById("create-new-payment-method");
    const newMethodContainer = document.getElementById("new-payment-method-container");
    const newMethodInput = document.getElementById("new-payment-method-input");
    const errorDiv = document.getElementById("payment-method-error");
    const closeBtn = document.getElementById("close-payment-modal");
    const cancelBtn = document.getElementById("cancel-payment-btn");
    const confirmBtn = document.getElementById("confirm-payment-btn");

    if (!modal || !select) {
      resolve(null);
      return;
    }

    const closeModal = (result = null) => {
      modal.style.display = "none";
      modal.classList.remove("active");
      resolve(result);
    };

    const handleConfirm = async () => {
      errorDiv.style.display = "none";
      errorDiv.textContent = "";
      let paymentMethod = null;

      if (createNewCheckbox.checked) {
        const newMethodName = newMethodInput.value.trim();
        if (!newMethodName) {
          errorDiv.textContent = "Por favor, ingrese un nombre para el nuevo método de pago.";
          errorDiv.style.display = "block";
          return;
        }
        const newMethod = await createPaymentMethod(newMethodName);
        if (!newMethod) {
          errorDiv.textContent = "No se pudo crear el nuevo método de pago. Intente nuevamente.";
          errorDiv.style.display = "block";
          return;
        }
        paymentMethod = newMethod.name;
      } else {
        paymentMethod = select.value;
        if (!paymentMethod) {
          errorDiv.textContent = "Por favor, seleccione un método de pago.";
          errorDiv.style.display = "block";
          return;
        }
      }
      closeModal(paymentMethod);
    };

    const handleCancel = () => closeModal(null);

    closeBtn.onclick = handleCancel;
    cancelBtn.onclick = handleCancel;
    confirmBtn.onclick = () => handleConfirm();

    modal.onclick = (e) => {
      if (e.target === modal) handleCancel();
    };

    createNewCheckbox.checked = false;
    newMethodContainer.style.display = "none";
    newMethodInput.value = "";
    errorDiv.style.display = "none";
    select.innerHTML = '<option value="">-- Seleccione un método --</option>';

    loadPaymentMethods().then((methods) => {
      methods.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.name;
        opt.textContent = m.name;
        if (m.name === (currentPaymentMethod || "").trim()) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
      if (!currentPaymentMethod && methods.length > 0) {
        select.selectedIndex = 0;
      }
    });

    modal.style.display = "flex";
    modal.classList.add("active");
  });
}

function setupPaymentMethodModalForLabel() {
  const createNewCheckbox = document.getElementById("create-new-payment-method");
  const newMethodContainer = document.getElementById("new-payment-method-container");
  const newMethodInput = document.getElementById("new-payment-method-input");
  const select = document.getElementById("payment-method-select");

  if (!createNewCheckbox) return;

  createNewCheckbox.addEventListener("change", (e) => {
    if (e.target.checked) {
      newMethodContainer.style.display = "block";
      if (select) select.disabled = true;
    } else {
      newMethodContainer.style.display = "none";
      if (select) select.disabled = false;
      if (newMethodInput) newMethodInput.value = "";
    }
  });
}

async function updateOrderPaymentMethod(orderId, paymentMethod) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase || !orderId || !paymentMethod) return false;
  try {
    const { error } = await supabase
      .from("orders")
      .update({
        payment_method: paymentMethod,
        updated_at: new Date().toISOString()
      })
      .eq("id", orderId);
    if (error) {
      console.error("❌ Error actualizando método de pago:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("❌ Error en updateOrderPaymentMethod:", err);
    return false;
  }
}

// Función para cargar transportes programados
async function loadScheduledTransports() {
  try {
    if (!supabase) {
      supabase = await getSupabase();
    }
    if (!supabase) {
      console.warn("⚠️ Supabase no disponible para cargar transportes");
      return;
    }

    const { data, error } = await supabase
      .from("transports")
      .select("id, name")
      .order("name", { ascending: true });

    if (error) {
      console.error("❌ Error cargando transportes:", error);
      scheduledTransports = [];
      return;
    }

    scheduledTransports = data || [];
    console.log("✅ Transportes cargados:", scheduledTransports.length);
  } catch (error) {
    console.error("❌ Error en loadScheduledTransports:", error);
    scheduledTransports = [];
  }
}

// Función para configurar botones de imprimir rótulos
function setupPrintLabelsButtons() {
  // Usar event delegation para manejar botones que se agregan dinámicamente
  document.addEventListener('click', async (e) => {
    if (e.target.hasAttribute('data-print-labels')) {
      e.preventDefault();
      e.stopPropagation();

      const orderId = e.target.getAttribute('data-print-labels');

      // Buscar el pedido en los datos cargados
      let order = null;
      let customer = null;

      for (const cust of allCustomersData) {
        const foundOrder = cust.orders.find(o => o.id === orderId);
        if (foundOrder) {
          order = foundOrder;
          // Usar customer_data si está disponible, sino usar el customer del loop
          customer = order.customer_data || cust;
          break;
        }
      }

      if (!order || !customer) {
        alert("No se pudo encontrar el pedido.");
        return;
      }

      let nameSelection;
      try {
        nameSelection = await showLabelNameModalForPrint(order, customer);
      } catch (error) {
        console.error("Error en selector de nombre:", error);
        alert("Error al elegir el nombre: " + (error.message || "Error desconocido"));
        return;
      }
      if (!nameSelection) return;

      try {
        await setOrderLabelNameSelection(order.id, nameSelection.buttonIndex, customer);
      } catch (error) {
        console.error("Error guardando nombre del rótulo:", error);
        alert("No se pudo guardar el nombre elegido: " + (error.message || "Error desconocido"));
        return;
      }

      const selectedLabelEntry = nameSelection.entry;
      const transportId = customer.transport_id || order.transport_id;
      const transport = transportId ? scheduledTransports.find(t => t.id === transportId) : null;
      
      // Preguntar si quiere reprogramar el envío (solo si hay transporte)
      let shouldReschedule = false;
      let shippingDate = null;
      
      if (transport) {
        // Si hay transporte, ofrecer la opción de reprogramar
        const wantsToReschedule = confirm(
          `🚚 Transporte asignado: ${transport.name}\n\n` +
          `¿Desea reprogramar la fecha de envío?\n\n` +
          `• SÍ: El pedido aparecerá en la lista de envíos de "Pedidos Cerrados" para la nueva fecha\n` +
          `• NO: Solo imprimirá los rótulos sin cambiar la fecha`
        );
        
        if (wantsToReschedule) {
          // Preguntar nueva fecha
          const today = new Date().toISOString().split('T')[0];
          shippingDate = prompt(
            `📅 Nueva fecha de envío para ${transport.name}\n\nFormato: YYYY-MM-DD (ejemplo: ${today})`,
            today
          );

          if (!shippingDate) {
            return; // Usuario canceló
          }

          // Validar formato de fecha
          const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
          if (!dateRegex.test(shippingDate)) {
            alert("❌ Formato de fecha inválido.\n\nDebe usar el formato YYYY-MM-DD (ejemplo: 2026-01-20)");
            return;
          }

          // Validar que la fecha no sea muy antigua
          const selectedDate = new Date(shippingDate);
          const oneYearAgo = new Date();
          oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
          
          if (selectedDate < oneYearAgo) {
            if (!confirm(`⚠️ La fecha seleccionada (${shippingDate}) es de hace más de un año.\n\n¿Está seguro de que desea continuar?`)) {
              return;
            }
          }
          
          shouldReschedule = true;
        }
      }

      // Preguntar método de pago (para confirmar o modificar)
      const currentPaymentMethod = order.payment_method || "";
      const selectedPaymentMethod = await showPaymentMethodModalForLabel(currentPaymentMethod);
      if (selectedPaymentMethod === null) {
        return; // Usuario canceló
      }

      // Actualizar pedido si el método de pago cambió
      if (selectedPaymentMethod !== (currentPaymentMethod || "").trim()) {
        const updated = await updateOrderPaymentMethod(order.id, selectedPaymentMethod);
        if (updated) {
          order.payment_method = selectedPaymentMethod;
          console.log(`✅ Método de pago actualizado en pedido: ${selectedPaymentMethod}`);
        } else {
          if (!confirm("⚠️ No se pudo actualizar el método de pago en el pedido.\n\n¿Desea continuar con la impresión usando el método seleccionado en el rótulo?")) {
            return;
          }
        }
      }

      // Preguntar cantidad de rótulos a imprimir
      const labelsCount = prompt("¿Cuántos rótulos deseas imprimir?", "1");
      if (!labelsCount || isNaN(labelsCount) || parseInt(labelsCount) < 1) {
        return;
      }

      try {
        // Reprogramar fecha si el usuario lo solicitó
        if (shouldReschedule && shippingDate) {
          console.log(`🔄 Reprogramando pedido ${order.order_number || order.id.substring(0, 8)} para ${shippingDate}...`);
          const rescheduleSuccess = await rescheduleOrder(order.id, shippingDate);
          
          if (!rescheduleSuccess) {
            console.error("❌ No se pudo reprogramar el pedido");
            if (!confirm("⚠️ No se pudo reprogramar la fecha.\n\n¿Desea continuar con la impresión de todas formas?")) {
              return;
            }
          }
        }

        // Preparar datos del rótulo con el nombre elegido (titular o sub-nombre)
        const shippingLabel = buildShippingLabelFromSelection(order, customer, selectedLabelEntry);

        // Validar datos mínimos
        if (!shippingLabel.fullName || shippingLabel.fullName === "Cliente sin nombre") {
          if (!confirm("⚠️ El cliente no tiene nombre completo. ¿Deseas continuar con la impresión?")) {
            return;
          }
        }

        // Imprimir rótulos
        const printSuccess = await printTscShippingLabel(shippingLabel, parseInt(labelsCount));

        if (printSuccess) {
          console.log("✅ Rótulos impresos correctamente");
          
          // Mensaje de confirmación
          let successMessage = `✅ Rótulos impresos exitosamente\n\n`;
          
          if (shouldReschedule && shippingDate && transport) {
            successMessage += `📅 Pedido reprogramado para: ${shippingDate}\n` +
                            `🚚 Transporte: ${transport.name}\n\n` +
                            `El pedido ahora aparecerá en la lista de envíos de "Pedidos Cerrados" para esta fecha y transporte.`;
          }
          
          alert(successMessage);
        }
      } catch (error) {
        console.error("❌ Error al imprimir rótulos:", error);
        alert("Error al imprimir los rótulos: " + (error.message || "Error desconocido"));
      }
    }
  });
}

// Función para eliminar un item del pedido
async function deleteOrderItem(itemId, orderId) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    alert("No se pudo conectar con la base de datos.");
    return;
  }

  try {
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      "rpc_remove_order_item_restore_stock",
      { p_order_item_id: itemId }
    );

    if (rpcError) {
      console.error("❌ Error eliminando item via RPC:", rpcError);
      alert(
        "No se pudo eliminar el producto de forma segura: "
          + (rpcError.message || "Error desconocido")
      );
      return;
    }

    const resolvedOrderId = rpcResult?.order_id || orderId;
    if (resolvedOrderId) {
      await supabase
        .from("orders")
        .update({
          sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", resolvedOrderId);
    }

    // Recargar la lista de pedidos enviados
    await loadSentOrders();

    // Si el modal del cliente está abierto, actualizarlo también
    const modal = document.getElementById("customer-modal");
    if (modal && modal.classList.contains("active")) {
      const modalCustomerName = document.getElementById("modal-customer-name");
      if (modalCustomerName) {
        const customerName = modalCustomerName.textContent;
        const customer = allCustomersData.find(c => formatCustomerDisplayName(c) === customerName);
        if (customer) {
          closeModal();
          setTimeout(() => {
            openCustomerModal(customer);
          }, 100);
        }
      }
    }

    console.log("✅ Producto eliminado correctamente vía RPC");
  } catch (error) {
    console.error("❌ Error eliminando producto:", error);
    alert("Error al eliminar el producto: " + (error.message || "Error desconocido"));
  }
}

// Variable para rastrear si ya se configuraron los listeners
let deleteItemButtonsSetup = false;

// Función para configurar botones de eliminar items
function setupDeleteItemButtons() {
  // Evitar múltiples registros
  if (deleteItemButtonsSetup) {
    return;
  }
  deleteItemButtonsSetup = true;

  // Usar event delegation para manejar botones que se agregan dinámicamente
  document.addEventListener('click', async (e) => {
    if (e.target.hasAttribute('data-delete-item') || e.target.closest('[data-delete-item]')) {
      e.preventDefault();
      e.stopPropagation();

      const deleteBtn = e.target.hasAttribute('data-delete-item')
        ? e.target
        : e.target.closest('[data-delete-item]');

      const itemId = deleteBtn.getAttribute('data-delete-item');
      const orderId = deleteBtn.getAttribute('data-order-id');

      if (!itemId || !orderId) {
        console.error("❌ No se pudo obtener itemId u orderId");
        return;
      }

      // Confirmar antes de eliminar
      const productName = deleteBtn.closest('.order-item-detail')?.querySelector('.order-item-detail-name')?.textContent?.trim() || 'este producto';
      if (!confirm(`¿Estás seguro de que deseas eliminar ${productName} de este pedido?\n\nEl stock se restaurará según la trazabilidad registrada del pedido.`)) {
        return;
      }

      // Deshabilitar el botón mientras se procesa
      deleteBtn.disabled = true;
      deleteBtn.textContent = "Eliminando...";

      try {
        await deleteOrderItem(itemId, orderId);
      } catch (error) {
        console.error("❌ Error en setupDeleteItemButtons:", error);
        alert("Error al eliminar el producto: " + (error.message || "Error desconocido"));
      } finally {
        // El botón se eliminará cuando se recargue la lista, así que no necesitamos restaurarlo
      }
    }
  });
}

// Función para marcar un pedido como devolución y devolver stock
// Usa la función RPC para garantizar atomicidad
async function markOrderAsDevolucion(orderId) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    alert("No se pudo conectar con la base de datos.");
    return;
  }

  try {
    // Verificar primero si el pedido ya está en devolución (verificación rápida en cliente)
    const { data: currentOrder, error: checkError } = await supabase
      .from("orders")
      .select("status, customer_id, order_number")
      .eq("id", orderId)
      .maybeSingle();

    if (checkError) {
      console.error("❌ Error verificando estado del pedido:", checkError);
      throw new Error("No se pudo verificar el estado del pedido");
    }

    if (!currentOrder) {
      throw new Error("No se encontró el pedido");
    }

    if (currentOrder.status === 'devolución') {
      console.log("⚠️ El pedido ya está en devolución, no se procesará nuevamente");
      alert("Este pedido ya está marcado como devolución.");
      return;
    }

    console.log(`🔄 Llamando a función RPC para marcar pedido ${orderId} como devolución...`);

    const operationId = generateOperationId();
    const { error: rpcError } = await supabase.rpc('rpc_mark_order_as_devolucion', {
      p_order_id: orderId,
      p_operation_id: operationId,
      p_request: { source: 'admin/sent-orders.js', action: 'mark_devolucion' },
    });

    if (rpcError) {
      console.error("❌ Error en función RPC rpc_mark_order_as_devolucion:", rpcError);

      if (rpcError.code === '42883' || rpcError.message?.includes('does not exist')) {
        alert("⚠️ La función de devolución no está disponible. Por favor, ejecuta el script SQL '20_mark_order_as_devolucion.sql' en la base de datos.");
        console.error("❌ La función RPC rpc_mark_order_as_devolucion no existe. Ejecuta el script SQL correspondiente.");
        return;
      }

      alert("Error al procesar la devolución: " + (rpcError.message || "Error desconocido"));
      return;
    }

    console.log(`✅ Devolución procesada correctamente para pedido ${orderId} (op: ${operationId})`);

    if (currentOrder?.customer_id) {
      await emitCustomerNotification({
        customerId: currentOrder.customer_id,
        orderId,
        type: CUSTOMER_NOTIFICATION_ORDER_DEVOLUCION,
        message:
          "Tu pedido fue marcado como devolución. Si necesitás ayuda para generar uno nuevo, escribinos por WhatsApp.",
        payload: {
          action_url: "/client/dashboard.html?view=history",
          order_number: currentOrder.order_number || null,
        },
      });
    }

    // Recargar la lista de pedidos enviados
    await loadSentOrders();

    // Si el modal del cliente está abierto, actualizarlo también
    const modal = document.getElementById("customer-modal");
    if (modal && modal.classList.contains("active")) {
      const modalCustomerName = document.getElementById("modal-customer-name");
      if (modalCustomerName) {
        const customerName = modalCustomerName.textContent;
        const customer = allCustomersData.find(c => formatCustomerDisplayName(c) === customerName);
        if (customer) {
          closeModal();
          setTimeout(() => {
            openCustomerModal(customer);
          }, 100);
        }
      }
    }

    alert("✅ Pedido marcado como devolución. Todos los productos han vuelto al stock general.");
  } catch (error) {
    console.error("❌ Error marcando pedido como devolución:", error);
    alert("Error al procesar la devolución: " + (error.message || "Error desconocido"));
  }
}

// Variable para rastrear si ya se configuraron los listeners de devolución
let devolucionButtonsSetup = false;

// Función para configurar botones de devolución
function setupDevolucionButtons() {
  // Evitar múltiples registros
  if (devolucionButtonsSetup) {
    return;
  }
  devolucionButtonsSetup = true;

  // Usar event delegation para manejar botones que se agregan dinámicamente
  document.addEventListener('click', async (e) => {
    if (e.target.hasAttribute('data-devolucion-order') || e.target.closest('[data-devolucion-order]')) {
      e.preventDefault();
      e.stopPropagation();

      const devolucionBtn = e.target.hasAttribute('data-devolucion-order')
        ? e.target
        : e.target.closest('[data-devolucion-order]');

      const orderId = devolucionBtn.getAttribute('data-devolucion-order');

      if (!orderId) {
        console.error("❌ No se pudo obtener orderId");
        return;
      }

      // Verificar si este pedido ya está siendo procesado
      if (processingDevolucion.has(orderId)) {
        console.log("⚠️ Este pedido ya está siendo procesado");
        return;
      }

      // Verificar si el botón ya está procesando (evitar múltiples clics)
      if (devolucionBtn.disabled || devolucionBtn.textContent === "Procesando...") {
        return;
      }

      // Verificar si el pedido ya está en devolución desde los datos cargados
      const orderCard = devolucionBtn.closest('.order-date-item');
      if (orderCard && orderCard.classList.contains('devolucion')) {
        alert("Este pedido ya está marcado como devolución.");
        return;
      }

      // Verificar también desde los datos en memoria
      let orderFound = null;
      for (const customer of allCustomersData) {
        const found = customer.orders.find(o => o.id === orderId);
        if (found) {
          orderFound = found;
          break;
        }
      }

      if (orderFound && orderFound.status === 'devolución') {
        alert("Este pedido ya está marcado como devolución.");
        return;
      }

      // Confirmar antes de marcar como devolución
      if (!confirm("¿Estás seguro de que deseas marcar este pedido como devolución?\n\nTodos los productos volverán al stock general y el pedido se marcará en rojo.")) {
        return;
      }

      // Marcar este pedido como en proceso
      processingDevolucion.add(orderId);

      // Deshabilitar el botón mientras se procesa
      devolucionBtn.disabled = true;
      devolucionBtn.textContent = "Procesando...";
      devolucionBtn.style.pointerEvents = 'none';
      devolucionBtn.style.opacity = '0.6';

      try {
        await markOrderAsDevolucion(orderId);
        // No restaurar el botón aquí - la recarga de la lista lo manejará
        // El pedido ahora estará en devolución y el botón no debería aparecer o estar deshabilitado
      } catch (error) {
        console.error("❌ Error en setupDevolucionButtons:", error);
        alert("Error al procesar la devolución: " + (error.message || "Error desconocido"));
        // Restaurar el botón solo si hubo un error (el estado no se actualizó)
        devolucionBtn.disabled = false;
        devolucionBtn.textContent = "Devolución";
        devolucionBtn.style.pointerEvents = 'auto';
        devolucionBtn.style.opacity = '1';
      } finally {
        // Remover el flag de procesamiento
        processingDevolucion.delete(orderId);
      }
    }
  });
}

// ============================================================================
// Funciones de impresión de ticket para pedidos enviados
// ============================================================================

/**
 * Construye el ticket en formato ESC/POS a partir de los datos del pedido
 * @param {Object} order - Objeto del pedido completo
 * @returns {Promise<string>} Ticket formateado en texto plano
 */
async function buildEscposTicketOrder(order) {
  const items = order.order_items || [];
  
  // Obtener cliente desde allCustomersData
  let customer = null;
  for (const customerData of allCustomersData) {
    const foundOrder = customerData.orders.find(o => o.id === order.id);
    if (foundOrder) {
      customer = customerData;
      break;
    }
  }

  // Parsear valores extra desde order.notes
  let shippingAmount = parseFloat(order.shipping_amount || 0);
  let discountAmount = parseFloat(order.discount_amount || 0);
  let extrasAmount = parseFloat(order.extras_amount || 0);
  let extrasPercentage = parseFloat(order.extras_percentage || 0);

  if (order.notes) {
    try {
      const extraValues = JSON.parse(order.notes);
      shippingAmount = parseFloat(extraValues.shipping) || shippingAmount;
      discountAmount = parseFloat(extraValues.discount) || discountAmount;
      extrasAmount = parseFloat(extraValues.extras_amount) || extrasAmount;
      extrasPercentage = parseFloat(extraValues.extras_percentage) || extrasPercentage;
    } catch (e) {
      console.warn('Error parseando valores extra del pedido:', e);
    }
  }

  // Formatear fecha y hora
  const orderDate = new Date(order.created_at || order.sent_at || order.updated_at);
  const dateStr = orderDate.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  const timeStr = orderDate.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires',
  });

  let ticket = [];

  // Encabezado centrado (sin líneas vacías al inicio)
  ticket.push(center("FYL moda"));
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push("");

  // Datos del pedido
  ticket.push(`Pedido: ${order.order_number || order.id}`);
  ticket.push(`Fecha: ${dateStr}`);
  ticket.push(`Hora: ${timeStr}`);
  if (customer) {
    // Obtener nombre del cliente
    let customerName = customer.full_name || customer.name || '';
    if (!customerName) {
      customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    }
    customerName = customerName.trim();
    
    if (customerName) {
      const maxNameLength = TICKET_WIDTH - 9; // "Cliente: " = 9 caracteres
      ticket.push(`Cliente: ${customerName.substring(0, maxNameLength)}`);
    }
  }
  ticket.push("");
  ticket.push("-".repeat(TICKET_WIDTH));

  // Sección DETALLE DEL PEDIDO (centrada)
  ticket.push(center("DETALLE DEL PEDIDO"));
  ticket.push("-".repeat(TICKET_WIDTH));

  // Cabecera de columnas con anchos: Producto 22, Cant 4, Precio 8, Total 8
  const colProducto = 22;
  const colCant = 4;
  const colPrecio = 8;
  const colTotal = 8;

  const header = padRight("Producto", colProducto) +
    padLeft("Cant", colCant) +
    padLeft("Precio", colPrecio) +
    padLeft("Total", colTotal);
  ticket.push(header);
  ticket.push("-".repeat(TICKET_WIDTH));

  // Items del pedido (solo los que no están faltantes)
  const validItems = items.filter(item => item.status !== 'missing');
  validItems.forEach(item => {
    const price = getSentOrderUnitPrice(item);
    const qty = parseInt(item.quantity || 0);
    const total = price * qty;

    // Nombre del producto (truncar a 22 caracteres)
    let productName = `${item.product_name || 'N/A'}`;
    if (item.color) productName += ` - ${item.color}`;
    if (item.size) productName += ` (${item.size})`;

    // Truncar a 22 caracteres
    const name = productName.slice(0, colProducto);

    // Formatear valores
    const qtyStr = padLeft(String(qty), colCant);
    const priceStr = `$${price.toLocaleString('es-AR')}`;
    const totalStr = `$${total.toLocaleString('es-AR')}`;
    const priceFormatted = padLeft(priceStr, colPrecio);
    const totalFormatted = padLeft(totalStr, colTotal);

    // Línea del item con columnas alineadas
    ticket.push(
      padRight(name, colProducto) +
      qtyStr +
      priceFormatted +
      totalFormatted
    );
  });

  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push("");

  // Subtotal productos
  const productsSubtotal = validItems.reduce((sum, item) => {
    const price = getSentOrderUnitPrice(item);
    const qty = parseInt(item.quantity || 0);
    return sum + (price * qty);
  }, 0);

  // Envío (si existe)
  if (shippingAmount > 0) {
    ticket.push(`Envio: ${padLeft(`$${shippingAmount.toLocaleString('es-AR')}`, TICKET_WIDTH - 7)}`);
    ticket.push("");
  }

  // Descuento (si existe)
  if (discountAmount > 0) {
    ticket.push(`Descuento: ${padLeft(`-$${discountAmount.toLocaleString('es-AR')}`, TICKET_WIDTH - 11)}`);
    ticket.push("");
  }

  // Extras (si existen)
  if (extrasAmount > 0) {
    ticket.push(`Extras: ${padLeft(`$${extrasAmount.toLocaleString('es-AR')}`, TICKET_WIDTH - 8)}`);
    ticket.push("");
  }

  // Extras porcentuales (si existen)
  if (extrasPercentage > 0) {
    const extrasPercentAmount = productsSubtotal * extrasPercentage / 100;
    ticket.push(`Extras (${extrasPercentage}%): ${padLeft(`$${extrasPercentAmount.toLocaleString('es-AR')}`, TICKET_WIDTH - 18)}`);
    ticket.push("");
  }

  // TOTAL alineado a la derecha
  const totalAmount = parseARSNumber(order.total_amount || 0);
  const totalStr = `$${totalAmount.toLocaleString('es-AR')}`;
  ticket.push(padLeft(`TOTAL: ${totalStr}`, TICKET_WIDTH));
  ticket.push("");

  // Footer: DOCUMENTO NO VALIDO / COMO FACTURA
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push(center("DOCUMENTO NO VALIDO"));
  ticket.push(center("COMO FACTURA"));
  ticket.push("");

  // Texto previo al QR (si existe cliente con QR)
  if (customer?.qr_code) {
    ticket.push(center("Escanea para ver tu"));
    ticket.push(center("historial y creditos:"));
  }

  return ticket.join("\n");
}

/**
 * Imprime el ticket del pedido usando QZ Tray
 * @param {Object} order - Objeto del pedido completo
 * @returns {Promise<void>}
 */
async function printOrderTicketWithQZ(order) {
  // Verificar si QZ está disponible antes de intentar
  if (typeof qz === 'undefined' || !qz) {
    throw new Error("QZ Tray no está disponible");
  }

  try {
    // Conectar a QZ
    await qzConnect();

    // Obtener configuración de impresora POS-80 específicamente para tickets
    const config = await qzGetPrinterConfigPos80();

    // Construir ticket de texto
    const ticketText = await buildEscposTicketOrder(order);

    // Preparar datos para QZ
    const data = [];

    // Reset impresora y ticket de texto (sin espacios adicionales)
    data.push("\x1B\x40" + ticketText);

    // QR Code como imagen (si existe cliente con QR)
    let customer = null;
    for (const customerData of allCustomersData) {
      const foundOrder = customerData.orders.find(o => o.id === order.id);
      if (foundOrder) {
        customer = customerData;
        break;
      }
    }

    if (customer && customer.qr_code) {
      const url = `${window.location.origin}/customer.html?code=${customer.qr_code}`;
      const size = 180;
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=10&data=${encodeURIComponent(url)}`;

      // Alineación centrada antes del QR
      data.push("\x1B\x61\x01");  // ESC a 1

      data.push({
        type: "raw",
        format: "image",
        flavor: "file",
        data: qrApiUrl,
        options: {
          language: "ESCPOS"
        }
      });

      // Alimentar un poco después del QR
      data.push("\x1B\x64\x03");  // ESC d 3 -> 3 líneas

      // Volver a alineación izquierda
      data.push("\x1B\x61\x00");  // ESC a 0
    }

    // Corte total
    data.push("\x1D\x56\x42\x00");   // GS V 66 0

    console.log("[QZ] print requested");
    await qz.print(config, data);
    console.log("✅ Ticket del pedido enviado a impresora");

  } catch (error) {
    console.error("❌ Error imprimiendo con QZ Tray:", error);
    throw error;
  }
}

/**
 * Imprime el ticket del pedido directamente usando QZ Tray
 * @param {Object} order - Objeto del pedido completo
 * @returns {Promise<void>}
 */
async function printOrderTicketDirectly(order) {
  // Verificar que QZ Tray esté disponible
  if (typeof qz === 'undefined' || !qz || !qz.websocket) {
    alert("⚠️ QZ Tray no está disponible. Por favor, instala QZ Tray para imprimir tickets.");
    return;
  }

  try {
    await printOrderTicketWithQZ(order);
  } catch (error) {
    console.error("❌ Error al imprimir ticket:", error);
    throw error;
  }
}

// Función para configurar botones de imprimir ticket
function setupPrintTicketButtons() {
  // Usar event delegation para manejar botones que se agregan dinámicamente
  document.addEventListener('click', async (e) => {
    if (e.target.hasAttribute('data-print-ticket')) {
      e.preventDefault();
      e.stopPropagation();

      const orderId = e.target.getAttribute('data-print-ticket');

      // Buscar el pedido en los datos cargados
      let order = null;
      for (const customer of allCustomersData) {
        const foundOrder = customer.orders.find(o => o.id === orderId);
        if (foundOrder) {
          order = foundOrder;
          break;
        }
      }

      if (!order) {
        alert("Pedido no encontrado.");
        return;
      }

      // Deshabilitar el botón mientras se imprime
      e.target.disabled = true;
      const originalText = e.target.textContent;
      e.target.textContent = 'Imprimiendo...';

      try {
        await printOrderTicketDirectly(order);
        // No mostrar alert, solo actualizar el botón
      } catch (error) {
        console.error("❌ Error al imprimir ticket:", error);
        
        // Mensaje de error mejorado para "Connection blocked"
        let errorMessage = "Error al imprimir el ticket: " + (error.message || "Error desconocido");
        
        if (error.message && error.message.includes("Connection blocked")) {
          errorMessage = "No se pudo conectar con QZ Tray.\n\n" +
            "El sitio web está bloqueado por QZ Tray.\n\n" +
            "Para solucionarlo:\n" +
            "1. Abrí QZ Tray (buscalo en la bandeja del sistema)\n" +
            "2. Click derecho en el ícono de QZ Tray\n" +
            "3. Seleccioná 'Site Manager' o 'Administrador de Sitios'\n" +
            "4. Agregá esta URL a la lista de sitios permitidos:\n" +
            `   ${window.location.origin}\n\n` +
            "5. Guardá los cambios y volvé a intentar";
        }
        
        alert(errorMessage);
      } finally {
        // Rehabilitar el botón
        e.target.disabled = false;
        e.target.textContent = originalText;
      }
    }
  });
}

// Inicializar cuando esté listo
initWhenReady();

