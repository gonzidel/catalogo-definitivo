// admin/offers.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";

await requireAuth();

// Estado global
let currentProduct = null;
let currentProductVariants = [];
let selectedPromoItems = []; // Array de {type: 'product'|'variant', id: uuid, name: string}

// Variables para elementos del DOM (se inicializarán cuando el DOM esté listo)
let tabs, tabContents, productSearch, productSuggestions, searchProductBtn;
let productInfo, productName, colorsList, offersList;
let promoType, fixedAmountGroup, fixedAmount, promoStartDate, promoEndDate;
let promoStatus, promoStatusText, promoItemSearch, promoItemSuggestions;
let addPromoItemBtn, selectedItems, createPromoBtn, promotionsList;
let offerCampaignId, refreshCampaignsBtn;

// Inicialización
function init() {
  // Obtener elementos del DOM
  tabs = document.querySelectorAll('.tab');
  tabContents = document.querySelectorAll('.tab-content');
  productSearch = document.getElementById('product-search');
  productSuggestions = document.getElementById('product-suggestions');
  searchProductBtn = document.getElementById('search-product-btn');
  productInfo = document.getElementById('product-info');
  productName = document.getElementById('product-name');
  colorsList = document.getElementById('colors-list');
  offersList = document.getElementById('offers-list');

  // Promociones
  promoType = document.getElementById('promo-type');
  fixedAmountGroup = document.getElementById('fixed-amount-group');
  fixedAmount = document.getElementById('fixed-amount');
  promoStartDate = document.getElementById('promo-start-date');
  promoEndDate = document.getElementById('promo-end-date');
  promoStatus = document.getElementById('promo-status');
  promoStatusText = document.getElementById('promo-status-text');
  promoItemSearch = document.getElementById('promo-item-search');
  promoItemSuggestions = document.getElementById('promo-item-suggestions');
  addPromoItemBtn = document.getElementById('add-promo-item-btn');
  selectedItems = document.getElementById('selected-items');
  createPromoBtn = document.getElementById('create-promo-btn');
  promotionsList = document.getElementById('promotions-list');

  // Campañas de oferta
  offerCampaignId = document.getElementById('offer-campaign-id');
  refreshCampaignsBtn = document.getElementById('refresh-campaigns-btn');

  // Inicializar funcionalidades
  initTabs();
  initProductSearch();
  initPromoForm();
  initOfferImagePreview();
  initPromoImagePreview();
  loadOfferCampaigns();
  loadOffers();
  loadPromotions();
  
  // Event listener para actualizar campañas
  if (refreshCampaignsBtn) {
    refreshCampaignsBtn.addEventListener('click', () => {
      loadOfferCampaigns();
      showMessage('Lista de campañas actualizada', 'success');
    });
  }
  
  // Establecer fechas por defecto
  if (promoStartDate && promoEndDate) {
    const today = new Date().toISOString().split('T')[0];
    promoStartDate.value = today;
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    promoEndDate.value = nextMonth.toISOString().split('T')[0];
  }
}

// Esperar a que el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM ya está listo
  init();
}

// Tabs
function initTabs() {
  if (!tabs || tabs.length === 0) {
    console.warn('Tabs no encontrados');
    return;
  }
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(tc => tc.classList.remove('active'));
      
      tab.classList.add('active');
      const targetContent = document.getElementById(`${targetTab}-tab`);
      if (targetContent) {
        targetContent.classList.add('active');
      }
    });
  });
}

// Búsqueda de productos
function initProductSearch() {
  let searchTimeout = null;
  
  productSearch?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const term = e.target.value.trim();
    
    if (term.length < 2) {
      productSuggestions.innerHTML = '';
      return;
    }
    
    searchTimeout = setTimeout(() => {
      searchProducts(term);
    }, 300);
  });
  
  searchProductBtn?.addEventListener('click', async () => {
    const term = productSearch.value.trim();
    if (!term) {
      showMessage('Ingrese un término de búsqueda', 'error');
      return;
    }
    await searchProducts(term);
    await loadProduct(term);
  });
  
  productSearch?.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const term = productSearch.value.trim();
      if (term) {
        await searchProducts(term);
        await loadProduct(term);
      }
    }
  });
}

async function searchProducts(term) {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('id, name, category')
      .ilike('name', `%${term}%`)
      .eq('status', 'active')
      .limit(10);
    
    if (error) throw error;
    
    productSuggestions.innerHTML = '';
    if (data && data.length > 0) {
      data.forEach(product => {
        const option = document.createElement('option');
        option.value = product.name;
        option.setAttribute('data-product-id', product.id);
        productSuggestions.appendChild(option);
      });
    }
  } catch (error) {
    console.error('Error buscando productos:', error);
  }
}

async function loadProduct(searchTerm) {
  try {
    const { data: productsData, error } = await supabase
      .from('products')
      .select('id, name, category')
      .ilike('name', searchTerm)
      .eq('status', 'active')
      .limit(1);
    
    if (error) {
      console.error('Error en consulta:', error);
      showMessage('Error al buscar producto: ' + error.message, 'error');
      return;
    }
    
    if (!productsData || productsData.length === 0) {
      showMessage('Producto no encontrado', 'error');
      return;
    }
    
    const products = productsData[0];
    currentProduct = products;
    
    // Cargar variantes
    const { data: variants, error: variantsError } = await supabase
      .from('product_variants')
      .select('id, color, size, price, active')
      .eq('product_id', products.id)
      .eq('active', true)
      .order('color, size');
    
    if (variantsError) throw variantsError;
    
    currentProductVariants = variants || [];
    
    // Mostrar información del producto
    const productNameEl = document.getElementById('product-name');
    const productInfoEl = document.getElementById('product-info');
    
    if (productNameEl) {
      productNameEl.textContent = products.name;
    }
    if (productInfoEl) {
      productInfoEl.classList.add('active');
    }
    
    // Renderizar colores
    renderColors();
    
    // Cargar ofertas existentes para este producto
    await loadProductOffers();
  } catch (error) {
    console.error('Error cargando producto:', error);
    showMessage('Error al cargar producto: ' + error.message, 'error');
  }
}

function renderColors() {
  const colorsListEl = document.getElementById('colors-list');
  if (!colorsListEl) {
    console.error('colors-list no encontrado');
    return;
  }
  
  const colors = [...new Set(currentProductVariants.map(v => v.color).filter(Boolean))];
  
  colorsListEl.innerHTML = '';
  
  colors.forEach(color => {
    const colorItem = document.createElement('div');
    colorItem.className = 'color-item';
    colorItem.innerHTML = `
      <h4>Color: ${color}</h4>
      <div class="form-row">
        <div class="form-group">
          <label>Precio Oferta *</label>
          <input type="number" class="offer-price" data-color="${color}" placeholder="0.00" step="0.01" min="0.01" />
        </div>
        <div class="form-group">
          <label>Fecha Inicio *</label>
          <input type="date" class="offer-start-date" data-color="${color}" />
        </div>
        <div class="form-group">
          <label>Fecha Fin *</label>
          <input type="date" class="offer-end-date" data-color="${color}" />
        </div>
        <div class="form-group">
          <label>Estado</label>
          <label class="toggle-switch">
            <input type="checkbox" class="offer-status" data-color="${color}" checked />
            <span class="toggle-slider"></span>
          </label>
          <span class="offer-status-text">Activa</span>
        </div>
      </div>
      <button class="btn btn-primary save-offer-btn" data-color="${color}" style="margin-top: 8px;">Guardar Oferta</button>
    `;
    
    colorsListEl.appendChild(colorItem);
    
    // Event listeners para el toggle
    const toggle = colorItem.querySelector('.offer-status');
    const statusText = colorItem.querySelector('.offer-status-text');
    toggle.addEventListener('change', (e) => {
      statusText.textContent = e.target.checked ? 'Activa' : 'Inactiva';
    });
    
    // Event listener para guardar
    const saveBtn = colorItem.querySelector('.save-offer-btn');
    saveBtn.addEventListener('click', () => saveOffer(color));
  });
}

