// Importar dinámicamente para asegurar que se cargue después
let supabase = null;

// Verificar permisos de pedidos
let canViewOrders = false;
let canEditOrders = false;
let canDeleteOrders = false;

async function checkOrdersPermissions() {
  try {
    const { checkPermission } = await import("./permissions-helper.js");
    canViewOrders = await checkPermission('orders', 'view');
    canEditOrders = await checkPermission('orders', 'edit');
    canDeleteOrders = await checkPermission('orders', 'delete');
    
    if (!canViewOrders) {
      alert("No tienes permiso para ver pedidos.");
      window.location.href = "./index.html";
      return;
    }
  } catch (error) {
    console.error("Error verificando permisos:", error);
    // Si hay error, permitir acceso (fallback)
    canViewOrders = true;
    canEditOrders = true;
  }
}

// Verificar permisos al cargar
checkOrdersPermissions();

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

// Módulo orders.js cargado

const ORDER_STATUS_LABELS = {
  active: "Activo",
  picked: "Apartado",
  closed: "Cerrado",
  sent: "Enviado",
  pending: "Pendiente",
  waiting: "Espera",
};

const ORDER_STATUS_CLASSES = {
  active: "status-active",
  picked: "status-picked",
  closed: "status-closed",
  sent: "status-sent",
  pending: "status-pending",
  cancelled: "status-cancelled",
  waiting: "status-waiting",
};

const ITEM_STATUS_INFO = {
  reserved: { text: "Reservado", className: "" },
  picked: { text: "Apartado", className: "picked" },
  missing: { text: "Falta", className: "missing" },
  cancelled: { text: "Cancelado", className: "cancelled" },
  waiting: { text: "Espera", className: "waiting" },
};

// Función auxiliar para verificar si un pedido tiene todos los items apartados
// waiting se trata como picked para verificación de completitud
function hasAllItemsPicked(order) {
  if (!order.order_items || order.order_items.length === 0) {
    return false;
  }
  const totalItems = order.order_items.length;
  const pickedItems = order.order_items.filter(item => 
    item.status === 'picked' || item.status === 'waiting'
  ).length;
  return pickedItems === totalItems && totalItems > 0;
}

// Función auxiliar para verificar si un pedido tiene al menos un item reservado
function hasReservedItems(order) {
  if (!order.order_items || order.order_items.length === 0) {
    return false;
  }
  return order.order_items.some(item => item.status === 'reserved');
}

// Función auxiliar para verificar si un pedido tiene items que necesitan atención
// (reserved o missing - no completamente apartados)
function hasItemsNeedingAttention(order) {
  if (!order.order_items || order.order_items.length === 0) {
    return false;
  }
  // Un pedido necesita atención si tiene items "reserved" o "missing"
  // Es decir, si NO todos los items están "picked" o "waiting"
  const hasNeedingAttention = order.order_items.some(item => 
    item.status === 'reserved' || item.status === 'missing'
  );
  
  // Log para depuración
  if (!hasNeedingAttention && order.order_items.length > 0) {
    const statuses = order.order_items.map(item => item.status);
    console.log(`🔍 Pedido ${order.order_number || order.id} - Status de items:`, statuses);
  }
  
  return hasNeedingAttention;
}

// Función auxiliar para verificar si un pedido tiene items en espera
function hasWaitingItems(order) {
  if (!order.order_items || order.order_items.length === 0) {
    return false;
  }
  // Verificar si tiene al menos un item en espera (sin contar cancelados)
  return order.order_items.some(item => item.status === 'waiting');
}

// Función auxiliar para verificar si un pedido tiene SOLO items en espera (sin reserved)
// DEPRECATED: Ya no se usa, pero se mantiene por compatibilidad
function hasOnlyWaitingItems(order) {
  if (!order.order_items || order.order_items.length === 0) {
    return false;
  }
  const hasWaiting = order.order_items.some(item => item.status === 'waiting');
  const hasReserved = order.order_items.some(item => item.status === 'reserved');
  // Tiene solo waiting si tiene waiting pero NO tiene reserved
  return hasWaiting && !hasReserved;
}

let currentFilter = "active";
let orders = [];
let currentAdminUser = null;
let historyControlsInitialized = false;
let historyVisible = false;
let realtimeSubscription = null;
let currentSort = 'recent';
let currentSearch = '';
let searchDebounce = null;
// Map para rastrear qué pedidos están en modo "ver completo" vs "solo reservados" en pestaña Activos
// orderId -> true (ver completo) | false/undefined (solo reservados)
let orderViewMode = new Map();
let orderWaitingViewMode = new Map(); // Para rastrear si se muestra solo items en espera o todos en la pestaña "Espera"
// Cache de almacenes
let warehousesCache = { general: null, ventaPublico: null };

function getCustomerName(order) {
  let customerName = '';
  if (Array.isArray(order.customers)) {
    customerName = order.customers[0]?.full_name || order.customers[0]?.name || '';
  } else if (order.customers && typeof order.customers === 'object') {
    customerName = order.customers.full_name || order.customers.name || '';
  }
  return (customerName || '').toString().toLowerCase();
}

function formatCustomerDisplayName(customer) {
  const full = (customer?.full_name || customer?.name || '').trim();
  if (!full) return 'Cliente sin nombre';
  const parts = full.split(/\s+/);
  if (parts.length === 1) return full;
  const last = parts.pop();
  const first = parts.join(' ');
  return `${last}, ${first}`;
}

function getCustomerPhone(order) {
  if (Array.isArray(order.customers)) return (order.customers[0]?.phone || '').toString().toLowerCase();
  if (order.customers && typeof order.customers === 'object') return (order.customers.phone || '').toString().toLowerCase();
  return '';
}

function getCustomerDni(order) {
  if (Array.isArray(order.customers)) return (order.customers[0]?.dni || '').toString().toLowerCase();
  if (order.customers && typeof order.customers === 'object') return (order.customers.dni || '').toString().toLowerCase();
  return '';
}

function matchesSearch(order) {
  const q = (currentSearch || '').trim().toLowerCase();
  if (!q) return true;
  const name = getCustomerName(order);
  // construir "apellido, nombre"
  const displayName = (() => {
    const full = name;
    const parts = full.trim().split(/\s+/);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      const first = parts.slice(0, -1).join(' ');
      return `${last}, ${first}`.toLowerCase();
    }
    return full;
  })();
  return (
    name.includes(q) ||
    displayName.includes(q) ||
    getCustomerPhone(order).includes(q) ||
    getCustomerDni(order).includes(q)
  );
}

function sortOrders(list) {
  const sorted = [...(list || [])];
  if (currentSort === 'oldest') {
    sorted.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  } else if (currentSort === 'name_az') {
    sorted.sort((a, b) => getCustomerName(a).localeCompare(getCustomerName(b), 'es'));
  } else if (currentSort === 'name_za') {
    sorted.sort((a, b) => getCustomerName(b).localeCompare(getCustomerName(a), 'es'));
  } else {
    // recent (default)
    sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }
  return sorted;
}

function setupSortControls() {
  const select = document.getElementById('sort-select');
  if (!select) return;
  select.value = currentSort;
  select.addEventListener('change', () => {
    currentSort = select.value || 'recent';
    displayOrders();
  });
}

function setupSearchControls() {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.value = currentSearch;
  input.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      currentSearch = input.value || '';
      displayOrders();
    }, 250);
  });
}

async function initOrders() {
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
    setupFilters();
    setupButtons();
    await loadOrders();
    setupRealtimeSubscription();
    updateActiveOrdersBadge();
    updatePickedOrdersBadge();
    updateClosedOrdersBadge();
    updateCancelledOrdersBadge();
    updateWaitingOrdersBadge();
  } catch (error) {
    console.error("❌ Error inicializando panel de pedidos:", error);
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

async function loadOrders() {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en loadOrders");
    return;
  }

  // Hacer consulta sin join (PostgREST no encuentra la relación)
  // Obteneremos customers y emails por separado
  const response = await supabase
    .from("orders")
    .select(
      `
        id,
        order_number,
        status,
        total_amount,
        created_at,
        updated_at,
        sent_at,
        customer_id,
        notes,
        order_items (
          id,
          product_name,
          color,
          size,
          quantity,
          price_snapshot,
          status,
          imagen,
          variant_id
        )
      `
    )
    .order("created_at", { ascending: false });
  
  let data = response.data;
  let error = response.error;
  
  // Si hay datos, obtener información de customers y emails por separado
  if (data && !error && data.length > 0) {
    const customerIds = [...new Set(data.map(order => order.customer_id).filter(Boolean))];
    
    console.log("🔍 Pedidos encontrados:", data.length);
    console.log("🔍 Customer IDs únicos:", customerIds.length, customerIds);
    
    if (customerIds.length > 0) {
      // Obtener información de customers (ahora incluye email y customer_number)
      const { data: customersData, error: customersError } = await supabase
        .from("customers")
        .select("id, customer_number, full_name, phone, city, province, dni, email")
        .in("id", customerIds);
      
      if (customersError) {
        console.error("❌ Error obteniendo datos de customers:", customersError);
      } else {
        console.log("✅ Customers obtenidos:", customersData?.length || 0, customersData);
      }
      
      // Los emails ahora vienen directamente en customersData
      // Combinar datos de customers con orders
      const customersMap = new Map();
      if (customersData) {
        customersData.forEach(c => {
          customersMap.set(c.id, c);
          console.log(`✅ Customer mapeado: ${c.id} -> ${c.full_name || 'Sin nombre'}, email: ${c.email || 'Sin email'}`);
        });
      }
      
      // Verificar qué customer_ids no tienen datos
      const missingCustomers = customerIds.filter(id => !customersMap.has(id));
      if (missingCustomers.length > 0) {
        console.warn("⚠️ Customer IDs sin datos en customers:", missingCustomers);
      }
      
      // Mapear orders con customers (el email ya viene en customer)
      data = data.map(order => {
        const customer = customersMap.get(order.customer_id) || {};
        
        if (!customer.id && order.customer_id) {
          console.warn(`⚠️ Pedido ${order.id} tiene customer_id ${order.customer_id} pero no se encontró en customers`);
        }
        
        if (!customer.email && order.customer_id) {
          console.warn(`⚠️ Pedido ${order.id} tiene customer_id ${order.customer_id} pero no tiene email en customers`);
        }
        
        return {
          ...order,
          customers: customer
        };
      });
      
      console.log("✅ Datos combinados. Primer pedido customers:", JSON.stringify(data[0]?.customers, null, 2));
    } else {
      console.warn("⚠️ No hay customer_ids válidos en los pedidos");
    }
  }

  if (error) {
    console.error("❌ Error cargando pedidos:", error);
    return;
  }

  orders = data || [];
  await displayOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
}

