import { supabase } from "../scripts/supabase-client.js";

const FALLBACK_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' rx='12' fill='%23f2f2f2'/%3E%3Cpath d='M24 88L44 62l12 14 16-22 24 34H24z' fill='none' stroke='%23cd844d' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='46' cy='42' r='10' fill='%23cd844d' opacity='0.35'/%3E%3Ctext x='60' y='108' fill='%23777' font-family='Poppins,Arial,sans-serif' font-size='12' text-anchor='middle'%3ESin imagen%3C/text%3E%3C/svg%3E";

let cartSyncedListenerRegistered = false;
let cartActionsInitialized = false;
let historyControlsInitialized = false;
let modalControlsInitialized = false;
let historyVisible = false;
let currentUserId = null;
let currentCartItems = [];
let ordersRealtimeSubscription = null;

console.log("📦 dashboard-instant.js cargado (orders2)");

function hideLoader() {
  const loader = document.getElementById("loader");
  if (loader) {
    loader.style.display = "none";
    loader.style.visibility = "hidden";
    loader.style.opacity = "0";
    loader.style.position = "absolute";
    loader.style.left = "-9999px";
  }
  document.querySelectorAll(".spinner").forEach((spinner) => {
    spinner.style.display = "none";
  });
}

function showContent() {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (!dashboardContent) return;
    dashboardContent.innerHTML = `
      <div class="cart-section">
        <h2 class="section-title">🛒 Carrito Actual</h2>
        <div id="cart-info">
          <p>Verificando información del carrito...</p>
        </div>
      <div id="cart-actions" class="cart-actions" style="display:none; gap:12px; margin-top:16px; flex-wrap:wrap;">
        <button id="submit-cart-btn" class="btn">Enviar mi pedido</button>
        <button id="clear-cart-btn" class="btn btn-secondary">Limpiar Carrito</button>
      </div>
      </div>
      <div class="orders-section">
        <h2 class="section-title">📋 Mis Pedidos</h2>
        <div id="orders-section">
          <p>Verificando historial de pedidos...</p>
        </div>
      <button id="toggle-history-btn" class="btn btn-secondary" style="margin-top:12px;">Ver pedidos anteriores</button>
      </div>
    `;
  historyControlsInitialized = false;
  modalControlsInitialized = false;
  historyVisible = false;
}

function setContentVisibility(isVisible) {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (!dashboardContent) return;
  if (isVisible) {
    dashboardContent.style.visibility = "visible";
    dashboardContent.style.opacity = "1";
  } else {
    dashboardContent.style.visibility = "hidden";
    dashboardContent.style.opacity = "0";
  }
}

// Función para obtener variant_id basado en product_name, color y size
async function findVariantIdForItem(productName, color, size, variantId = null) {
  if (variantId) return variantId;
  if (!productName || !color || !size) return null;
  
  try {
    const { data: productData } = await supabase
      .from('products')
      .select('id')
      .eq('name', productName)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    
    if (!productData) return null;
    
    const { data: variantData } = await supabase
      .from('product_variants')
      .select('id')
      .eq('product_id', productData.id)
      .eq('color', color)
      .eq('size', size)
      .eq('active', true)
      .limit(1)
      .maybeSingle();
    
    return variantData?.id || null;
  } catch (error) {
    console.error('Error buscando variant_id:', error);
    return null;
  }
}

// Función para obtener ofertas y promociones para items
async function getOffersAndPromotionsForItems(items) {
  if (!items || items.length === 0) {
    return { itemOffers: new Map(), itemPromos: new Map(), totalDiscount: 0 };
  }
  
  const variantIds = [];
  const itemVariantMap = new Map();
  
  // Obtener variant_ids de los items
  for (const item of items) {
    const variantId = await findVariantIdForItem(
      item.product_name || item.articulo,
      item.color,
      item.size || item.talle,
      item.variant_id
    );
    
    if (variantId) {
      variantIds.push(variantId);
      if (!itemVariantMap.has(variantId)) {
        itemVariantMap.set(variantId, []);
      }
      itemVariantMap.get(variantId).push(item);
    }
  }
  
  if (variantIds.length === 0) {
    return { itemOffers: new Map(), itemPromos: new Map(), totalDiscount: 0 };
  }
  
  // Obtener promociones activas
  const { data: promotionsData, error: promotionsError } = await supabase
    .rpc('get_active_promotions_for_variants', {
      p_variant_ids: variantIds
    });
  
  const promotions = promotionsError ? [] : (promotionsData || []);
  
  const itemOffersMap = new Map();
  const itemPromosMap = new Map();
  
  // Procesar promociones (tienen prioridad)
  for (const promo of promotions) {
    const variantIdsInPromo = promo.variant_ids || [];
    const promoText = promo.promo_type === '2x1' 
      ? '2x1' 
      : promo.promo_type === '2xMonto' && promo.fixed_amount
      ? `2x$${promo.fixed_amount}`
      : null;
    
    if (promoText) {
      for (const variantId of variantIdsInPromo) {
        const itemsInPromo = itemVariantMap.get(variantId) || [];
        for (const item of itemsInPromo) {
          itemPromosMap.set(item.id || `${item.product_name}-${item.color}-${item.size}`, promoText);
        }
      }
    }
  }
  
  // Procesar ofertas (solo para items que no están en promociones)
  for (const item of items) {
    const itemKey = item.id || `${item.product_name}-${item.color}-${item.size}`;
    if (itemPromosMap.has(itemKey)) continue;
    
    if (!item.product_name && !item.articulo) continue;
    const productName = item.product_name || item.articulo;
    if (!productName || !item.color) continue;
    
    const { data: productData } = await supabase
      .from('products')
      .select('id')
      .eq('name', productName)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    
    if (!productData) continue;
    
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
      const originalPrice = item.price_snapshot || item.variantInfo?.price || 0;
      const offerPrice = offerData.offer_price;
      itemOffersMap.set(itemKey, {
        offerPrice: offerPrice,
        originalPrice: originalPrice,
        promoText: '🔥 Oferta'
      });
    }
  }
  
  // Calcular descuentos totales
  let totalDiscount = 0;
  
  // Descuentos de promociones
  for (const promo of promotions) {
    const variantIdsInPromo = promo.variant_ids || [];
    const itemsInPromo = [];
    
    for (const variantId of variantIdsInPromo) {
      itemsInPromo.push(...(itemVariantMap.get(variantId) || []));
    }
    
    if (itemsInPromo.length === 0) continue;
    
    let totalQuantity = 0;
    let totalPrice = 0;
    
    for (const item of itemsInPromo) {
      const qty = Number(item.quantity || item.qty || 0);
      const price = Number(item.price_snapshot || item.variantInfo?.price || 0);
      totalQuantity += qty;
      totalPrice += qty * price;
    }
    
    if (totalQuantity > 0) {
      const groups = Math.floor(totalQuantity / 2);
      let discount = 0;
      
      if (promo.promo_type === '2x1') {
        const averagePrice = totalPrice / totalQuantity;
        discount = groups * averagePrice;
      } else if (promo.promo_type === '2xMonto' && promo.fixed_amount) {
        const promoPrice = groups * promo.fixed_amount;
        discount = totalPrice - promoPrice;
      }
      
      totalDiscount += discount;
    }
  }
  
  // Descuentos de ofertas
  for (const [itemKey, offerInfo] of itemOffersMap.entries()) {
    const item = items.find(i => (i.id || `${i.product_name}-${i.color}-${i.size}`) === itemKey);
    if (item) {
      const qty = Number(item.quantity || item.qty || 0);
      const discount = (offerInfo.originalPrice - offerInfo.offerPrice) * qty;
      totalDiscount += discount;
    }
  }
  
  return {
    itemOffers: itemOffersMap,
    itemPromos: itemPromosMap,
    totalDiscount: totalDiscount
  };
}

async function resolveItemImage(item) {
  if (item.imagen) return item.imagen;
  try {
    const { data, error } = await supabase
      .from("catalog_public_view")
      .select(`"Imagen Principal","Imagen 1","Imagen 2"`)
      .eq("Articulo", item.product_name || item.articulo || "")
      .eq("Color", item.color || "")
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("⚠️ No se pudo obtener imagen desde catálogo:", error.message);
      return FALLBACK_IMAGE;
    }
    if (data) {
      return (
        data["Imagen Principal"] ||
        data["Imagen 1"] ||
        data["Imagen 2"] ||
        FALLBACK_IMAGE
      );
    }
  } catch (error) {
    console.warn("⚠️ Error resolviendo imagen:", error.message);
  }
  return FALLBACK_IMAGE;
}

async function fetchVariantInfo(articulo, color, talle, variantId = null) {
  try {
    const normalizedArticulo = articulo?.trim();
    const normalizedColor = color?.trim();
    const normalizedSize = talle?.trim();

    if (!normalizedArticulo || !normalizedColor || !normalizedSize) {
      return null;
    }

    if (variantId) {
      const { data: variantById, error: variantByIdError } = await supabase
        .from("product_variants")
        .select("id, stock_qty, reserved_qty, price, color, size")
        .eq("id", variantId)
        .maybeSingle();

      if (!variantByIdError && variantById) {
        const stock = Number(variantById.stock_qty ?? 0);
        const reserved = Number(variantById.reserved_qty ?? 0);
        return {
          id: variantById.id,
          stock,
          reserved,
          available: Math.max(0, stock - reserved),
          price: Number(variantById.price ?? 0) || 0,
          color: variantById.color,
          size: variantById.size,
        };
      }
    }

    const { data: product, error: productError } = await supabase
      .from("products")
      .select("id")
      .ilike("name", normalizedArticulo)
      .maybeSingle();

    if (productError || !product) {
      return null;
    }

    const { data: variant, error: variantError } = await supabase
      .from("product_variants")
      .select("id, stock_qty, reserved_qty, price, color, size")
      .eq("product_id", product.id)
      .ilike("color", normalizedColor)
      .eq("size", normalizedSize)
      .maybeSingle();

    if (variantError || !variant) {
      return null;
    }

    const stock = Number(variant.stock_qty ?? 0);
    const reserved = Number(variant.reserved_qty ?? 0);

    return {
      id: variant.id,
      stock,
      reserved,
      available: Math.max(0, stock - reserved),
      price: Number(variant.price ?? 0) || 0,
      color: variant.color,
      size: variant.size,
    };
  } catch (error) {
    console.warn("⚠️ Error obteniendo información de la variante:", error.message);
    return null;
  }
}

