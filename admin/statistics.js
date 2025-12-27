// statistics.js - Módulo de Estadísticas Admin

let supabase = null;
let currentAdminUser = null;
let currentChannel = 'all';
let currentFrom = null;
let currentTo = null;
let currentGranularity = 'day';
let revenueChart = null;
let unitsChart = null;
let customersChart = null;

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

// Formatear número como moneda ARS
function formatCurrency(value) {
  if (value === null || value === undefined) return '$0';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

// Formatear número con separadores
function formatNumber(value) {
  if (value === null || value === undefined) return '0';
  return new Intl.NumberFormat('es-AR').format(value);
}

// Formatear porcentaje
function formatPercent(value) {
  if (value === null || value === undefined) return '0%';
  return `${value.toFixed(1)}%`;
}

// Inicializar fechas por defecto (últimos 30 días)
function initDates() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  
  // Formatear fechas como YYYY-MM-DD para los inputs
  const formatDateForInput = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  
  document.getElementById('date-from').value = formatDateForInput(from);
  document.getElementById('date-to').value = formatDateForInput(to);
  
  // Convertir a ISO string con hora 00:00:00 y 23:59:59 para UTC
  currentFrom = from.toISOString().split('T')[0] + 'T00:00:00Z';
  currentTo = to.toISOString().split('T')[0] + 'T23:59:59Z';
}

// Cargar KPIs principales
async function loadKPIs() {
  try {
    const { data, error } = await supabase.rpc('get_dashboard_kpis', {
      p_from: currentFrom,
      p_to: currentTo,
      p_channel: currentChannel
    });

    if (error) {
      console.error('Error cargando KPIs:', error);
      document.getElementById('kpi-grid').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      return;
    }

    renderKPIs(data);
  } catch (error) {
    console.error('Error cargando KPIs:', error);
    document.getElementById('kpi-grid').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
  }
}

// Renderizar KPIs
function renderKPIs(kpis) {
  const grid = document.getElementById('kpi-grid');
  let html = '';

  if (currentChannel === 'all' || currentChannel === 'envios') {
    html += `
      <div class="kpi-card">
        <h3>Revenue Envíos</h3>
        <p class="value">${formatCurrency(kpis.envio_revenue || 0)}</p>
      </div>
      <div class="kpi-card">
        <h3>Pedidos Enviados</h3>
        <p class="value">${formatNumber(kpis.envio_orders_sent || 0)}</p>
      </div>
      <div class="kpi-card">
        <h3>Unidades Envíos</h3>
        <p class="value">${formatNumber(kpis.envio_units || 0)}</p>
      </div>
      <div class="kpi-card">
        <h3>Ticket Promedio Envíos</h3>
        <p class="value">${formatCurrency(kpis.ticket_prom_envios || 0)}</p>
      </div>
    `;
  }

  if (currentChannel === 'all' || currentChannel === 'publico') {
    html += `
      <div class="kpi-card">
        <h3>Revenue Público</h3>
        <p class="value">${formatCurrency(kpis.publico_revenue || 0)}</p>
      </div>
      <div class="kpi-card">
        <h3>Ventas Público</h3>
        <p class="value">${formatNumber(kpis.publico_sales_count || 0)}</p>
      </div>
      <div class="kpi-card">
        <h3>Unidades Público</h3>
        <p class="value">${formatNumber(kpis.publico_units || 0)}</p>
      </div>
      <div class="kpi-card">
        <h3>Ticket Promedio Público</h3>
        <p class="value">${formatCurrency(kpis.ticket_prom_publico || 0)}</p>
      </div>
    `;
  }

  if (currentChannel === 'all') {
    html += `
      <div class="kpi-card">
        <h3>Revenue Total</h3>
        <p class="value">${formatCurrency(kpis.total_revenue || 0)}</p>
      </div>
      <div class="kpi-card">
        <h3>Unidades Total</h3>
        <p class="value">${formatNumber(kpis.total_units || 0)}</p>
      </div>
    `;
  }

  html += `
    <div class="kpi-card">
      <h3>Margen Total</h3>
      <p class="value">${formatCurrency(kpis.margin_amount_total || 0)}</p>
      <p class="subvalue">${formatPercent(kpis.margin_percent_total || 0)}</p>
    </div>
    <div class="kpi-card">
      <h3>Carritos Creados</h3>
      <p class="value">${formatNumber(kpis.carts_created || 0)}</p>
    </div>
    <div class="kpi-card">
      <h3>Carritos Activos</h3>
      <p class="value">${formatNumber(kpis.carts_active || 0)}</p>
    </div>
  `;

  grid.innerHTML = html;

  // Mostrar warnings
  renderWarnings(kpis);
}