// Función para actualizar el badge de pedidos activos
function updateActiveOrdersBadge() {
  // Contar pedidos que NO tienen todos los items apartados y no están cerrados ni enviados
  // Esto incluye pedidos con items "reserved", "missing", o mezclados
  const activeCount = orders.filter(order => 
    order.status !== "closed" && 
    order.status !== "sent" && 
    order.status !== "devolución" && // Excluir devoluciones
    !hasAllItemsPicked(order)
  ).length;
  const badge = document.getElementById("active-orders-badge");
  
  if (badge) {
    if (activeCount > 0) {
      badge.textContent = activeCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

// Función para actualizar el badge de pedidos apartados
function updatePickedOrdersBadge() {
  // Contar pedidos que tienen todos los items "picked" (NO waiting) y no están cerrados ni enviados
  // EXCLUIR pedidos con items en espera (estos van SOLO a "Espera")
  const pickedCount = orders.filter(order => {
    if (order.status === "closed" || order.status === "sent" || order.status === "devolución") {
      return false;
    }
    // EXCLUIR si tiene items en espera (prioridad: va a Espera)
    if (hasWaitingItems(order)) {
      return false;
    }
    // Debe tener todos los items apartados (picked, pero NO waiting)
    if (!hasAllItemsPicked(order)) {
      return false;
    }
    // Excluir si tiene items reservados (estos van a "Activos")
    if (hasReservedItems(order)) {
      return false;
    }
    return true;
  }).length;
  const badge = document.getElementById("picked-orders-badge");
  
  if (badge) {
    if (pickedCount > 0) {
      badge.textContent = pickedCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

// Función para actualizar el badge de pedidos cerrados
function updateClosedOrdersBadge() {
  // Contar pedidos que están cerrados
  const closedCount = orders.filter(order => 
    order.status === "closed"
  ).length;
  const badge = document.getElementById("closed-orders-badge");
  
  if (badge) {
    if (closedCount > 0) {
      badge.textContent = closedCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

// Función para actualizar el badge de cancelaciones
function updateCancelledOrdersBadge() {
  // Contar pedidos que tienen al menos un item cancelado
  const cancelledCount = orders.filter(order => {
    const hasCancelledItems = (order.order_items || []).some(item => item.status === 'cancelled');
    return hasCancelledItems;
  }).length;
  const badge = document.getElementById("cancelled-orders-badge");
  
  if (badge) {
    if (cancelledCount > 0) {
      badge.textContent = cancelledCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

// Función para actualizar el badge de pedidos en espera
function updateWaitingOrdersBadge() {
  // Contar pedidos que tienen AL MENOS UN item en espera
  // (sin importar si también tienen reserved, picked, etc.)
  const waitingCount = orders.filter(order => {
    if (order.status === "closed" || order.status === "sent" || order.status === "devolución") {
      return false;
    }
    // Contar si tiene al menos un item en espera
    return hasWaitingItems(order);
  }).length;
  const badge = document.getElementById("waiting-orders-badge");
  
  if (badge) {
    if (waitingCount > 0) {
      badge.textContent = waitingCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

// Exponer funciones de actualización de badges globalmente (después de que estén definidas)
window.updateActiveOrdersBadge = updateActiveOrdersBadge;
window.updatePickedOrdersBadge = updatePickedOrdersBadge;
window.updateClosedOrdersBadge = updateClosedOrdersBadge;
window.updateCancelledOrdersBadge = updateCancelledOrdersBadge;
window.updateWaitingOrdersBadge = updateWaitingOrdersBadge;

// Función para configurar suscripción en tiempo real
function setupRealtimeSubscription() {
  if (!supabase) return;
  
  // Cancelar suscripción anterior si existe
  if (realtimeSubscription) {
    supabase.removeChannel(realtimeSubscription);
  }
  
  // Suscribirse a cambios en la tabla orders
  realtimeSubscription = supabase
    .channel("orders-changes")
    .on(
      "postgres_changes",
      {
        event: "*", // INSERT, UPDATE, DELETE
        schema: "public",
        table: "orders",
      },
      async (payload) => {
        console.log("🔄 Cambio en pedidos detectado:", payload.eventType);
        // Recargar pedidos cuando haya cambios
        await loadOrders();
        updateActiveOrdersBadge();
        updatePickedOrdersBadge();
        updateClosedOrdersBadge();
        updateCancelledOrdersBadge();
      }
    )
    .on(
      "postgres_changes",
      {
        event: "*", // INSERT, UPDATE, DELETE
        schema: "public",
        table: "order_items",
      },
      async (payload) => {
        console.log("🔄 Cambio en items de pedidos detectado:", payload.eventType);
        // Recargar pedidos cuando haya cambios en items
        await loadOrders();
        updateActiveOrdersBadge();
        updatePickedOrdersBadge();
        updateClosedOrdersBadge();
        updateCancelledOrdersBadge();
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("✅ Suscripción en tiempo real activa");
      } else if (status === "CHANNEL_ERROR") {
        console.error("❌ Error en suscripción en tiempo real");
      }
    });
}

async function displayOrders() {
  const container = document.getElementById("orders-content");
  if (!container) return;

  // Filtrar por pestaña actual
  const filteredByTab = filterOrders(orders);

  // Requisito: búsqueda solo en Apartados y Cerrados (no combinar estados)
  let filtered = filteredByTab;
  if (currentFilter === 'picked' || currentFilter === 'closed') {
    filtered = filteredByTab.filter(matchesSearch);
  }

  const sorted = sortOrders(filtered);

  if (!sorted.length) {
    container.innerHTML = `
      <div class="empty-orders">
        <h2>No hay pedidos</h2>
        <p>No se encontraron pedidos con el filtro seleccionado.</p>
      </div>
    `;
    updateActiveOrdersBadge();
    updatePickedOrdersBadge();
    updateClosedOrdersBadge();
    updateCancelledOrdersBadge();
    updateWaitingOrdersBadge();
    return;
  }

  // Limpiar el estado de visualización cuando cambiamos de filtro
  // Solo mantener el estado si seguimos en la misma pestaña
  if (currentFilter !== 'active') {
    orderViewMode.clear();
  }
  
  // Renderizar pedidos de forma asíncrona
  const cardsPromises = sorted.map(async (order) => await renderOrderCard(order));
  const cardsHtml = (await Promise.all(cardsPromises)).join("");

  container.innerHTML = `<div class="orders-list">${cardsHtml}</div>`;
  attachOrderEventHandlers();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  updateWaitingOrdersBadge();
  setupSortControls();
  setupSearchControls();
}

// Función para obtener variant_id basado en product_name, color y size
async function findVariantId(productName, color, size) {
  if (!supabase || !productName || !color || !size) return null;
  
  try {
    // Buscar producto por nombre
    const { data: productData, error: productError } = await supabase
      .from('products')
      .select('id')
      .eq('name', productName)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    
    if (productError || !productData) return null;
    
    // Buscar variante por producto, color y tamaño
    const { data: variantData, error: variantError } = await supabase
      .from('product_variants')
      .select('id')
      .eq('product_id', productData.id)
      .eq('color', color)
      .eq('size', size)
      .eq('active', true)
      .limit(1)
      .maybeSingle();
    
    return variantError ? null : variantData?.id || null;
  } catch (error) {
    console.error('Error buscando variant_id:', error);
    return null;
  }
}

// Función para obtener ofertas y promociones activas para los items de un pedido
async function getOffersAndPromotionsForOrder(order) {
  if (!supabase || !order.order_items || order.order_items.length === 0) {
    return { offers: [], promotions: [], totalDiscount: 0, itemOffers: new Map(), itemPromos: new Map() };
  }
  
  const items = order.order_items.filter(item => item.status !== 'cancelled');
  const variantIds = [];
  const itemVariantMap = new Map(); // Mapea variant_id -> items[]
  const itemToVariantMap = new Map(); // Mapea item.id -> variant_id
  
  // Obtener variant_ids de los items
  for (const item of items) {
    let variantId = item.variant_id;
    
    // Si no tiene variant_id, intentar buscarlo
    if (!variantId && item.product_name && item.color && item.size) {
      variantId = await findVariantId(item.product_name, item.color, item.size);
    }
    
    if (variantId) {
      variantIds.push(variantId);
      if (!itemVariantMap.has(variantId)) {
        itemVariantMap.set(variantId, []);
      }
      itemVariantMap.get(variantId).push(item);
      itemToVariantMap.set(item.id, variantId);
    }
  }
  
  if (variantIds.length === 0) {
    return { offers: [], promotions: [], totalDiscount: 0, itemOffers: new Map(), itemPromos: new Map() };
  }
  
  // Obtener promociones activas
  const { data: promotionsData, error: promotionsError } = await supabase
    .rpc('get_active_promotions_for_variants', {
      p_variant_ids: variantIds
    });
  
  const promotions = promotionsError ? [] : (promotionsData || []);
  
  // Obtener ofertas activas (por color)
  const variantOffersMap = new Map();
  const itemOffersMap = new Map(); // item.id -> { offerPrice, originalPrice, promoText }
  const itemPromosMap = new Map(); // item.id -> promoText
  
  // Primero procesar promociones (tienen prioridad)
  // Primero calcular si se cumple la condición mínima antes de asignar etiquetas
  const validPromotions = new Map(); // promo -> { promoText, itemsInPromo[], totalQuantity }
  
  for (const promo of promotions) {
    const variantIdsInPromo = promo.variant_ids || [];
    const itemsInPromo = [];
    
    // Recolectar todos los items que están en esta promoción
    for (const variantId of variantIdsInPromo) {
      const variantItems = itemVariantMap.get(variantId) || [];
      itemsInPromo.push(...variantItems);
    }
    
    if (itemsInPromo.length === 0) continue;
    
    // Calcular cantidad total para verificar si se cumple la condición mínima
    let totalQuantity = 0;
    for (const item of itemsInPromo) {
      totalQuantity += item.quantity || 0;
    }
    
    // Las promociones tipo 2x requieren mínimo 2 unidades para aplicarse
    const groups = Math.floor(totalQuantity / 2);
    if (groups > 0) {
      const promoText = promo.promo_type === '2x1' 
        ? '2x1' 
        : promo.promo_type === '2xMonto' && promo.fixed_amount
        ? `2x$${promo.fixed_amount}`
        : null;
      
      if (promoText) {
        validPromotions.set(promo, { promoText, itemsInPromo, totalQuantity });
        // Solo asignar etiqueta si se cumple la condición
        for (const item of itemsInPromo) {
          itemPromosMap.set(item.id, promoText);
        }
      }
    }
  }
  
  // Luego procesar ofertas (solo para items que no están en promociones)
  for (const item of items) {
    // Si ya tiene promoción, saltar oferta
    if (itemPromosMap.has(item.id)) continue;
    
    if (!item.product_name || !item.color) continue;
    
    // Buscar producto por nombre
    const { data: productData } = await supabase
      .from('products')
      .select('id')
      .eq('name', item.product_name)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    
    if (!productData) continue;
    
    // Buscar oferta activa para este producto y color
    const today = new Date().toISOString().split('T')[0];
    const { data: offerData } = await supabase
      .from('color_price_offers')
      .select('*')
      .eq('product_id', productData.id)
      .eq('color', item.color)
      .eq('status', 'active')
      .lte('start_date', today)
      .gte('end_date', today)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (offerData) {
      const originalPrice = item.price_snapshot || 0;
      const offerPrice = offerData.offer_price;
      itemOffersMap.set(item.id, {
        offerPrice: offerPrice,
        originalPrice: originalPrice,
        promoText: '🔥 Oferta'
      });
    }
  }
  
  // Calcular descuentos totales
  let totalDiscount = 0;
  const appliedPromotions = new Map(); // promo_type -> { count, discount, fixed_amount }
  
  // Calcular descuentos de promociones (solo las que cumplen la condición mínima)
  for (const [promo, promoData] of validPromotions.entries()) {
    const itemsInPromo = promoData.itemsInPromo;
    const totalQuantity = promoData.totalQuantity;
    
    // Calcular precio total
    let totalPrice = 0;
    for (const item of itemsInPromo) {
      const qty = item.quantity || 0;
      const price = item.price_snapshot || 0;
      totalPrice += qty * price;
    }
    
    // Ya verificamos que groups > 0 antes de agregar a validPromotions
    const groups = Math.floor(totalQuantity / 2);
    let discount = 0;
    
    if (promo.promo_type === '2x1') {
      // En 2x1, se cobra solo la mitad (redondeando hacia arriba)
      // Descuento = precio de la mitad de los items
      const averagePrice = totalPrice / totalQuantity;
      discount = groups * averagePrice;
    } else if (promo.promo_type === '2xMonto' && promo.fixed_amount) {
      // En 2xMonto, se cobra el monto fijo por cada grupo de 2
      const promoPrice = groups * promo.fixed_amount;
      discount = totalPrice - promoPrice;
    }
    
    totalDiscount += discount;
    
    const promoKey = promo.promo_type === '2x1' ? '2x1' : `2x$${promo.fixed_amount}`;
    if (!appliedPromotions.has(promoKey)) {
      appliedPromotions.set(promoKey, { count: 0, discount: 0 });
    }
    const promoInfo = appliedPromotions.get(promoKey);
    promoInfo.count += totalQuantity;
    promoInfo.discount += discount;
  }
  
  // Calcular descuentos de ofertas
  for (const [itemId, offerInfo] of itemOffersMap.entries()) {
    const item = items.find(i => i.id === itemId);
    if (item) {
      const discount = (offerInfo.originalPrice - offerInfo.offerPrice) * (item.quantity || 0);
      totalDiscount += discount;
    }
  }
  
  return {
    offers: Array.from(itemOffersMap.values()),
    promotions: Array.from(appliedPromotions.entries()).map(([type, info]) => ({ type, ...info })),
    totalDiscount: totalDiscount,
    itemOffers: itemOffersMap,
    itemPromos: itemPromosMap
  };
}

// Función para cargar almacenes si no están en cache
async function loadWarehouses() {
  if (warehousesCache.general && warehousesCache.ventaPublico) {
    return warehousesCache;
  }
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    return warehousesCache;
  }
  
  try {
    const { data, error } = await supabase
      .from("warehouses")
      .select("id, code, name")
      .in("code", ["general", "venta-publico"]);
    
    if (!error && data) {
      data.forEach(w => {
        if (w.code === "general") warehousesCache.general = w.id;
        if (w.code === "venta-publico") warehousesCache.ventaPublico = w.id;
      });
    }
  } catch (error) {
    console.error("❌ Error cargando almacenes:", error);
  }
  
  return warehousesCache;
}

// Función para obtener el depósito de un item reservado
async function getItemWarehouse(item) {
  // Solo para items en estado reservado con variant_id
  if (item.status !== 'reserved' || !item.variant_id) {
    return null;
  }
  
  // Cargar almacenes si no están en cache
  await loadWarehouses();
  
  if (!warehousesCache.general || !warehousesCache.ventaPublico) {
    return null;
  }
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    return null;
  }
  
  try {
    // Consultar stock en ambos depósitos
    const { data: stockData, error } = await supabase
      .from("variant_warehouse_stock")
      .select("warehouse_id, stock_qty")
      .eq("variant_id", item.variant_id)
      .in("warehouse_id", [warehousesCache.general, warehousesCache.ventaPublico]);
    
    if (error || !stockData) {
      return null;
    }
    
    // Buscar stock en general primero (prioridad)
    const generalStock = stockData.find(s => s.warehouse_id === warehousesCache.general);
    const ventaStock = stockData.find(s => s.warehouse_id === warehousesCache.ventaPublico);
    
    const generalQty = generalStock?.stock_qty || 0;
    const ventaQty = ventaStock?.stock_qty || 0;
    const itemQty = item.quantity || 1;
    
    // Lógica: primero se descuenta del general, luego del local
    // Si hay suficiente stock en general, está en General
    if (generalQty >= itemQty) {
      return "General";
    }
    // Si hay stock en general pero no suficiente, y hay stock en venta para completar
    if (generalQty > 0 && (generalQty + ventaQty) >= itemQty) {
      // Se usó de ambos, pero priorizamos mostrar General ya que se descuenta primero de ahí
      return "General";
    }
    // Si no hay stock en general o no es suficiente y solo hay en venta, está en Local
    if (ventaQty >= itemQty) {
      return "Local";
    }
    // Si hay stock combinado suficiente pero no individual, determinar según prioridad
    if ((generalQty + ventaQty) >= itemQty) {
      // Si hay algo en general, priorizar General (se descuenta primero de ahí)
      return generalQty > 0 ? "General" : "Local";
    }
    
    return null;
  } catch (error) {
    console.error("❌ Error obteniendo depósito del item:", error);
    return null;
  }
}

async function renderOrderCard(order) {
  // Determinar el estado del pedido basado en los items
  let displayStatus = order.status;
  let statusLabel = ORDER_STATUS_LABELS[displayStatus] || displayStatus || "Desconocido";
  let statusClass = ORDER_STATUS_CLASSES[displayStatus] || "status-active";
  
  // Si el pedido no está cerrado ni enviado, verificar el estado basado en los items
  if (order.status !== "closed" && order.status !== "sent") {
    // Si tiene items en espera y estamos en el filtro de espera, mostrar como "Espera"
    // Mostrar como "Espera" si tiene al menos un item en espera (sin importar otros estados)
    if (currentFilter === 'waiting' && hasWaitingItems(order)) {
      displayStatus = "waiting";
      statusLabel = "Espera";
      statusClass = "status-waiting";
    } else if (hasAllItemsPicked(order) && !hasWaitingItems(order)) {
      // Todos los items están apartados (pero NO waiting, porque esos van a Espera)
      displayStatus = "picked";
      statusLabel = "Apartado";
      statusClass = "status-picked";
    } else {
      // Si no todos están apartados, mostrar como "Activo"
      // Esto incluye pedidos con items "reserved", "missing", o mezclados
      // (pero NO waiting, porque esos van a Espera)
      displayStatus = "active";
      statusLabel = "Activo";
      statusClass = "status-active";
    }
  } else if (order.status === "sent") {
    // Si el pedido está enviado, mostrar como "Enviado"
    displayStatus = "sent";
    statusLabel = "Enviado";
    statusClass = "status-sent";
  }
  
  // Manejar customer que puede ser objeto o array
  let customer = {};
  if (Array.isArray(order.customers)) {
    customer = order.customers[0] || {};
  } else if (order.customers && typeof order.customers === 'object') {
    customer = order.customers;
  }
  
  // Obtener email del usuario (ya viene en customer.email desde la función RPC)
  const customerEmail = customer.email || "Sin email";
  
  // Obtener ofertas y promociones
  const offersData = await getOffersAndPromotionsForOrder(order);
  
  const total =
    typeof order.total_amount === "number"
      ? order.total_amount
      : (order.order_items || []).reduce(
          (sum, item) => sum + (item.quantity || 0) * ((item.price_snapshot || 0)),
          0
        );

  // Fecha de creación y días transcurridos
  const createdAt = order.created_at ? new Date(order.created_at) : null;
  let createdLabel = "";
  if (createdAt && !isNaN(createdAt.getTime())) {
    const now = new Date();
    const diffMs = now - createdAt;
    const diffDays = Math.max(0, Math.floor(diffMs / 86400000));
    const daysColor = diffDays >= 7 ? "#dc3545" : "#6c757d";
    const daysText = `${diffDays} día${diffDays === 1 ? '' : 's'}`;
    const createdText = createdAt.toLocaleDateString('es-AR');
    createdLabel = `<div style="font-size:12px; color:#666; margin-top:2px;">
                      Creado: ${createdText}
                      <span style="margin-left:8px; font-weight:700; color:${daysColor};">${daysText}</span>
                    </div>`;
  }

  // Fecha de envío (sent_at) - mostrar si el pedido está enviado o cerrado y tiene sent_at
  let sentLabel = "";
  if ((order.status === "sent" || order.status === "closed") && order.sent_at) {
    const sentAt = new Date(order.sent_at);
    if (!isNaN(sentAt.getTime())) {
      const sentText = sentAt.toLocaleDateString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      sentLabel = `<div style="font-size:12px; color:#28a745; margin-top:2px; font-weight:600;">
                    Enviado: ${sentText}
                  </div>`;
    }
  } else if (order.status === "sent" && !order.sent_at && order.updated_at) {
    // Fallback: usar updated_at si sent_at no existe (pedidos antiguos)
    const updatedAt = new Date(order.updated_at);
    if (!isNaN(updatedAt.getTime())) {
      const updatedText = updatedAt.toLocaleDateString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      sentLabel = `<div style="font-size:12px; color:#28a745; margin-top:2px; font-weight:600;">
                    Enviado: ${updatedText}
                  </div>`;
    }
  }
  
  // Separar items cancelados de los demás para mostrarlos primero con advertencia
  const allItems = order.order_items || [];
  const cancelledItems = allItems.filter(item => item.status === 'cancelled');
  
  // Determinar qué items mostrar según el filtro y el modo de visualización
  let activeItems;
  if (currentFilter === 'waiting') {
    // En filtro de espera, verificar si está en modo "ver completo"
    const isFullView = orderWaitingViewMode.get(order.id) === true;
    if (isFullView) {
      // Modo completo: mostrar todos excepto cancelados
      activeItems = allItems.filter(item => item.status !== 'cancelled');
    } else {
      // Modo por defecto: solo mostrar items en espera
      activeItems = allItems.filter(item => item.status === 'waiting');
    }
  } else if (currentFilter === 'active') {
    // En pestaña Activos, verificar si está en modo "ver completo"
    const isFullView = orderViewMode.get(order.id) === true;
    if (isFullView) {
      // Modo completo: mostrar todos excepto cancelados
      activeItems = allItems.filter(item => item.status !== 'cancelled');
    } else {
      // Modo por defecto: solo mostrar items reservados
      activeItems = allItems.filter(item => item.status === 'reserved');
    }
  } else {
    // En otros filtros, mostrar todos excepto cancelados
    activeItems = allItems.filter(item => item.status !== 'cancelled');
  }
  
  // Mostrar advertencia si hay items cancelados (solo si no estamos en filtro de espera)
  const cancelledWarning = (currentFilter !== 'waiting' && cancelledItems.length > 0) ? `
    <div class="cancelled-warning">
      <span>⚠️</span>
      <span>${cancelledItems.length} producto(s) cancelado(s) por el cliente ${customer.full_name || 'Cliente sin nombre'}${customer.customer_number ? ` (Nº ${customer.customer_number})` : ''}</span>
    </div>
  ` : '';
  
  // Parsear valores extra desde notes
  let extraValuesHtml = '';
  if (order.notes) {
    try {
      const extraValues = JSON.parse(order.notes);
      const shippingAmount = parseFloat(extraValues.shipping) || 0;
      const discountAmount = parseFloat(extraValues.discount) || 0;
      const extrasAmount = parseFloat(extraValues.extras_amount) || 0;
      const extrasPercentage = parseFloat(extraValues.extras_percentage) || 0;
      
      // Calcular subtotal de productos para el porcentaje de extras
      const productsSubtotal = allItems.reduce((sum, item) => {
        return sum + ((item.price_snapshot || 0) * (item.quantity || 0));
      }, 0);
      
      if (shippingAmount > 0) {
        extraValuesHtml += `
          <div class="order-item" style="background: #e3f2fd; border-left: 4px solid #2196f3; padding: 12px; margin: 8px 0; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 15px;">🚚 Envío</strong>
                <div style="font-size: 14px; color: #2196f3; margin-top: 4px; font-weight: 600;">
                  $${shippingAmount.toLocaleString('es-AR')}
                </div>
              </div>
            </div>
          </div>
        `;
      }
      
      if (discountAmount > 0) {
        extraValuesHtml += `
          <div class="order-item" style="background: #ffebee; border-left: 4px solid #f44336; padding: 12px; margin: 8px 0; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 15px;">💸 Descuento</strong>
                <div style="font-size: 14px; color: #f44336; margin-top: 4px; font-weight: 600;">
                  -$${discountAmount.toLocaleString('es-AR')}
                </div>
              </div>
            </div>
          </div>
        `;
      }
      
      if (extrasAmount > 0) {
        extraValuesHtml += `
          <div class="order-item" style="background: #f3e5f5; border-left: 4px solid #9c27b0; padding: 12px; margin: 8px 0; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 15px;">➕ Extras</strong>
                <div style="font-size: 14px; color: #9c27b0; margin-top: 4px; font-weight: 600;">
                  $${extrasAmount.toLocaleString('es-AR')}
                </div>
              </div>
            </div>
          </div>
        `;
      }
      
      if (extrasPercentage > 0) {
        const extrasFromPercentage = productsSubtotal * extrasPercentage / 100;
        extraValuesHtml += `
          <div class="order-item" style="background: #f3e5f5; border-left: 4px solid #9c27b0; padding: 12px; margin: 8px 0; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 15px;">➕ Extras (${extrasPercentage}%)</strong>
                <div style="font-size: 14px; color: #9c27b0; margin-top: 4px; font-weight: 600;">
                  $${extrasFromPercentage.toLocaleString('es-AR')}
                </div>
              </div>
            </div>
          </div>
        `;
      }
    } catch (e) {
      console.warn('Error parseando valores extra del pedido:', e);
    }
  }
  
  // Obtener información de depósitos para items reservados
  const warehouseInfoMap = new Map();
  if (activeItems.some(item => item.status === 'reserved')) {
    await Promise.all(activeItems
      .filter(item => item.status === 'reserved')
      .map(async (item) => {
        const warehouse = await getItemWarehouse(item);
        if (warehouse) {
          warehouseInfoMap.set(item.id, warehouse);
        }
      })
    );
  }
  
  // Renderizar items: primero cancelados, luego activos, luego valores extra
  // En pestaña Activos modo "solo reservados", no mostrar valores extra
  const showExtraValues = currentFilter !== 'waiting' && 
                         (currentFilter !== 'active' || orderViewMode.get(order.id) === true);
  
  const itemsHtml = cancelledWarning + 
    (currentFilter !== 'waiting' ? cancelledItems.map((item) => renderOrderItem(item, customer, offersData, warehouseInfoMap)).join("") : "") + 
    activeItems.map((item) => renderOrderItem(item, customer, offersData, warehouseInfoMap)).join("") + 
    (showExtraValues ? extraValuesHtml : "");
  
  // Agregar resumen de ofertas y promociones si hay descuentos
  let offersSummaryHtml = '';
  if (offersData.totalDiscount > 0) {
    let summaryText = '';
    let summaryCount = 0;
    
    // Contar promociones aplicadas
    if (offersData.promotions.length > 0) {
      for (const promo of offersData.promotions) {
        summaryCount += promo.count || 0;
        summaryText += `${promo.count || 0} items en ${promo.type}`;
      }
    }
    
    // Contar ofertas aplicadas
    if (offersData.offers.length > 0) {
      const offerCount = offersData.offers.reduce((sum, o) => {
        const item = activeItems.find(i => offersData.itemOffers.has(i.id));
        return sum + (item?.quantity || 0);
      }, 0);
      if (offerCount > 0) {
        if (summaryText) summaryText += ' + ';
        summaryText += `${offerCount} items en oferta`;
      }
    }
    
    offersSummaryHtml = `
      <div class="order-item" style="background: #fff3e0; border-left: 4px solid #ff9800; padding: 12px; margin: 8px 0; border-radius: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 15px;">🔥 Ofertas y Promociones</strong>
            <div style="font-size: 13px; color: #666; margin-top: 4px;">
              ${summaryText || 'Descuentos aplicados'}
            </div>
            <div style="font-size: 14px; color: #ff9800; margin-top: 4px; font-weight: 600;">
              Descuento: -$${offersData.totalDiscount.toLocaleString('es-AR')}
            </div>
          </div>
        </div>
      </div>
    `;
  }
  
  const finalItemsHtml = itemsHtml + offersSummaryHtml;

  const readyCount = (order.order_items || []).filter(
    (item) => item.status === "picked"
  ).length;

  const totalItems = order.order_items?.length || 0;

  // Mostrar botones según el estado del pedido
  let actionButtons = "";
  if (order.status === "closed") {
    // Para pedidos cerrados, mostrar botón "TERMINADO" y "Editar"
    actionButtons = `
      <button class="btn" style="background: #17a2b8; color: white;" data-edit-order="${order.id}">✏️ Editar Pedido</button>
      <button class="btn" style="background: #28a745; color: white;" data-mark-sent="${order.id}">TERMINADO</button>
    `;
  } else if (order.status !== "sent") {
    // Para pedidos activos, mostrar botón "Editar" y "Cerrar pedido"
    actionButtons = `
      <button class="btn" style="background: #17a2b8; color: white;" data-edit-order="${order.id}">✏️ Editar Pedido</button>
      <button class="btn btn-success" data-close-order="${order.id}">Cerrar pedido</button>
    `;
    
    // Si el pedido está en estado "apartado" (picked), agregar botón "Enviar al Local"
    if (displayStatus === "picked" && hasAllItemsPicked(order) && !hasWaitingItems(order)) {
      actionButtons += `
        <button class="btn" style="background: #CD844D; color: white;" data-send-to-local="${order.id}">🏪 Enviar al Local</button>
      `;
    }
  }

  // Obtener número de pedido o usar ID como fallback
  const orderDisplayNumber = order.order_number || order.id.substring(0, 8);
  
  // Determinar el estado de visualización y el texto del botón
  let shouldStartCollapsed = false;
  let toggleLabel = 'Ocultar productos';
  let itemsDisplay = 'block';
  
  if (currentFilter === 'active') {
    // En pestaña Activos, el botón alterna entre "ver completo" y "solo reservados"
    const isFullView = orderViewMode.get(order.id) === true;
    if (isFullView) {
      toggleLabel = 'Ver solo reservados';
      itemsDisplay = 'block';
    } else {
      toggleLabel = 'Ver pedido completo';
      itemsDisplay = 'block';
    }
  } else if (currentFilter === 'waiting') {
    // En pestaña Espera, mostrar expandido por defecto (solo items en espera)
    // El botón alterna entre "ver pedido completo" y "ver solo en espera"
    const isFullView = orderWaitingViewMode.get(order.id) === true;
    if (isFullView) {
      toggleLabel = 'Ver solo en espera';
      itemsDisplay = 'block';
    } else {
      toggleLabel = 'Ver pedido completo';
      itemsDisplay = 'block'; // Mostrar expandido por defecto
    }
  } else if (currentFilter === 'picked') {
    // En Apartados, colapsar por defecto
    shouldStartCollapsed = true;
    itemsDisplay = 'none';
    toggleLabel = 'Ver productos';
  } else {
    // En otros filtros, mostrar expandido
    itemsDisplay = 'block';
    toggleLabel = 'Ocultar productos';
  }
  
  // Si estamos en filtro de espera y no hay items en espera, no mostrar la tarjeta
  if (currentFilter === 'waiting' && activeItems.length === 0) {
    return '';
  }
  
  return `
    <div class="order-card" data-order-id="${order.id}">
      <div class="order-header">
        <div class="order-id">Pedido #${orderDisplayNumber}${createdLabel}${sentLabel}</div>
        <div class="order-status ${statusClass}">${statusLabel}</div>
      </div>
      <div class="customer-info">
        <div class="customer-name">
          ${customer.customer_number ? `<span style="color: #CD844D; font-weight: 600; margin-right: 8px;">#${customer.customer_number}</span>` : ""}
          ${formatCustomerDisplayName(customer)}
        </div>
        <div class="customer-details">
          ${customer.dni ? `<span>🆔 DNI: ${customer.dni}</span>` : ""}
          <span>📞 ${customer.phone || "Sin teléfono"}</span>
          <span>📧 ${customerEmail}</span>
          ${(customer.city || customer.province) ? `<span>📍 ${[customer.city, customer.province].filter(Boolean).join(" - ")}</span>` : ""}
        </div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin:8px 0 4px 0;">
        <button class="btn btn-outline" data-toggle-items="${order.id}">${toggleLabel}</button>
        <div style="font-size:14px; color:#555; font-weight:600;">Productos separados: ${readyCount}/${totalItems}</div>
      </div>
      <div class="order-items" id="order-items-${order.id}" style="display:${itemsDisplay};" data-order-id="${order.id}">
        ${finalItemsHtml}
      </div>
      <div class="order-total">
        <span>Total</span>
        <span>${formatCurrency(total)}</span>
      </div>
      <div class="order-actions">
        ${actionButtons}
      </div>
    </div>
  `;
}

function renderOrderItem(item, customer = {}, offersData = { itemOffers: new Map(), itemPromos: new Map() }, warehouseInfoMap = new Map()) {
  const info = ITEM_STATUS_INFO[item.status] || ITEM_STATUS_INFO.reserved;
  
  // Obtener información del depósito si el item está reservado
  const warehouse = item.status === 'reserved' ? warehouseInfoMap.get(item.id) : null;
  
  // Verificar si tiene promoción (prioridad sobre oferta)
  const promoText = offersData.itemPromos?.get(item.id);
  const offerInfo = offersData.itemOffers?.get(item.id);
  
  // Calcular precio y subtotal
  let displayPrice = item.price_snapshot || 0;
  let originalPrice = null;
  
  if (promoText) {
    // Si tiene promoción, mostrar precio original
    originalPrice = displayPrice;
  } else if (offerInfo) {
    // Si tiene oferta, usar precio de oferta
    originalPrice = offerInfo.originalPrice;
    displayPrice = offerInfo.offerPrice;
  }
  
  const subtotal = (item.quantity || 0) * displayPrice;
  const isCancelled = item.status === 'cancelled';
  const isMissing = item.status === 'missing';
  const isWaiting = item.status === 'waiting';

  const imageHtml = item.imagen
    ? `<img src="${item.imagen}" alt="${item.product_name}" class="item-thumb" onerror="this.remove()" />`
    : "";

  // Mostrar leyenda de oferta o promoción
  let offerPromoBadge = '';
  if (promoText) {
    offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #ff9800; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">${promoText}</div>`;
  } else if (offerInfo) {
    offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #e74c3c; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">🔥 Oferta</div>`;
  }

  // Si está cancelado, mostrar información del cliente que lo canceló
  const cancelledInfo = isCancelled ? `
    <div style="margin-top: 8px; padding: 8px; background: #fff3e0; border-radius: 6px; font-size: 12px; color: #e65100;">
      <strong>Cancelado por:</strong> ${customer.full_name || 'Cliente sin nombre'}${customer.customer_number ? ` (Nº ${customer.customer_number})` : ''}${customer.phone ? ` • Tel: ${customer.phone}` : ''}${customer.email ? ` • Email: ${customer.email}` : ''}
    </div>
  ` : '';

  // Si está cancelado, mostrar botón para aceptar y limpiar la cancelación
  // Si está faltante, mostrar botón para eliminar del pedido
  // Si está en espera, mostrar botón para confirmar (cambiar a picked)
  const actionButtons = isCancelled ? `
    <div class="item-actions">
      <button class="item-action-btn success" title="Aceptar cancelación y eliminar del pedido" data-item-id="${
        item.id
      }" data-item-action="cleanup-cancelled">✓</button>
    </div>
  ` : isMissing ? `
    <div class="item-actions">
      <button class="item-action-btn danger" title="Eliminar producto faltante del pedido" data-item-id="${
        item.id
      }" data-item-action="remove-missing">🗑️</button>
      <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${
        item.id
      }" data-item-action="reserved">↺</button>
    </div>
  ` : isWaiting ? `
    <div class="item-actions">
      <button class="item-action-btn success" title="Confirmar producto - Cambiar a Apartado" data-item-id="${
        item.id
      }" data-item-action="picked" style="background: #28a745; font-weight: 600;">✓ Confirmar</button>
      <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${
        item.id
      }" data-item-action="reserved">↺</button>
      <button class="item-action-btn danger" title="Eliminar del pedido y reintegrar al stock" data-item-id="${
        item.id
      }" data-item-action="delete-item">🗑️</button>
    </div>
  ` : `
    <div class="item-actions">
      <button class="item-action-btn success" title="Producto apartado" data-item-id="${
        item.id
      }" data-item-action="picked">✓</button>
      <button class="item-action-btn" title="Producto en espera" data-item-id="${
        item.id
      }" data-item-action="waiting" style="background: #ff9800; color: white;">⏳</button>
      <button class="item-action-btn danger" title="Producto faltante" data-item-id="${
        item.id
      }" data-item-action="missing">✕</button>
      <button class="item-action-btn neutral" title="Restaurar estado" data-item-id="${
        item.id
      }" data-item-action="reserved">↺</button>
      <button class="item-action-btn danger" title="Eliminar del pedido" data-item-id="${
        item.id
      }" data-item-action="delete-item">🗑️</button>
    </div>
  `;

  return `
    <div class="order-item ${isCancelled ? 'cancelled-item' : ''}">
      ${imageHtml}
      <div class="item-main">
        <div class="item-name">${item.product_name}</div>
        <div class="item-details">
          Color: ${item.color || "-"} • Talle: ${item.size || "-"} • Cantidad: ${
    item.quantity || 0
  }
        </div>
        ${offerPromoBadge}
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap;">
          <span class="item-status ${info.className}">${info.text}</span>
          ${warehouse ? `<span style="background: #e3f2fd; color: #1565c0; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;">📍 ${warehouse}</span>` : ''}
        </div>
        <div class="item-price">
          ${originalPrice ? `<span style="text-decoration: line-through; color: #888; font-size: 0.9em; margin-right: 8px;">${formatCurrency(originalPrice * (item.quantity || 0))}</span>` : ''}
          ${formatCurrency(subtotal)}
        </div>
        ${cancelledInfo}
      </div>
      ${actionButtons}
    </div>
  `;
}

function filterOrders(list) {
  if (currentFilter === "all") return list;
  
  // PRIORIDAD: Si un pedido tiene AL MENOS UN item en "waiting", debe aparecer SOLO en "Espera"
  // Los pedidos solo pueden estar en una pestaña a la vez
  
  if (currentFilter === "waiting") {
    // Mostrar pedidos que tienen AL MENOS UN item en espera
    // (sin importar si también tienen reserved, picked, etc.)
    return list.filter((order) => {
      if (order.status === "closed" || order.status === "sent" || order.status === "devolución") return false;
      // Mostrar si tiene al menos un item en espera
      return hasWaitingItems(order);
    });
  }
  
  if (currentFilter === "active") {
    // Mostrar pedidos que no están cerrados ni enviados y que NO tienen todos los items apartados
    // EXCLUIR pedidos con items en espera (estos van SOLO a "Espera")
    // EXCLUIR pedidos con items cancelados (estos van a "Cancelaciones")
    // EXCLUIR pedidos en devolución (estos solo aparecen en "Pedidos Enviados")
    return list.filter((order) => {
      if (order.status === "closed" || order.status === "sent" || order.status === "devolución") return false;
      // EXCLUIR si tiene items en espera (prioridad: va a Espera)
      if (hasWaitingItems(order)) return false;
      if (hasAllItemsPicked(order)) return false;
      // Excluir si tiene items cancelados
      const hasCancelledItems = (order.order_items || []).some(item => item.status === 'cancelled');
      if (hasCancelledItems) return false;
      // Incluir pedidos con items reservados, missing u otros estados (pero sin waiting)
      return true;
    });
  }
  
  if (currentFilter === "picked") {
    // Mostrar pedidos que tienen todos los items "picked" (NO waiting)
    // EXCLUIR pedidos con items en espera (estos van SOLO a "Espera")
    return list.filter((order) => {
      if (order.status === "closed" || order.status === "sent" || order.status === "devolución") return false;
      // EXCLUIR si tiene items en espera (prioridad: va a Espera)
      if (hasWaitingItems(order)) return false;
      // Debe tener todos los items apartados (picked, pero NO waiting)
      if (!hasAllItemsPicked(order)) return false;
      // Excluir si tiene items reservados (estos van a "Activos")
      if (hasReservedItems(order)) return false;
      return true;
    });
  }
  
  if (currentFilter === "closed") {
    // Mostrar pedidos cerrados (excluir los que ya están enviados/terminados)
    return list.filter((order) => order.status === "closed");
  }
  
  if (currentFilter === "cancelled") {
    // Mostrar pedidos que tienen al menos un item cancelado
    return list.filter((order) => {
      const hasCancelledItems = (order.order_items || []).some(item => item.status === 'cancelled');
      return hasCancelledItems;
    });
  }
  
  // Fallback: filtrar por status
  return list.filter((order) => order.status === currentFilter);
}

function showLoading() {
  const container = document.getElementById("orders-content");
  if (!container) return;
  container.innerHTML = `
    <div class="loading">
      <div class="loading-spinner"></div>
      <p>Cargando pedidos...</p>
    </div>
  `;
}

function hideLoading() {
  const container = document.getElementById("orders-content");
  if (!container) return;
  const loading = container.querySelector(".loading");
  if (loading) {
    loading.classList.add("hidden");
  }
}

function setupFilters() {
  const filterButtons = document.querySelectorAll(".filter-btn");
  filterButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      filterButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.status;
      // Limpiar el estado de visualización al cambiar de pestaña
      orderViewMode.clear();
      // Mostrar indicador de carga
      showLoading();
      // Esperar un pequeño delay para que se muestre el spinner antes de renderizar
      await new Promise(resolve => setTimeout(resolve, 50));
      // Cargar y mostrar pedidos
      await displayOrders();
    });
  });
}

function setupButtons() {
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Actualizando...";
      await loadOrders();
      updateActiveOrdersBadge();
      updatePickedOrdersBadge();
      updateClosedOrdersBadge();
      updateCancelledOrdersBadge();
      if (historyVisible) {
        await loadClosedOrders();
      }
      refreshBtn.textContent = "Actualizar";
      refreshBtn.disabled = false;
    });
  }

  // Event listeners para el modal de método de pago
  setupPaymentMethodModal();
}

// Función para configurar los event listeners del modal de método de pago
function setupPaymentMethodModal() {
  const modal = document.getElementById("payment-method-modal");
  const closeBtn = document.getElementById("close-payment-modal");
  const cancelBtn = document.getElementById("cancel-payment-btn");
  const confirmBtn = document.getElementById("confirm-payment-btn");
  const createNewCheckbox = document.getElementById("create-new-payment-method");
  const newMethodContainer = document.getElementById("new-payment-method-container");
  const select = document.getElementById("payment-method-select");

  if (!modal) return;

  // Cerrar modal al hacer clic en X o Cancelar
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      hidePaymentMethodModal();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      hidePaymentMethodModal();
    });
  }

  // Cerrar modal al hacer clic fuera del contenido
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      hidePaymentMethodModal();
    }
  });

  // Toggle para crear nuevo método de pago
  if (createNewCheckbox) {
    createNewCheckbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        newMethodContainer.style.display = "block";
        select.disabled = true;
        select.value = "";
      } else {
        newMethodContainer.style.display = "none";
        select.disabled = false;
        const newMethodInput = document.getElementById("new-payment-method-input");
        if (newMethodInput) {
          newMethodInput.value = "";
        }
      }
    });
  }

  // Confirmar método de pago
  if (confirmBtn) {
    confirmBtn.addEventListener("click", async () => {
      await confirmCloseOrderWithPayment();
    });
  }

  // Permitir Enter en el input de nuevo método
  const newMethodInput = document.getElementById("new-payment-method-input");
  if (newMethodInput) {
    newMethodInput.addEventListener("keypress", async (e) => {
      if (e.key === "Enter") {
        await confirmCloseOrderWithPayment();
      }
    });
  }
}