async function removeItemFromSupabase(itemId) {
  try {
    if (!itemId) {
      console.warn("⚠️ removeItemFromSupabase llamado sin itemId");
      return false;
    }

    // Intento 1: borrar directamente en Supabase por id
    const { error, count } = await supabase
      .from("cart_items")
      .delete({ count: "exact" })
      .eq("id", itemId);

    if (!error && typeof count === "number" && count > 0) {
      window.dispatchEvent(new CustomEvent("cart:synced"));
      return true;
    }

    if (error) {
      console.warn("⚠️ Supabase DELETE por id falló:", error.message || error);
    } else {
      console.warn("⚠️ Supabase DELETE por id no afectó filas (posible id desincronizado)");
    }

    // Intento 2 (fallback): usar el helper global que sincroniza contra Supabase
    if (typeof window.removeCartItem === "function") {
      const ok = await window.removeCartItem(itemId);
      if (ok) {
        window.dispatchEvent(new CustomEvent("cart:synced"));
        return true;
      }
    }

    // Intento 3: re-cargar y reintentar encontrar el item por id visible
    try {
      const { data: row } = await supabase
        .from("cart_items")
        .select("id")
        .eq("id", itemId)
        .maybeSingle();
      if (!row) {
        // Ya no existe: considerarlo eliminado
        return true;
      }
    } catch (_) {}

    return false;
  } catch (err) {
    console.warn("⚠️ Error eliminando item del carrito:", err?.message || err);
    // Fallback final
    if (typeof window.removeCartItem === "function") {
      try {
        const ok = await window.removeCartItem(itemId);
        if (ok) {
          window.dispatchEvent(new CustomEvent("cart:synced"));
          return true;
        }
      } catch (_) {}
    }
    return false;
  }
}

function attachRemoveHandlers(userId) {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;
  cartInfo.querySelectorAll(".cart-mini-remove").forEach((btn) => {
    btn.onclick = async (event) => {
      const itemId = event.currentTarget.dataset.id;
      if (!itemId) return;
      const confirmed = confirm("¿Quitar este producto del carrito?");
      if (!confirmed) return;
      const success = await removeItemFromSupabase(itemId);
      if (!success) {
        await loadCart(userId);
        alert("No se pudo eliminar el producto. Intenta nuevamente.");
      }
    };
  });
}

// Función para manejar botones "Ver alternativas" en productos agotados
async function attachAlternativasHandlers(userId) {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;

  cartInfo.querySelectorAll(".btn-ver-alternativas").forEach((btn) => {
    btn.onclick = async (event) => {
      const articulo = event.currentTarget.dataset.articulo;
      const color = event.currentTarget.dataset.color;
      const talle = event.currentTarget.dataset.talle;
      const agotadoItemId = event.currentTarget.dataset.itemId; // capturar antes del modal
      
      if (!articulo || !talle) {
        alert("No se pudo obtener la información del producto.");
        return;
      }

      // Obtener tags del producto desde el catálogo
      try {
        const { data: productoCatalogo, error: catalogError } = await supabase
          .from("catalog_public_view")
          .select('"Filtro1","Filtro2","Filtro3"')
          .eq("Articulo", articulo)
          .limit(1)
          .maybeSingle();

        const tags = [];
        if (!catalogError && productoCatalogo) {
          if (productoCatalogo.Filtro1) tags.push(productoCatalogo.Filtro1);
          if (productoCatalogo.Filtro2) tags.push(productoCatalogo.Filtro2);
          if (productoCatalogo.Filtro3) tags.push(productoCatalogo.Filtro3);
        }

        // Buscar productos alternativos
        if (!window.buscarProductosAlternativos || !window.mostrarModalAlternativas) {
          alert("El sistema de alternativas no está disponible. Por favor, elimina este producto del carrito.");
          return;
        }

        const productos = await window.buscarProductosAlternativos({
          articulo,
          talle,
          tags,
          color,
          limit: 6,
        });

        // Mostrar modal con alternativas
        window.mostrarModalAlternativas({
          mensaje: `Productos alternativos disponibles en talle ${talle} (reemplazo para ${articulo}):`,
          productos,
          onProductoSeleccionado: async (productoSeleccionado) => {
            // Agregar el producto seleccionado al carrito
            if (window.addToCart) {
              const productData = {
                articulo: productoSeleccionado.articulo,
                color: productoSeleccionado.color,
                talle: productoSeleccionado.talle,
                cantidad: 1,
                precio: productoSeleccionado.precio,
                imagen: productoSeleccionado.imagen,
                descripcion: productoSeleccionado.descripcion,
                variant_id: productoSeleccionado.variant_id,
              };
              
              const added = await window.addToCart(productData);
              if (added) {
                // Si tenemos el itemId faltante, cancelarlo automáticamente
                if (agotadoItemId) {
                  try {
                    const { error: cancelError } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: agotadoItemId });
                    if (cancelError) {
                      console.warn("⚠️ No se pudo cancelar el item faltante:", cancelError.message || cancelError);
                    }
                  } catch (e) {
                    console.warn("⚠️ Error cancelando item faltante:", e?.message || e);
                  }
                }
                
                alert(`✅ ${productoSeleccionado.articulo} agregado al carrito`);
                // Recargar el carrito y pedidos para reflejar cambios
                if (currentUserId) {
                  await loadCart(currentUserId);
                  await loadOrders(currentUserId);
                }
              } else {
                alert(`No se pudo agregar ${productoSeleccionado.articulo} al carrito.`);
              }
            } else {
              alert("No se pudo agregar el producto al carrito. Por favor, recarga la página.");
            }
          },
          onCerrar: () => {
            console.log("Modal de alternativas cerrado");
          },
        });
      } catch (error) {
        console.error("❌ Error mostrando alternativas:", error);
        alert("No se pudieron cargar productos alternativos. Por favor, intenta nuevamente.");
      }
    };
  });
}

function attachQuantityHandlers(userId) {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;

  cartInfo.querySelectorAll(".cart-qty-btn").forEach((btn) => {
    btn.onclick = async (event) => {
      const action = event.currentTarget.dataset.action;
      const itemId = event.currentTarget.dataset.id;
      const max = Number(event.currentTarget.dataset.max) || null;
      if (!itemId) return;

      const input = cartInfo.querySelector(
        `.cart-qty-input[data-id="${itemId}"]`
      );
      let currentValue = Number(input?.value || "1") || 1;

      if (action === "increment") {
        currentValue += 1;
      } else {
        currentValue -= 1;
      }

      currentValue = Math.max(1, currentValue);

      if (max && currentValue > max) {
        alert(`Solo hay ${max} unidades disponibles para este producto.`);
        currentValue = max;
      }

      if (input) {
        input.value = currentValue;
      }

      const ok = await updateCartItemQuantity(itemId, currentValue);
      if (!ok) {
        await loadCart(userId);
        alert("No se pudo actualizar la cantidad. Verifica el stock disponible.");
      }
    };
  });

  cartInfo.querySelectorAll(".cart-qty-input").forEach((input) => {
    input.onchange = async (event) => {
      const itemId = event.currentTarget.dataset.id;
      const max = Number(event.currentTarget.dataset.max) || null;
      if (!itemId) return;

      let value = Math.max(1, Number(event.currentTarget.value || "1") || 1);

      if (max && value > max) {
        alert(`Solo hay ${max} unidades disponibles para este producto.`);
        value = max;
      }

      event.currentTarget.value = value;

      const ok = await updateCartItemQuantity(itemId, value);
      if (!ok) {
        await loadCart(userId);
        alert("No se pudo actualizar la cantidad. Verifica el stock disponible.");
      }
    };
  });
}

function setupCartActions() {
  if (cartActionsInitialized) return;
  cartActionsInitialized = true;

  const cartActions = document.getElementById("cart-actions");
  if (cartActions) {
    cartActions.style.gap = "12px";
    cartActions.style.marginTop = "16px";
    cartActions.style.flexWrap = "wrap";
  }

  const submitBtn = document.getElementById("submit-cart-btn");
  const clearBtn = document.getElementById("clear-cart-btn");

  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      if (!currentUserId) return;
      await submitCurrentCart();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      if (!currentUserId) return;
      const confirmClear = confirm(
        "¿Quieres vaciar completamente tu carrito?"
      );
      if (!confirmClear) return;
      await clearCurrentCart();
    });
  }
}

async function clearCurrentCart() {
  try {
    const clearBtn = document.getElementById("clear-cart-btn");
    if (clearBtn) clearBtn.disabled = true;

    const cartIds = currentCartItems.map((item) => item.id).filter(Boolean);
    if (!cartIds.length) {
      await loadCart(currentUserId);
      if (clearBtn) clearBtn.disabled = false;
      return;
    }

    const { error } = await supabase
      .from("cart_items")
      .delete()
      .in("id", cartIds);

    if (error) {
      alert("No se pudo limpiar el carrito. Intenta nuevamente.");
      console.error("❌ Error limpiando carrito:", error);
      return;
    }

    window.dispatchEvent(new CustomEvent("cart:synced"));
    await loadCart(currentUserId);
  } catch (error) {
    console.error("❌ Error limpiando carrito:", error);
  } finally {
    const clearBtn = document.getElementById("clear-cart-btn");
    if (clearBtn) clearBtn.disabled = false;
  }
}

