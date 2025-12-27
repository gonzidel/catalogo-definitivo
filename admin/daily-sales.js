// daily-sales.js - Gestión de ventas diarias

let supabase = null;
let currentAdminUser = null;
let currentDate = new Date().toISOString().split('T')[0];
let currentFilter = 'all';
let sales = [];

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

// Verificar autenticación admin
async function verifyAdminAuth() {
  try {
    if (!supabase) {
      supabase = await getSupabase();
    }
    
    if (!supabase) {
      return false;
    }

    const { data: { user }, error } = await supabase.auth.getUser();
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

// Inicializar módulo
async function initDailySales() {
  try {
    supabase = await getSupabase();
    
    if (!supabase) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      supabase = window.supabase;
      
      if (!supabase) {
        console.error("❌ Supabase no disponible");
        showMessage("Error: Supabase no disponible. Por favor, recarga la página.", "error");
        return;
      }
    }
    
    // Verificar autenticación
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) {
      window.location.href = "index.html";
      return;
    }
    
    const isAdmin = await verifyAdminAuth();
    
    if (!isAdmin) {
      window.location.href = "index.html";
      return;
    }
    
    // Configurar controles
    setupDateSelector();
    setupFilters();
    setupEditModal();
    
    // Cargar ventas del día actual
    await loadSales();
  } catch (error) {
    console.error("❌ Error inicializando ventas diarias:", error);
    window.location.href = "index.html";
  }
}

// Configurar selector de fecha
function setupDateSelector() {
  const dateInput = document.getElementById("sale-date");
  if (!dateInput) return;
  
  // Establecer fecha actual por defecto
  dateInput.value = currentDate;
  dateInput.max = currentDate; // No permitir fechas futuras
  
  dateInput.addEventListener("change", async (e) => {
    currentDate = e.target.value;
    await loadSales();
  });
}

// Configurar filtros por tipo
function setupFilters() {
  const filterButtons = document.querySelectorAll(".filter-btn[data-type]");
  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.type;
      displaySales();
    });
  });
}

// Configurar modal de edición
function setupEditModal() {
  const modal = document.getElementById("edit-modal");
  const closeBtn = document.getElementById("close-edit-modal");
  const cancelBtn = document.getElementById("cancel-edit-btn");
  const form = document.getElementById("edit-sale-form");
  
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
  }
  
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
  }
  
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
      }
    });
  }
  
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await updateSale();
    });
  }
}

// Cargar ventas del día seleccionado
async function loadSales() {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible en loadSales");
    return;
  }

  const container = document.getElementById("sales-content");
  if (container) {
    container.innerHTML = '<div class="loading"><p>Cargando ventas...</p></div>';
  }

  try {
    const { data, error } = await supabase
      .from("daily_sales")
      .select("*")
      .eq("sale_date", currentDate)
      .order("sale_time", { ascending: false });

    if (error) {
      console.error("❌ Error cargando ventas:", error);
      showMessage("Error al cargar las ventas. Por favor, intenta de nuevo.", "error");
      if (container) {
        container.innerHTML = '<div class="empty-state"><p>Error al cargar las ventas</p></div>';
      }
      return;
    }

    sales = data || [];
    displaySales();
    updateSummary();
  } catch (error) {
    console.error("❌ Error en loadSales:", error);
    showMessage("Error al cargar las ventas.", "error");
    if (container) {
      container.innerHTML = '<div class="empty-state"><p>Error al cargar las ventas</p></div>';
    }
  }
}