// Renderizar warnings
function renderWarnings(kpis) {
  const container = document.getElementById('warnings-container');
  let warnings = [];

  if (kpis.missing_cost_items_count > 0) {
    warnings.push(`Algunos productos no tienen costo asignado (${formatNumber(kpis.missing_cost_items_count)} items)`);
  }

  if (kpis.missing_variant_items_count_envios > 0) {
    warnings.push(`Algunos items de envíos no tienen variante asociada (${formatNumber(kpis.missing_variant_items_count_envios)} items)`);
  }

  if (kpis.legacy_sent_without_sent_at_count > 0) {
    warnings.push(`Hay pedidos marcados como enviados sin fecha de envío (${formatNumber(kpis.legacy_sent_without_sent_at_count)} pedidos)`);
  }

  if (warnings.length > 0) {
    container.innerHTML = `
      <div class="warning-banner">
        <strong>⚠️ Advertencias:</strong>
        ${warnings.map(w => `<div>• ${w}</div>`).join('')}
      </div>
    `;
  } else {
    container.innerHTML = '';
  }
}

// Cargar métricas de clientes
async function loadCustomerKPIs() {
  try {
    const { data, error } = await supabase.rpc('get_customer_kpis', {
      p_from: currentFrom,
      p_to: currentTo
    });

    if (error) {
      console.error('Error cargando métricas de clientes:', error);
      document.getElementById('customer-kpi-grid').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      return;
    }

    renderCustomerKPIs(data);
  } catch (error) {
    console.error('Error cargando métricas de clientes:', error);
    document.getElementById('customer-kpi-grid').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
  }
}

// Renderizar métricas de clientes
function renderCustomerKPIs(kpis) {
  const grid = document.getElementById('customer-kpi-grid');
  const html = `
    <div class="kpi-card">
      <h3>Clientes Nuevos</h3>
      <p class="value">${formatNumber(kpis.customers_new || 0)}</p>
    </div>
    <div class="kpi-card">
      <h3>Compradores Únicos</h3>
      <p class="value">${formatNumber(kpis.customers_with_purchase || 0)}</p>
    </div>
    <div class="kpi-card">
      <h3>Clientes que Volvieron</h3>
      <p class="value">${formatNumber(kpis.customers_returning || 0)}</p>
    </div>
    <div class="kpi-card">
      <h3>Nuevos que Compraron (7d)</h3>
      <p class="value">${formatNumber(kpis.customers_new_and_purchased_7d || 0)}</p>
    </div>
    <div class="kpi-card">
      <h3>Nuevos que Compraron (30d)</h3>
      <p class="value">${formatNumber(kpis.customers_new_and_purchased_30d || 0)}</p>
    </div>
  `;
  grid.innerHTML = html;
}

// Cargar series temporales
async function loadTimeseries() {
  try {
    const { data, error } = await supabase.rpc('get_sales_timeseries', {
      p_from: currentFrom,
      p_to: currentTo,
      p_granularity: currentGranularity,
      p_channel: currentChannel
    });

    if (error) {
      console.error('Error cargando series temporales:', error);
      return;
    }

    renderRevenueChart(data);
    renderUnitsChart(data);
  } catch (error) {
    console.error('Error cargando series temporales:', error);
  }
}