async function submitCurrentCart() {
  try {
    // Verificar si hay productos agotados antes de enviar
    const hasOutOfStockItems = currentCartItems && currentCartItems.some(item => item.isOutOfStock);
    if (hasOutOfStockItems) {
      alert("⚠️ No puedes enviar el pedido porque tienes productos agotados en tu carrito. Por favor elimina los productos agotados (marcados en rosa) para continuar.");
      return;
    }
    
    const submitBtn = document.getElementById("submit-cart-btn");
    if (submitBtn) submitBtn.disabled = true;

    const { data, error } = await supabase.rpc("rpc_checkout_cart");
    if (error) {
      console.error("❌ Error enviando pedido:", error);
      alert(error.message || "No se pudo enviar el pedido. Intenta nuevamente.");
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    alert("✅ Pedido enviado. Lo verás en 'Mi pedido activo'.");
    window.dispatchEvent(new CustomEvent("cart:synced"));
    await loadCart(currentUserId);
    await loadOrders(currentUserId);
  } catch (error) {
    console.error("❌ Error enviando pedido:", error);
    alert("Ocurrió un error inesperado al enviar el pedido.");
  } finally {
    const submitBtn = document.getElementById("submit-cart-btn");
    if (submitBtn) submitBtn.disabled = false;
  }
}

function openPreviousOrdersModal() {
  const modal = document.getElementById("previous-orders-modal");
  const modalContent = document.getElementById("modal-orders-content");
  
  if (!modal || !modalContent) {
    console.error("❌ No se encontró el modal de pedidos anteriores");
    return;
  }
  
  // Abrir modal
  modal.classList.add("active");
  historyVisible = true;
  
  // Cargar pedidos
  if (!currentUserId) {
    console.error("❌ currentUserId no está disponible");
    modalContent.innerHTML = `<p style="text-align: center; color: #dc3545; padding: 40px;">Error: No se pudo identificar al usuario.</p>`;
    return;
  }
  
  modalContent.innerHTML = `<p style="text-align: center; color: #666; padding: 40px;">Cargando pedidos anteriores...</p>`;
  console.log("📋 Cargando pedidos anteriores para usuario:", currentUserId);
  loadClosedOrders(currentUserId);
}

function closePreviousOrdersModal() {
  const modal = document.getElementById("previous-orders-modal");
  
  if (!modal) {
    console.error("❌ No se encontró el modal de pedidos anteriores");
    return;
  }
  
  // Cerrar modal
  modal.classList.remove("active");
  historyVisible = false;
}

function setupModalControls() {
  if (modalControlsInitialized) return;
  
  const modal = document.getElementById("previous-orders-modal");
  const closeBtn = document.getElementById("modal-close-btn");
  
  if (!modal || !closeBtn) {
    console.warn("⚠️ No se encontraron los elementos del modal");
    return;
  }
  
  modalControlsInitialized = true;
  
  // Cerrar con botón X
  closeBtn.addEventListener("click", () => {
    closePreviousOrdersModal();
  });
  
  // Cerrar al hacer clic fuera del modal
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      closePreviousOrdersModal();
    }
  });
  
  // Cerrar con tecla ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closePreviousOrdersModal();
    }
  });
  
  console.log("✅ Controles del modal configurados");
}

function setupHistoryControls() {
  if (historyControlsInitialized) {
    console.log("ℹ️ setupHistoryControls ya inicializado, omitiendo...");
    return;
  }

  const toggleBtn = document.getElementById("toggle-history-btn");
  
  if (!toggleBtn) {
    console.warn("⚠️ No se encontró el botón de historial, reintentando en 100ms...");
    // Reintentar después de un breve delay
    setTimeout(() => {
      setupHistoryControls();
    }, 100);
    return;
  }

  historyControlsInitialized = true;
  console.log("✅ Configurando controles del historial");

  // Configurar controles del modal (esto solo se hace una vez)
  setupModalControls();

  // Al hacer clic en "Ver pedidos anteriores", abrir el modal
  toggleBtn.addEventListener("click", () => {
    console.log("🔘 Botón 'Ver pedidos anteriores' presionado");
    openPreviousOrdersModal();
  });
  
  console.log("✅ Event listener agregado al botón 'Ver pedidos anteriores'");
}

// Función para cancelar un producto individual del pedido
async function cancelOrderItem(itemId) {
  try {
    console.log("🔄 Cancelando producto del pedido:", itemId);

    // Obtener estado actual del item para decidir la acción y capturar el order_id
    const { data: itemRow, error: itemErr } = await supabase
      .from("order_items")
      .select("id, order_id, status, quantity, price_snapshot")
      .eq("id", itemId)
      .maybeSingle();

    if (itemErr || !itemRow) {
      console.error("❌ No se pudo obtener el item del pedido:", itemErr);
      alert("No se encontró el producto a cancelar.");
      return;
    }

    const orderId = itemRow.order_id;

    if ((itemRow.status || '').toLowerCase() === 'missing') {
      // Si el item fue marcado faltante por el admin, eliminarlo directamente
      const qty = Number(itemRow.quantity || 0) || 0;
      const price = Number(itemRow.price_snapshot || 0) || 0;
      const itemTotal = qty * price;

      const { error: delErr } = await supabase
        .from("order_items")
        .delete()
        .eq("id", itemId);
      if (delErr) {
        console.error("❌ Error eliminando item faltante:", delErr);
        alert("No se pudo eliminar el producto faltante.");
        return;
      }

      if (orderId && itemTotal > 0) {
        const { data: orderData } = await supabase
          .from("orders")
          .select("total_amount")
          .eq("id", orderId)
          .maybeSingle();
        if (orderData) {
          const newTotal = Math.max(0, Number(orderData.total_amount || 0) - itemTotal);
          await supabase
            .from("orders")
            .update({ total_amount: newTotal, updated_at: new Date().toISOString() })
            .eq("id", orderId);
        }
      }

      // Si el pedido queda sin items, eliminar el pedido
      await maybeDeleteEmptyOrder(orderId);

      // Recargar pedidos para mostrar los cambios
      if (currentUserId) {
        await loadOrders(currentUserId);
      }

      alert("✅ Producto faltante eliminado correctamente del pedido.");
      return;
    }

    // Para otros estados, usar el RPC estándar (puede notificar al admin si estaba picked)
    const { data, error } = await supabase.rpc("rpc_cancel_order_item", {
      p_item_id: itemId,
    });

    if (error) {
      console.error("❌ Error cancelando producto:", error);
      alert(error.message || "No se pudo cancelar el producto.");
      return;
    }

    console.log("✅ Producto cancelado correctamente:", data);

    // Si el pedido queda sin items, eliminar el pedido
    await maybeDeleteEmptyOrder(orderId);

    // Recargar pedidos para mostrar los cambios
    if (currentUserId) {
      await loadOrders(currentUserId);
    }

    // Mostrar mensaje según el estado del producto
    if (data?.was_picked) {
      alert("✅ Producto cancelado correctamente. Se ha enviado una notificación al administrador ya que este producto estaba apartado.");
    } else {
      alert("✅ Producto cancelado correctamente.");
    }
  } catch (error) {
    console.error("❌ Error cancelando producto:", error);
    alert("Ocurrió un error al cancelar el producto.");
  }
}

// Si un pedido no tiene items, eliminarlo para que no quede 'Activo' vacío
async function maybeDeleteEmptyOrder(orderId) {
  try {
    if (!orderId) return;
    const { count, error: countErr } = await supabase
      .from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId);
    if (!countErr && (Number(count) || 0) === 0) {
      await supabase.from("orders").delete().eq("id", orderId);
      console.log(`🗑️ Pedido ${orderId} eliminado por quedar sin productos`);
    }
  } catch (e) {
    console.warn("⚠️ No se pudo verificar/eliminar pedido vacío:", e?.message || e);
  }
}

async function closeOrder(orderId) {
  try {
    const confirmClose = confirm(
      "¿Está seguro que quiere cerrar su pedido y que se lo enviemos?"
    );
    if (!confirmClose) return;

    console.log("🔄 Cerrando pedido:", orderId);

    const { error } = await supabase.rpc("rpc_close_order", {
      p_order_id: orderId,
    });

    if (error) {
      console.error("❌ Error cerrando pedido:", error);
      alert(error.message || "No se pudo cerrar el pedido.");
      return;
    }

    console.log("✅ Pedido cerrado correctamente");

    // Recargar pedidos activos (el pedido cerrado aparecerá con estado "En preparación")
    await loadOrders(currentUserId);

    alert("✅ Pedido cerrado correctamente. Tu pedido está ahora en preparación y aparecerá en \"Mis Pedidos\" con el estado \"En preparación\". Cuando esté listo para enviar, pasará a \"Pedidos Anteriores\".");
  } catch (error) {
    console.error("❌ Error cerrando pedido:", error);
    alert("Ocurrió un error al cerrar el pedido.");
  }
}

async function updateCartItemQuantity(itemId, desiredQuantity) {
  try {
    let newQuantity = Math.floor(Number(desiredQuantity) || 1);
    if (newQuantity <= 0) {
      newQuantity = 1;
    }

    const { data: item, error } = await supabase
      .from("cart_items")
      .select("id, product_name, color, size, quantity, price_snapshot, variant_id")
      .eq("id", itemId)
      .maybeSingle();

    if (error || !item) {
      console.warn("⚠️ No se pudo obtener el item del carrito para actualizar.");
      return false;
    }

    const currentQty = Number(item.quantity ?? 0) || 0;

    const variantInfo = await fetchVariantInfo(
      item.product_name,
      item.color,
      item.size,
      item.variant_id
    );

    if (!variantInfo) {
      alert(
        `No se pudo verificar el stock de ${item.product_name} (${item.color} • ${item.size}).`
      );
      return false;
    }

    const remainingStock = Math.max(
      0,
      (variantInfo.available ?? 0) - currentQty
    );
    const maxAllowed = currentQty + remainingStock;

    if (maxAllowed <= 0) {
      alert(
        `No hay stock disponible para ${item.product_name} (${item.color} • ${item.size}).`
      );
      return false;
    }

    if (newQuantity > maxAllowed) {
      alert(
        `Solo puedes reservar hasta ${maxAllowed} unidades de ${item.product_name} (${item.color} • ${item.size}).`
      );
      newQuantity = maxAllowed;
    }

    const { error: updateError } = await supabase
      .from("cart_items")
      .update({
        quantity: newQuantity,
        qty: newQuantity,
        variant_id: variantInfo.id,
        price_snapshot:
          item.price_snapshot ?? variantInfo.price ?? item.price_snapshot ?? 0,
      })
      .eq("id", itemId);

    if (updateError) {
      console.error("❌ Error actualizando cantidad del carrito:", updateError);
      return false;
    }

    window.dispatchEvent(new CustomEvent("cart:synced"));
    return true;
  } catch (error) {
    console.error("❌ Error actualizando cantidad:", error);
    return false;
  }
}

let isCleaningCart = false;