async function loadProductOffers() {
  if (!currentProduct) return;
  
  try {
    const { data, error } = await supabase
      .from('color_price_offers')
      .select('*')
      .eq('product_id', currentProduct.id)
      .order('color, created_at', { ascending: false });
    
    if (error) throw error;
    
    // Pre-llenar formularios con ofertas existentes
    data.forEach(offer => {
      const priceInput = document.querySelector(`.offer-price[data-color="${offer.color}"]`);
      const startInput = document.querySelector(`.offer-start-date[data-color="${offer.color}"]`);
      const endInput = document.querySelector(`.offer-end-date[data-color="${offer.color}"]`);
      const statusToggle = document.querySelector(`.offer-status[data-color="${offer.color}"]`);
      const statusText = document.querySelector(`.offer-status-text`);
      
      if (priceInput) priceInput.value = offer.offer_price;
      if (startInput) startInput.value = offer.start_date;
      if (endInput) endInput.value = offer.end_date;
      if (statusToggle) {
        statusToggle.checked = offer.status === 'active';
        if (statusText) statusText.textContent = offer.status === 'active' ? 'Activa' : 'Inactiva';
      }
    });
  } catch (error) {
    console.error('Error cargando ofertas del producto:', error);
  }
}

// Función para subir imagen a Supabase Storage
async function uploadOfferImage(file) {
  if (!file) return null;
  
  try {
    // Verificar/crear bucket
    const bucketName = 'offer-images';
    
    // Intentar crear el bucket si no existe (esto puede fallar si ya existe, está bien)
    try {
      const { data: buckets } = await supabase.storage.listBuckets();
      const bucketExists = buckets?.some(b => b.name === bucketName);
      
      if (!bucketExists) {
        const { error: createError } = await supabase.storage.createBucket(bucketName, {
          public: true,
          fileSizeLimit: 5242880, // 5MB
          allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp']
        });
        
        if (createError && createError.message !== 'duplicate key value violates unique constraint') {
          console.warn('No se pudo crear bucket (puede que ya exista):', createError);
        }
      }
    } catch (e) {
      console.warn('Error verificando bucket:', e);
    }
    
    // Generar nombre único para el archivo
    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
    const filePath = `${fileName}`;
    
    // Subir archivo
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: false
      });
    
    if (error) throw error;
    
    // Obtener URL pública
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);
    
    return urlData?.publicUrl || null;
  } catch (error) {
    console.error('Error subiendo imagen:', error);
    throw new Error('No se pudo subir la imagen: ' + error.message);
  }
}

// Función para subir imagen de promoción a Supabase Storage
async function uploadPromoImage(file) {
  if (!file) return null;
  
  try {
    // Verificar/crear bucket
    const bucketName = 'promo-images';
    
    // Intentar crear el bucket si no existe (esto puede fallar si ya existe, está bien)
    try {
      const { data: buckets } = await supabase.storage.listBuckets();
      const bucketExists = buckets?.some(b => b.name === bucketName);
      
      if (!bucketExists) {
        const { error: createError } = await supabase.storage.createBucket(bucketName, {
          public: true,
          fileSizeLimit: 5242880, // 5MB
          allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp']
        });
        
        if (createError && createError.message !== 'duplicate key value violates unique constraint') {
          console.warn('No se pudo crear bucket (puede que ya exista):', createError);
        }
      }
    } catch (e) {
      console.warn('Error verificando bucket:', e);
    }
    
    // Generar nombre único para el archivo
    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
    const filePath = `${fileName}`;
    
    // Subir archivo
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: false
      });
    
    if (error) throw error;
    
    // Obtener URL pública
    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filePath);
    
    return urlData?.publicUrl || null;
  } catch (error) {
    console.error('Error subiendo imagen de promoción:', error);
    throw new Error('No se pudo subir la imagen: ' + error.message);
  }
}

async function saveOffer(color) {
  if (!currentProduct) {
    showMessage('Primero seleccione un producto', 'error');
    return;
  }
  
  const priceInput = document.querySelector(`.offer-price[data-color="${color}"]`);
  const startInput = document.querySelector(`.offer-start-date[data-color="${color}"]`);
  const endInput = document.querySelector(`.offer-end-date[data-color="${color}"]`);
  const statusToggle = document.querySelector(`.offer-status[data-color="${color}"]`);
  const imageInput = document.getElementById('offer-image-input');
  const titleInput = document.getElementById('offer-title');
  const campaignIdSelect = document.getElementById('offer-campaign-id');
  const saveBtn = document.querySelector(`.save-offer-btn[data-color="${color}"]`);
  
  const offerPrice = parseFloat(priceInput?.value);
  const startDate = startInput?.value;
  const endDate = endInput?.value;
  const status = statusToggle?.checked ? 'active' : 'inactive';
  const offerTitle = titleInput?.value?.trim() || null;
  const campaignId = campaignIdSelect?.value?.trim() || null;
  
  // Verificar si estamos editando una oferta específica
  const editingOfferId = saveBtn?.dataset.offerId;
  
  if (!offerPrice || offerPrice <= 0) {
    showMessage('El precio de oferta debe ser mayor a 0', 'error');
    return;
  }
  
  if (!startDate || !endDate) {
    showMessage('Debe completar las fechas de inicio y fin', 'error');
    return;
  }
  
  if (new Date(endDate) < new Date(startDate)) {
    showMessage('La fecha fin debe ser posterior a la fecha inicio', 'error');
    return;
  }
  
  // Obtener datos de oferta existente si estamos editando
  let existingOffer = null;
  let existingCampaignId = null;
  let existingImageUrl = null;
  
  if (editingOfferId) {
    // Modo edición: cargar datos de la oferta específica
    const { data, error } = await supabase
      .from('color_price_offers')
      .select('id, offer_campaign_id, offer_image_url, offer_title')
      .eq('id', editingOfferId)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    existingOffer = data;
    existingCampaignId = data?.offer_campaign_id || null;
    existingImageUrl = data?.offer_image_url || null;
  } else {
    // Modo creación: verificar si ya existe una oferta para este producto y color
    const { data: existing, error: checkError } = await supabase
      .from('color_price_offers')
      .select('id, offer_campaign_id, offer_image_url')
      .eq('product_id', currentProduct.id)
      .eq('color', color)
      .maybeSingle();
    
    if (checkError && checkError.code !== 'PGRST116') throw checkError;
    existingOffer = existing;
    existingCampaignId = existing?.offer_campaign_id || null;
    existingImageUrl = existing?.offer_image_url || null;
  }
  
  let offerImageUrl = existingImageUrl;
  let finalCampaignId = campaignId || existingCampaignId || null;
  
  // Si hay una nueva imagen, subirla
  if (imageInput?.files && imageInput.files.length > 0) {
    try {
      offerImageUrl = await uploadOfferImage(imageInput.files[0]);
      if (!offerImageUrl) {
        showMessage('Error al subir la imagen', 'error');
        return;
      }
    } catch (error) {
      showMessage('Error al subir la imagen: ' + error.message, 'error');
      return;
    }
  }
  
  // Si no hay campaign_id, generar uno nuevo
  if (!finalCampaignId) {
    finalCampaignId = crypto.randomUUID();
  }
  
  // La imagen es opcional, no se requiere validación
  
  try {
    // Preparar datos de actualización/inserción
    const offerData = {
      offer_price: offerPrice,
      start_date: startDate,
      end_date: endDate,
      status: status,
      offer_campaign_id: finalCampaignId,
      offer_title: offerTitle
    };
    
    // Solo actualizar imagen si se subió una nueva
    if (offerImageUrl) {
      offerData.offer_image_url = offerImageUrl;
    }
    
    if (existingOffer) {
      // Actualizar oferta existente
      const { error: updateError } = await supabase
        .from('color_price_offers')
        .update(offerData)
        .eq('id', existingOffer.id);
      
      if (updateError) throw updateError;
      
      // Si se subió una nueva imagen y hay un campaign_id, actualizar todas las ofertas de la campaña
      if (finalCampaignId && imageInput?.files && imageInput.files.length > 0 && offerImageUrl) {
        const updateData = {
          offer_title: offerTitle || null
        };
        
        // Solo actualizar la imagen si se subió una nueva
        if (offerImageUrl) {
          updateData.offer_image_url = offerImageUrl;
        }
        
        const { error: campaignUpdateError } = await supabase
          .from('color_price_offers')
          .update(updateData)
          .eq('offer_campaign_id', finalCampaignId)
          .neq('id', existingOffer.id);
        
        if (campaignUpdateError) {
          console.warn('Error actualizando otras ofertas de la campaña:', campaignUpdateError);
          // No fallar si esto falla, solo mostrar advertencia
        }
      }
      
      showMessage('Oferta actualizada correctamente', 'success');
      
      // Limpiar el data-offer-id del botón para permitir crear nuevas ofertas
      if (saveBtn) {
        delete saveBtn.dataset.offerId;
        saveBtn.textContent = 'Guardar Oferta';
      }
      
      // Limpiar indicador visual de edición
      const colorItem = priceInput?.closest('.color-item');
      if (colorItem) {
        colorItem.style.border = '';
        colorItem.style.background = '';
        const editBadge = colorItem.querySelector('div[style*="CD844D"]');
        if (editBadge) editBadge.remove();
      }
      
      // Remover información de campaña si existe
      const campaignInfo = document.querySelector('.campaign-info');
      if (campaignInfo) campaignInfo.remove();
      
      // Remover botón de cancelar edición
      const cancelBtn = document.querySelector('.cancel-edit-btn');
      if (cancelBtn) cancelBtn.remove();
    } else {
      // Crear nueva oferta
      const { error: insertError } = await supabase
        .from('color_price_offers')
        .insert({
          product_id: currentProduct.id,
          color: color,
          ...offerData
        });
      
      if (insertError) throw insertError;
      showMessage('Oferta creada correctamente', 'success');
    }
    
    // Limpiar formulario de imagen solo si se subió una nueva
    if (imageInput && imageInput.files && imageInput.files.length > 0) {
      imageInput.value = '';
      const preview = document.getElementById('offer-image-preview');
      if (preview) preview.style.display = 'none';
    }
    
    await loadOffers();
    // Recargar campañas para actualizar la lista
    await loadOfferCampaigns();
  } catch (error) {
    console.error('Error guardando oferta:', error);
    showMessage('Error al guardar oferta: ' + error.message, 'error');
  }
}

