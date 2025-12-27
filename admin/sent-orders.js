// Importar dinámicamente para asegurar que se cargue después
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
    const module = await import("../scripts/supabase-client.js");
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
let scheduledTransports = [];
let warehouses = { general: null, ventaPublico: null };
let processingDevolucion = new Set(); // Rastrear pedidos en proceso de devolución

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
    await loadWarehouses();
    await loadScheduledTransports();
    await loadSentOrders();
    setupPrintLabelsButtons();
    setupDeleteItemButtons();
    setupDevolucionButtons();
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

async function loadSentOrders() {
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

  try {
    // Obtener todos los pedidos enviados con sus items
    const { data: orders, error: ordersError } = await supabase
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
        order_items (
          id,
          product_name,
          color,
          size,
          quantity,
          price_snapshot,
          imagen,
          status,
          variant_id
        )
        `
      )
      .in("status", ["sent", "devolución"])
      .order("sent_at", { ascending: false });

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

    if (!orders || orders.length === 0) {
      customersContent.innerHTML = `
        <div class="empty-state">
          <h2>No hay pedidos enviados</h2>
          <p>Cuando marques pedidos como terminados, aparecerán aquí.</p>
        </div>
      `;
      return;
    }

    // Obtener customer_ids únicos
    const customerIds = [...new Set(orders.map(order => order.customer_id).filter(Boolean))];
    
    // Obtener información de customers (incluyendo transport_id)
    const { data: customersData, error: customersError } = await supabase
      .from("customers")
      .select("id, customer_number, full_name, phone, city, province, dni, email, address, transport_id")
      .in("id", customerIds);

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

function renderCustomers(customers) {
  const customersContent = document.getElementById("customers-content");
  if (!customersContent) return;

  // Filtrar por término de búsqueda
  const filteredCustomers = searchTerm
    ? customers.filter(customer => {
        const searchLower = searchTerm.toLowerCase();
        const name = (customer.full_name || "").toLowerCase();
        const parts = name.split(/\s+/);
        let combined = name;
        if (parts.length > 1) {
          const last = parts[parts.length-1];
          const first = parts.slice(0,-1).join(' ');
          combined = `${last}, ${first}`.toLowerCase();
        }
        const customerNumber = (customer.customer_number || "").toLowerCase();
        return name.includes(searchLower) || combined.includes(searchLower) || customerNumber.includes(searchLower);
      })
    : customers;

  if (filteredCustomers.length === 0) {
    customersContent.innerHTML = `
      <div class="empty-state">
        <h2>No se encontraron clientes</h2>
        <p>${searchTerm ? "Intenta con otro término de búsqueda." : "No hay pedidos enviados."}</p>
      </div>
    `;
    return;
  }

  const customersHtml = filteredCustomers
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
  if (!searchInput) return;

  searchInput.addEventListener("input", (e) => {
    searchTerm = e.target.value.trim();
    renderCustomers(allCustomersData);
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
  modalCustomerInfo.innerHTML = `
    <p><strong>Número de Cliente:</strong> #${customer.customer_number || "N/A"}</p>
    <p><strong>Email:</strong> ${customer.email || "Sin email"}</p>
    <p><strong>Teléfono:</strong> ${customer.phone || "Sin teléfono"}</p>
    <p><strong>DNI:</strong> ${customer.dni || "Sin DNI"}</p>
    <p><strong>Ubicación:</strong> ${location}</p>
  `;

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
          const price = Number(item.price_snapshot || 0);
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
        const total = order.total_amount ? Number(order.total_amount) : (subtotal + extrasTotal);
        
        // Generar HTML de items del pedido
        const itemsHtml = orderItems.length > 0
          ? orderItems.map(item => {
              const itemImage = item.imagen || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23f2f2f2'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23999' font-size='12'%3ESin imagen%3C/text%3E%3C/svg%3E";
              const itemQuantity = Number(item.quantity || 0);
              const itemPrice = Number(item.price_snapshot || 0);
              const itemSubtotal = itemQuantity * itemPrice;
              const isMissing = item.status === 'missing';
              const itemClass = isMissing ? 'order-item-detail missing' : 'order-item-detail';
              
              return `
                <div class="${itemClass}">
                  <img src="${itemImage}" alt="${item.product_name || 'Producto'}" class="order-item-detail-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'64\\' height=\\'64\\' viewBox=\\'0 0 64 64\\'%3E%3Crect width=\\'64\\' height=\\'64\\' fill=\\'%23f2f2f2\\'/%3E%3Ctext x=\\'50%25\\' y=\\'50%25\\' text-anchor=\\'middle\\' dy=\\'.3em\\' fill=\\'%23999\\' font-size=\\'12\\'%3ESin imagen%3C/text%3E%3C/svg%3E'">
                  <div class="order-item-detail-info">
                    <div class="order-item-detail-name">${item.product_name || "Producto sin nombre"} ${isMissing ? '<span style="color: #dc3545; font-size: 12px;">(Faltante)</span>' : ''}</div>
                    <div class="order-item-detail-meta">Color: ${item.color || "-"} • Talle: ${item.size || "-"}</div>
                    <div class="order-item-detail-quantity">Cantidad: ${itemQuantity}</div>
                  </div>
                  <div style="display: flex; align-items: center; gap: 8px;">
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
                  <span class="order-date">${formattedDate} <span class="order-expand-icon">▼</span></span>
                  <span class="order-number">#${orderNumber}</span>
                </div>
                <div class="order-total">Total: $${total.toLocaleString("es-AR")}</div>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                  <button class="modify-order-btn" data-modify-order="${order.id}">✏️ Modificar</button>
                  <button class="btn btn-warning" data-print-labels="${order.id}" style="background: #ffc107; color: #000; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: background 0.2s;">Imprimir rótulos</button>
                </div>
              </div>
              <div class="order-card-right">
                <button class="devolucion-btn" data-devolucion-order="${order.id}" ${isDevolucion ? 'style="opacity: 0.5; cursor: not-allowed;"' : ''}>Devolución</button>
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
window.loadSentOrders = async function() {
  console.log("🔄 Recargando pedidos enviados...");
  await loadSentOrders();
  
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

// ============================================================================
// QZ Tray - Funciones helper para TSC
// ============================================================================

async function qzConnect() {
  if (typeof qz === 'undefined' || !qz || !qz.websocket) {
    throw new Error("QZ Tray no está disponible");
  }
  
  if (!qz.websocket.isActive()) {
    try {
      await qz.websocket.connect();
      console.log("✅ QZ Tray conectado");
    } catch (error) {
      throw error;
    }
  }
}

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

function buildTsplShippingLabel(shippingLabel, packageNumber = 1, totalPackages = 1) {
  const clean = (v) =>
    (v ?? "")
      .toString()
      .replace(/[\r\n]+/g, " ")
      .replace(/"/g, "'");

  const fullName   = clean(shippingLabel.fullName).toUpperCase();
  const address    = clean(shippingLabel.address);
  const locality   = clean(shippingLabel.locality);
  const province   = clean(shippingLabel.province);
  const phone      = clean(shippingLabel.phone);
  const carrier    = clean(shippingLabel.carrier);
  const itemsCount = clean(shippingLabel.itemsCount);
  const amount     = clean(shippingLabel.amount);
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
  const total = typeof order.total_amount === "number"
    ? order.total_amount
    : (order.order_items || []).reduce(
        (sum, item) => sum + (item.quantity || 0) * ((item.price_snapshot || 0)),
        0
      );

  // Formatear monto sin símbolo de moneda para el rótulo
  const amount = total.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return {
    fullName: customer.full_name || "Cliente sin nombre",
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

      // Pedir cantidad de rótulos a imprimir
      const labelsCount = prompt("¿Cuántos rótulos deseas imprimir?", "1");
      if (!labelsCount || isNaN(labelsCount) || parseInt(labelsCount) < 1) {
        return;
      }

      try {
        // Preparar datos del rótulo
        const shippingLabel = prepareShippingLabelFromOrder(order, customer);

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
    // Obtener el item completo de la base de datos
    const { data: item, error: itemError } = await supabase
      .from("order_items")
      .select("id, order_id, status, quantity, price_snapshot, variant_id")
      .eq("id", itemId)
      .maybeSingle();

    if (itemError || !item) {
      alert("No se encontró el producto.");
      return;
    }

    const qty = Number(item.quantity || 0) || 0;
    const price = Number(item.price_snapshot || 0) || 0;
    const itemTotal = qty * price;

    // Devolver stock al stock general si el item tiene variant_id
    if (item.variant_id) {
      console.log(`🔄 Intentando devolver stock para variant_id: ${item.variant_id}, cantidad: ${qty}`);
      
      // Asegurar que los almacenes estén cargados
      if (!warehouses.general) {
        await loadWarehouses();
      }
      
      if (!warehouses.general) {
        console.error("❌ No se pudo cargar el almacén 'general'");
        alert("Error: No se pudo encontrar el almacén 'general'. El producto fue eliminado pero el stock no se actualizó.");
      } else {
        try {
          console.log(`✅ Usando almacén 'general': ${warehouses.general}`);
          
          // Obtener el stock actual del almacén general para esta variante
          const { data: stockRow, error: stockError } = await supabase
            .from("variant_warehouse_stock")
            .select("stock_qty")
            .eq("variant_id", item.variant_id)
            .eq("warehouse_id", warehouses.general)
            .maybeSingle();

          // Si no existe el registro, currentStock será 0
          const currentStock = stockError && stockError.code === 'PGRST116' 
            ? 0 
            : Number(stockRow?.stock_qty || 0);
          
          const newStock = currentStock + qty;
          
          console.log(`📦 Stock actual: ${currentStock}, Cantidad a devolver: ${qty}, Nuevo stock: ${newStock}`);

          // Actualizar o insertar el stock en variant_warehouse_stock
          const { data: upsertData, error: updateError } = await supabase
            .from("variant_warehouse_stock")
            .upsert({
              variant_id: item.variant_id,
              warehouse_id: warehouses.general,
              stock_qty: newStock
            }, {
              onConflict: 'variant_id,warehouse_id'
            })
            .select();

          if (updateError) {
            console.error("❌ Error actualizando stock en variant_warehouse_stock:", updateError);
            console.error("❌ Detalles completos:", JSON.stringify(updateError, null, 2));
            console.error("❌ Datos del upsert:", {
              variant_id: item.variant_id,
              warehouse_id: warehouses.general,
              stock_qty: newStock
            });
            alert(`Error al devolver el stock: ${updateError.message || 'Error desconocido'}. El producto fue eliminado pero el stock no se actualizó. Por favor, verifica manualmente el stock del producto.`);
          } else {
            console.log(`✅ Stock devuelto exitosamente: ${qty} unidades agregadas al almacén 'general' para la variante ${item.variant_id}`);
            console.log(`   Stock anterior: ${currentStock}, Nuevo stock: ${newStock}`);
            console.log(`   Resultado del upsert:`, upsertData);
            
            // Verificar que el stock se actualizó correctamente
            const { data: verifyStock, error: verifyError } = await supabase
              .from("variant_warehouse_stock")
              .select("stock_qty")
              .eq("variant_id", item.variant_id)
              .eq("warehouse_id", warehouses.general)
              .maybeSingle();
            
            if (!verifyError && verifyStock) {
              const verifiedStock = Number(verifyStock.stock_qty || 0);
              console.log(`✅ Verificación: Stock actual en BD: ${verifiedStock}`);
              if (verifiedStock !== newStock) {
                console.warn(`⚠️ Discrepancia: Stock esperado ${newStock} pero BD tiene ${verifiedStock}`);
              }
            } else {
              console.warn(`⚠️ No se pudo verificar el stock después del upsert:`, verifyError);
            }
          }
        } catch (e) {
          console.error("❌ Error devolviendo stock:", e);
          console.error("❌ Stack trace:", e.stack);
          alert("Advertencia: El producto se eliminó pero no se pudo devolver el stock. Por favor, verifica manualmente el stock del producto.");
        }
      }
    } else {
      console.warn("⚠️ El item no tiene variant_id, no se puede devolver el stock");
    }

    // Eliminar el item
    const { error: delErr } = await supabase
      .from("order_items")
      .delete()
      .eq("id", itemId);

    if (delErr) {
      alert("No se pudo eliminar el producto: " + (delErr.message || "Error desconocido"));
      return;
    }

    // Actualizar total del pedido
    if (item.order_id && itemTotal > 0) {
      const { data: orderRow, error: orderError } = await supabase
        .from("orders")
        .select("total_amount")
        .eq("id", item.order_id)
        .maybeSingle();

      if (!orderError && orderRow) {
        const newTotal = Math.max(0, Number(orderRow.total_amount || 0) - itemTotal);
        await supabase
          .from("orders")
          .update({ 
            total_amount: newTotal, 
            sent_at: new Date().toISOString(), // Actualizar sent_at cuando se modifica
            updated_at: new Date().toISOString() 
          })
          .eq("id", item.order_id);
        console.log(`✅ Total del pedido actualizado: $${newTotal}`);
      }
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

    console.log("✅ Producto eliminado correctamente");
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
      if (!confirm(`¿Estás seguro de que deseas eliminar ${productName} de este pedido?\n\nEl stock volverá al stock general.`)) {
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
      .select("status")
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

    // Llamar a la función RPC que maneja todo de manera atómica
    const { error: rpcError } = await supabase.rpc('rpc_mark_order_as_devolucion', {
      p_order_id: orderId
    });

    if (rpcError) {
      console.error("❌ Error en función RPC rpc_mark_order_as_devolucion:", rpcError);
      
      // Si la función RPC no existe, mostrar mensaje instructivo
      if (rpcError.code === '42883' || rpcError.message?.includes('does not exist')) {
        alert("⚠️ La función de devolución no está disponible. Por favor, ejecuta el script SQL '20_mark_order_as_devolucion.sql' en la base de datos.");
        console.error("❌ La función RPC rpc_mark_order_as_devolucion no existe. Ejecuta el script SQL correspondiente.");
        return;
      }
      
      alert("Error al procesar la devolución: " + (rpcError.message || "Error desconocido"));
      return;
    }

    console.log(`✅ Función RPC ejecutada correctamente para pedido ${orderId}`);

    // Verificar que el estado se actualizó correctamente inmediatamente
    const { data: verifyOrder, error: verifyError } = await supabase
      .from("orders")
      .select("status")
      .eq("id", orderId)
      .maybeSingle();

    if (verifyError) {
      console.error("❌ Error verificando estado después de RPC:", verifyError);
    } else if (verifyOrder && verifyOrder.status !== 'devolución') {
      console.error(`❌ ADVERTENCIA: Después de RPC, el estado es ${verifyOrder.status}, no 'devolución'`);
      alert(`⚠️ Advertencia: El proceso se completó pero el estado final es "${verifyOrder.status}" en lugar de "devolución". Por favor, verifica manualmente.`);
    } else {
      console.log(`✅ Estado verificado correctamente: ${verifyOrder?.status}`);
    }

    // Esperar un momento y verificar nuevamente para detectar cambios posteriores
    await new Promise(resolve => setTimeout(resolve, 1000));

    const { data: finalCheck, error: finalCheckError } = await supabase
      .from("orders")
      .select("status")
      .eq("id", orderId)
      .maybeSingle();

    if (finalCheckError) {
      console.error("❌ Error en verificación final después de delay:", finalCheckError);
    } else if (finalCheck && finalCheck.status !== 'devolución') {
      console.error(`❌ ADVERTENCIA CRÍTICA: Después de delay, el estado cambió a ${finalCheck.status}`);
      
      // Intentar restaurar el estado a devolución
      console.log(`🔄 Intentando restaurar estado a 'devolución'...`);
      const { error: restoreError } = await supabase
        .from("orders")
        .update({ 
          status: 'devolución',
          updated_at: new Date().toISOString()
        })
        .eq("id", orderId)
        .in("status", ["picked", "active", "closed", "sent"]);
      
      if (restoreError) {
        console.error("❌ Error restaurando estado:", restoreError);
        alert(`⚠️ Error crítico: El estado del pedido cambió a "${finalCheck.status}" después de marcarlo como devolución. No se pudo restaurar automáticamente. Por favor, verifica manualmente.`);
      } else {
        console.log(`✅ Estado restaurado correctamente a 'devolución'`);
        alert(`⚠️ Advertencia: El estado del pedido cambió temporalmente pero fue restaurado a "devolución".`);
      }
    } else {
      console.log(`✅ Verificación final: Estado correcto (${finalCheck?.status})`);
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

// Inicializar cuando esté listo
initWhenReady();