async function cleanupDuplicateCartItems(cartId, items) {
  if (isCleaningCart) return false;

  const groups = new Map();
  items.forEach((item) => {
    const key = `${item.product_name || ""}__${item.color || ""}__${item.size || ""}`;
    const qty = Number(item.quantity ?? item.qty ?? 0) || 0;
    if (!groups.has(key)) {
      groups.set(key, {
        primary: item,
        duplicates: [],
        totalQty: qty,
      });
    } else {
      const group = groups.get(key);
      group.duplicates.push(item);
      group.totalQty += qty;
    }
  });

  let cleaned = false;
  isCleaningCart = true;
  try {
    for (const group of groups.values()) {
      if (group.duplicates.length === 0) continue;

      const idsToDelete = [group.primary, ...group.duplicates]
        .map((row) => row.id)
        .filter(Boolean);

      if (idsToDelete.length === 0) continue;

      const { error: deleteError } = await supabase
        .from("cart_items")
        .delete()
        .in("id", idsToDelete);

      if (deleteError) {
        console.warn(
          "⚠️ Error eliminando duplicados:",
          deleteError.message
        );
        continue;
      }

      const primary = group.primary;
      const totalQty = group.totalQty;

      const { error: insertError } = await supabase.from("cart_items").insert({
        cart_id: cartId,
        product_name: primary.product_name,
        color: primary.color,
        size: primary.size,
        quantity: totalQty,
        qty: totalQty,
        price_snapshot: primary.price_snapshot,
        status: primary.status || "reserved",
        imagen: primary.imagen || null,
        variant_id: primary.variant_id || null,
      });

      if (insertError) {
        console.warn(
          "⚠️ Error reinsertando item consolidado:",
          insertError.message
        );
        continue;
      }

      cleaned = true;
    }
  } finally {
    isCleaningCart = false;
  }

  return cleaned;
}