// Renderizar gráfico de revenue
function renderRevenueChart(data) {
  const ctx = document.getElementById('revenue-chart').getContext('2d');
  
  if (revenueChart) {
    revenueChart.destroy();
  }

  const labels = data.map(d => {
    const date = new Date(d.date);
    if (currentGranularity === 'day') {
      return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
    } else if (currentGranularity === 'week') {
      return `Sem ${date.toLocaleDateString('es-AR', { week: 'numeric', month: 'short' })}`;
    } else {
      return date.toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });
    }
  });

  const datasets = [];
  if (currentChannel === 'all' || currentChannel === 'envios') {
    datasets.push({
      label: 'Envíos',
      data: data.map(d => d.envios_revenue || 0),
      borderColor: '#28a745',
      backgroundColor: 'rgba(40, 167, 69, 0.1)',
      tension: 0.4
    });
  }
  if (currentChannel === 'all' || currentChannel === 'publico') {
    datasets.push({
      label: 'Público',
      data: data.map(d => d.publico_revenue || 0),
      borderColor: '#007bff',
      backgroundColor: 'rgba(0, 123, 255, 0.1)',
      tension: 0.4
    });
  }
  if (currentChannel === 'all') {
    datasets.push({
      label: 'Total',
      data: data.map(d => d.total_revenue || 0),
      borderColor: '#CD844D',
      backgroundColor: 'rgba(205, 132, 77, 0.1)',
      tension: 0.4
    });
  }

  revenueChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${formatCurrency(context.parsed.y)}`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return formatCurrency(value);
            }
          }
        }
      }
    }
  });
}

// Renderizar gráfico de unidades
function renderUnitsChart(data) {
  const ctx = document.getElementById('units-chart').getContext('2d');
  
  if (unitsChart) {
    unitsChart.destroy();
  }

  const labels = data.map(d => {
    const date = new Date(d.date);
    if (currentGranularity === 'day') {
      return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
    } else if (currentGranularity === 'week') {
      return `Sem ${date.toLocaleDateString('es-AR', { week: 'numeric', month: 'short' })}`;
    } else {
      return date.toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });
    }
  });

  unitsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Unidades',
        data: data.map(d => d.units_total || 0),
        backgroundColor: '#CD844D',
        borderColor: '#B8734A',
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `Unidades: ${formatNumber(context.parsed.y)}`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return formatNumber(value);
            }
          }
        }
      }
    }
  });
}

// Cargar series temporales de clientes
async function loadCustomerTimeseries() {
  try {
    const { data, error } = await supabase.rpc('get_customer_timeseries', {
      p_from: currentFrom,
      p_to: currentTo,
      p_granularity: currentGranularity
    });

    if (error) {
      console.error('Error cargando series temporales de clientes:', error);
      return;
    }

    renderCustomersChart(data);
  } catch (error) {
    console.error('Error cargando series temporales de clientes:', error);
  }
}

// Renderizar gráfico de clientes
function renderCustomersChart(data) {
  const ctx = document.getElementById('customers-chart').getContext('2d');
  
  if (customersChart) {
    customersChart.destroy();
  }

  const labels = data.map(d => {
    const date = new Date(d.date);
    if (currentGranularity === 'day') {
      return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
    } else if (currentGranularity === 'week') {
      return `Sem ${date.toLocaleDateString('es-AR', { week: 'numeric', month: 'short' })}`;
    } else {
      return date.toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });
    }
  });

  customersChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Nuevos',
          data: data.map(d => d.new_customers || 0),
          borderColor: '#28a745',
          backgroundColor: 'rgba(40, 167, 69, 0.1)',
          tension: 0.4
        },
        {
          label: 'Compradores Únicos',
          data: data.map(d => d.buyers_unique || 0),
          borderColor: '#007bff',
          backgroundColor: 'rgba(0, 123, 255, 0.1)',
          tension: 0.4
        },
        {
          label: 'Que Volvieron',
          data: data.map(d => d.returning_buyers || 0),
          borderColor: '#ffc107',
          backgroundColor: 'rgba(255, 193, 7, 0.1)',
          tension: 0.4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top' }
      },
      scales: {
        y: {
          beginAtZero: true
        }
      }
    }
  });
}

// Cargar rankings
async function loadRankings() {
  await Promise.all([
    loadTopSKUs(),
    loadTopProducts(),
    loadTopCategories()
  ]);
}

// Cargar Top SKUs
async function loadTopSKUs() {
  try {
    const { data, error } = await supabase.rpc('get_top_skus', {
      p_from: currentFrom,
      p_to: currentTo,
      p_channel: currentChannel,
      p_limit: 20
    });

    if (error) {
      console.error('Error cargando Top SKUs:', error);
      document.getElementById('top-skus-table').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      return;
    }

    renderTopSKUs(data);
  } catch (error) {
    console.error('Error cargando Top SKUs:', error);
    document.getElementById('top-skus-table').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
  }
}

// Renderizar Top SKUs
function renderTopSKUs(data) {
  const container = document.getElementById('top-skus-table');
  
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay datos disponibles</div>';
    return;
  }

  const html = `
    <table class="stats-table">
      <thead>
        <tr>
          <th>SKU</th>
          <th>Producto</th>
          <th>Color</th>
          <th>Talle</th>
          <th>Categoría</th>
          <th class="text-right">Unidades</th>
          <th class="text-right">Revenue</th>
          <th class="text-right">Margen</th>
        </tr>
      </thead>
      <tbody>
        ${data.map(item => `
          <tr>
            <td>${item.sku || '-'}</td>
            <td>${item.title || '-'}</td>
            <td>${item.color || '-'}</td>
            <td>${item.size || '-'}</td>
            <td>${item.category || '-'}</td>
            <td class="text-right">${formatNumber(item.units || 0)}</td>
            <td class="text-right">${formatCurrency(item.revenue || 0)}</td>
            <td class="text-right">${formatCurrency(item.margin_amount || 0)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  container.innerHTML = html;
}

// Cargar Top Productos
async function loadTopProducts() {
  try {
    const { data, error } = await supabase.rpc('get_top_products', {
      p_from: currentFrom,
      p_to: currentTo,
      p_channel: currentChannel,
      p_limit: 20
    });

    if (error) {
      console.error('Error cargando Top Productos:', error);
      document.getElementById('top-products-table').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      return;
    }

    renderTopProducts(data);
  } catch (error) {
    console.error('Error cargando Top Productos:', error);
    document.getElementById('top-products-table').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
  }
}

// Renderizar Top Productos
function renderTopProducts(data) {
  const container = document.getElementById('top-products-table');
  
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay datos disponibles</div>';
    return;
  }

  const html = `
    <table class="stats-table">
      <thead>
        <tr>
          <th>Producto</th>
          <th>Categoría</th>
          <th class="text-right">Unidades</th>
          <th class="text-right">Revenue</th>
          <th class="text-right">Margen</th>
        </tr>
      </thead>
      <tbody>
        ${data.map(item => `
          <tr>
            <td>${item.product_name || '-'}</td>
            <td>${item.category || '-'}</td>
            <td class="text-right">${formatNumber(item.units || 0)}</td>
            <td class="text-right">${formatCurrency(item.revenue || 0)}</td>
            <td class="text-right">${formatCurrency(item.margin_amount || 0)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  container.innerHTML = html;
}

// Cargar Top Categorías
async function loadTopCategories() {
  try {
    const { data, error } = await supabase.rpc('get_top_categories', {
      p_from: currentFrom,
      p_to: currentTo,
      p_channel: currentChannel
    });

    if (error) {
      console.error('Error cargando Top Categorías:', error);
      document.getElementById('top-categories-table').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      return;
    }

    renderTopCategories(data);
  } catch (error) {
    console.error('Error cargando Top Categorías:', error);
    document.getElementById('top-categories-table').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
  }
}

// Renderizar Top Categorías
function renderTopCategories(data) {
  const container = document.getElementById('top-categories-table');
  
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay datos disponibles</div>';
    return;
  }

  const html = `
    <table class="stats-table">
      <thead>
        <tr>
          <th>Categoría</th>
          <th class="text-right">Unidades</th>
          <th class="text-right">Revenue</th>
        </tr>
      </thead>
      <tbody>
        ${data.map(item => `
          <tr>
            <td>${item.category || '-'}</td>
            <td class="text-right">${formatNumber(item.units || 0)}</td>
            <td class="text-right">${formatCurrency(item.revenue || 0)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  container.innerHTML = html;
}

// Cargar desglose de origen de pedidos
async function loadOrderSourceBreakdown() {
  try {
    const { data, error } = await supabase.rpc('get_order_source_breakdown', {
      p_from: currentFrom,
      p_to: currentTo
    });

    if (error) {
      console.error('Error cargando desglose de origen:', error);
      document.getElementById('order-source-breakdown').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      return;
    }

    renderOrderSourceBreakdown(data);
  } catch (error) {
    console.error('Error cargando desglose de origen:', error);
    document.getElementById('order-source-breakdown').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
  }
}

// Renderizar desglose de origen
function renderOrderSourceBreakdown(data) {
  const container = document.getElementById('order-source-breakdown');
  const totalOrders = (data.orders_customer || 0) + (data.orders_admin || 0);
  const totalRevenue = (data.revenue_customer || 0) + (data.revenue_admin || 0);

  const html = `
    <table class="stats-table">
      <thead>
        <tr>
          <th>Origen</th>
          <th class="text-right">Pedidos</th>
          <th class="text-right">%</th>
          <th class="text-right">Revenue</th>
          <th class="text-right">%</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Cliente (Web)</td>
          <td class="text-right">${formatNumber(data.orders_customer || 0)}</td>
          <td class="text-right">${totalOrders > 0 ? formatPercent((data.orders_customer || 0) / totalOrders * 100) : '0%'}</td>
          <td class="text-right">${formatCurrency(data.revenue_customer || 0)}</td>
          <td class="text-right">${totalRevenue > 0 ? formatPercent((data.revenue_customer || 0) / totalRevenue * 100) : '0%'}</td>
        </tr>
        <tr>
          <td>Admin</td>
          <td class="text-right">${formatNumber(data.orders_admin || 0)}</td>
          <td class="text-right">${totalOrders > 0 ? formatPercent((data.orders_admin || 0) / totalOrders * 100) : '0%'}</td>
          <td class="text-right">${formatCurrency(data.revenue_admin || 0)}</td>
          <td class="text-right">${totalRevenue > 0 ? formatPercent((data.revenue_admin || 0) / totalRevenue * 100) : '0%'}</td>
        </tr>
        <tr style="font-weight: 600; background: #f8f9fa;">
          <td>Total</td>
          <td class="text-right">${formatNumber(totalOrders)}</td>
          <td class="text-right">100%</td>
          <td class="text-right">${formatCurrency(totalRevenue)}</td>
          <td class="text-right">100%</td>
        </tr>
      </tbody>
    </table>
  `;
  container.innerHTML = html;
}

// Cargar métodos de registro
async function loadRegistrationMethods() {
  try {
    const { data, error } = await supabase.rpc('get_customer_registration_methods', {
      p_from: currentFrom,
      p_to: currentTo
    });

    if (error) {
      console.error('Error cargando métodos de registro:', error);
      document.getElementById('registration-methods').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
      return;
    }

    renderRegistrationMethods(data);
  } catch (error) {
    console.error('Error cargando métodos de registro:', error);
    document.getElementById('registration-methods').innerHTML = `<div class="empty-state">Error: ${error.message}</div>`;
  }
}

// Renderizar métodos de registro
function renderRegistrationMethods(data) {
  const container = document.getElementById('registration-methods');
  const total = (data.oauth || 0) + (data.magiclink || 0) + (data.admin_created || 0) + (data.email || 0);

  const html = `
    <table class="stats-table">
      <thead>
        <tr>
          <th>Método</th>
          <th class="text-right">Clientes</th>
          <th class="text-right">%</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>OAuth (Google)</td>
          <td class="text-right">${formatNumber(data.oauth || 0)}</td>
          <td class="text-right">${total > 0 ? formatPercent((data.oauth || 0) / total * 100) : '0%'}</td>
        </tr>
        <tr>
          <td>Magic Link</td>
          <td class="text-right">${formatNumber(data.magiclink || 0)}</td>
          <td class="text-right">${total > 0 ? formatPercent((data.magiclink || 0) / total * 100) : '0%'}</td>
        </tr>
        <tr>
          <td>Admin Creado</td>
          <td class="text-right">${formatNumber(data.admin_created || 0)}</td>
          <td class="text-right">${total > 0 ? formatPercent((data.admin_created || 0) / total * 100) : '0%'}</td>
        </tr>
        <tr>
          <td>Email</td>
          <td class="text-right">${formatNumber(data.email || 0)}</td>
          <td class="text-right">${total > 0 ? formatPercent((data.email || 0) / total * 100) : '0%'}</td>
        </tr>
        <tr style="font-weight: 600; background: #f8f9fa;">
          <td>Total</td>
          <td class="text-right">${formatNumber(total)}</td>
          <td class="text-right">100%</td>
        </tr>
      </tbody>
    </table>
  `;
  container.innerHTML = html;
}

// Recargar todos los datos
async function reloadAll() {
  const fromDate = document.getElementById('date-from').value;
  const toDate = document.getElementById('date-to').value;
  
  if (!fromDate || !toDate) {
    console.error('Fechas no válidas');
    return;
  }
  
  // Convertir fechas a UTC (asumiendo que el usuario selecciona fechas en zona horaria local)
  // Las fechas se interpretarán como medianoche en la zona horaria local y se convertirán a UTC
  currentFrom = fromDate + 'T00:00:00Z';
  currentTo = toDate + 'T23:59:59Z';
  currentGranularity = document.getElementById('granularity').value;

  await Promise.all([
    loadKPIs(),
    loadCustomerKPIs(),
    loadTimeseries(),
    loadCustomerTimeseries(),
    loadRankings(),
    loadOrderSourceBreakdown(),
    loadRegistrationMethods()
  ]);
}

// Inicializar módulo
async function initStatistics() {
  try {
    supabase = await getSupabase();
    
    if (!supabase) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      supabase = window.supabase;
      
      if (!supabase) {
        console.error('❌ No se pudo obtener Supabase');
        return;
      }
    }

    const isAdmin = await verifyAdminAuth();
    if (!isAdmin) {
      window.location.href = 'index.html';
      return;
    }

    // Inicializar fechas
    initDates();

    // Event listeners
    document.getElementById('date-from').addEventListener('change', reloadAll);
    document.getElementById('date-to').addEventListener('change', reloadAll);
    document.getElementById('granularity').addEventListener('change', reloadAll);

    // Filtros de canal
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentChannel = btn.dataset.channel;
        reloadAll();
      });
    });

    // Cargar datos iniciales
    await reloadAll();
  } catch (error) {
    console.error('Error inicializando estadísticas:', error);
  }
}

// Ejecutar cuando el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStatistics);
} else {
  initStatistics();
}