function setupHistoryControls() {
  if (historyControlsInitialized) return;

  const toggleBtn = document.getElementById("toggle-history-btn");
  const historyContainer = document.getElementById("orders-history");
  if (!toggleBtn || !historyContainer) return;

  historyControlsInitialized = true;

  toggleBtn.addEventListener("click", async () => {
    historyVisible = !historyVisible;
    if (historyVisible) {
      toggleBtn.textContent = "Ocultar pedidos anteriores";
      historyContainer.style.display = "block";
      historyContainer.innerHTML = `
        <p style="margin:0; font-size:14px; color:#666;">Cargando pedidos anteriores...</p>
      `;
      await loadClosedOrders();
    } else {
      toggleBtn.textContent = "Ver pedidos anteriores";
      historyContainer.style.display = "none";
    }
  });
}

function attachOrderEventHandlers() {
  document.querySelectorAll("[data-item-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.dataset.itemId;
      const status = btn.dataset.itemAction;
      
      // Si es acción de limpiar cancelado o eliminar faltante, usar función diferente
      if (status === "cleanup-cancelled") {
        await cleanupCancelledItem(itemId);
      } else if (status === "remove-missing") {
        await removeMissingItem(itemId);
      } else if (status === "delete-item") {
        await deleteOrderItemImmediate(itemId);
      } else {
        await updateOrderItemStatus(itemId, status);
      }
    });
  });

  // Toggle de productos por pedido
  document.querySelectorAll('[data-toggle-items]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const orderId = btn.getAttribute('data-toggle-items');
      const itemsEl = document.getElementById(`order-items-${orderId}`);
      if (!itemsEl) return;
      
      if (currentFilter === 'active') {
        // En pestaña Activos, alternar entre modo completo y solo reservados
        const isFullView = orderViewMode.get(orderId) === true;
        const newMode = !isFullView;
        orderViewMode.set(orderId, newMode);
        
        // Recargar el pedido para actualizar la vista
        const order = orders.find(o => o.id === orderId);
        if (order) {
          // Re-renderizar solo este pedido
          renderOrderCard(order).then(async (html) => {
            if (html) {
              const orderCard = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
              if (orderCard) {
                orderCard.outerHTML = html;
                // Re-attach event handlers para este pedido
                attachOrderEventHandlers();
              }
            }
          });
        }
      } else if (currentFilter === 'waiting') {
        // En pestaña Espera, alternar entre modo completo y solo items en espera
        const isFullView = orderWaitingViewMode.get(orderId) === true;
        const newMode = !isFullView;
        orderWaitingViewMode.set(orderId, newMode);
        
        // Recargar el pedido para actualizar la vista
        const order = orders.find(o => o.id === orderId);
        if (order) {
          // Re-renderizar solo este pedido
          renderOrderCard(order).then(async (html) => {
            if (html) {
              const orderCard = document.querySelector(`.order-card[data-order-id="${orderId}"]`);
              if (orderCard) {
                orderCard.outerHTML = html;
                // Re-attach event handlers para este pedido
                attachOrderEventHandlers();
              }
            }
          });
        }
      } else {
        // En otras pestañas, solo colapsar/expandir
        const isHidden = itemsEl.style.display === 'none';
        itemsEl.style.display = isHidden ? 'block' : 'none';
        btn.textContent = isHidden ? 'Ocultar productos' : 'Ver productos';
      }
    });
  });

  document.querySelectorAll("[data-close-order]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.closeOrder;
      await closeOrder(orderId);
    });
  });

  document.querySelectorAll("[data-mark-sent]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.markSent;
      await markOrderAsSent(orderId);
    });
  });

  document.querySelectorAll("[data-edit-order]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.editOrder;
      
      // Esperar a que order-creator.js esté cargado
      let attempts = 0;
      while (!window.openEditOrderModal && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      
      if (window.openEditOrderModal) {
        window.openEditOrderModal(orderId);
      } else {
        alert("Error: No se pudo cargar el módulo de edición. Por favor, recarga la página.");
        console.error("❌ window.openEditOrderModal no está disponible después de esperar");
      }
    });
  });

  document.querySelectorAll("[data-send-to-local]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.dataset.sendToLocal;
      await sendOrderToLocal(orderId);
    });
  });

  setupHistoryControls();
}