async function loadCart(userId) {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;

  try {
    const { data: cart, error: cartError } = await supabase
      .from("carts")
      .select("id, created_at")
      .eq("customer_id", userId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cartError || !cart) {
        cartInfo.innerHTML = `
          <h3>Carrito Actual</h3>
          <p>No hay items en el carrito</p>
        `;
      const cartActions = document.getElementById("cart-actions");
      if (cartActions) {
        cartActions.style.display = "none";
      }
      currentCartItems = [];
      return;
    }

    const { data: cartItems, error } = await supabase
      .from("cart_items")
      .select(
        "id, product_name, color, size, quantity, qty, price_snapshot, imagen, status, variant_id"
      )
      .eq("cart_id", cart.id);

      if (error) {
        cartInfo.innerHTML = `
          <h3>Carrito Actual</h3>
          <p style="color: #dc3545;">Error cargando carrito</p>
        `;
      return;
    }

    const cleaned = await cleanupDuplicateCartItems(cart.id, cartItems);
    if (cleaned) {
      await loadCart(userId);
      return;
    }

    if (!cartItems || cartItems.length === 0) {
        cartInfo.innerHTML = `
          <h3>Carrito Actual</h3>
          <p>No hay items en el carrito</p>
        `;
      const cartActions = document.getElementById("cart-actions");
      if (cartActions) {
        cartActions.style.display = "none";
      }
      currentCartItems = [];
      return;
    }

    const enrichedItems = await Promise.all(
      cartItems.map(async (item) => {
        const resolvedImage = await resolveItemImage(item);
        const variantInfo = await fetchVariantInfo(
          item.product_name,
          item.color,
          item.size,
          item.variant_id
        );
        const qtyValue = Number(item.quantity ?? item.qty ?? 0) || 0;
        
        // Verificar stock REAL disponible (sin contar lo que está en el carrito del usuario)
        // El stock disponible es: stock_qty - reserved_qty
        // No restamos qtyValue porque los productos en el carrito NO están reservados aún
        const realAvailableStock = variantInfo
          ? Math.max(0, variantInfo.available ?? 0)
          : 0;
        
        // Si la cantidad en el carrito es mayor que el stock disponible REAL, está agotado
        const isOutOfStock = qtyValue > realAvailableStock;
        
        const remainingStock = Math.max(0, realAvailableStock - qtyValue);
        const maxQty = qtyValue + remainingStock;

        return {
          ...item,
          resolvedImage,
          variantInfo,
          maxQty,
          remainingStock,
          isOutOfStock,
          realAvailableStock,
        };
      })
    );

    currentCartItems = enrichedItems;

    // Verificar si hay productos agotados
    const hasOutOfStockItems = enrichedItems.some(item => item.isOutOfStock);
    
    const cartActions = document.getElementById("cart-actions");
    if (cartActions) {
      if (enrichedItems.length > 0) {
        cartActions.style.display = "flex";
        cartActions.style.gap = "12px";
        cartActions.style.marginTop = "16px";
        cartActions.style.flexWrap = "wrap";
        cartActions.style.justifyContent = "flex-start";
        
        // Deshabilitar botón de envío si hay productos agotados
        const submitBtn = document.getElementById("submit-cart-btn");
        if (submitBtn) {
          if (hasOutOfStockItems) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = "0.5";
            submitBtn.style.cursor = "not-allowed";
            submitBtn.title = "No puedes enviar el pedido mientras haya productos agotados. Elimina los productos agotados para continuar.";
            console.log("🔴 Botón de envío deshabilitado - hay productos agotados");
      } else {
            submitBtn.disabled = false;
            submitBtn.style.opacity = "1";
            submitBtn.style.cursor = "pointer";
            submitBtn.title = "";
            console.log("🟢 Botones de carrito visibles y habilitados");
          }
        }
        
        // Mostrar mensaje si hay productos agotados
        const existingWarning = cartActions.querySelector(".out-of-stock-warning");
        if (hasOutOfStockItems) {
          if (!existingWarning) {
            const warningDiv = document.createElement("div");
            warningDiv.className = "out-of-stock-warning";
            warningDiv.style.cssText = "width:100%; padding:12px; background:#fff3cd; border:2px solid #ffc107; border-radius:8px; color:#856404; font-size:14px; margin-bottom:12px; font-weight:600;";
            warningDiv.innerHTML = "⚠️ Tienes productos agotados en tu carrito. Elimínalos para poder enviar tu pedido.";
            cartActions.insertBefore(warningDiv, cartActions.firstChild);
          }
        } else {
          if (existingWarning) {
            existingWarning.remove();
          }
        }
      } else {
        cartActions.style.display = "none";
        console.log("⚪ Botones de carrito ocultos (sin items)");
      }
    }

    const totalItems = enrichedItems.reduce((sum, item) => {
      const qty = Number(item.quantity ?? item.qty ?? 0);
      return sum + (Number.isFinite(qty) ? qty : 0);
    }, 0);

    // Obtener ofertas y promociones para los items del carrito
    const offersData = await getOffersAndPromotionsForItems(enrichedItems);
    
    const totalPrice = enrichedItems.reduce((sum, item) => {
      const qty = Number(item.quantity ?? item.qty ?? 0);
      const price = Number(item.price_snapshot ?? 0);
      return sum + (Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0);
    }, 0);

    const itemsHtml = enrichedItems
      .map((item) => {
        const itemKey = item.id || `${item.product_name}-${item.color}-${item.size}`;
        const promoText = offersData.itemPromos?.get(itemKey);
        const offerInfo = offersData.itemOffers?.get(itemKey);
        
        const qty = Number(item.quantity ?? item.qty ?? 0) || 0;
        let price = Number(item.price_snapshot ?? item.variantInfo?.price ?? 0) || 0;
        let originalPrice = null;
        
        if (promoText) {
          originalPrice = price;
        } else if (offerInfo) {
          originalPrice = offerInfo.originalPrice;
          price = offerInfo.offerPrice;
        }
        
        const lineTotal = qty * price;
        const thumb = item.resolvedImage || FALLBACK_IMAGE;
        const productName = item.product_name || "Producto";
        const color = item.color || "Color único";
        const size = item.size || "Talle único";
        const maxQty = Math.max(1, Math.floor(Number(item.maxQty) || qty));
        const remainingStock =
          Math.max(0, Math.floor(Number(item.remainingStock) || 0)) || 0;
        const isOutOfStock = item.isOutOfStock || false;
        const realAvailableStock = item.realAvailableStock || 0;
        
        // Mostrar leyenda de oferta o promoción
        let offerPromoBadge = '';
        if (promoText) {
          offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #ff9800; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">${promoText}</div>`;
        } else if (offerInfo) {
          offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #e74c3c; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">🔥 Oferta</div>`;
        }
        
        // Estilos para producto agotado (tonos rosas)
        const outOfStockStyles = isOutOfStock
          ? `background: #fce4ec; border: 2px solid #f48fb1; opacity: 0.9;`
          : ``;
        const outOfStockTextStyles = isOutOfStock
          ? `color: #c2185b; font-weight: 600;`
          : ``;
        
        return `
          <div class="cart-mini-item ${isOutOfStock ? 'cart-item-out-of-stock' : ''}" style="${outOfStockStyles}">
            <div style="display:flex; gap:12px; align-items:flex-start;">
              <img src="${thumb}" alt="${productName}" class="cart-mini-thumb" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" style="opacity: ${isOutOfStock ? '0.6' : '1'};">
              <div class="cart-mini-body">
                <div class="cart-mini-header" style="display:flex; align-items:flex-start; gap:8px;">
                  <div class="cart-mini-title" style="${outOfStockTextStyles}">${productName}</div>
                  <button class="cart-mini-remove" data-id="${item.id}" title="Eliminar ítem">&times;</button>
                </div>
                <div class="cart-mini-meta" style="${outOfStockTextStyles}">Color: ${color} • Talle: ${size}</div>
                ${offerPromoBadge}
                ${isOutOfStock ? `
                  <div style="margin-top:8px; padding:8px; background:#f8bbd0; border-radius:6px; color:#880e4f; font-size:13px; font-weight:600;">
                    ⚠️ Este producto está agotado. Solo hay ${realAvailableStock} unidad(es) disponible(s). Por favor elimínalo del carrito para continuar.
                  </div>
                  <button class="btn-ver-alternativas" 
                          data-articulo="${productName}" 
                          data-color="${color}" 
                          data-talle="${size}"
                          data-item-id="${item.id}"
                          style="margin-top:8px; padding:8px 12px; background:#CD844D; color:white; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; width:100%;">
                    Ver alternativas
                  </button>
                ` : ''}
              </div>
              <div class="cart-mini-footer">
                <span class="cart-mini-price" style="${outOfStockTextStyles}">
                  ${originalPrice ? `<span style="text-decoration: line-through; color: #888; font-size: 0.9em; margin-right: 8px;">$${(originalPrice * qty).toLocaleString('es-AR')}</span>` : ''}
                  $${(price * qty).toLocaleString('es-AR')}
                </span>
                <div class="cart-mini-quantity" style="display:flex; align-items:center; gap:8px;">
                  <button class="cart-qty-btn" data-action="decrement" data-id="${item.id}" data-max="${maxQty}" ${isOutOfStock ? 'disabled' : ''} style="${isOutOfStock ? 'opacity:0.5; cursor:not-allowed;' : ''}">−</button>
                  <input type="number" class="cart-qty-input" data-id="${item.id}" data-max="${maxQty}" min="1" value="${qty}" style="width:64px; text-align:center; ${isOutOfStock ? 'opacity:0.5;' : ''}" ${isOutOfStock ? 'disabled' : ''}>
                  <button class="cart-qty-btn" data-action="increment" data-id="${item.id}" data-max="${maxQty}" ${isOutOfStock ? 'disabled' : ''} style="${isOutOfStock ? 'opacity:0.5; cursor:not-allowed;' : ''}">+</button>
                </div>
                <span class="cart-mini-stock" style="${outOfStockTextStyles}">Stock disponible: ${realAvailableStock}</span>
                <span style="${outOfStockTextStyles}">Total: $${lineTotal.toLocaleString('es-AR')}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join("");
    
    // Agregar resumen de descuentos si hay
    let discountSummaryHtml = '';
    if (offersData.totalDiscount > 0) {
      discountSummaryHtml = `
        <div style="margin-top: 12px; padding: 12px; background: #fff3e0; border-left: 4px solid #ff9800; border-radius: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong style="font-size: 15px;">🔥 Ofertas y Promociones</strong>
              <div style="font-size: 14px; color: #ff9800; margin-top: 4px; font-weight: 600;">
                Descuento: -$${offersData.totalDiscount.toLocaleString('es-AR')}
              </div>
            </div>
          </div>
        </div>
      `;
    }

        cartInfo.innerHTML = `
      <div class="cart-mini-summary">
        <div><strong>Items totales:</strong> ${totalItems}</div>
        <div><strong>Productos únicos:</strong> ${enrichedItems.length}</div>
        <div><strong>Total estimado:</strong> $${totalPrice.toLocaleString()}</div>
        ${offersData.totalDiscount > 0 ? `<div style="color: #ff9800; font-weight: 600;"><strong>Descuento aplicado:</strong> -$${offersData.totalDiscount.toLocaleString('es-AR')}</div>` : ''}
        ${offersData.totalDiscount > 0 ? `<div style="color: #CD844D; font-weight: 600; font-size: 16px; margin-top: 4px;"><strong>Total con descuento:</strong> $${(totalPrice - offersData.totalDiscount).toLocaleString('es-AR')}</div>` : ''}
      </div>
      <div class="cart-items-list">
        ${itemsHtml}
      </div>
      ${discountSummaryHtml}
    `;

    attachRemoveHandlers(userId);
    attachQuantityHandlers(userId);
    attachAlternativasHandlers(userId);

    // Actualizar almacenamiento local para mantener sincronizados catálogo y dashboard
    try {
      const storageItems = enrichedItems.map((item) => ({
        id: item.id,
        articulo: item.product_name,
        color: item.color,
        talle: item.size,
        cantidad: Number(item.quantity ?? item.qty ?? 0) || 0,
        precio:
          Number(item.price_snapshot ?? item.variantInfo?.price ?? 0) || 0,
        imagen: item.imagen || item.resolvedImage || null,
        descripcion: null,
        variant_id: item.variant_id || item.variantInfo?.id || null,
      }));
      window.localStorage.setItem("fyl_cart", JSON.stringify(storageItems));
    } catch (storageError) {
      console.warn("⚠️ No se pudo actualizar el carrito local:", storageError);
    }
  } catch (error) {
    console.warn("⚠️ Error cargando carrito:", error.message);
      cartInfo.innerHTML = `
        <h3>Carrito Actual</h3>
        <p style="color: #dc3545;">Error cargando carrito</p>
      `;
  }
}

async function loadOrders(userId) {
  const ordersSection = document.getElementById("orders-section");
  if (!ordersSection) return;

  try {
    // Cargar pedidos activos y cerrados (pero NO enviados)
    // Los pedidos "closed" aparecerán con aviso "En preparación"
    const { data: orders, error } = await supabase
      .from("orders")
      .select(
        "id, order_number, status, total_amount, created_at, updated_at, order_items(id, product_name, color, size, quantity, price_snapshot, imagen, status, variant_id)"
      )
      .eq("customer_id", userId)
      .neq("status", "sent")  // Solo excluir "sent", incluir "active" y "closed"
      .order("created_at", { ascending: false });

      if (error) {
        ordersSection.innerHTML = `
        <div class="order-item" style="border:1px solid #f5c6cb; background:#f8d7da; padding:16px; border-radius:8px;">
          <p style="color:#721c24; margin:0;">Error cargando pedidos activos.</p>
        </div>
        `;
      return;
    }

    if (!orders || orders.length === 0) {
        ordersSection.innerHTML = `
        <div class="order-item" style="border:1px solid #e0e0e0; padding:16px; border-radius:8px; background:#fafafa;">
          <p style="margin:0;">Todavía no tienes pedidos. Envía tu carrito para crear uno nuevo.</p>
        </div>
      `;
      return;
    }

    const ordersHtml = await Promise.all(orders.map(async (order) => {
        const items = order.order_items || [];
        const orderStatus = (order.status || "").toLowerCase().trim();
        const isActive = orderStatus === "active";
        const isClosed = orderStatus === "closed";  // En preparación
        
        // Calcular total excluyendo items faltantes
        const validItems = items.filter(item => item.status !== 'missing');
        const total = validItems.reduce((sum, item) => {
          const qty = Number(item.quantity || 0) || 0;
          const price = Number(item.price_snapshot || 0) || 0;
          return sum + (qty * price);
        }, 0);
        
        // Obtener número de pedido o usar ID como fallback
        const orderDisplayNumber = order.order_number || order.id.substring(0, 8);
        
        // Determinar el estado a mostrar
        let statusLabel = "Activo";
        let statusStyle = "background:#e6f4ea; color:#1b5e20;";
        
        if (isClosed) {
          statusLabel = "En preparación";
          statusStyle = "background:#fff3cd; color:#856404;";
        } else if (isActive) {
          statusLabel = "Activo";
          statusStyle = "background:#e6f4ea; color:#1b5e20;";
        }
        
        // Obtener ofertas y promociones para los items del pedido
        const offersData = await getOffersAndPromotionsForItems(items.filter(item => item.status !== 'cancelled'));
        
        const itemsHtml = items
          .filter(item => item.status !== 'cancelled') // Excluir items cancelados de la vista
          .map((item) => {
            const itemKey = item.id || `${item.product_name}-${item.color}-${item.size}`;
            const promoText = offersData.itemPromos?.get(itemKey);
            const offerInfo = offersData.itemOffers?.get(itemKey);
            
            let price = Number(item.price_snapshot || 0) || 0;
            let originalPrice = null;
            
            if (promoText) {
              originalPrice = price;
            } else if (offerInfo) {
              originalPrice = offerInfo.originalPrice;
              price = offerInfo.offerPrice;
            }
            
            const qty = Number(item.quantity || 0) || 0;
            const lineTotal = qty * price;
            // Mapear 'waiting' a 'picked' para los clientes (estado interno)
            const itemStatus = item.status || 'reserved';
            const displayStatus = itemStatus === 'waiting' ? 'picked' : itemStatus;
            const isMissing = displayStatus === 'missing';
            const isPicked = displayStatus === 'picked';
            const isReserved = displayStatus === 'reserved';
            
            // Mostrar leyenda de oferta o promoción
            let offerPromoBadge = '';
            if (promoText) {
              offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #ff9800; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">${promoText}</div>`;
            } else if (offerInfo) {
              offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #e74c3c; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">🔥 Oferta</div>`;
            }
            
            // Determinar el texto del estado
            let statusText = '';
            let statusClass = '';
            let statusIcon = '';
            
            if (isPicked) {
              statusText = 'Apartado';
              statusClass = 'item-status-picked';
              statusIcon = '✓';
            } else if (isMissing) {
              statusText = 'Faltante';
              statusClass = 'item-status-missing';
              statusIcon = '✕';
            } else if (isReserved) {
              statusText = 'En proceso de reserva';
              statusClass = 'item-status-reserved';
              statusIcon = '⏳';
            }
            
            // Botón cancelar solo visible si el pedido está activo o cerrado (pero no enviado)
            const canCancel = isActive || isClosed;
            
            return `
              <div class="cart-mini-item order-item-product ${isMissing ? 'item-missing' : ''}" style="padding:12px; border:1px solid ${isMissing ? '#f5c6cb' : '#eee'}; background:${isMissing ? '#f8d7da' : '#fff'}; border-radius:8px; margin-bottom:8px;">
                <div style="display:flex; gap:12px; align-items:flex-start;">
                  <img src="${item.imagen || FALLBACK_IMAGE}" alt="${
              item.product_name || "Producto"
            }" class="cart-mini-thumb" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" style="opacity:${isMissing ? '0.5' : '1'};">
                  <div class="cart-mini-body" style="flex:1;">
                    <div class="cart-mini-header" style="display:flex; align-items:flex-start; gap:8px; justify-content:space-between;">
                      <div class="cart-mini-title" style="${isMissing ? 'text-decoration: line-through; opacity: 0.6;' : ''}">${item.product_name || "Producto"}</div>
                      ${isPicked ? `<span class="item-status-badge ${statusClass}" style="background:#e6f4ea; color:#1b5e20; padding:4px 8px; border-radius:12px; font-size:12px; font-weight:600; display:flex; align-items:center; gap:4px;"><span>${statusIcon}</span> ${statusText}</span>` : ''}
                      ${isMissing ? `<span class="item-status-badge ${statusClass}" style="background:#fdecea; color:#c62828; padding:4px 8px; border-radius:12px; font-size:12px; font-weight:600; display:flex; align-items:center; gap:4px;"><span>${statusIcon}</span> ${statusText}</span>` : ''}
                      ${isReserved ? `<span class="item-status-badge ${statusClass}" style="background:#fff3cd; color:#856404; padding:4px 8px; border-radius:12px; font-size:12px; font-weight:600; display:flex; align-items:center; gap:4px;"><span>${statusIcon}</span> ${statusText}</span>` : ''}
                    </div>
                    <div class="cart-mini-meta" style="${isMissing ? 'text-decoration: line-through; opacity: 0.6;' : ''}">Color: ${
                      item.color || "Color único"
                    } • Talle: ${item.size || "Talle único"}</div>
                    ${offerPromoBadge}
                    <div class="cart-mini-footer" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
                      <span class="cart-mini-price" style="${isMissing ? 'text-decoration: line-through; opacity: 0.6; color: #999;' : ''}">
                        ${originalPrice ? `<span style="text-decoration: line-through; color: #888; font-size: 0.9em; margin-right: 8px;">$${(originalPrice * qty).toLocaleString('es-AR')}</span>` : ''}
                        $${(price * qty).toLocaleString('es-AR')}
                      </span>
                      <span style="${isMissing ? 'text-decoration: line-through; opacity: 0.6;' : ''}">Cantidad: ${qty}</span>
                      <span style="${isMissing ? 'text-decoration: line-through; opacity: 0.6; color: #999;' : 'font-weight:600; color:#CD844D;'}">Total: $${lineTotal.toLocaleString('es-AR')}</span>
                    </div>
                    <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
                      ${isMissing ? `<button class="btn-ver-alternativas-faltante" data-item-id="${item.id}" data-articulo="${item.product_name || ''}" data-color="${item.color || ''}" data-talle="${item.size || ''}" style="padding:6px 12px; background:#CD844D; color:white; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600;">Ver alternativas</button>` : ''}
                      ${canCancel ? `<button class="btn-cancel-item" data-item-id="${item.id}" data-product-name="${item.product_name || 'Producto'}" style="padding:6px 12px; background:#dc3545; color:white; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600;">Cancelar producto</button>` : ''}
                    </div>
                  </div>
                </div>
              </div>
            `;
          })
          .join("");
        
        // Agregar resumen de descuentos si hay
        let discountSummaryHtml = '';
        if (offersData.totalDiscount > 0) {
          discountSummaryHtml = `
            <div style="margin-top: 12px; padding: 12px; background: #fff3e0; border-left: 4px solid #ff9800; border-radius: 4px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <strong style="font-size: 15px;">🔥 Ofertas y Promociones</strong>
                  <div style="font-size: 14px; color: #ff9800; margin-top: 4px; font-weight: 600;">
                    Descuento: -$${offersData.totalDiscount.toLocaleString('es-AR')}
                  </div>
                </div>
              </div>
            </div>
          `;
        }

        return `
          <div class="order-item" style="padding:16px; border:1px solid #ddd; border-radius:10px; background:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.1);">
            <div style="margin-bottom:12px; padding-bottom:12px; border-bottom:2px solid #eee;">
              <p style="margin:4px 0; font-size:16px; font-weight:600;"><strong>Pedido #${orderDisplayNumber}</strong></p>
              <p style="margin:4px 0; font-size:14px; color:#666;">Estado: <span class="status-active" style="padding:4px 10px; border-radius:12px; font-size:12px; font-weight:600; ${statusStyle}">${statusLabel}</span></p>
              ${isClosed ? `<p style="margin:4px 0; font-size:13px; color:#856404; font-style:italic;">⏳ Tu pedido está siendo preparado para el envío</p>` : ''}
              <p style="margin:4px 0; font-size:14px; color:#666;">Creado: ${new Date(order.created_at).toLocaleString('es-AR')}</p>
              ${isClosed ? `<p style="margin:4px 0; font-size:14px; color:#666;">Cerrado: ${new Date(order.updated_at || order.created_at).toLocaleString('es-AR')}</p>` : ''}
              <p style="margin:8px 0 0 0; font-size:18px; font-weight:600; color:#CD844D;">Total: $${total.toLocaleString('es-AR')}</p>
              ${offersData.totalDiscount > 0 ? `<p style="margin:4px 0 0 0; font-size:14px; color:#ff9800; font-weight:600;">Descuento aplicado: -$${offersData.totalDiscount.toLocaleString('es-AR')}</p>` : ''}
              ${offersData.totalDiscount > 0 ? `<p style="margin:4px 0 0 0; font-size:16px; font-weight:600; color:#CD844D;">Total con descuento: $${(total - offersData.totalDiscount).toLocaleString('es-AR')}</p>` : ''}
            </div>
            ${
              isActive
                ? `<div style="display:flex; gap:8px; margin-bottom:12px;">
                     <button class="btn" data-cancel-entire-order="${order.id}" style="background:#dc3545; color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:14px;">Cancelar pedido</button>
                     <button class="btn close-order-btn" data-order-id="${order.id}" style="background:#CD844D; color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:14px;">Cerrar pedido</button>
                   </div>`
                : ""
            }
            <div class="cart-items-list" style="margin-top:12px;">
              ${itemsHtml || "<p>No hay productos asociados al pedido.</p>"}
            </div>
            ${discountSummaryHtml}
          </div>
        `;
      }));
    
    const ordersHtmlFinal = ordersHtml.join("");

        ordersSection.innerHTML = `
          <div class="orders-list">
        ${ordersHtmlFinal}
              </div>
        `;

    document.querySelectorAll(".close-order-btn").forEach((btn) => {
      btn.onclick = async () => {
        const orderId = btn.dataset.orderId;
        if (!orderId) return;
        await closeOrder(orderId);
      };
    });

    // Nuevo: cancelar pedido completo
    document.querySelectorAll("[data-cancel-entire-order]").forEach((btn) => {
      btn.onclick = async () => {
        const orderId = btn.dataset.cancelEntireOrder;
        if (!orderId) return;
        await cancelEntireOrder(orderId);
      };
    });
    
    // Configurar botones de cancelar producto
    document.querySelectorAll(".btn-cancel-item").forEach((btn) => {
      btn.onclick = async () => {
        const itemId = btn.dataset.itemId;
        const productName = btn.dataset.productName || "este producto";
        if (!itemId) return;
        
        const confirmed = confirm(
          `¿Estás seguro que quieres cancelar "${productName}"? ${
            btn.closest('.order-item-product')?.querySelector('.item-status-picked') 
              ? 'Este producto ya fue apartado por el administrador, se le enviará una notificación.' 
              : 'Este producto está en proceso de reserva y no afectará al administrador.'
          }`
        );
        
        if (!confirmed) return;
        
        await cancelOrderItem(itemId);
      };
    });
    
    // Configurar botones de ver alternativas para productos faltantes
    document.querySelectorAll(".btn-ver-alternativas-faltante").forEach((btn) => {
      btn.onclick = async () => {
        const articulo = btn.dataset.articulo;
        const color = btn.dataset.color;
        const talle = btn.dataset.talle;
        const itemId = btn.dataset.itemId;
        
        if (!articulo || !talle) {
          alert("No se pudo obtener la información del producto faltante.");
          return;
        }
        
        await mostrarAlternativasParaProductoFaltante({
          articulo,
          color,
          talle,
          itemId,
        });
      };
    });
    
    setupHistoryControls();
  } catch (error) {
    console.warn("⚠️ Error cargando pedidos:", error.message);
        ordersSection.innerHTML = `
      <div class="order-item" style="border:1px solid #f5c6cb; background:#f8d7da; padding:16px; border-radius:8px;">
        <p style="color:#721c24; margin:0;">Error cargando pedidos activos.</p>
          </div>
        `;
  }
}