// Mostrar ventas filtradas
function displaySales() {
  const container = document.getElementById("sales-content");
  if (!container) return;

  // Filtrar por tipo
  let filteredSales = sales;
  if (currentFilter !== 'all') {
    filteredSales = sales.filter(sale => sale.sale_type === currentFilter);
  }

  if (filteredSales.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No hay ventas registradas</h2>
        <p>No se encontraron ventas para la fecha seleccionada${currentFilter !== 'all' ? ` del tipo "${currentFilter === 'local' ? 'Local' : 'Envíos'}"` : ''}.</p>
      </div>
    `;
    return;
  }

  const tableHTML = `
    <table class="sales-table">
      <thead>
        <tr>
          <th>Horario</th>
          <th>Tipo</th>
          <th>Cliente</th>
          <th>Cantidad</th>
          <th>Monto</th>
          <th>Acciones</th>
        </tr>
      </thead>
      <tbody>
        ${filteredSales.map(sale => `
          <tr>
            <td>${formatTime(sale.sale_time)}</td>
            <td><span class="sale-type-badge sale-type-${sale.sale_type}">${sale.sale_type === 'local' ? 'Local' : 'Envíos'}</span></td>
            <td>${escapeHtml(sale.customer_name)}</td>
            <td>${sale.product_quantity}</td>
            <td>${formatCurrency(sale.sale_amount)}</td>
            <td>
              <div class="action-buttons">
                <button class="btn btn-outline btn-icon" onclick="editSale('${sale.id}')">✏️ Editar</button>
                <button class="btn btn-danger btn-icon" onclick="deleteSale('${sale.id}')">🗑️ Eliminar</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = tableHTML;
}

// Actualizar resumen de totales
async function updateSummary() {
  try {
    // Usar la función RPC para obtener el resumen
    const { data, error } = await supabase.rpc('get_daily_sales_summary', {
      p_sale_date: currentDate,
      p_sale_type: null
    });

    if (error) {
      console.error("❌ Error obteniendo resumen:", error);
      // Calcular manualmente si falla la RPC
      calculateSummaryManually();
      return;
    }

    if (data) {
      document.getElementById("total-sales").textContent = data.total_sales || 0;
      document.getElementById("total-amount").textContent = formatCurrency(data.total_amount || 0);
      document.getElementById("local-sales").textContent = data.local?.sales || 0;
      document.getElementById("local-amount").textContent = formatCurrency(data.local?.amount || 0);
      document.getElementById("envios-sales").textContent = data.envios?.sales || 0;
      document.getElementById("envios-amount").textContent = formatCurrency(data.envios?.amount || 0);
    }
  } catch (error) {
    console.error("❌ Error en updateSummary:", error);
    calculateSummaryManually();
  }
}

// Calcular resumen manualmente
function calculateSummaryManually() {
  const totalSales = sales.length;
  const totalAmount = sales.reduce((sum, sale) => sum + parseFloat(sale.sale_amount || 0), 0);
  
  const localSales = sales.filter(s => s.sale_type === 'local');
  const localAmount = localSales.reduce((sum, sale) => sum + parseFloat(sale.sale_amount || 0), 0);
  
  const enviosSales = sales.filter(s => s.sale_type === 'envios');
  const enviosAmount = enviosSales.reduce((sum, sale) => sum + parseFloat(sale.sale_amount || 0), 0);

  document.getElementById("total-sales").textContent = totalSales;
  document.getElementById("total-amount").textContent = formatCurrency(totalAmount);
  document.getElementById("local-sales").textContent = localSales.length;
  document.getElementById("local-amount").textContent = formatCurrency(localAmount);
  document.getElementById("envios-sales").textContent = enviosSales.length;
  document.getElementById("envios-amount").textContent = formatCurrency(enviosAmount);
}

// Editar venta
window.editSale = async function(saleId) {
  const sale = sales.find(s => s.id === saleId);
  if (!sale) {
    showMessage("Venta no encontrada.", "error");
    return;
  }

  const modal = document.getElementById("edit-modal");
  document.getElementById("edit-sale-id").value = sale.id;
  document.getElementById("edit-sale-type").value = sale.sale_type;
  document.getElementById("edit-sale-time").value = sale.sale_time;
  document.getElementById("edit-customer-name").value = sale.customer_name;
  document.getElementById("edit-product-quantity").value = sale.product_quantity;
  document.getElementById("edit-sale-amount").value = sale.sale_amount;
  
  modal.style.display = "flex";
};

// Actualizar venta
async function updateSale() {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    showMessage("Error: No se pudo conectar con la base de datos.", "error");
    return;
  }

  const saleId = document.getElementById("edit-sale-id").value;
  const saleType = document.getElementById("edit-sale-type").value;
  const saleTime = document.getElementById("edit-sale-time").value;
  const customerName = document.getElementById("edit-customer-name").value.trim();
  const productQuantity = parseInt(document.getElementById("edit-product-quantity").value);
  const saleAmount = parseFloat(document.getElementById("edit-sale-amount").value);

  // Validaciones
  if (!customerName) {
    showMessage("Por favor, ingresa el nombre del cliente.", "error");
    return;
  }

  if (productQuantity < 0) {
    showMessage("La cantidad de productos no puede ser negativa.", "error");
    return;
  }

  if (saleAmount < 0) {
    showMessage("El monto no puede ser negativo.", "error");
    return;
  }

  try {
    const { error } = await supabase
      .from("daily_sales")
      .update({
        sale_type: saleType,
        sale_time: saleTime,
        customer_name: customerName,
        product_quantity: productQuantity,
        sale_amount: saleAmount
      })
      .eq("id", saleId);

    if (error) {
      console.error("❌ Error actualizando registro:", error);
      showMessage("Error al actualizar el registro. Por favor, intenta de nuevo.", "error");
      return;
    }

    showMessage("✅ Registro actualizado correctamente en el control de caja.\n\nNota: Esto solo actualiza el registro consolidado. La venta original no se modifica.", "success");
    document.getElementById("edit-modal").style.display = "none";
    await loadSales();
  } catch (error) {
    console.error("❌ Error en updateSale:", error);
    showMessage("Error al actualizar la venta.", "error");
  }
}

// Eliminar venta (solo del registro consolidado, no afecta la venta original)
window.deleteSale = async function(saleId) {
  if (!confirm("¿Estás seguro de que deseas eliminar este registro del control de caja?\n\nNota: Esto solo elimina el registro consolidado. La venta original en Public Sales o Pedidos no se eliminará.")) {
    return;
  }

  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    showMessage("Error: No se pudo conectar con la base de datos.", "error");
    return;
  }

  try {
    const { error } = await supabase
      .from("daily_sales")
      .delete()
      .eq("id", saleId);

    if (error) {
      console.error("❌ Error eliminando venta:", error);
      showMessage("Error al eliminar el registro. Por favor, intenta de nuevo.", "error");
      return;
    }

    showMessage("✅ Registro eliminado correctamente del control de caja.", "success");
    await loadSales();
  } catch (error) {
    console.error("❌ Error en deleteSale:", error);
    showMessage("Error al eliminar el registro.", "error");
  }
};

// Mostrar mensaje
function showMessage(message, type = "info") {
  const container = document.getElementById("message-container");
  if (!container) return;

  const messageDiv = document.createElement("div");
  messageDiv.className = type === "error" ? "error-message" : "success-message";
  messageDiv.textContent = message;

  container.innerHTML = "";
  container.appendChild(messageDiv);

  // Auto-ocultar después de 5 segundos
  setTimeout(() => {
    messageDiv.remove();
  }, 5000);
}

// Formatear moneda
function formatCurrency(value) {
  const amount = Number(value) || 0;
  return `$${amount.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Formatear hora
function formatTime(time) {
  if (!time) return "";
  // time viene como "HH:MM:SS" o "HH:MM"
  return time.substring(0, 5);
}

// Escapar HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Inicializar cuando esté listo
async function initWhenReady() {
  if (document.readyState === "loading") {
    await new Promise(resolve => {
      document.addEventListener("DOMContentLoaded", resolve);
    });
  }
  
  supabase = await getSupabase();
  
  if (!supabase) {
    console.error("❌ No se pudo obtener Supabase");
    showMessage("Error: No se pudo conectar con Supabase. Por favor, recarga la página.", "error");
    return;
  }
  
  await initDailySales();
}

initWhenReady();