// Función para eliminar un item faltante del pedido
async function removeMissingItem(itemId) {
  if (!itemId) return;
  
  const confirmRemove = confirm(
    "¿Está seguro que desea eliminar este producto faltante del pedido? El producto se eliminará permanentemente del pedido del cliente y el total se actualizará."
  );
  
  if (!confirmRemove) return;
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en removeMissingItem");
    alert("No se pudo eliminar el producto faltante. Por favor, recarga la página.");
    return;
  }
  
  if (!currentAdminUser) {
    console.error("❌ Usuario admin no disponible");
    return;
  }
  
  console.log(`🗑️ Eliminando item faltante ${itemId}`);
  
  // Obtener información del item para verificar que está marcado como missing
  const { data: itemData, error: itemError } = await supabase
    .from("order_items")
    .select("id, order_id, status, quantity, price_snapshot, variant_id")
    .eq("id", itemId)
    .maybeSingle();
  
  if (itemError || !itemData) {
    console.error("❌ Error obteniendo item:", itemError);
    alert("No se pudo encontrar el producto a eliminar.");
    return;
  }
  
  // Verificar que el item está marcado como faltante
  if (itemData.status !== "missing") {
    alert("Este producto no está marcado como faltante.");
    return;
  }
  
  const orderId = itemData.order_id;
  const itemPrice = Number(itemData.price_snapshot || 0);
  const itemQuantity = Number(itemData.quantity || 0);
  const itemTotal = itemPrice * itemQuantity;
  
  // Eliminar el item de la base de datos
  const { error: deleteError } = await supabase
    .from("order_items")
    .delete()
    .eq("id", itemId);
  
  if (deleteError) {
    console.error("❌ Error eliminando item faltante:", deleteError);
    alert("No se pudo eliminar el producto faltante.");
    return;
  }
  
  // Actualizar el total del pedido restando el precio del item eliminado
  if (orderId && itemTotal > 0) {
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .select("total_amount")
      .eq("id", orderId)
      .maybeSingle();
    
    if (!orderError && orderData) {
      const currentTotal = Number(orderData.total_amount || 0);
      const newTotal = Math.max(0, currentTotal - itemTotal);
      
      const { error: updateError } = await supabase
        .from("orders")
        .update({ 
          total_amount: newTotal,
          updated_at: new Date().toISOString()
        })
        .eq("id", orderId);
      
      if (updateError) {
        console.warn("⚠️ No se pudo actualizar el total del pedido:", updateError);
      }
    }
  }
  
  console.log("✅ Item faltante eliminado correctamente");
  
  // Recargar pedidos para actualizar la vista
  await loadOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  
  if (historyVisible) {
    await loadClosedOrders();
  }
  
  alert("✅ Producto faltante eliminado correctamente del pedido. El total ha sido actualizado.");
}

