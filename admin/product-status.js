// admin/product-status.js
import { requireAuth } from "./admin-auth.js?v=m260607";
import { supabase } from "../scripts/supabase-client.js?v=m260607";

await requireAuth();

let allProducts = [];
let filteredProducts = [];
let currentFilter = 'all';
let searchTerm = '';

// Función para mostrar mensajes
function showMessage(text, type = 'ok') {
  const container = document.getElementById('message-container');
  if (!container) return;
  
  container.innerHTML = `<div class="message ${type}">${text}</div>`;
  
  if (type === 'ok') {
    setTimeout(() => {
      container.innerHTML = '';
    }, 5000);
  }
}

// Función para formatear fecha
function formatDate(dateString) {
  if (!dateString) return '-';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('es-AR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (e) {
    return dateString;
  }
}

// Función para obtener badge de estado
function getStatusBadge(status) {
  const badges = {
    active: '<span class="status-badge active">Active</span>',
    draft: '<span class="status-badge draft">Draft</span>',
    pending_stock: '<span class="status-badge pending_stock">Pending Stock</span>'
  };
  return badges[status] || `<span class="status-badge draft">${status || 'N/A'}</span>`;
}

// Función para cargar productos desde Supabase
async function loadProducts(filterStatus = null) {
  try {
    const tbody = document.getElementById('products-tbody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando productos...</td></tr>';
    }

    let query = supabase
      .from('products')
      .select('id, name, handle, category, status, created_at, updated_at')
      .order('created_at', { ascending: false });
    
    if (filterStatus && filterStatus !== 'all') {
      query = query.eq('status', filterStatus);
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error('Error cargando productos:', error);
      showMessage(`Error cargando productos: ${error.message}`, 'err');
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:#721c24;">Error al cargar productos</td></tr>';
      }
      return [];
    }

    console.log(`📦 Productos cargados: ${(data || []).length}`);
    return data || [];
  } catch (err) {
    console.error('Error en loadProducts:', err);
    showMessage(`Error: ${err.message}`, 'err');
    return [];
  }
}

// Función para actualizar estadísticas
function updateStats(products) {
  const stats = {
    total: products.length,
    active: products.filter(p => p.status === 'active').length,
    draft: products.filter(p => p.status === 'draft').length,
    pending_stock: products.filter(p => p.status === 'pending_stock').length
  };

  const statTotal = document.getElementById('stat-total');
  const statActive = document.getElementById('stat-active');
  const statDraft = document.getElementById('stat-draft');
  const statPending = document.getElementById('stat-pending');

  if (statTotal) statTotal.textContent = stats.total;
  if (statActive) statActive.textContent = stats.active;
  if (statDraft) statDraft.textContent = stats.draft;
  if (statPending) statPending.textContent = stats.pending_stock;
}