// Función para cargar campañas de ofertas existentes
async function loadOfferCampaigns() {
  if (!offerCampaignId) return;
  
  try {
    // Obtener todas las campañas únicas con información agregada
    const { data: campaigns, error } = await supabase
      .from('color_price_offers')
      .select(`
        offer_campaign_id,
        offer_title,
        offer_image_url,
        start_date,
        end_date
      `)
      .not('offer_campaign_id', 'is', null)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    // Agrupar por campaign_id y obtener información
    const campaignMap = new Map();
    
    if (campaigns && campaigns.length > 0) {
      campaigns.forEach(offer => {
        const campaignId = offer.offer_campaign_id;
        if (!campaignMap.has(campaignId)) {
          campaignMap.set(campaignId, {
            id: campaignId,
            title: offer.offer_title || 'Sin título',
            imageUrl: offer.offer_image_url,
            startDate: offer.start_date,
            endDate: offer.end_date
          });
        }
      });
      
      // Contar ofertas por campaña
      const campaignCounts = await Promise.all(
        Array.from(campaignMap.keys()).map(async (campaignId) => {
          const { count, error: countError } = await supabase
            .from('color_price_offers')
            .select('*', { count: 'exact', head: true })
            .eq('offer_campaign_id', campaignId);
          
          if (countError) {
            console.error('Error contando ofertas:', countError);
            return { campaignId, count: 0 };
          }
          
          return { campaignId, count: count || 0 };
        })
      );
      
      // Agregar conteos a las campañas
      campaignCounts.forEach(({ campaignId, count }) => {
        const campaign = campaignMap.get(campaignId);
        if (campaign) {
          campaign.count = count;
        }
      });
    }
    
    // Limpiar y poblar el select
    const currentValue = offerCampaignId.value;
    offerCampaignId.innerHTML = '<option value="">-- Crear Nueva Campaña --</option>';
    
    // Ordenar campañas por título
    const sortedCampaigns = Array.from(campaignMap.values()).sort((a, b) => 
      a.title.localeCompare(b.title)
    );
    
    sortedCampaigns.forEach(campaign => {
      const option = document.createElement('option');
      option.value = campaign.id;
      option.textContent = `${campaign.title} (${campaign.count} oferta${campaign.count !== 1 ? 's' : ''})`;
      option.setAttribute('data-title', campaign.title);
      offerCampaignId.appendChild(option);
    });
    
    // Restaurar valor anterior si existe
    if (currentValue) {
      offerCampaignId.value = currentValue;
    }
    
    // Si hay campañas, actualizar el título automáticamente cuando se selecciona una
    offerCampaignId.addEventListener('change', (e) => {
      const selectedOption = e.target.options[e.target.selectedIndex];
      if (selectedOption && selectedOption.value) {
        const title = selectedOption.getAttribute('data-title');
        const titleInput = document.getElementById('offer-title');
        if (titleInput && title) {
          titleInput.value = title;
        }
      }
    });
  } catch (error) {
    console.error('Error cargando campañas:', error);
    // No mostrar error al usuario, solo dejar el select vacío
  }
}