// Función para limpiar/eliminar un item cancelado del pedido
async function cleanupCancelledItem(itemId) {
  if (!canDeleteOrders) {
    alert("No tienes permiso para eliminar items de pedidos.");
    return;
  }
  
  if (!itemId) return;
  
  const confirmCleanup = confirm(
    "¿Está seguro que desea eliminar este producto cancelado del pedido? El producto se eliminará permanentemente y el pedido volverá a aparecer en las otras secciones si no tiene más cancelaciones."
  );
  
  if (!confirmCleanup) return;
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en cleanupCancelledItem");
    alert("No se pudo limpiar el producto cancelado. Por favor, recarga la página.");
    return;
  }
  
  if (!currentAdminUser) {
    console.error("❌ Usuario admin no disponible");
    return;
  }
  
  console.log(`🧹 Limpiando item cancelado ${itemId}`);
  
  // Primero, obtener información del item para obtener el order_id
  const { data: itemData, error: itemError } = await supabase
    .from("order_items")
    .select("id, order_id, status")
    .eq("id", itemId)
    .maybeSingle();
  
  if (itemError || !itemData) {
    console.error("❌ Error obteniendo item:", itemError);
    alert("No se pudo encontrar el producto a eliminar.");
    return;
  }
  
  // Verificar que el item está cancelado
  if (itemData.status !== "cancelled") {
    alert("Este producto no está cancelado.");
    return;
  }
  
  // Obtener información completa del item para actualizar el total del pedido
  const { data: fullItemData, error: fullItemError } = await supabase
    .from("order_items")
    .select("id, order_id, quantity, price_snapshot")
    .eq("id", itemId)
    .maybeSingle();
  
  if (fullItemError || !fullItemData) {
    console.error("❌ Error obteniendo información completa del item:", fullItemError);
    alert("No se pudo obtener la información del producto.");
    return;
  }
  
  const orderId = fullItemData.order_id;
  const itemPrice = Number(fullItemData.price_snapshot || 0);
  const itemQuantity = Number(fullItemData.quantity || 0);
  const itemTotal = itemPrice * itemQuantity;
  
  // Eliminar el item de la base de datos
  const { error: deleteError } = await supabase
    .from("order_items")
    .delete()
    .eq("id", itemId);
  
  if (deleteError) {
    console.error("❌ Error eliminando item cancelado:", deleteError);
    alert("No se pudo eliminar el producto cancelado.");
    return;
  }
  
  // Actualizar el total del pedido restando el precio del item eliminado
  if (orderId && itemTotal > 0) {
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .select("total_amount")
      .eq("id", orderId)
      .maybeSingle();
    
    if (!orderError && orderData) {
      const currentTotal = Number(orderData.total_amount || 0);
      const newTotal = Math.max(0, currentTotal - itemTotal);
      
      const { error: updateError } = await supabase
        .from("orders")
        .update({ 
          total_amount: newTotal,
          updated_at: new Date().toISOString()
        })
        .eq("id", orderId);
      
      if (updateError) {
        console.warn("⚠️ No se pudo actualizar el total del pedido:", updateError);
      }
    }
  }
  
  console.log("✅ Item cancelado eliminado correctamente");
  
  // Recargar pedidos para actualizar la vista
  await loadOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  
  if (historyVisible) {
    await loadClosedOrders();
  }
  
  alert("✅ Producto cancelado eliminado correctamente. El pedido ha sido actualizado.");
}