async function loadClosedOrders(userId) {
  // Usar el contenedor del modal en lugar del contenedor de historial
  const historyContainer = document.getElementById("modal-orders-content");
  if (!historyContainer) {
    console.error("❌ No se encontró el contenedor del modal");
    return;
  }

  if (!userId) {
    console.error("❌ userId no proporcionado");
    historyContainer.innerHTML = `
      <p style="text-align: center; color: #dc3545; padding: 40px;">Error: No se pudo identificar al usuario.</p>
    `;
    return;
  }

  try {
    console.log("📋 Buscando pedidos cerrados/enviados para usuario:", userId);
    
    // Primero, verificar todos los pedidos del usuario para depuración
    const { data: allOrders, error: allOrdersError } = await supabase
      .from("orders")
      .select("id, order_number, status, customer_id")
      .eq("customer_id", userId);
    
    if (allOrdersError) {
      console.error("❌ Error obteniendo todos los pedidos:", allOrdersError);
    } else if (allOrders) {
      console.log("📋 Todos los pedidos del usuario:", allOrders.length, "pedidos encontrados");
      allOrders.forEach(o => {
        console.log(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}", customer_id="${o.customer_id}"`);
      });
      
      // Verificar cuántos pedidos tienen estado sent (solo estos aparecen en Pedidos Anteriores)
      const sentOrders = allOrders.filter(o => {
        const status = (o.status || "").toLowerCase().trim();
        return status === "sent";
      });
      console.log(`📋 Pedidos con estado "sent" (Pedidos Anteriores):`, sentOrders.length);
      sentOrders.forEach(o => {
        console.log(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}", customer_id="${o.customer_id}"`);
      });
      
      // Verificar pedidos "closed" (aparecen en Mis Pedidos con "En preparación")
      const closedOrders = allOrders.filter(o => {
        const status = (o.status || "").toLowerCase().trim();
        return status === "closed";
      });
      console.log(`📋 Pedidos con estado "closed" (Mis Pedidos - En preparación):`, closedOrders.length);
      
      // Verificar si hay pedidos con estados diferentes
      const otherStatuses = allOrders.filter(o => {
        const status = (o.status || "").toLowerCase().trim();
        return status !== "closed" && status !== "sent" && status !== "active";
      });
      if (otherStatuses.length > 0) {
        console.log(`📋 Pedidos con otros estados:`, otherStatuses.length);
        otherStatuses.forEach(o => {
          console.log(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}"`);
        });
      }
      } else {
      console.log("⚠️ No se encontraron pedidos para el usuario");
    }
    
    // Intentar obtener pedidos cerrados/enviados
    // Primero intentar con consultas separadas que son más confiables
    console.log("📋 Intentando consultas separadas para closed y sent...");
    
    // SOLO pedidos enviados (sent) aparecen en "Pedidos Anteriores"
    // Los pedidos "closed" aparecen en "Mis Pedidos" con aviso "En preparación"
    const { data: sentOrders, error: sentError } = await supabase
      .from("orders")
      .select(
        "id, order_number, status, total_amount, created_at, updated_at, order_items(id, product_name, color, size, quantity, price_snapshot, imagen, status, variant_id)"
      )
      .eq("customer_id", userId)
      .eq("status", "sent")
      .order("created_at", { ascending: false });
    
    // Verificar errores
    if (sentError) {
      console.error("❌ Error obteniendo pedidos enviados:", sentError);
    } else {
      console.log("📋 Pedidos enviados encontrados:", sentOrders?.length || 0);
    }
    
    const finalOrders = sentOrders || [];
    const error = sentError || null;

    if (error) {
      console.error("❌ Error cargando pedidos anteriores:", error);
      console.error("❌ Detalles del error:", JSON.stringify(error, null, 2));
      
      historyContainer.innerHTML = `
        <div class="order-item" style="border:1px solid #f5c6cb; background:#f8d7da; padding:16px; border-radius:8px;">
          <p style="color:#721c24; margin:0;">Error cargando pedidos anteriores: ${error.message}</p>
          <p style="color:#721c24; margin:4px 0 0 0; font-size:12px;">Por favor, revisa la consola para más detalles.</p>
        </div>
      `;
      return;
    }

    console.log("📋 Total de pedidos enviados (sent):", finalOrders.length);
    if (finalOrders && finalOrders.length > 0) {
      finalOrders.forEach(o => {
        console.log(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}", items=${o.order_items?.length || 0}`);
      });
    }
    
    if (!finalOrders || finalOrders.length === 0) {
      console.log("ℹ️ No se encontraron pedidos enviados (estado 'sent')");
      console.log("ℹ️ Nota: Los pedidos 'closed' aparecen en 'Mis Pedidos' con aviso 'En preparación'");
      
      historyContainer.innerHTML = `
        <p style="text-align: center; color: #666; padding: 40px;">No tienes pedidos anteriores. Los pedidos en preparación aparecen en "Mis Pedidos".</p>
      `;
      return;
    }

    console.log("✅ Mostrando", finalOrders.length, "pedidos anteriores");
    
    // Ordenar pedidos por fecha más reciente primero
    const sortedOrders = [...finalOrders].sort((a, b) => {
      const dateA = new Date(a.updated_at || a.created_at);
      const dateB = new Date(b.updated_at || b.created_at);
      return dateB - dateA; // Más reciente primero
    });
    
    const ordersHtml = sortedOrders
      .map((order) => {
        const orderDate = new Date(order.updated_at || order.created_at);
        const formattedDate = orderDate.toLocaleDateString("es-AR", {
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
        const orderNumber = order.order_number || order.id.substring(0, 8);
        const items = order.order_items || [];
        
        // Calcular total excluyendo items faltantes
        const validItems = items.filter(item => item.status !== 'missing');
        const total = validItems.reduce((sum, item) => {
          const qty = Number(item.quantity || 0) || 0;
          const price = Number(item.price_snapshot || 0) || 0;
          return sum + (qty * price);
        }, 0);
        
        // Generar HTML de items del pedido
        const itemsHtml = items.length > 0
          ? items.map(item => {
              const itemImage = item.imagen || FALLBACK_IMAGE;
              const itemQuantity = Number(item.quantity || 0);
              const itemPrice = Number(item.price_snapshot || 0);
              const itemSubtotal = itemQuantity * itemPrice;
              const isMissing = item.status === 'missing';
              const itemClass = isMissing ? 'order-item-detail missing' : 'order-item-detail';
              
              return `
                <div class="${itemClass}">
                  <img src="${itemImage}" alt="${item.product_name || 'Producto'}" class="order-item-detail-image" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
                  <div class="order-item-detail-info">
                    <div class="order-item-detail-name">${item.product_name || "Producto sin nombre"} ${isMissing ? '<span style="color: #dc3545; font-size: 12px;">(Faltante)</span>' : ''}</div>
                    <div class="order-item-detail-meta">Color: ${item.color || "-"} • Talle: ${item.size || "-"}</div>
                    <div class="order-item-detail-quantity">Cantidad: ${itemQuantity}</div>
                  </div>
                  <div class="order-item-detail-price" style="${isMissing ? 'text-decoration: line-through; opacity: 0.5;' : ''}">$${itemSubtotal.toLocaleString("es-AR")}</div>
                </div>
              `;
            }).join("")
          : "<p style='color: #666; font-size: 14px;'>No hay productos en este pedido.</p>";
        
        return `
          <div class="order-date-item" data-order-id="${order.id}">
            <div class="order-date-item-header" data-order-toggle="${order.id}">
              <span class="order-date">${formattedDate} <span class="order-expand-icon">▼</span></span>
              <span class="order-number">#${orderNumber}</span>
            </div>
            <div class="order-total">Total: $${total.toLocaleString("es-AR")}</div>
            <div class="order-items-detail" id="order-items-${order.id}">
              ${itemsHtml}
              ${items.length > 0 ? `<div class="order-items-summary">Total del pedido: $${total.toLocaleString("es-AR")}</div>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    historyContainer.innerHTML = `
      <div class="orders-list">
        ${ordersHtml}
      </div>
    `;
    
    // Agregar event listeners para expandir/contraer pedidos dentro del modal
    const modalOrdersList = historyContainer.querySelector(".orders-list");
    if (modalOrdersList) {
      modalOrdersList.querySelectorAll("[data-order-toggle]").forEach(toggleBtn => {
        toggleBtn.addEventListener("click", (e) => {
          e.stopPropagation(); // Evitar que se propague el evento
          
          const orderId = toggleBtn.dataset.orderToggle;
          const orderItem = modalOrdersList.querySelector(`[data-order-id="${orderId}"]`);
          const itemsDetail = document.getElementById(`order-items-${orderId}`);
          
          if (orderItem && itemsDetail) {
            // Toggle expanded
            if (orderItem.classList.contains("expanded")) {
              orderItem.classList.remove("expanded");
              itemsDetail.classList.remove("visible");
            } else {
              // Cerrar otros pedidos expandidos
              modalOrdersList.querySelectorAll(".order-date-item.expanded").forEach(expanded => {
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
    }
  } catch (error) {
    console.warn("⚠️ Error cargando pedidos anteriores:", error.message);
    historyContainer.innerHTML = `
      <p style="text-align: center; color: #dc3545; padding: 40px;">Error cargando pedidos anteriores.</p>
    `;
  }
}

function showNoSession() {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (!dashboardContent) return;
    const messageDiv = document.createElement("div");
    messageDiv.style.cssText = `
      background: #f8d7da;
      border: 1px solid #f5c6cb;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 20px;
      color: #721c24;
    `;
    messageDiv.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 20px;">🔒</span>
        <div>
          <strong>No hay sesión activa</strong>
          <p style="margin: 5px 0 0 0; font-size: 14px;">
            <a href="./login.html" style="color: #CD844D; text-decoration: underline;">Inicia sesión</a> para acceder a tu área personal.
          </p>
        </div>
      </div>
    `;
    dashboardContent.insertBefore(messageDiv, dashboardContent.firstChild);
}

function showError(message) {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (!dashboardContent) return;
    const messageDiv = document.createElement("div");
    messageDiv.style.cssText = `
      background: #fff3cd;
      border: 1px solid #ffeaa7;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 20px;
      color: #856404;
    `;
    messageDiv.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 20px;">⚠️</span>
        <div>
          <strong>Error</strong>
          <p style="margin: 5px 0 0 0; font-size: 14px;">${message}</p>
        </div>
      </div>
    `;
    dashboardContent.insertBefore(messageDiv, dashboardContent.firstChild);
  }

async function loadData() {
  try {
    setContentVisibility(false);

    await withAuth(
      async (user) => {
        currentUserId = user.id;
        const userName = document.getElementById("user-name");
        const userEmail = document.getElementById("user-email");
        const userAvatar = document.getElementById("user-avatar");

        if (userName) {
          userName.textContent =
            user.user_metadata?.full_name ||
            user.email?.split("@")[0] ||
            "Usuario";
        }
        if (userEmail) {
          userEmail.textContent = user.email;
        }
        if (userAvatar) {
          const displayName =
            user.user_metadata?.full_name ||
            user.email?.split("@")[0] ||
            "Usuario";
          const avatarUrl =
            user.user_metadata?.avatar_url ||
            user.user_metadata?.picture ||
            `https://ui-avatars.com/api/?name=${encodeURIComponent(
              displayName
            )}&background=CD844D&color=fff&size=96`;
          userAvatar.src = avatarUrl;
          userAvatar.alt = `Avatar de ${displayName}`;
        }

        setupCartActions();

        await loadCart(user.id);
        await loadOrders(user.id);
        
        // Asegurar que los controles del historial estén configurados
        // Esto es necesario incluso si no hay pedidos para que el botón funcione
        setupHistoryControls();

        if (!cartSyncedListenerRegistered) {
          window.addEventListener("cart:synced", () => loadCart(user.id));
          cartSyncedListenerRegistered = true;
        }

        // Configurar suscripción en tiempo real para pedidos
        setupOrdersRealtimeSubscription(user.id);

        setContentVisibility(true);
        hideLoader();
      },
      async () => {
        showNoSession();
        setContentVisibility(true);
        hideLoader();
      }
    );
  } catch (error) {
    console.warn("⚠️ Error cargando datos del dashboard:", error.message);
    showError("Error de conexión");
    setContentVisibility(true);
    hideLoader();
  }
}

function initDashboard() {
  showContent();
  setContentVisibility(false);
  loadData();
}

// Función para configurar suscripción en tiempo real para pedidos
async function setupOrdersRealtimeSubscription(userId) {
  if (!supabase || !userId) return;
  
  // Cancelar suscripción anterior si existe
  if (ordersRealtimeSubscription) {
    try {
      await supabase.removeChannel(ordersRealtimeSubscription);
      ordersRealtimeSubscription = null;
    } catch (error) {
      console.warn("⚠️ Error eliminando suscripción anterior:", error);
    }
  }
  
  // Suscribirse a cambios en orders del cliente
  // Nota: Supabase Realtime solo permite filtros simples, así que nos suscribimos a todos los cambios
  // y luego verificamos si el pedido pertenece al usuario en el callback
  ordersRealtimeSubscription = supabase
    .channel(`orders-updates-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "*", // INSERT, UPDATE, DELETE
        schema: "public",
        table: "orders",
      },
      async (payload) => {
        // Solo procesar si el pedido pertenece al usuario actual
        if (payload.new && payload.new.customer_id === userId) {
          console.log("🔄 Cambio en pedidos detectado:", payload.eventType);
          if (currentUserId) {
            await loadOrders(currentUserId);
            // Si el modal está abierto, recargar pedidos anteriores también
            const modal = document.getElementById("previous-orders-modal");
            if (modal && modal.classList.contains("active")) {
              await loadClosedOrders(currentUserId);
            }
          }
        } else if (payload.old && payload.old.customer_id === userId) {
          // Para DELETE, payload.old contiene los datos antiguos
          console.log("🔄 Eliminación de pedido detectada:", payload.eventType);
          if (currentUserId) {
            await loadOrders(currentUserId);
            // Si el modal está abierto, recargar pedidos anteriores también
            const modal = document.getElementById("previous-orders-modal");
            if (modal && modal.classList.contains("active")) {
              await loadClosedOrders(currentUserId);
            }
          }
        }
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
        // Verificar si el item pertenece a un pedido del usuario
        // Necesitamos obtener el order_id y verificar si pertenece al usuario
        const orderId = payload.new?.order_id || payload.old?.order_id;
        if (orderId) {
          // Verificar rápidamente si el pedido pertenece al usuario
          const { data: order } = await supabase
            .from("orders")
            .select("customer_id")
            .eq("id", orderId)
            .maybeSingle();
          
          if (order && order.customer_id === userId) {
            console.log("🔄 Cambio en items de pedido detectado:", payload.eventType);
            if (currentUserId) {
              await loadOrders(currentUserId);
              // Si el modal está abierto, recargar pedidos anteriores también
              const modal = document.getElementById("previous-orders-modal");
              if (modal && modal.classList.contains("active")) {
                await loadClosedOrders(currentUserId);
              }
            }
          }
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("✅ Suscripción en tiempo real de pedidos activa");
      } else if (status === "CHANNEL_ERROR") {
        console.error("❌ Error en suscripción en tiempo real de pedidos");
      } else if (status === "TIMED_OUT") {
        console.warn("⚠️ Suscripción en tiempo real expiró, reintentando...");
        // Reintentar después de un delay
        setTimeout(() => {
          if (currentUserId) {
            setupOrdersRealtimeSubscription(currentUserId);
          }
        }, 2000);
      }
    });
}

// Función para mostrar alternativas cuando un producto está marcado como faltante
async function mostrarAlternativasParaProductoFaltante({ articulo, color, talle, itemId }) {
  try {
    if (!window.buscarProductosAlternativos || !window.mostrarModalAlternativas) {
      alert(
        `Este producto no está disponible en el talle ${talle}. Por favor selecciona otro talle o producto.`
      );
      return;
    }

    // Intentar obtener los tags del producto original desde el catálogo
    let tags = [];
    try {
      const { data: productoData } = await supabase
        .from("catalog_public_view")
        .select("Filtro1, Filtro2, Filtro3")
        .eq("Articulo", articulo)
        .maybeSingle();

      if (productoData) {
        if (productoData.Filtro1) tags.push(productoData.Filtro1);
        if (productoData.Filtro2) tags.push(productoData.Filtro2);
        if (productoData.Filtro3) tags.push(productoData.Filtro3);
      }
    } catch (error) {
      console.warn("⚠️ No se pudieron obtener los tags del producto:", error);
    }

    const mensaje = `El producto "${articulo}" no está disponible en el talle ${talle} (faltante). ¿Querés ver alternativas similares en talle ${talle}?`;

    // Crear un modal inicial con dos opciones
    const confirmacion = await new Promise((resolve) => {
      const modalInicial = document.createElement("div");
      modalInicial.className = "alternativas-modal active";
      modalInicial.innerHTML = `
        <div class="alternativas-modal-content" style="max-width: 500px;">
          <div class="alternativas-modal-header">
            <h2>⚠️ Producto Faltante</h2>
            <button class="alternativas-modal-close" onclick="window.__verAlternativasFaltanteResolve(false)">×</button>
          </div>
          <div class="alternativas-modal-body">
            <p class="alternativas-modal-message">${mensaje}</p>
          </div>
          <div class="alternativas-modal-footer" style="gap: 12px; display: flex; justify-content: flex-end;">
            <button class="alternativas-cerrar-btn" onclick="window.__verAlternativasFaltanteResolve(false)">Cerrar</button>
            <button class="alternativa-select-btn" style="margin: 0;" onclick="window.__verAlternativasFaltanteResolve(true)">Ver alternativas</button>
          </div>
        </div>
      `;
      
      const backdrop = document.createElement("div");
      backdrop.className = "alternativas-modal-backdrop";
      backdrop.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1999;";
      
      window.__verAlternativasFaltanteResolve = (result) => {
        modalInicial.remove();
        backdrop.remove();
        delete window.__verAlternativasFaltanteResolve;
        resolve(result);
      };
      
      backdrop.addEventListener("click", () => {
        window.__verAlternativasFaltanteResolve(false);
      });
      
      document.body.appendChild(backdrop);
      document.body.appendChild(modalInicial);
    });

    if (!confirmacion) return;

    // Buscar alternativas
    const productos = await window.buscarProductosAlternativos({
      articulo,
      talle,
      tags,
      color,
      limit: 6,
    });

    if (!productos || productos.length === 0) {
      alert(`No se encontraron productos alternativos disponibles en talle ${talle}.`);
      return;
    }

    // Mostrar modal con alternativas
    window.mostrarModalAlternativas({
      mensaje: `Productos alternativos disponibles en talle ${talle}:`,
      productos,
      onProductoSeleccionado: async (productoSeleccionado) => {
        // Agregar el producto seleccionado al carrito
        if (window.addToCart) {
          const productData = {
            articulo: productoSeleccionado.articulo,
            color: productoSeleccionado.color,
            talle: productoSeleccionado.talle,
            cantidad: 1,
            precio: productoSeleccionado.precio,
            imagen: productoSeleccionado.imagen,
            descripcion: productoSeleccionado.descripcion,
            variant_id: productoSeleccionado.variant_id,
          };
          
          const added = await window.addToCart(productData);
          if (added) {
            // Si tenemos el itemId faltante, cancelarlo automáticamente
            if (itemId) {
              try {
                const { error: cancelError } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: itemId });
                if (cancelError) {
                  console.warn("⚠️ No se pudo cancelar el item faltante:", cancelError.message || cancelError);
                }
              } catch (e) {
                console.warn("⚠️ Error cancelando item faltante:", e?.message || e);
              }
            }
            
            alert(`✅ ${productoSeleccionado.articulo} agregado al carrito`);
            // Recargar el carrito y pedidos para reflejar cambios
            if (currentUserId) {
              await loadCart(currentUserId);
              await loadOrders(currentUserId);
            }
          } else {
            alert(`No se pudo agregar ${productoSeleccionado.articulo} al carrito.`);
          }
        } else {
          alert("No se pudo agregar el producto al carrito. Por favor, recarga la página.");
        }
      },
      onCerrar: () => {
        console.log("Modal de alternativas cerrado");
      },
    });
  } catch (error) {
    console.error("❌ Error mostrando alternativas para producto faltante:", error);
    alert(
      `No se pudieron cargar alternativas para el producto. Por favor intenta de nuevo.`
    );
  }
}

// Limpiar suscripción cuando se cierra la página
window.addEventListener("beforeunload", () => {
  if (ordersRealtimeSubscription && supabase) {
    supabase.removeChannel(ordersRealtimeSubscription);
  }
});

if (document.readyState === "loading") {
document.addEventListener("DOMContentLoaded", initDashboard);
} else {
  initDashboard();
}

async function cancelEntireOrder(orderId) {
  try {
    const confirmText = "¿Seguro que querés cancelar todo el pedido?\n\n- Los productos ya apartados notificarán al administrador y el pedido quedará como 'Cerrado'.\n- Los productos que aún no fueron apartados se cancelarán sin notificar y, si no había nada apartado, el pedido se eliminará.";
    const confirmed = confirm(confirmText);
    if (!confirmed) return;

    // Obtener items del pedido
    const { data: items, error } = await supabase
      .from("order_items")
      .select("id, status")
      .eq("order_id", orderId);

    if (error) {
      alert("No se pudieron obtener los productos del pedido.");
      console.error("❌ Error listando items:", error);
      return;
    }

    if (!items || items.length === 0) {
      // Si ya no tiene items, eliminar el pedido
      await supabase.from("orders").delete().eq("id", orderId);
      await loadOrders(currentUserId);
      alert("Pedido cancelado.");
      return;
    }

    let hadPicked = false;

    // Cancelar cada item usando la misma lógica de cancelación
    for (const it of items) {
      // Reusar cancelOrderItem para cada ítem
      // Pero sin confirmación individual
      try {
        if ((it.status || '').toLowerCase() === 'missing') {
          // Forzar eliminación directa (ramas de missing ya manejan total/update)
          await cancelOrderItem(it.id);
        } else {
          const { data: res, error: rpcErr } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: it.id });
          if (rpcErr) {
            console.warn("⚠️ No se pudo cancelar item:", it.id, rpcErr.message);
          } else if (res?.was_picked) {
            hadPicked = true;
          }
        }
      } catch (e) {
        console.warn("⚠️ Error cancelando item:", it.id, e?.message || e);
      }
    }

    // Si hubo algún 'picked', dejar el pedido como 'closed' (visible para admin)
    if (hadPicked) {
      await supabase.from("orders").update({ status: "closed", updated_at: new Date().toISOString() }).eq("id", orderId);
      await loadOrders(currentUserId);
      alert("✅ Pedido cancelado. Había productos apartados: el admin fue notificado y el pedido quedó 'Cerrado'.");
      return;
    }

    // Si no hubo 'picked', verificar si quedó vacío y eliminar pedido entero
    const { count } = await supabase
      .from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId);

    if ((Number(count) || 0) === 0) {
      await supabase.from("orders").delete().eq("id", orderId);
    } else {
      // Aún hay items cancelados, borrar también los cancelados y eliminar pedido
      await supabase.from("order_items").delete().eq("order_id", orderId);
      await supabase.from("orders").delete().eq("id", orderId);
    }

    await loadOrders(currentUserId);
    alert("✅ Pedido cancelado completamente.");
  } catch (e) {
    console.error("❌ Error cancelando pedido completo:", e);
    alert("No se pudo cancelar el pedido.");
  }
}