async function loadOffers() {
  if (!offersList) return;
  
  try {
    const { data, error } = await supabase
      .from('color_price_offers')
      .select(`
        *,
        products!inner(id, name, category)
      `)
      .order('created_at', { ascending: false })
      .limit(100);
    
    if (error) {
      console.error('Error cargando ofertas:', error);
      offersList.innerHTML = '<p>Error al cargar ofertas: ' + error.message + '</p>';
      return;
    }
    
    if (!data || data.length === 0) {
      offersList.innerHTML = '<p>No hay ofertas creadas</p>';
      return;
    }
    
    offersList.innerHTML = data.map(offer => {
      const product = offer.products;
      const statusClass = offer.status === 'active' ? 'status-active' : 'status-inactive';
      const statusText = offer.status === 'active' ? 'Activa' : 'Inactiva';
      
      return `
        <div class="list-item">
          <div class="list-item-info">
            <h4>${escapeHtml(product.name)} - ${escapeHtml(offer.color)}</h4>
            <p><strong>Precio Oferta:</strong> $${offer.offer_price.toLocaleString('es-AR')}</p>
            <p><strong>Fechas:</strong> ${formatDate(offer.start_date)} - ${formatDate(offer.end_date)}</p>
            <p><span class="status-badge ${statusClass}">${statusText}</span></p>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-secondary" onclick="editOffer('${offer.id}')">Editar</button>
            <button class="btn btn-danger" onclick="deleteOffer('${offer.id}')">Eliminar</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Error cargando ofertas:', error);
    if (offersList) {
      offersList.innerHTML = '<p>Error al cargar ofertas: ' + error.message + '</p>';
    }
  }
}

async function deleteOffer(offerId) {
  if (!confirm('¿Está seguro de eliminar esta oferta?')) return;
  
  try {
    const { error } = await supabase
      .from('color_price_offers')
      .delete()
      .eq('id', offerId);
    
    if (error) throw error;
    
    showMessage('Oferta eliminada correctamente', 'success');
    await loadOffers();
  } catch (error) {
    console.error('Error eliminando oferta:', error);
    showMessage('Error al eliminar oferta: ' + error.message, 'error');
  }
}

// Promociones
// Inicializar vista previa de imagen de oferta
function initOfferImagePreview() {
  const imageInput = document.getElementById('offer-image-input');
  const preview = document.getElementById('offer-image-preview');
  const previewImg = document.getElementById('offer-image-preview-img');
  const removeBtn = document.getElementById('remove-offer-image');
  
  if (imageInput && preview && previewImg) {
    imageInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          previewImg.src = event.target.result;
          preview.style.display = 'block';
        };
        reader.readAsDataURL(file);
      }
    });
  }
  
  if (removeBtn && imageInput && preview) {
    removeBtn.addEventListener('click', () => {
      if (imageInput) imageInput.value = '';
      if (preview) preview.style.display = 'none';
      if (previewImg) previewImg.src = '';
    });
  }
}

// Inicializar vista previa de imagen de promoción
function initPromoImagePreview() {
  const imageInput = document.getElementById('promo-image-input');
  const preview = document.getElementById('promo-image-preview');
  const previewImg = document.getElementById('promo-image-preview-img');
  const removeBtn = document.getElementById('remove-promo-image');
  
  if (imageInput && preview && previewImg) {
    imageInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          previewImg.src = event.target.result;
          preview.style.display = 'block';
        };
        reader.readAsDataURL(file);
      }
    });
  }
  
  if (removeBtn && imageInput && preview) {
    removeBtn.addEventListener('click', () => {
      if (imageInput) imageInput.value = '';
      if (preview) preview.style.display = 'none';
      if (previewImg) previewImg.src = '';
    });
  }
}

function initPromoForm() {
  if (!promoType) {
    console.warn('Elementos de promoción no encontrados');
    return;
  }
  
  promoType.addEventListener('change', (e) => {
    if (e.target.value === '2xMonto') {
      if (fixedAmountGroup) fixedAmountGroup.style.display = 'block';
      if (fixedAmount) fixedAmount.required = true;
    } else {
      if (fixedAmountGroup) fixedAmountGroup.style.display = 'none';
      if (fixedAmount) {
        fixedAmount.required = false;
        fixedAmount.value = '';
      }
    }
  });
  
  if (promoStatus && promoStatusText) {
    promoStatus.addEventListener('change', (e) => {
      promoStatusText.textContent = e.target.checked ? 'Activa' : 'Inactiva';
    });
  }
  
  // Búsqueda de items para promoción
  let searchTimeout = null;
  if (promoItemSearch) {
    promoItemSearch.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      const term = e.target.value.trim();
      
      if (term.length < 2) {
        if (promoItemSuggestions) promoItemSuggestions.innerHTML = '';
        return;
      }
      
      searchTimeout = setTimeout(() => {
        searchPromoItems(term);
      }, 300);
    });
  }
  
  if (addPromoItemBtn) {
    addPromoItemBtn.addEventListener('click', () => {
      const term = promoItemSearch?.value.trim();
      if (term) {
        addPromoItem(term);
      }
    });
  }
  
  if (createPromoBtn) {
    createPromoBtn.addEventListener('click', () => {
      createPromotion();
    });
  }
}

async function searchPromoItems(term) {
  try {
    if (!promoItemSuggestions) return;
    
    // Buscar productos
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, name, category, cost')
      .ilike('name', `%${term}%`)
      .eq('status', 'active')
      .limit(5);
    
    if (productsError) {
      console.error('Error buscando productos:', productsError);
      throw productsError;
    }
    
    // Buscar variantes por SKU
    const { data: variantsBySku, error: variantsSkuError } = await supabase
      .from('product_variants')
      .select('id, sku, color, size, products!inner(id, name, cost)')
      .ilike('sku', `%${term}%`)
      .eq('active', true)
      .limit(5);
    
    // Buscar productos que coincidan con el término
    const { data: matchingProducts, error: productsMatchError } = await supabase
      .from('products')
      .select('id')
      .ilike('name', `%${term}%`)
      .eq('status', 'active')
      .limit(10);
    
    // Buscar variantes de productos que coincidan
    let variantsByName = [];
    if (!productsMatchError && matchingProducts && matchingProducts.length > 0) {
      const productIds = matchingProducts.map(p => p.id);
      const { data: variantsData, error: variantsNameError } = await supabase
        .from('product_variants')
        .select('id, sku, color, size, products!inner(id, name, cost)')
        .in('product_id', productIds)
        .eq('active', true)
        .limit(5);
      
      if (!variantsNameError && variantsData) {
        variantsByName = variantsData;
      }
    }
    
    // Combinar resultados, evitando duplicados
    const variantMap = new Map();
    if (!variantsSkuError && variantsBySku) {
      variantsBySku.forEach(v => variantMap.set(v.id, v));
    }
    variantsByName.forEach(v => variantMap.set(v.id, v));
    const variants = Array.from(variantMap.values()).slice(0, 5);
    
    if (variantsSkuError && productsMatchError) {
      console.error('Error buscando variantes:', variantsSkuError || productsMatchError);
      throw variantsSkuError || productsMatchError;
    }
    
    promoItemSuggestions.innerHTML = '';
    
    if (products && products.length > 0) {
      products.forEach(product => {
        const option = document.createElement('option');
        option.value = `${product.name} (Producto)`;
        option.setAttribute('data-type', 'product');
        option.setAttribute('data-id', product.id);
        option.setAttribute('data-name', product.name);
        option.setAttribute('data-cost', product.cost || '');
        promoItemSuggestions.appendChild(option);
      });
    }
    
    if (variants && variants.length > 0) {
      variants.forEach(variant => {
        const option = document.createElement('option');
        option.value = `${variant.products.name} - ${variant.color} ${variant.size} (${variant.sku})`;
        option.setAttribute('data-type', 'variant');
        option.setAttribute('data-id', variant.id);
        option.setAttribute('data-name', `${variant.products.name} - ${variant.color} ${variant.size}`);
        // Para variantes, obtener el costo del producto padre
        option.setAttribute('data-cost', variant.products.cost || '');
        promoItemSuggestions.appendChild(option);
      });
    }
  } catch (error) {
    console.error('Error buscando items:', error);
    showMessage('Error al buscar items: ' + error.message, 'error');
  }
}

function addPromoItem(term) {
  if (!promoItemSuggestions) {
    showMessage('Error: elemento de sugerencias no encontrado', 'error');
    return;
  }
  
  // Buscar en las opciones del datalist
  const options = Array.from(promoItemSuggestions.options);
  const selected = options.find(opt => opt.value === term);
  
  if (!selected) {
    showMessage('Item no encontrado. Seleccione de la lista desplegable', 'error');
    return;
  }
  
  const type = selected.getAttribute('data-type');
  const id = selected.getAttribute('data-id');
  const name = selected.getAttribute('data-name');
  const cost = selected.getAttribute('data-cost') || null;
  
  if (!type || !id || !name) {
    showMessage('Error: datos del item incompletos', 'error');
    return;
  }
  
  // Verificar que no esté ya agregado
  if (selectedPromoItems.some(item => item.type === type && item.id === id)) {
    showMessage('Este item ya está agregado', 'error');
    return;
  }
  
  selectedPromoItems.push({ type, id, name, cost });
  renderSelectedItems();
  if (promoItemSearch) promoItemSearch.value = '';
  if (promoItemSuggestions) promoItemSuggestions.innerHTML = '';
}

function renderSelectedItems() {
  if (!selectedItems) return;
  
  if (selectedPromoItems.length === 0) {
    selectedItems.innerHTML = '<p style="color: #999; margin: 0;">No hay items seleccionados</p>';
    return;
  }
  
  selectedItems.innerHTML = selectedPromoItems.map((item, index) => {
    const costText = item.cost ? ` - Costo: $${parseFloat(item.cost).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    return `
      <span class="selected-item">
        ${item.name} (${item.type === 'product' ? 'Producto' : 'Variante'})${costText}
        <button onclick="removePromoItem(${index})">×</button>
      </span>
    `;
  }).join('');
}

function removePromoItem(index) {
  selectedPromoItems.splice(index, 1);
  renderSelectedItems();
}

async function createPromotion() {
  const type = promoType.value;
  const amount = fixedAmount.value ? parseFloat(fixedAmount.value) : null;
  const startDate = promoStartDate.value;
  const endDate = promoEndDate.value;
  const status = promoStatus.checked ? 'active' : 'inactive';
  
  if (!type) {
    showMessage('Seleccione el tipo de promoción', 'error');
    return;
  }
  
  if (type === '2xMonto' && (!amount || amount <= 0)) {
    showMessage('Ingrese un monto válido para 2xMonto', 'error');
    return;
  }
  
  if (!startDate || !endDate) {
    showMessage('Complete las fechas de inicio y fin', 'error');
    return;
  }
  
  if (new Date(endDate) < new Date(startDate)) {
    showMessage('La fecha fin debe ser posterior a la fecha inicio', 'error');
    return;
  }
  
  if (selectedPromoItems.length === 0) {
    showMessage('Agregue al menos un producto o variante a la promoción', 'error');
    return;
  }
  
  try {
    // Subir imagen si se seleccionó una
    let promoImageUrl = null;
    const imageInput = document.getElementById('promo-image-input');
    if (imageInput?.files && imageInput.files.length > 0) {
      try {
        promoImageUrl = await uploadPromoImage(imageInput.files[0]);
        if (!promoImageUrl) {
          showMessage('Error al subir la imagen', 'error');
          return;
        }
      } catch (error) {
        showMessage('Error al subir la imagen: ' + error.message, 'error');
        return;
      }
    }
    
    // Crear promoción
    const promotionData = {
      promo_type: type,
      fixed_amount: amount,
      start_date: startDate,
      end_date: endDate,
      status: status
    };
    
    // Agregar imagen si existe
    if (promoImageUrl) {
      promotionData.promo_image_url = promoImageUrl;
    }
    
    const { data: promotion, error: promoError } = await supabase
      .from('promotions')
      .insert(promotionData)
      .select()
      .single();
    
    if (promoError) throw promoError;
    
    // Crear items de promoción
    const items = selectedPromoItems.map(item => ({
      promotion_id: promotion.id,
      product_id: item.type === 'product' ? item.id : null,
      variant_id: item.type === 'variant' ? item.id : null
    }));
    
    const { error: itemsError } = await supabase
      .from('promotion_items')
      .insert(items);
    
    if (itemsError) throw itemsError;
    
    showMessage('Promoción creada correctamente', 'success');
    
    // Limpiar formulario
    promoType.value = '';
    fixedAmount.value = '';
    fixedAmountGroup.style.display = 'none';
    selectedPromoItems = [];
    renderSelectedItems();
    const today = new Date().toISOString().split('T')[0];
    promoStartDate.value = today;
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    promoEndDate.value = nextMonth.toISOString().split('T')[0];
    promoStatus.checked = true;
    promoStatusText.textContent = 'Activa';
    
    // Limpiar imagen
    if (imageInput) {
      imageInput.value = '';
      const preview = document.getElementById('promo-image-preview');
      if (preview) preview.style.display = 'none';
      const previewImg = document.getElementById('promo-image-preview-img');
      if (previewImg) previewImg.src = '';
    }
    
    await loadPromotions();
  } catch (error) {
    console.error('Error creando promoción:', error);
    showMessage('Error al crear promoción: ' + error.message, 'error');
  }
}

async function loadPromotions() {
  if (!promotionsList) return;
  
  try {
    const { data, error } = await supabase
      .from('promotions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    
    if (error) {
      console.error('Error cargando promociones:', error);
      promotionsList.innerHTML = '<p>Error al cargar promociones: ' + error.message + '</p>';
      return;
    }
    
    if (!data || data.length === 0) {
      promotionsList.innerHTML = '<p>No hay promociones creadas</p>';
      return;
    }
    
    // Obtener items con nombres de productos/variantes
    const promotionsWithItems = await Promise.all(
      data.map(async (promo) => {
        const { data: items, error: itemsError } = await supabase
          .from('promotion_items')
          .select(`
            id,
            product_id,
            variant_id,
            products:product_id(id, name, cost),
            variants:variant_id(id, sku, color, size, products!inner(id, name, cost))
          `)
          .eq('promotion_id', promo.id);
        
        if (itemsError) {
          console.error('Error obteniendo items:', itemsError);
          return { ...promo, itemsCount: 0, items: [] };
        }
        
        // Construir lista de nombres de items con costo
        const itemNames = [];
        if (items && items.length > 0) {
          items.forEach(item => {
            if (item.product_id && item.products) {
              // Es un producto completo
              const costText = item.products.cost ? ` (Costo: $${parseFloat(item.products.cost).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : '';
              itemNames.push(`${item.products.name}${costText}`);
            } else if (item.variant_id && item.variants) {
              // Es una variante
              const variant = item.variants;
              if (variant.products) {
                const costText = variant.products.cost ? ` (Costo: $${parseFloat(variant.products.cost).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : '';
                itemNames.push(`${variant.products.name} - ${variant.color} ${variant.size || ''}${costText}`.trim());
              }
            }
          });
        }
        
        return { 
          ...promo, 
          itemsCount: items?.length || 0,
          itemNames: itemNames
        };
      })
    );
    
    promotionsList.innerHTML = promotionsWithItems.map(promo => {
      const statusClass = promo.status === 'active' ? 'status-active' : 'status-inactive';
      const statusText = promo.status === 'active' ? 'Activa' : 'Inactiva';
      const promoText = promo.promo_type === '2x1' ? '2x1' : `2x$${promo.fixed_amount.toLocaleString('es-AR')}`;
      
      // Construir HTML de items
      let itemsHtml = '';
      if (promo.itemNames && promo.itemNames.length > 0) {
        itemsHtml = `<p><strong>Items (${promo.itemsCount}):</strong></p><ul style="margin: 4px 0; padding-left: 20px; font-size: 13px; color: #555;">`;
        promo.itemNames.forEach(name => {
          itemsHtml += `<li>${escapeHtml(name)}</li>`;
        });
        itemsHtml += '</ul>';
      } else {
        itemsHtml = `<p><strong>Items:</strong> ${promo.itemsCount}</p>`;
      }
      
      return `
        <div class="list-item">
          <div class="list-item-info">
            <h4>${escapeHtml(promoText)}</h4>
            <p><strong>Fechas:</strong> ${formatDate(promo.start_date)} - ${formatDate(promo.end_date)}</p>
            ${itemsHtml}
            <p><span class="status-badge ${statusClass}">${statusText}</span></p>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-secondary" onclick="editPromotion('${promo.id}')">Editar</button>
            <button class="btn btn-danger" onclick="deletePromotion('${promo.id}')">Eliminar</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Error cargando promociones:', error);
    if (promotionsList) {
      promotionsList.innerHTML = '<p>Error al cargar promociones: ' + error.message + '</p>';
    }
  }
}

async function deletePromotion(promoId) {
  if (!confirm('¿Está seguro de eliminar esta promoción?')) return;
  
  try {
    const { error } = await supabase
      .from('promotions')
      .delete()
      .eq('id', promoId);
    
    if (error) throw error;
    
    showMessage('Promoción eliminada correctamente', 'success');
    await loadPromotions();
  } catch (error) {
    console.error('Error eliminando promoción:', error);
    showMessage('Error al eliminar promoción: ' + error.message, 'error');
  }
}

// Funciones auxiliares
function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('es-AR');
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showMessage(message, type = 'success') {
  const container = document.getElementById('message-container');
  if (!container) {
    console.warn('message-container no encontrado');
    alert(message); // Fallback
    return;
  }
  
  container.innerHTML = `<div class="message ${type} active">${escapeHtml(message)}</div>`;
  
  setTimeout(() => {
    container.innerHTML = '';
  }, 5000);
}

// Funciones globales para botones
window.editOffer = async function(offerId) {
  try {
    // Cargar datos de la oferta
    const { data: offer, error: offerError } = await supabase
      .from('color_price_offers')
      .select(`
        *,
        products!inner(id, name, category)
      `)
      .eq('id', offerId)
      .single();
    
    if (offerError) throw offerError;
    if (!offer) {
      showMessage('Oferta no encontrada', 'error');
      return;
    }
    
    // Cargar el producto y sus variantes
    currentProduct = offer.products;
    
    const { data: variants, error: variantsError } = await supabase
      .from('product_variants')
      .select('id, color, size, price, active')
      .eq('product_id', currentProduct.id)
      .eq('active', true)
      .order('color, size');
    
    if (variantsError) throw variantsError;
    currentProductVariants = variants || [];
    
    // Mostrar información del producto
    const productNameEl = document.getElementById('product-name');
    const productInfoEl = document.getElementById('product-info');
    
    if (productNameEl) {
      productNameEl.textContent = currentProduct.name;
    }
    if (productInfoEl) {
      productInfoEl.classList.add('active');
    }
    
    // Renderizar colores con datos de la oferta
    renderColors();
    
    // Pre-llenar el formulario con los datos de la oferta
    const priceInput = document.querySelector(`.offer-price[data-color="${offer.color}"]`);
    const startInput = document.querySelector(`.offer-start-date[data-color="${offer.color}"]`);
    const endInput = document.querySelector(`.offer-end-date[data-color="${offer.color}"]`);
    const statusToggle = document.querySelector(`.offer-status[data-color="${offer.color}"]`);
    const statusText = document.querySelector(`.offer-status-text`);
    
    if (priceInput) priceInput.value = offer.offer_price;
    if (startInput) startInput.value = offer.start_date;
    if (endInput) endInput.value = offer.end_date;
    if (statusToggle) {
      statusToggle.checked = offer.status === 'active';
      if (statusText) statusText.textContent = offer.status === 'active' ? 'Activa' : 'Inactiva';
    }
    
    // Resaltar visualmente el color que se está editando
    const colorItems = document.querySelectorAll('.color-item');
    colorItems.forEach(item => {
      const h4 = item.querySelector('h4');
      if (h4 && h4.textContent.includes(offer.color)) {
        item.style.border = '3px solid #CD844D';
        item.style.background = '#fff9e6';
        const editBadge = document.createElement('div');
        editBadge.style.cssText = 'background: #CD844D; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-bottom: 8px; display: inline-block;';
        editBadge.textContent = '✏️ Editando oferta';
        h4.parentNode.insertBefore(editBadge, h4);
      }
    });
    
    // Pre-llenar campos de campaña
    const titleInput = document.getElementById('offer-title');
    const imagePreview = document.getElementById('offer-image-preview');
    const imagePreviewImg = document.getElementById('offer-image-preview-img');
    
    if (titleInput && offer.offer_title) {
      titleInput.value = offer.offer_title;
    }
    if (offerCampaignId && offer.offer_campaign_id) {
      // Asegurarse de que las campañas estén cargadas antes de seleccionar
      await loadOfferCampaigns();
      offerCampaignId.value = offer.offer_campaign_id;
    }
    if (imagePreview && imagePreviewImg && offer.offer_image_url) {
      imagePreviewImg.src = offer.offer_image_url;
      imagePreview.style.display = 'block';
    }
    
    // Guardar el ID de la oferta para actualización
    // Buscar el color item que corresponde a este color (reutilizar colorItems ya declarado)
    colorItems.forEach(item => {
      const h4 = item.querySelector('h4');
      if (h4 && h4.textContent.includes(offer.color)) {
        const saveBtn = item.querySelector('.save-offer-btn');
        if (saveBtn) {
          saveBtn.dataset.offerId = offerId;
          saveBtn.textContent = 'Actualizar Oferta';
        }
      }
    });
    
    // Cambiar a la pestaña de ofertas si no está activa
    const offersTab = document.querySelector('.tab[data-tab="offers"]');
    if (offersTab) {
      offersTab.click();
    }
    
    // Scroll al formulario
    productInfoEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    showMessage('Oferta cargada para edición. Modifique los campos y haga clic en "Guardar Oferta"', 'success');
    
    // Cargar otras ofertas de la misma campaña si existe
    if (offer.offer_campaign_id) {
      await loadCampaignOffers(offer.offer_campaign_id, offerId);
    }
    
    // Agregar botón para cancelar edición y crear nueva oferta
    const cancelEditBtn = document.createElement('button');
    cancelEditBtn.className = 'btn btn-secondary';
    cancelEditBtn.textContent = 'Cancelar Edición';
    cancelEditBtn.style.cssText = 'margin-top: 12px;';
    cancelEditBtn.onclick = () => {
      // Limpiar formulario
      if (productInfoEl) {
        productInfoEl.classList.remove('active');
      }
      if (productNameEl) {
        productNameEl.textContent = '';
      }
      if (colorsList) {
        colorsList.innerHTML = '';
      }
      if (titleInput) titleInput.value = '';
      if (offerCampaignId) offerCampaignId.value = '';
      if (imageInput) {
        imageInput.value = '';
        const preview = document.getElementById('offer-image-preview');
        if (preview) preview.style.display = 'none';
      }
      currentProduct = null;
      currentProductVariants = [];
      
      // Remover información de campaña
      const campaignInfo = document.querySelector('.campaign-info');
      if (campaignInfo) campaignInfo.remove();
      
      showMessage('Edición cancelada', 'success');
    };
    
    const campaignSection = document.querySelector('.campaign-section');
    if (campaignSection && !campaignSection.querySelector('.cancel-edit-btn')) {
      cancelEditBtn.className += ' cancel-edit-btn';
      campaignSection.appendChild(cancelEditBtn);
    }
  } catch (error) {
    console.error('Error cargando oferta para edición:', error);
    showMessage('Error al cargar oferta: ' + error.message, 'error');
  }
};

// Función para cargar otras ofertas de la misma campaña
async function loadCampaignOffers(campaignId, currentOfferId) {
  try {
    const { data: campaignOffers, error } = await supabase
      .from('color_price_offers')
      .select(`
        id,
        product_id,
        color,
        offer_price,
        products!inner(id, name)
      `)
      .eq('offer_campaign_id', campaignId)
      .neq('id', currentOfferId);
    
    if (error) throw error;
    
    // Mostrar información sobre otras ofertas de la campaña
    const campaignInfo = document.createElement('div');
    campaignInfo.className = 'campaign-info';
    campaignInfo.style.cssText = 'background: #e7f3ff; padding: 12px; border-radius: 8px; margin-top: 12px; border: 1px solid #b3d9ff;';
    
    let offersListHtml = '';
    if (campaignOffers && campaignOffers.length > 0) {
      offersListHtml = `
        <h5 style="margin: 0 0 8px; color: #004085;">Otras ofertas de esta campaña (${campaignOffers.length}):</h5>
        <ul style="margin: 0; padding-left: 20px; color: #004085;">
          ${campaignOffers.map(off => `
            <li style="margin-bottom: 4px;">
              ${escapeHtml(off.products.name)} - ${escapeHtml(off.color)} ($${off.offer_price.toLocaleString('es-AR')})
              <button onclick="editOffer('${off.id}')" style="margin-left: 8px; padding: 2px 8px; font-size: 11px; background: #004085; color: white; border: none; border-radius: 4px; cursor: pointer;">Editar</button>
            </li>
          `).join('')}
        </ul>
      `;
    } else {
      offersListHtml = '<p style="margin: 0; color: #004085;">Esta es la única oferta de esta campaña.</p>';
    }
    
    campaignInfo.innerHTML = `
      ${offersListHtml}
      <p style="margin: 8px 0 0; font-size: 12px; color: #666;">
        <strong>Nota:</strong> Si cambias la imagen o el título de la campaña, se aplicará a todas las ofertas de esta campaña.
      </p>
      <button onclick="addProductToCampaign('${campaignId}')" class="btn btn-primary" style="margin-top: 8px; padding: 6px 12px; font-size: 12px;">
        + Agregar Producto a esta Campaña
      </button>
    `;
    
    const campaignSection = document.querySelector('.campaign-section');
    if (campaignSection) {
      const existingInfo = campaignSection.querySelector('.campaign-info');
      if (existingInfo) existingInfo.remove();
      campaignSection.appendChild(campaignInfo);
    }
  } catch (error) {
    console.error('Error cargando ofertas de campaña:', error);
  }
}

// Función para agregar un producto a una campaña existente
window.addProductToCampaign = async function(campaignId) {
  const productName = prompt('Ingrese el nombre del producto que desea agregar a esta campaña:');
  if (!productName || !productName.trim()) return;
  
  try {
    // Buscar el producto
    const { data: products, error: searchError } = await supabase
      .from('products')
      .select('id, name')
      .ilike('name', `%${productName.trim()}%`)
      .eq('status', 'active')
      .limit(5);
    
    if (searchError) throw searchError;
    
    if (!products || products.length === 0) {
      showMessage('No se encontraron productos con ese nombre', 'error');
      return;
    }
    
    if (products.length === 1) {
      // Si hay un solo resultado, usarlo directamente
      await loadProductForCampaign(products[0].id, campaignId);
    } else {
      // Si hay múltiples resultados, mostrar lista
      const productList = products.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
      const selection = prompt(`Se encontraron múltiples productos:\n\n${productList}\n\nIngrese el número del producto que desea agregar:`);
      const index = parseInt(selection) - 1;
      
      if (isNaN(index) || index < 0 || index >= products.length) {
        showMessage('Selección inválida', 'error');
        return;
      }
      
      await loadProductForCampaign(products[index].id, campaignId);
    }
  } catch (error) {
    console.error('Error agregando producto a campaña:', error);
    showMessage('Error al agregar producto: ' + error.message, 'error');
  }
};

// Función auxiliar para cargar un producto y pre-llenar con datos de campaña
async function loadProductForCampaign(productId, campaignId) {
  try {
    // Obtener datos de la campaña (imagen, título)
    const { data: campaignData, error: campaignError } = await supabase
      .from('color_price_offers')
      .select('offer_image_url, offer_title')
      .eq('offer_campaign_id', campaignId)
      .limit(1)
      .maybeSingle();
    
    if (campaignError) throw campaignError;
    
    // Cargar el producto
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, name, category')
      .eq('id', productId)
      .single();
    
    if (productError) throw productError;
    
    // Cargar variantes
    const { data: variants, error: variantsError } = await supabase
      .from('product_variants')
      .select('id, color, size, price, active')
      .eq('product_id', productId)
      .eq('active', true)
      .order('color, size');
    
    if (variantsError) throw variantsError;
    
    currentProduct = product;
    currentProductVariants = variants || [];
    
    // Mostrar información del producto
    const productNameEl = document.getElementById('product-name');
    const productInfoEl = document.getElementById('product-info');
    
    if (productNameEl) {
      productNameEl.textContent = product.name;
    }
    if (productInfoEl) {
      productInfoEl.classList.add('active');
    }
    
    // Renderizar colores
    renderColors();
    
    // Pre-llenar datos de campaña
    const titleInput = document.getElementById('offer-title');
    const imagePreview = document.getElementById('offer-image-preview');
    const imagePreviewImg = document.getElementById('offer-image-preview-img');
    
    if (offerCampaignId) {
      // Asegurarse de que las campañas estén cargadas antes de seleccionar
      await loadOfferCampaigns();
      offerCampaignId.value = campaignId;
    }
    if (titleInput && campaignData?.offer_title) {
      titleInput.value = campaignData.offer_title;
    }
    if (imagePreview && imagePreviewImg && campaignData?.offer_image_url) {
      imagePreviewImg.src = campaignData.offer_image_url;
      imagePreview.style.display = 'block';
    }
    
    // Cambiar a la pestaña de ofertas
    const offersTab = document.querySelector('.tab[data-tab="offers"]');
    if (offersTab) {
      offersTab.click();
    }
    
    // Scroll al formulario
    productInfoEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    showMessage(`Producto "${product.name}" cargado. Seleccione un color y complete los datos para agregarlo a la campaña.`, 'success');
  } catch (error) {
    console.error('Error cargando producto para campaña:', error);
    showMessage('Error al cargar producto: ' + error.message, 'error');
  }
}

// Función para actualizar una promoción
async function updatePromotion(promoId) {
  const type = promoType.value;
  const amount = fixedAmount.value ? parseFloat(fixedAmount.value) : null;
  const startDate = promoStartDate.value;
  const endDate = promoEndDate.value;
  const status = promoStatus.checked ? 'active' : 'inactive';
  
  if (!type) {
    showMessage('Seleccione el tipo de promoción', 'error');
    return;
  }
  
  if (type === '2xMonto' && (!amount || amount <= 0)) {
    showMessage('Ingrese un monto válido para 2xMonto', 'error');
    return;
  }
  
  if (!startDate || !endDate) {
    showMessage('Complete las fechas de inicio y fin', 'error');
    return;
  }
  
  if (new Date(endDate) < new Date(startDate)) {
    showMessage('La fecha fin debe ser posterior a la fecha inicio', 'error');
    return;
  }
  
  if (selectedPromoItems.length === 0) {
    showMessage('Agregue al menos un producto o variante a la promoción', 'error');
    return;
  }
  
  try {
    // Subir imagen si se seleccionó una nueva
    let promoImageUrl = null;
    const imageInput = document.getElementById('promo-image-input');
    let imageChanged = false;
    
    if (imageInput?.files && imageInput.files.length > 0) {
      try {
        promoImageUrl = await uploadPromoImage(imageInput.files[0]);
        if (!promoImageUrl) {
          showMessage('Error al subir la imagen', 'error');
          return;
        }
        imageChanged = true;
      } catch (error) {
        showMessage('Error al subir la imagen: ' + error.message, 'error');
        return;
      }
    }
    
    // Preparar datos de actualización
    const promotionData = {
      promo_type: type,
      fixed_amount: amount,
      start_date: startDate,
      end_date: endDate,
      status: status
    };
    
    // Agregar imagen solo si se cambió
    if (imageChanged && promoImageUrl) {
      promotionData.promo_image_url = promoImageUrl;
    }
    
    // Actualizar promoción
    const { error: updateError } = await supabase
      .from('promotions')
      .update(promotionData)
      .eq('id', promoId);
    
    if (updateError) throw updateError;
    
    // Obtener items actuales de la promoción
    const { data: currentItems, error: itemsError } = await supabase
      .from('promotion_items')
      .select('id, product_id, variant_id')
      .eq('promotion_id', promoId);
    
    if (itemsError) throw itemsError;
    
    // Determinar qué items eliminar y cuáles agregar
    // Crear set de items actuales: clave es "product-{id}" o "variant-{id}"
    const currentItemsSet = new Set(
      (currentItems || []).map(item => {
        if (item.product_id) {
          return `product-${item.product_id}`;
        } else if (item.variant_id) {
          return `variant-${item.variant_id}`;
        }
        return null;
      }).filter(Boolean)
    );
    
    // Crear set de nuevos items
    const newItemsSet = new Set(
      selectedPromoItems.map(item => 
        `${item.type}-${item.id}`
      )
    );
    
    // Items a eliminar: están en currentItems pero no en newItemsSet
    const itemsToDelete = (currentItems || []).filter(item => {
      let key;
      if (item.product_id) {
        key = `product-${item.product_id}`;
      } else if (item.variant_id) {
        key = `variant-${item.variant_id}`;
      } else {
        return false;
      }
      return !newItemsSet.has(key);
    });
    
    // Items a agregar: están en selectedPromoItems pero no en currentItemsSet
    const itemsToAdd = selectedPromoItems.filter(item => {
      const key = `${item.type}-${item.id}`;
      return !currentItemsSet.has(key);
    });
    
    // Eliminar items
    if (itemsToDelete.length > 0) {
      const idsToDelete = itemsToDelete.map(item => item.id);
      const { error: deleteError } = await supabase
        .from('promotion_items')
        .delete()
        .in('id', idsToDelete);
      
      if (deleteError) throw deleteError;
    }
    
    // Agregar nuevos items
    if (itemsToAdd.length > 0) {
      const newItems = itemsToAdd.map(item => ({
        promotion_id: promoId,
        product_id: item.type === 'product' ? item.id : null,
        variant_id: item.type === 'variant' ? item.id : null
      }));
      
      const { error: insertError } = await supabase
        .from('promotion_items')
        .insert(newItems);
      
      if (insertError) throw insertError;
    }
    
    showMessage('Promoción actualizada correctamente', 'success');
    
    // Limpiar formulario y salir del modo edición
    resetPromoForm();
    exitEditMode();
    
    await loadPromotions();
  } catch (error) {
    console.error('Error actualizando promoción:', error);
    showMessage('Error al actualizar promoción: ' + error.message, 'error');
  }
}

// Función para resetear el formulario de promoción
function resetPromoForm() {
  promoType.value = '';
  fixedAmount.value = '';
  fixedAmountGroup.style.display = 'none';
  selectedPromoItems = [];
  renderSelectedItems();
  const today = new Date().toISOString().split('T')[0];
  promoStartDate.value = today;
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  promoEndDate.value = nextMonth.toISOString().split('T')[0];
  promoStatus.checked = true;
  promoStatusText.textContent = 'Activa';
  
  // Limpiar imagen
  const imageInput = document.getElementById('promo-image-input');
  if (imageInput) {
    imageInput.value = '';
    const preview = document.getElementById('promo-image-preview');
    if (preview) preview.style.display = 'none';
    const previewImg = document.getElementById('promo-image-preview-img');
    if (previewImg) previewImg.src = '';
  }
}

// Función para salir del modo edición
function exitEditMode() {
  const createBtn = document.getElementById('create-promo-btn');
  const updateBtn = document.getElementById('update-promo-btn');
  const sectionTitle = document.querySelector('#promotions-tab .section h2');
  
  if (createBtn) createBtn.style.display = 'block';
  if (updateBtn) updateBtn.style.display = 'none';
  if (sectionTitle) sectionTitle.textContent = 'Crear Nueva Promoción';
  
  // Remover data attribute de edición
  if (updateBtn) delete updateBtn.dataset.promoId;
}

window.deleteOffer = deleteOffer;
window.editPromotion = async function(promoId) {
  try {
    // Cargar datos de la promoción
    const { data: promotion, error: promoError } = await supabase
      .from('promotions')
      .select('*')
      .eq('id', promoId)
      .single();
    
    if (promoError) throw promoError;
    if (!promotion) {
      showMessage('Promoción no encontrada', 'error');
      return;
    }
    
    // Cargar items de la promoción
    const { data: items, error: itemsError } = await supabase
      .from('promotion_items')
      .select(`
        id,
        product_id,
        variant_id,
        products:product_id(id, name, cost),
        variants:variant_id(id, sku, color, size, products!inner(id, name, cost))
      `)
      .eq('promotion_id', promoId);
    
    if (itemsError) throw itemsError;
    
    // Pre-llenar formulario con datos de la promoción
    if (promoType) promoType.value = promotion.promo_type;
    if (promotion.promo_type === '2xMonto') {
      if (fixedAmountGroup) fixedAmountGroup.style.display = 'block';
      if (fixedAmount) fixedAmount.value = promotion.fixed_amount;
    } else {
      if (fixedAmountGroup) fixedAmountGroup.style.display = 'none';
      if (fixedAmount) fixedAmount.value = '';
    }
    if (promoStartDate) promoStartDate.value = promotion.start_date;
    if (promoEndDate) promoEndDate.value = promotion.end_date;
    if (promoStatus) promoStatus.checked = promotion.status === 'active';
    if (promoStatusText) promoStatusText.textContent = promotion.status === 'active' ? 'Activa' : 'Inactiva';
    
    // Cargar items seleccionados
    selectedPromoItems = [];
    if (items && items.length > 0) {
      items.forEach(item => {
        if (item.product_id) {
          // Es un producto completo
          const product = item.products;
          if (product) {
            selectedPromoItems.push({
              type: 'product',
              id: product.id,
              name: product.name,
              cost: product.cost || null
            });
          }
        } else if (item.variant_id) {
          // Es una variante
          const variant = item.variants;
          if (variant && variant.products) {
            selectedPromoItems.push({
              type: 'variant',
              id: variant.id,
              name: `${variant.products.name} - ${variant.color} ${variant.size}`,
              cost: variant.products.cost || null
            });
          }
        }
      });
    }
    renderSelectedItems();
    
    // Mostrar imagen actual si existe
    const imageInput = document.getElementById('promo-image-input');
    const imagePreview = document.getElementById('promo-image-preview');
    const imagePreviewImg = document.getElementById('promo-image-preview-img');
    
    if (promotion.promo_image_url && imagePreview && imagePreviewImg) {
      imagePreviewImg.src = promotion.promo_image_url;
      imagePreview.style.display = 'block';
    } else if (imagePreview) {
      // Ocultar vista previa si no hay imagen
      imagePreview.style.display = 'none';
    }
    // Limpiar input de imagen para permitir seleccionar nueva
    if (imageInput) imageInput.value = '';
    
    // Cambiar a modo edición
    const createBtn = document.getElementById('create-promo-btn');
    const updateBtn = document.getElementById('update-promo-btn');
    const sectionTitle = document.querySelector('#promotions-tab .section h2');
    
    if (createBtn) createBtn.style.display = 'none';
    if (updateBtn) {
      updateBtn.style.display = 'block';
      updateBtn.dataset.promoId = promoId;
      updateBtn.onclick = () => updatePromotion(promoId);
    }
    if (sectionTitle) sectionTitle.textContent = 'Editar Promoción';
    
    // Cambiar a la pestaña de promociones si no está activa
    const promotionsTab = document.querySelector('.tab[data-tab="promotions"]');
    if (promotionsTab && !promotionsTab.classList.contains('active')) {
      promotionsTab.click();
    }
    
    // Scroll al formulario
    const promoForm = document.querySelector('.promo-form');
    if (promoForm) {
      promoForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    
    showMessage('Promoción cargada para edición. Modifique los campos y haga clic en "Actualizar Promoción"', 'success');
  } catch (error) {
    console.error('Error cargando promoción para edición:', error);
    showMessage('Error al cargar promoción: ' + error.message, 'error');
  }
};
window.deletePromotion = deletePromotion;
window.removePromoItem = removePromoItem;