async function updateOrderItemStatus(itemId, status) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!itemId) return;
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en updateOrderItemStatus");
    return;
  }
  
  if (!currentAdminUser) {
    console.error("❌ Usuario admin no disponible");
    return;
  }
  
  console.log(`🔄 Actualizando item ${itemId} a status: ${status}`);
  
  // Usar la nueva función RPC que verifica si todos los items están apartados
  const { data, error } = await supabase.rpc("rpc_update_order_item_status", {
    p_item_id: itemId,
    p_status: status,
    p_checked_by: currentAdminUser.id,
  });

  if (error) {
    console.error("❌ Error actualizando ítem:", error);
    alert(error.message || "No se pudo actualizar el estado del producto.");
    return;
  }

  console.log("✅ Item actualizado correctamente. Respuesta:", data);
  
  // Recargar pedidos para actualizar la vista
  await loadOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  updateWaitingOrdersBadge();
  
  // Si todos los items están apartados, mostrar mensaje
  if (data && data.all_items_picked) {
    console.log("✅ Todos los items del pedido están apartados");
  } else {
    console.log("ℹ️ El pedido aún tiene items que necesitan atención");
  }
  
  if (historyVisible) {
    await loadClosedOrders();
  }
}

// Variable para almacenar el orderId pendiente de cerrar
let pendingCloseOrderId = null;