// Función para renderizar la tabla de productos
function renderTable(products) {
  const tbody = document.getElementById('products-tbody');
  if (!tbody) return;

  if (!products || products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No se encontraron productos</td></tr>';
    return;
  }

  const rows = products.map((product, index) => {
    const statusOptions = ['active', 'draft', 'pending_stock']
      .map(status => {
        const selected = product.status === status ? 'selected' : '';
        const label = status === 'pending_stock' ? 'Pending Stock' : status.charAt(0).toUpperCase() + status.slice(1);
        return `<option value="${status}" ${selected}>${label}</option>`;
      })
      .join('');

    // Escapar comillas simples y dobles en el nombre
    const safeName = (product.name || product.handle || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');

    return `
      <tr>
        <td><strong>${product.name || '-'}</strong></td>
        <td><code style="background:#f8f9fa;padding:2px 6px;border-radius:4px;font-size:12px;">${product.handle || '-'}</code></td>
        <td>${product.category || '-'}</td>
        <td>${getStatusBadge(product.status)}</td>
        <td>
          <select 
            class="action-select" 
            data-product-id="${product.id}"
            data-current-status="${product.status}"
            data-product-name="${safeName}"
          >
            ${statusOptions}
          </select>
        </td>
        <td style="font-size:12px;color:#6c757d;">${formatDate(product.updated_at || product.created_at)}</td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = rows;

  // Agregar event listeners a los selects
  const selects = tbody.querySelectorAll('.action-select');
  selects.forEach(select => {
    select.addEventListener('change', function() {
      const productId = this.dataset.productId;
      const newStatus = this.value;
      const productName = this.dataset.productName || 'Producto';
      handleStatusChange(productId, newStatus, productName, this);
    });
  });
}

// Función para manejar el cambio de estado
async function handleStatusChange(productId, newStatus, productName, selectElement = null) {
  const currentStatusElement = selectElement || document.querySelector(`select[data-product-id="${productId}"]`);
  const currentStatus = currentStatusElement?.dataset.currentStatus;

  if (currentStatus === newStatus) {
    return; // No hay cambio
  }

  // Confirmar cambio, especialmente si es de active a draft
  let confirmMessage = `¿Cambiar el estado del producto "${productName}" de "${currentStatus}" a "${newStatus}"?`;
  
  if (currentStatus === 'active' && newStatus === 'draft') {
    confirmMessage += '\n\n⚠️ El producto dejará de mostrarse en el catálogo público (index.html).';
  } else if (currentStatus === 'draft' && newStatus === 'active') {
    confirmMessage += '\n\n✅ El producto aparecerá en el catálogo público (index.html).';
  }

  if (!confirm(confirmMessage)) {
    // Restaurar el valor anterior en el select
    if (currentStatusElement) {
      currentStatusElement.value = currentStatus;
    }
    return;
  }

  try {
    const { error } = await supabase
      .from('products')
      .update({ status: newStatus })
      .eq('id', productId);

    if (error) {
      throw error;
    }

    showMessage(`Estado actualizado: "${productName}" ahora es "${newStatus}"`, 'ok');
    
    // Recargar productos
    await refreshProducts();
  } catch (err) {
    console.error('Error actualizando estado:', err);
    showMessage(`Error al actualizar estado: ${err.message}`, 'err');
    
    // Restaurar el valor anterior en el select
    if (currentStatusElement) {
      currentStatusElement.value = currentStatus;
    }
  }
}

// Hacer función global para que funcione desde el HTML
window.handleStatusChange = handleStatusChange;

// Función para filtrar productos localmente por búsqueda
function filterProducts(products, searchTerm) {
  if (!searchTerm || searchTerm.trim() === '') {
    return products;
  }

  const term = searchTerm.toLowerCase().trim();
  return products.filter(product => {
    const name = (product.name || '').toLowerCase();
    const handle = (product.handle || '').toLowerCase();
    const category = (product.category || '').toLowerCase();
    return name.includes(term) || handle.includes(term) || category.includes(term);
  });
}

// Función para refrescar productos
async function refreshProducts() {
  allProducts = await loadProducts(currentFilter);
  filteredProducts = filterProducts(allProducts, searchTerm);
  updateStats(allProducts);
  renderTable(filteredProducts);
}

// Función debounce para búsqueda
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Inicializar
async function init() {
  // Cargar productos iniciales
  await refreshProducts();

  // Event listeners para filtros
  const filterTabs = document.querySelectorAll('.filter-tab');
  filterTabs.forEach(tab => {
    tab.addEventListener('click', async () => {
      // Remover active de todos
      filterTabs.forEach(t => t.classList.remove('active'));
      // Agregar active al clickeado
      tab.classList.add('active');
      
      // Actualizar filtro y recargar
      currentFilter = tab.dataset.filter;
      allProducts = await loadProducts(currentFilter);
      filteredProducts = filterProducts(allProducts, searchTerm);
      updateStats(allProducts);
      renderTable(filteredProducts);
    });
  });

  // Event listener para búsqueda
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    const handleSearch = debounce((e) => {
      searchTerm = e.target.value;
      filteredProducts = filterProducts(allProducts, searchTerm);
      renderTable(filteredProducts);
    }, 300);

    searchInput.addEventListener('input', handleSearch);
  }
}

// Inicializar cuando el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}