// Función para cargar métodos de pago desde la base de datos
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

// Función para crear un nuevo método de pago
async function createPaymentMethod(name) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en createPaymentMethod");
    return null;
  }

  if (!name || name.trim() === "") {
    return null;
  }

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

// Función para mostrar el modal de método de pago
async function showPaymentMethodModal(orderId) {
  pendingCloseOrderId = orderId;

  const modal = document.getElementById("payment-method-modal");
  const select = document.getElementById("payment-method-select");
  const createNewCheckbox = document.getElementById("create-new-payment-method");
  const newMethodContainer = document.getElementById("new-payment-method-container");
  const newMethodInput = document.getElementById("new-payment-method-input");
  const errorDiv = document.getElementById("payment-method-error");

  // Limpiar estado anterior
  select.innerHTML = '<option value="">-- Seleccione un método --</option>';
  createNewCheckbox.checked = false;
  newMethodContainer.style.display = "none";
  newMethodInput.value = "";
  errorDiv.style.display = "none";
  errorDiv.textContent = "";

  // Cargar métodos de pago
  const paymentMethods = await loadPaymentMethods();
  paymentMethods.forEach((method) => {
    const option = document.createElement("option");
    option.value = method.name;
    option.textContent = method.name;
    select.appendChild(option);
  });

  // Mostrar modal
  modal.style.display = "flex";
  modal.classList.add("active");
}

// Función para cerrar el modal de método de pago
function hidePaymentMethodModal() {
  const modal = document.getElementById("payment-method-modal");
  modal.style.display = "none";
  modal.classList.remove("active");
  pendingCloseOrderId = null;
}

// Función para confirmar el cierre del pedido con método de pago
async function confirmCloseOrderWithPayment() {
  const select = document.getElementById("payment-method-select");
  const createNewCheckbox = document.getElementById("create-new-payment-method");
  const newMethodInput = document.getElementById("new-payment-method-input");
  const errorDiv = document.getElementById("payment-method-error");

  errorDiv.style.display = "none";
  errorDiv.textContent = "";

  let paymentMethod = null;

  if (createNewCheckbox.checked) {
    // Crear nuevo método de pago
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
    // Usar método existente
    paymentMethod = select.value;
    if (!paymentMethod) {
      errorDiv.textContent = "Por favor, seleccione un método de pago.";
      errorDiv.style.display = "block";
      return;
    }
  }

  // Guardar el orderId antes de cerrar el modal (que limpia pendingCloseOrderId)
  const orderIdToClose = pendingCloseOrderId;
  
  // Cerrar el modal
  hidePaymentMethodModal();

  // Proceder con el cierre del pedido
  if (orderIdToClose) {
    await closeOrderWithPayment(orderIdToClose, paymentMethod);
  } else {
    console.error("❌ No se encontró el ID del pedido para cerrar");
    alert("Error: No se pudo identificar el pedido a cerrar. Por favor, intente nuevamente.");
  }
}

// Función para cerrar el pedido con el método de pago seleccionado
async function closeOrderWithPayment(orderId, paymentMethod) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!orderId) return;

  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en closeOrderWithPayment");
    alert("No se pudo cerrar el pedido. Por favor, recarga la página.");
    return;
  }

  const { error } = await supabase.rpc("rpc_close_order", {
    p_order_id: orderId,
    p_payment_method: paymentMethod,
  });

  if (error) {
    console.error("❌ Error cerrando pedido:", error);
    alert("No se pudo cerrar el pedido.");
    return;
  }

  await loadOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (historyVisible) {
    await loadClosedOrders();
  }
}

async function closeOrder(orderId) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!orderId) return;
  
  // Mostrar modal de método de pago en lugar de confirm
  await showPaymentMethodModal(orderId);
}

async function markOrderAsSent(orderId) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!orderId) return;
  const confirmSend = confirm(
    "¿Está seguro que desea marcar este pedido como TERMINADO? El pedido se moverá a Pedidos Enviados."
  );
  if (!confirmSend) return;

  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en markOrderAsSent");
    alert("No se pudo marcar el pedido como terminado. Por favor, recarga la página.");
    return;
  }

  console.log("🔄 Marcando pedido como terminado:", orderId);

  const { error } = await supabase.rpc("rpc_mark_order_as_sent", {
    p_order_id: orderId,
  });

  if (error) {
    console.error("❌ Error marcando pedido como terminado:", error);
    alert(error.message || "No se pudo marcar el pedido como terminado.");
    return;
  }

  console.log("✅ Pedido marcado como terminado correctamente");

  await loadOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (historyVisible) {
    await loadClosedOrders();
  }

  showToastNotification("Pedido marcado como terminado. Se ha movido a Pedidos Enviados.", "success");
}

// Función para enviar pedido al local
async function sendOrderToLocal(orderId) {
  if (!canEditOrders) {
    alert("No tienes permiso para editar pedidos.");
    return;
  }
  
  if (!orderId) return;
  
  const confirmSend = confirm(
    "¿Está seguro que desea enviar este pedido al local? El cliente será copiado a los clientes del local y el pedido estará disponible en Venta al Público."
  );
  if (!confirmSend) return;

  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en sendOrderToLocal");
    alert("No se pudo enviar el pedido al local. Por favor, recarga la página.");
    return;
  }

  console.log("🔄 Enviando pedido al local:", orderId);

  // Llamar a la función RPC que copia cliente y crea pedido local
  const { data, error } = await supabase.rpc("rpc_send_order_to_local", {
    p_order_id: orderId,
  });

  if (error) {
    console.error("❌ Error enviando pedido al local:", error);
    alert(error.message || "No se pudo enviar el pedido al local.");
    return;
  }

  console.log("✅ Pedido enviado al local correctamente:", data);

  showToastNotification(
    `Pedido enviado al local correctamente. Número de pedido local: ${data.order_number || 'N/A'}`,
    "success"
  );

  // Recargar pedidos para actualizar la vista
  await loadOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (historyVisible) {
    await loadClosedOrders();
  }
}

// Función para mostrar notificación toast
function showToastNotification(message, type = "success") {
  // Eliminar notificación anterior si existe
  const existingToast = document.querySelector(".toast-notification");
  if (existingToast) {
    existingToast.remove();
  }

  // Crear elemento de notificación
  const toast = document.createElement("div");
  toast.className = `toast-notification ${type}`;
  
  const icon = type === "success" ? "✅" : "❌";
  
  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-message">${message}</span>
  `;

  // Agregar al body
  document.body.appendChild(toast);

  // Remover después de 3 segundos con animación
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
      }
    }, 300);
  }, 3000);
}

async function loadClosedOrders() {
  const historyContainer = document.getElementById("orders-history");
  if (!historyContainer) return;
  
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en loadClosedOrders");
    return;
  }

  // Consulta sin join para pedidos cerrados (misma estrategia que loadOrders)
  const response = await supabase
    .from("orders")
    .select(
      `
        id,
        order_number,
        status,
        total_amount,
        created_at,
        updated_at,
        customer_id,
        order_items (
          id,
          product_name,
          color,
          size,
          quantity,
          price_snapshot,
          status,
          imagen,
          variant_id
        )
      `
    )
    .eq("status", "closed")
    .order("updated_at", { ascending: false });
  
  let { data, error } = response;
  
  // Si hay datos, obtener información de customers por separado
  if (data && !error && data.length > 0) {
    const customerIds = [...new Set(data.map(order => order.customer_id).filter(Boolean))];
    
    console.log("🔍 Pedidos cerrados encontrados:", data.length);
    console.log("🔍 Customer IDs únicos (cerrados):", customerIds.length, customerIds);
    
    // Obtener información de customers (ahora incluye email y customer_number)
    const { data: customersData, error: customersError } = await supabase
      .from("customers")
      .select("id, customer_number, full_name, phone, city, province, dni, email")
      .in("id", customerIds);
    
    if (customersError) {
      console.error("❌ Error obteniendo datos de customers (cerrados):", customersError);
    } else {
      console.log("✅ Customers obtenidos (cerrados):", customersData?.length || 0);
    }
    
    // Los emails ahora vienen directamente en customersData
    // Combinar datos de customers con orders
    const customersMap = new Map();
    if (customersData) {
      customersData.forEach(c => {
        customersMap.set(c.id, c);
      });
    }
    
    // Verificar qué customer_ids no tienen datos
    const missingCustomers = customerIds.filter(id => !customersMap.has(id));
    if (missingCustomers.length > 0) {
      console.warn("⚠️ Customer IDs sin datos en customers (cerrados):", missingCustomers);
    }
    
    // Mapear orders con customers (el email ya viene en customer)
    data = data.map(order => {
      const customer = customersMap.get(order.customer_id) || {};
      
      if (!customer.id && order.customer_id) {
        console.warn(`⚠️ Pedido cerrado ${order.id} tiene customer_id ${order.customer_id} pero no se encontró en customers`);
      }
      
      return {
        ...order,
        customers: customer
      };
    });
  }

  if (error) {
    console.error("❌ Error cargando pedidos anteriores:", error);
    historyContainer.innerHTML = `
      <div class="empty-orders">
        <p>No se pudo cargar el historial.</p>
      </div>
    `;
    return;
  }

  if (!data || data.length === 0) {
    historyContainer.innerHTML = `
      <p style="margin:0; font-size:14px; color:#666;">Todavía no tienes pedidos anteriores.</p>
    `;
    return;
  }

  historyContainer.innerHTML = `<div class="orders-list">${data
    .map((order) => renderOrderCard(order))
    .join("")}</div>`;

  document.querySelectorAll("[data-close-order]").forEach((btn) => {
    btn.remove();
  });
}

function formatCurrency(value) {
  const amount = Number(value) || 0;
  return `$${amount.toLocaleString("es-AR")}`;
}

// Suprimir errores de extensiones del navegador que aparecen periódicamente
// Estos errores no afectan la funcionalidad de la aplicación
(function() {
  const originalError = console.error;
  const originalWarn = console.warn;
  
  // Interceptar console.error para filtrar errores de extensiones
  console.error = function(...args) {
    const message = args.join(' ');
    // Filtrar errores conocidos de extensiones del navegador
    if (message.includes('runtime.lastError') || 
        message.includes('message port closed') ||
        message.includes('Extension context invalidated') ||
        message.includes('The message port closed before a response was received')) {
      // No mostrar estos errores en la consola
      return;
    }
    // Mostrar otros errores normalmente
    originalError.apply(console, args);
  };
  
  // Interceptar console.warn también por si acaso
  console.warn = function(...args) {
    const message = args.join(' ');
    if (message.includes('runtime.lastError') || 
        message.includes('message port closed') ||
        message.includes('Extension context invalidated')) {
      return;
    }
    originalWarn.apply(console, args);
  };
  
  // También capturar errores no manejados relacionados con extensiones
  window.addEventListener('error', (event) => {
    const message = event.message || '';
    if (message.includes('runtime.lastError') || 
        message.includes('message port closed') ||
        message.includes('Extension context invalidated')) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
  }, true);
})();

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
  
  await initOrders();
}

// Limpiar suscripción cuando se cierra la página
window.addEventListener("beforeunload", () => {
  if (realtimeSubscription && supabase) {
    supabase.removeChannel(realtimeSubscription);
  }
});

// Inicializar cuando esté listo
initWhenReady();

async function deleteOrderItemImmediate(itemId) {
  if (!canDeleteOrders) {
    alert("No tienes permiso para eliminar items de pedidos.");
    return;
  }
  
  if (!itemId) return;
  const confirmed = confirm("¿Eliminar este producto del pedido? Se ajustará el total y (si corresponde) el stock.");
  if (!confirmed) return;

  if (!supabase) supabase = await getSupabase();
  if (!supabase) {
    alert("No se pudo conectar con la base de datos.");
    return;
  }

  // Obtener datos del item
  const { data: item, error: itemErr } = await supabase
    .from("order_items")
    .select("id, order_id, status, quantity, price_snapshot, variant_id")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr || !item) {
    alert("No se encontró el producto.");
    return;
  }

  const qty = Number(item.quantity || 0) || 0;
  const price = Number(item.price_snapshot || 0) || 0;
  const itemTotal = qty * price;

  // Ajuste de stock básico: si estaba 'picked' devolver al stock físico; si 'reserved', liberar reserva
  // Si estaba 'waiting', liberar reserva si existe (ya que los items en espera pueden tener stock reservado)
  if (item.variant_id) {
    try {
      const itemStatus = (item.status || '').toLowerCase();
      if (itemStatus === 'picked') {
        await supabase
          .from("product_variants")
          .update({ stock_qty: supabase.rpc ? undefined : undefined })
          .eq("id", item.variant_id);
        // Lectura del stock y actualización segura
        const { data: varRow } = await supabase
          .from("product_variants")
          .select("stock_qty, reserved_qty")
          .eq("id", item.variant_id)
          .maybeSingle();
        if (varRow) {
          await supabase
            .from("product_variants")
            .update({ stock_qty: (Number(varRow.stock_qty || 0) + qty) })
            .eq("id", item.variant_id);
        }
      } else if (itemStatus === 'reserved' || itemStatus === 'waiting') {
        // Para 'reserved' y 'waiting', liberar la reserva
        const { data: varRow } = await supabase
          .from("product_variants")
          .select("reserved_qty")
          .eq("id", item.variant_id)
          .maybeSingle();
        if (varRow) {
          await supabase
            .from("product_variants")
            .update({ reserved_qty: Math.max(0, Number(varRow.reserved_qty || 0) - qty) })
            .eq("id", item.variant_id);
        }
      }
    } catch (e) {
      console.warn("⚠️ No se pudo ajustar stock del ítem eliminado:", e?.message || e);
    }
  }

  // Eliminar el item
  const { error: delErr } = await supabase.from("order_items").delete().eq("id", itemId);
  if (delErr) {
    alert("No se pudo eliminar el producto.");
    return;
  }

  // Actualizar total del pedido
  if (item.order_id && itemTotal > 0) {
    const { data: orderRow } = await supabase
      .from("orders")
      .select("total_amount")
      .eq("id", item.order_id)
      .maybeSingle();
    if (orderRow) {
      const newTotal = Math.max(0, Number(orderRow.total_amount || 0) - itemTotal);
      await supabase
        .from("orders")
        .update({ total_amount: newTotal, updated_at: new Date().toISOString() })
        .eq("id", item.order_id);
    }
  }

  await loadOrders();
  updateActiveOrdersBadge();
  updatePickedOrdersBadge();
  updateClosedOrdersBadge();
  updateCancelledOrdersBadge();
  if (historyVisible) await loadClosedOrders();

  alert("✅ Producto eliminado del pedido.");
}
