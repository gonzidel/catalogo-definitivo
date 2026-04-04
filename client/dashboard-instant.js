import { supabase } from "../scripts/supabase-client.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";
import { hasInitialProfileComplete } from "./auth-helper.js";
import { maybeShowProfileOnboardingModal } from "../scripts/profile-onboarding-modal.js";
import {
  getTransportesDisponibles,
  guardarTransporteElegido,
} from "./transportes-data.js";

const FALLBACK_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' rx='12' fill='%23f2f2f2'/%3E%3Cpath d='M24 88L44 62l12 14 16-22 24 34H24z' fill='none' stroke='%23cd844d' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='46' cy='42' r='10' fill='%23cd844d' opacity='0.35'/%3E%3Ctext x='60' y='108' fill='%23777' font-family='Poppins,Arial,sans-serif' font-size='12' text-anchor='middle'%3ESin imagen%3C/text%3E%3C/svg%3E";
const GUEST_AVATAR_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 24 24' fill='none' stroke='%23CD844D' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='8' r='4'/%3E%3Cpath d='M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'/%3E%3C/svg%3E";

function setUserAvatarWithFallback(userAvatar, displayName, primaryUrl) {
  if (!userAvatar) return;
  const safeName = displayName || "Usuario";
  const uiAvatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(
    safeName
  )}&background=CD844D&color=fff&size=96`;

  userAvatar.onerror = () => {
    if (userAvatar.src !== uiAvatarUrl) {
      userAvatar.src = uiAvatarUrl;
      return;
    }
    userAvatar.onerror = null;
    userAvatar.src = GUEST_AVATAR_ICON;
  };
  userAvatar.src = primaryUrl || uiAvatarUrl;
  userAvatar.alt = `Avatar de ${safeName}`;
}

/** Colores largos en títulos compactos: primeras 5 letras + ".." (ej. Chocolate → Choco..) */
function abbreviateColorLabel(raw) {
  const s = String(raw ?? "").trim();
  if (s.length <= 5) return s;
  return s.slice(0, 5) + "..";
}

// PDP real del catálogo usa hash route: index.html#/pdp/<SKU>
const __variantSkuCache = new Map(); // variant_id -> sku (string)

function buildCatalogPdpHrefFromSku(sku) {
  if (!sku) return "";
  return `../index.html#/pdp/${encodeURIComponent(String(sku).trim())}`;
}

function buildCatalogFallbackHrefFromProductName(productName) {
  const name = String(productName || "").trim();
  return `../index.html?articulo=${encodeURIComponent(name)}`;
}

function buildCatalogHrefFromVariantOrName(variantId, productName) {
  const vid = variantId != null ? String(variantId).trim() : "";
  const sku = vid ? __variantSkuCache.get(vid) : null;
  if (sku) return buildCatalogPdpHrefFromSku(sku);
  return buildCatalogFallbackHrefFromProductName(productName);
}

async function ensureVariantSkusLoaded(variantIds = []) {
  if (!supabase) return;
  const ids = Array.from(new Set((variantIds || []).map((v) => String(v || "").trim()).filter(Boolean)));
  const missing = ids.filter((id) => !__variantSkuCache.has(id));
  if (missing.length === 0) return;

  const { data, error } = await supabase
    .from("product_variants")
    .select("id, sku")
    .in("id", missing);

  if (error) {
    console.warn("No se pudieron cargar SKU de variantes:", error.message || error);
    return;
  }
  (data || []).forEach((row) => {
    const id = row?.id != null ? String(row.id).trim() : "";
    const sku = row?.sku != null ? String(row.sku).trim() : "";
    if (id) __variantSkuCache.set(id, sku || "");
  });
}

function normalizeGuestCartStorageItems(items = []) {
  const map = new Map();

  items.forEach((item) => {
    const articulo = String(item?.articulo || item?.product_name || "Producto").trim();
    const color = String(item?.color || "Color único").trim();
    const rawSize = item?.talle || item?.size || "Talle único";
    const talle = normalizeSize(rawSize) || String(rawSize || "Talle único").trim();
    const qty = Number(item?.cantidad ?? item?.quantity ?? item?.qty ?? 0) || 0;
    const price = Number(item?.precio ?? item?.price_snapshot ?? 0) || 0;
    if (qty <= 0) return;

    const key = `${articulo}__${color}__${talle}`;
    if (!map.has(key)) {
      map.set(key, {
        articulo,
        color,
        talle,
        cantidad: qty,
        precio: price,
        imagen: item?.imagen || FALLBACK_IMAGE,
      });
      return;
    }

    const existing = map.get(key);
    const existingQty = Number(existing.cantidad) || 0;
    // Guest safety: same line repeated in storage should not keep inflating.
    if (qty > existingQty) {
      existing.cantidad = qty;
    }
    if (!existing.imagen && item?.imagen) existing.imagen = item.imagen;
    if (!existing.precio && price) existing.precio = price;
  });

  return Array.from(map.values());
}

let cartSyncedListenerRegistered = false;
let cartActionsInitialized = false;
let historyControlsInitialized = false;
let accountSheetControlsInitialized = false;
let modalControlsInitialized = false;
let historyVisible = false;
let currentUserId = null;
let currentCartId = null;
let currentCartItems = [];
let ordersRealtimeSubscription = null;

console.log("ðŸ“¦ dashboard-instant.js cargado (orders2)");

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
        <h2 class="section-title">ðŸ›’ Carrito Actual</h2>
        <div id="cart-info">
          <p>Verificando información del carrito...</p>
        </div>
      <div id="cart-actions" class="cart-actions" style="display:none; gap:12px; margin-top:16px; flex-wrap:wrap;">
        <button id="submit-cart-btn" class="btn">Enviar mi pedido</button>
        <button id="clear-cart-btn" class="btn btn-secondary">Limpiar Carrito</button>
      </div>
      </div>
      <div class="orders-section">
        <h2 class="section-title">ðŸ“‹ Mis Pedidos</h2>
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

// FunciÃ³n para obtener variant_id basado en product_name, color y size
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

// FunciÃ³n para obtener ofertas y promociones para items
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
  
  // Procesar ofertas (solo para items que no estÃ¡n en promociones)
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
        promoText: 'ðŸ”¥ Oferta'
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
      console.warn("âš ï¸ No se pudo obtener imagen desde catÃ¡logo:", error.message);
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
    console.warn("âš ï¸ Error resolviendo imagen:", error.message);
  }
  return FALLBACK_IMAGE;
}

async function fetchVariantInfo(articulo, color, talle, variantId = null) {
  try {
    const normalizedArticulo = (articulo || "").trim();
    const normalizedColor = (color || "Único").trim();
    const normalizedSizeForStock = normalizeSize(talle) || (talle || "").trim();

    if (!normalizedArticulo || !normalizedColor) return null;

    let vid = variantId;
    let price = 0;
    let reserved = 0;

    if (vid) {
      const { data: pv, error: pvErr } = await supabase
        .from("product_variants")
        .select("id, reserved_qty, price, color")
        .eq("id", vid)
        .maybeSingle();
      if (!pvErr && pv) {
        price = Number(pv.price ?? 0) || 0;
        reserved = Number(pv.reserved_qty ?? 0);
      }
    }
    if (!vid) {
      const { data: product, error: productError } = await supabase
        .from("products")
        .select("id")
        .ilike("name", normalizedArticulo)
        .maybeSingle();
      if (productError || !product) return null;
      const { data: pv, error: pvErr } = await supabase
        .from("product_variants")
        .select("id, reserved_qty, price, color")
        .eq("product_id", product.id)
        .ilike("color", normalizedColor)
        .eq("active", true)
        .maybeSingle();
      if (pvErr || !pv) return null;
      vid = pv.id;
      price = Number(pv.price ?? 0) || 0;
      reserved = Number(pv.reserved_qty ?? 0);
    }
    if (!vid) return null;

    const { data: whs } = await supabase.from("warehouses").select("id, code").in("code", ["general", "venta-publico"]);
    const whMap = new Map((whs || []).map((w) => [w.code, w.id]));
    const generalId = whMap.get("general");
    const ventaId = whMap.get("venta-publico");

    let stockTotal = 0;
    if (generalId && ventaId && normalizedSizeForStock) {
      const { data: sws } = await supabase
        .from("variant_size_warehouse_stock")
        .select("size, warehouse_id, stock_qty")
        .eq("variant_id", vid)
        .in("warehouse_id", [generalId, ventaId]);
      (sws || []).forEach((s) => {
        if (normalizeSize(s.size) === normalizedSizeForStock) stockTotal += Number(s.stock_qty || 0);
      });
    }
    if (stockTotal === 0 && normalizedSizeForStock) {
      const { data: sizeData, error: sizeErr } = await supabase
        .from("variant_sizes")
        .select("variant_id, size, stock_qty")
        .eq("variant_id", vid);
      if (!sizeErr && sizeData && sizeData.length) {
        const sizeRow = sizeData.find((r) => normalizeSize(r.size) === normalizedSizeForStock);
        if (sizeRow) stockTotal = Number(sizeRow.stock_qty || 0);
      }
    }

    const available = Math.max(0, stockTotal - reserved);
    return {
      id: vid,
      stock: stockTotal,
      reserved,
      available,
      price,
      color: normalizedColor,
      size: normalizedSizeForStock || talle?.trim(),
    };
  } catch (error) {
    console.warn("âš ï¸ Error obteniendo informaciÃ³n de la variante:", error.message);
    return null;
  }
}

async function removeItemFromSupabase(itemId) {
  try {
    if (!itemId) {
      console.warn("âš ï¸ removeItemFromSupabase llamado sin itemId");
      return false;
    }

    // Intento 1: borrar directamente en Supabase por id
    let deleteQuery = supabase
      .from("cart_items")
      .delete()
      .eq("id", itemId);
    if (currentCartId) {
      deleteQuery = deleteQuery.eq("cart_id", currentCartId);
    }
    const { error } = await deleteQuery;

    if (!error) {
      window.dispatchEvent(new CustomEvent("cart:synced"));
      return true;
    }

    if (error) {
      console.warn("âš ï¸ Supabase DELETE por id fallÃ³:", error.message || error);
    } else {
      console.warn("âš ï¸ Supabase DELETE por id no afectÃ³ filas (posible id desincronizado)");
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
    console.warn("âš ï¸ Error eliminando item del carrito:", err?.message || err);
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

  // Menú ⋯ en ítems de la Bolsa: Quitar de la bolsa
  cartInfo.querySelectorAll(".item-row__menuitem[data-action='remove-bag-item']").forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const itemId = btn.dataset.id;
      if (!itemId) return;
      const wrap = btn.closest(".item-row__menu-wrap");
      const popover = wrap?.querySelector(".item-row__popover");
      if (popover) {
        popover.classList.remove("is-open");
        popover.setAttribute("aria-hidden", "true");
        wrap?.querySelector(".item-row__kebab")?.setAttribute("aria-expanded", "false");
      }
      const confirmed = await confirmRemoveCartItemInApp();
      if (!confirmed) return;
      const success = await removeItemFromSupabase(itemId);
      if (success) {
        await loadCart(userId);
      } else {
        await loadCart(userId);
        alert("No se pudo eliminar el producto. Intenta nuevamente.");
      }
    };
  });

  // Abrir/cerrar popover al hacer clic en ⋯ (Bolsa)
  cartInfo.querySelectorAll(".dash-bolsa-item .item-row__kebab").forEach((kebabBtn) => {
    kebabBtn.onclick = (e) => {
      e.stopPropagation();
      const wrap = kebabBtn.closest(".item-row__menu-wrap");
      const popover = wrap?.querySelector(".item-row__popover");
      if (!popover) return;
      const isOpen = popover.classList.contains("is-open");
      cartInfo.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
        p.classList.remove("is-open");
        p.setAttribute("aria-hidden", "true");
      });
      cartInfo.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
      if (!isOpen) {
        popover.classList.add("is-open");
        popover.setAttribute("aria-hidden", "false");
        kebabBtn.setAttribute("aria-expanded", "true");
      }
    };
  });
}

function attachBolsaPopoverCloseOnOutsideClick() {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo || document.body.dataset.bolsaPopoverCloseBound) return;
  document.body.dataset.bolsaPopoverCloseBound = "true";
  document.addEventListener("click", (e) => {
    if (e.target.closest(".item-row__menu-wrap") || e.target.closest(".item-row__popover")) return;
    cartInfo.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
      p.classList.remove("is-open");
      p.setAttribute("aria-hidden", "true");
    });
    cartInfo.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
  });
}

// FunciÃ³n para manejar botones "Ver alternativas" en productos agotados
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
        alert("No se pudo obtener la informaciÃ³n del producto.");
        return;
      }

      // Obtener tags del producto desde el catÃ¡logo
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
          alert("El sistema de alternativas no estÃ¡ disponible. Por favor, elimina este producto del carrito.");
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
                // Si tenemos el itemId faltante, cancelarlo automÃ¡ticamente
                if (agotadoItemId) {
                  try {
                    const { error: cancelError } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: agotadoItemId });
                    if (cancelError) {
                      console.warn("âš ï¸ No se pudo cancelar el item faltante:", cancelError.message || cancelError);
                    }
                  } catch (e) {
                    console.warn("âš ï¸ Error cancelando item faltante:", e?.message || e);
                  }
                }
                
                alert(`âœ… ${productoSeleccionado.articulo} agregado al carrito`);
                // Recargar el carrito y pedidos para reflejar cambios
                if (currentUserId) {
                  await loadCart(currentUserId);
                  await loadOrders(currentUserId);
                }
              } else {
                alert(`No se pudo agregar ${productoSeleccionado.articulo} al carrito.`);
              }
            } else {
              alert("No se pudo agregar el producto al carrito. Por favor, recarga la pÃ¡gina.");
            }
          },
          onCerrar: () => {
            console.log("Modal de alternativas cerrado");
          },
        });
      } catch (error) {
        console.error("âŒ Error mostrando alternativas:", error);
        alert("No se pudieron cargar productos alternativos. Por favor, intenta nuevamente.");
      }
    };
  });
}

/** Opciones del select de cantidad en la bolsa (tope = stock disponible). Misma UI que stock OK: 0, 1 u…, Más+; sin fila placeholder. */
function buildDashBolsaQtySelectOptions(qty, maxQtyCap) {
  const useCompactQtyLabel =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(max-width: 360px)").matches;
  const cap = Math.max(0, Math.floor(Number(maxQtyCap) || 0));
  const cartQ = Math.max(0, Math.floor(Number(qty) || 0));
  const overshoot = cartQ > cap;

  if (cap === 0) {
    return `<option value="0" selected>0</option>`;
  }

  const maxOption = Math.min(4, cap);
  const qtyOptions = [0, ...Array.from({ length: maxOption }, (_, i) => i + 1)];
  const cartOver4WithinCap = cartQ > 4 && cartQ <= cap;
  const cartOver4Overshoot = cartQ > 4 && overshoot && cap > 4;

  let effectiveSelectedSmall = null;
  if (overshoot && cap <= 4) {
    effectiveSelectedSmall = Math.min(cap, maxOption);
  } else if (!overshoot && cartQ <= 4 && cartQ <= cap) {
    effectiveSelectedSmall = Math.min(cartQ, maxOption);
  }

  const parts = [];

  for (const n of qtyOptions) {
    const label =
      n === 0
        ? "0"
        : `${n} uni`;
    const sel =
      effectiveSelectedSmall !== null && n === effectiveSelectedSmall ? "selected" : "";
    parts.push(`<option value="${n}" ${sel}>${label}</option>`);
  }

  if (cartOver4WithinCap && cartQ > maxOption) {
    const label = `${cartQ} uni`;
    parts.push(`<option value="${cartQ}" selected>${label}</option>`);
  }

  if (cartOver4Overshoot) {
    const label = `${cap} uni`;
    parts.push(`<option value="${cap}" selected>${label}</option>`);
  }

  if (cap > 4) {
    parts.push(`<option value="mas">Más+</option>`);
  }

  return parts.join("");
}

function attachQuantityHandlers(userId) {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;

  const readCap = (el) => {
    const raw = el.dataset.max;
    if (
      raw == null ||
      String(raw).trim() === "" ||
      !Number.isFinite(Number(raw))
    ) {
      return null;
    }
    return Math.floor(Number(raw));
  };

  // Si el carrito tiene más unidades que el stock pero el select ya muestra un valor válido,
  // elegir de nuevo el mismo número no dispara `change`. Al cerrar el desplegable (blur)
  // aplicamos esa cantidad para que la tarjeta vuelva al estado normal.
  const maybeSyncOvershootOnBlur = async (selectEl) => {
    const itemId = selectEl.dataset.id;
    if (!itemId) return;
    const v = selectEl.value;
    if (v === "mas" || v === "" || v === "0") return;
    const num = Number(v);
    if (!Number.isFinite(num)) return;
    const latestCur = Number(selectEl.dataset.currentQty);
    const latestCap = readCap(selectEl);
    if (latestCap == null || !Number.isFinite(latestCur)) return;
    if (latestCur <= latestCap) return;
    if (num > latestCap) return;
    const ok = await updateCartItemQuantity(itemId, num);
    if (ok) await loadCart(userId);
  };

  // Selector de cantidad: 0 = quitar producto; 1-4 o valor numérico = actualizar; "mas" = pedir cantidad > 4
  cartInfo.querySelectorAll(".cart-qty-select").forEach((sel) => {
    const curQ = Number(sel.dataset.currentQty);
    const capQ = readCap(sel);
    if (Number.isFinite(curQ) && capQ != null && curQ > capQ && capQ > 0) {
      sel.addEventListener("blur", () => {
        void maybeSyncOvershootOnBlur(sel);
      });
    }

    sel.onchange = async (event) => {
      const selectEl = event.currentTarget;
      const itemId = selectEl.dataset.id;
      const max = readCap(selectEl);
      if (!itemId) return;

      const value = selectEl.value;
      if (value === "") return;

      if (value === "mas") {
        const raw = window.prompt(`Ingresá la cantidad (máximo ${max} por stock disponible):`, "5");
        if (raw == null) {
          await loadCart(userId);
          return;
        }

        let qty = Math.floor(Number(raw) || 0);
        if (qty < 5) {
          alert("Para cantidades de 1 a 4 usá el desplegable.");
          return;
        }
        if (max != null && qty > max) {
          alert(`Solo hay ${max} unidades disponibles para este producto.`);
          qty = max;
        }

        const ok = await updateCartItemQuantity(itemId, qty);
        if (!ok) {
          await loadCart(userId);
          alert("No se pudo actualizar la cantidad. Verifica el stock disponible.");
        } else {
          await loadCart(userId);
        }
        return;
      }

      const numValue = Number(value) || 0;

      if (numValue === 0) {
        const success = await removeItemFromSupabase(itemId);
        if (success) {
          await loadCart(userId);
        } else {
          await loadCart(userId);
          alert("No se pudo eliminar el producto. Intenta nuevamente.");
        }
        return;
      }

      const finalQty = max != null && numValue > max ? max : numValue;
      const ok = await updateCartItemQuantity(itemId, finalQty);
      if (!ok) {
        await loadCart(userId);
        alert("No se pudo actualizar la cantidad. Verifica el stock disponible.");
      } else {
        await loadCart(userId);
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
      if (!currentUserId) {
        showGuestLoginRequiredModal();
        return;
      }
      await submitCurrentCart();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      if (!currentUserId) {
        const confirmClearGuest = confirm("¿Quieres vaciar completamente tu carrito?");
        if (!confirmClearGuest) return;
        localStorage.setItem("fyl_cart", JSON.stringify([]));
        showNoSession();
        return;
      }
      const confirmClear = confirm(
        "¿Quieres vaciar completamente tu carrito?"
      );
      if (!confirmClear) return;
      await clearCurrentCart();
    });
  }
}

/**
 * Modal de confirmación in-app (misma UI que quitar de la bolsa).
 * @param {{ title: string, message?: string, bodyHtml?: string, confirmLabel?: string, cancelLabel?: string }} opts
 * @returns {Promise<boolean>}
 */
function showDashboardConfirmModal(opts) {
  const {
    title,
    message = "",
    bodyHtml = "",
    confirmLabel = "Aceptar",
    cancelLabel = "Cancelar",
  } = opts;

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-app-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-app-confirm-modal";
      modal.className = "dash-remove-cart-item-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "dash-app-confirm-title");
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML = `
        <div class="dash-remove-cart-item-modal__panel">
          <h3 id="dash-app-confirm-title" class="dash-remove-cart-item-modal__title"></h3>
          <div id="dash-app-confirm-message" class="dash-remove-cart-item-modal__hint dash-app-confirm-message"></div>
          <div class="dash-remove-cart-item-modal__actions">
            <button type="button" class="btn btn-ghost" id="dash-app-confirm-cancel"></button>
            <button type="button" class="btn btn-primary" id="dash-app-confirm-ok"></button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    const titleEl = modal.querySelector("#dash-app-confirm-title");
    const msgEl = modal.querySelector("#dash-app-confirm-message");
    const okBtn = modal.querySelector("#dash-app-confirm-ok");
    const cancelBtn = modal.querySelector("#dash-app-confirm-cancel");

    titleEl.textContent = title;
    msgEl.classList.remove("dash-app-confirm-message--html");
    if (bodyHtml) {
      msgEl.innerHTML = bodyHtml;
      msgEl.style.display = "";
      msgEl.classList.add("dash-app-confirm-message--html");
    } else if (message) {
      msgEl.textContent = message;
      msgEl.style.display = "";
    } else {
      msgEl.textContent = "";
      msgEl.innerHTML = "";
      msgEl.style.display = "none";
    }
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = (value) => {
      cleanup();
      resolve(value);
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done(false);
    }

    modal.onclick = (e) => {
      if (e.target === modal) done(false);
    };
    okBtn.onclick = (e) => {
      e.stopPropagation();
      done(true);
    };
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      done(false);
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    cancelBtn.focus();
  });
}

/**
 * Modal de selección (1..N). Devuelve número o null si cancela.
 * @param {{ title: string, max: number, confirmLabel?: string, cancelLabel?: string, label?: string }} opts
 * @returns {Promise<number|null>}
 */
function showDashboardQuantitySelectModal(opts) {
  const {
    title,
    max,
    confirmLabel = "Aceptar",
    cancelLabel = "Cancelar",
    label = "¿Cuántas unidades?",
  } = opts || {};

  const maxInt = Math.max(1, Number(max || 1) | 0);
  const optionsHtml = Array.from({ length: maxInt }, (_, i) => {
    const n = i + 1;
    return `<option value="${n}">${n}</option>`;
  }).join("");

  const bodyHtml = `
    <div class="dash-qty-select">
      <div class="dash-qty-select__label">${label}</div>
      <select id="dash-qty-select" class="dash-qty-select__select" aria-label="${label.replace(/"/g, "&quot;")}">
        ${optionsHtml}
      </select>
    </div>
  `;

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-app-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-app-confirm-modal";
      modal.className = "dash-remove-cart-item-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "dash-app-confirm-title");
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML = `
        <div class="dash-remove-cart-item-modal__panel">
          <h3 id="dash-app-confirm-title" class="dash-remove-cart-item-modal__title"></h3>
          <div id="dash-app-confirm-message" class="dash-remove-cart-item-modal__hint dash-app-confirm-message"></div>
          <div class="dash-remove-cart-item-modal__actions">
            <button type="button" class="btn btn-ghost" id="dash-app-confirm-cancel"></button>
            <button type="button" class="btn btn-primary" id="dash-app-confirm-ok"></button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    if (!modal) return resolve(null);

    const titleEl = modal.querySelector("#dash-app-confirm-title");
    const msgEl = modal.querySelector("#dash-app-confirm-message");
    const okBtn = modal.querySelector("#dash-app-confirm-ok");
    const cancelBtn = modal.querySelector("#dash-app-confirm-cancel");

    titleEl.textContent = title || "";
    msgEl.classList.add("dash-app-confirm-message--html");
    msgEl.style.display = "";
    msgEl.innerHTML = bodyHtml;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    const selectEl = modal.querySelector("#dash-qty-select");

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = (value) => {
      cleanup();
      resolve(value);
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done(null);
    }

    modal.onclick = (e) => {
      if (e.target === modal) done(null);
    };
    okBtn.onclick = (e) => {
      e.stopPropagation();
      const v = Number(selectEl?.value || 0) | 0;
      done(v > 0 ? v : 1);
    };
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      done(null);
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    // En mobile es más cómodo caer en el select
    (selectEl || cancelBtn).focus();
  });
}

/**
 * Modal para elegir una opción (ej. talle). Devuelve el `value` elegido o null si cancela.
 * @param {{ title: string, options: Array<{ value: string, label: string, sublabel?: string }>, confirmLabel?: string, cancelLabel?: string }} opts
 * @returns {Promise<string|null>}
 */
function showDashboardOptionButtonsModal(opts) {
  const {
    title,
    options = [],
    confirmLabel = "Aceptar",
    cancelLabel = "Cancelar",
  } = opts || {};

  const safeOptions = (options || [])
    .map((o) => ({
      value: String(o?.value ?? "").trim(),
      label: String(o?.label ?? "").trim(),
      sublabel: String(o?.sublabel ?? "").trim(),
    }))
    .filter((o) => o.value && o.label);

  const bodyHtml = `
    <div class="dash-opt-select">
      <div class="dash-opt-select__grid">
        ${safeOptions
          .map(
            (o) => `
              <button type="button" class="dash-opt-select__btn" data-opt-value="${o.value.replace(/"/g, "&quot;")}">
                <span class="dash-opt-select__btn-label">${o.label}</span>
                ${o.sublabel ? `<span class="dash-opt-select__btn-sub">${o.sublabel}</span>` : ""}
              </button>
            `
          )
          .join("")}
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-app-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-app-confirm-modal";
      modal.className = "dash-remove-cart-item-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "dash-app-confirm-title");
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML = `
        <div class="dash-remove-cart-item-modal__panel">
          <h3 id="dash-app-confirm-title" class="dash-remove-cart-item-modal__title"></h3>
          <div id="dash-app-confirm-message" class="dash-remove-cart-item-modal__hint dash-app-confirm-message"></div>
          <div class="dash-remove-cart-item-modal__actions">
            <button type="button" class="btn btn-ghost" id="dash-app-confirm-cancel"></button>
            <button type="button" class="btn btn-primary" id="dash-app-confirm-ok"></button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    if (!modal) return resolve(null);

    const titleEl = modal.querySelector("#dash-app-confirm-title");
    const msgEl = modal.querySelector("#dash-app-confirm-message");
    const okBtn = modal.querySelector("#dash-app-confirm-ok");
    const cancelBtn = modal.querySelector("#dash-app-confirm-cancel");

    titleEl.textContent = title || "";
    msgEl.classList.add("dash-app-confirm-message--html");
    msgEl.style.display = "";
    msgEl.innerHTML = bodyHtml;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    let pickedValue = safeOptions[0]?.value || null;
    const btns = Array.from(modal.querySelectorAll(".dash-opt-select__btn"));
    btns.forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        btns.forEach((x) => x.classList.remove("is-selected"));
        b.classList.add("is-selected");
        pickedValue = String(b.dataset.optValue || "").trim() || pickedValue;
      };
    });
    // Seleccionar la primera por defecto
    if (btns[0]) {
      btns[0].classList.add("is-selected");
      pickedValue = String(btns[0].dataset.optValue || "").trim() || pickedValue;
    }

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = (value) => {
      cleanup();
      resolve(value);
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done(null);
    }

    modal.onclick = (e) => {
      if (e.target === modal) done(null);
    };
    okBtn.onclick = (e) => {
      e.stopPropagation();
      done(pickedValue);
    };
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      done(null);
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    (btns[0] || cancelBtn).focus();
  });
}

/** Quitar ítem de la bolsa — usa el modal genérico del dashboard. */
function confirmRemoveCartItemInApp() {
  return showDashboardConfirmModal({
    title: "¿Quitar este producto del carrito?",
    message: "Se eliminará solo esta línea de tu bolsa.",
    confirmLabel: "Quitar",
    cancelLabel: "Cancelar",
  });
}

/** Reloj inline (historial) — mismo estilo trazo que el resto del dashboard. */
const DASH_MESSAGE_CLOCK_SVG = `<svg class="dash-app-message-modal__clock-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

/**
 * Modal in-app de un solo botón (sustituye alert() del navegador).
 * @param {{ title?: string, bodyHtml: string, confirmLabel?: string }} opts
 * @returns {Promise<void>}
 */
function showDashboardMessageModal(opts) {
  const {
    title = "",
    bodyHtml,
    confirmLabel = "Entendido",
  } = opts;

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-app-message-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-app-message-modal";
      modal.className = "dash-remove-cart-item-modal";
      modal.setAttribute("role", "alertdialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML = `
        <div class="dash-remove-cart-item-modal__panel">
          <h3 id="dash-app-message-title" class="dash-remove-cart-item-modal__title"></h3>
          <div id="dash-app-message-body" class="dash-app-message-modal__body"></div>
          <div class="dash-remove-cart-item-modal__actions dash-app-message-modal__actions--single">
            <button type="button" class="btn btn-primary" id="dash-app-message-ok"></button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    const titleEl = modal.querySelector("#dash-app-message-title");
    const bodyEl = modal.querySelector("#dash-app-message-body");
    const okBtn = modal.querySelector("#dash-app-message-ok");

    if (title) {
      titleEl.textContent = title;
      titleEl.style.display = "";
      modal.setAttribute("aria-labelledby", "dash-app-message-title");
    } else {
      titleEl.textContent = "";
      titleEl.style.display = "none";
      modal.removeAttribute("aria-labelledby");
    }
    bodyEl.innerHTML = bodyHtml;
    modal.setAttribute("aria-describedby", "dash-app-message-body");
    okBtn.textContent = confirmLabel;

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      okBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = () => {
      cleanup();
      resolve();
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done();
    }

    modal.onclick = (e) => {
      if (e.target === modal) done();
    };
    okBtn.onclick = (e) => {
      e.stopPropagation();
      done();
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    okBtn.focus();
  });
}

/** WhatsApp envíos (mismo enlace que index2 / footer Envíos). */
const WHATSAPP_ENVIOS_HREF = "https://wa.me/5493624118637";

const DASH_TRANSPORT_GEAR_SVG = `<svg class="dash-transport-config-hint__gear" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;

function escapeHtmlAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

async function fetchCustomerShippingRow() {
  if (!currentUserId) return null;
  const { data, error } = await supabase
    .from("customers")
    .select("transport_id, province, city")
    .eq("id", currentUserId)
    .maybeSingle();
  if (error) {
    console.warn("No se pudo leer datos de envío del cliente:", error.message);
    return null;
  }
  return data;
}

async function fetchCustomerProfileRow() {
  if (!currentUserId) return null;
  const { data, error } = await supabase
    .from("customers")
    .select("full_name, avatar_url, email")
    .eq("id", currentUserId)
    .maybeSingle();
  if (error) {
    console.warn("No se pudo leer perfil del cliente:", error.message);
    return null;
  }
  return data;
}

/**
 * Paso de transporte antes del cierre definitivo (solo si aún no hay transport_id en cuenta).
 * @returns {Promise<{ ok: boolean, transportName?: string }>}
 */
function showTransportFinalizeModal({ province, city, opciones }) {
  function normalizeForMatch(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/\u0301/g, "")
      .replace(/\u0300/g, "")
      .replace(/[\u0300-\u036f]/g, "");
  }

  const chacoSpecialLocalities = new Set(
    [
      "resistencia",
      "puerto vilela",
      "puerto vilelas",
      "barranqueras",
      "fontana",
      "puerto tirol",
      "margarita belen",
      "margarita belén",
      "colonia benites",
      "colonia benítez",
    ].map(normalizeForMatch)
  );

  const isChacoSpecial = normalizeForMatch(province) === "chaco" && chacoSpecialLocalities.has(normalizeForMatch(city));
  // Regla: para esas localidades, el transporte efectivo es solo "Retiro de Local".
  if (isChacoSpecial) opciones = ["Retiro de Local"];

  const soloSedeUnico = opciones.length === 1 && opciones[0] === "SEDE";
  const soloRetiroLocalUnico = opciones.length === 1 && opciones[0] === "Retiro de Local";

  return new Promise((resolve) => {
    let modal = document.getElementById("dash-transport-finalize-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dash-transport-finalize-modal";
      modal.className = "dash-remove-cart-item-modal dash-transport-finalize-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "dash-transport-finalize-title");
      document.body.appendChild(modal);
    }

    const waLink = `<a href="${WHATSAPP_ENVIOS_HREF}" target="_blank" rel="noopener noreferrer" class="dash-transport-wa-link">WhatsApp</a>`;

    let bodyInner;
    if (soloRetiroLocalUnico) {
      bodyInner = `
        <h3 id="dash-transport-finalize-title" class="dash-remove-cart-item-modal__title">Transporte asignado</h3>
        <div class="dash-transport-assigned">Retiro del local</div>
        <p class="dash-transport-lead">Acordar en el local.</p>
        <div class="dash-transport-block">
          <p class="dash-transport-block__text">¿Tenés dudas? Escribinos por ${waLink}.</p>
        </div>
      `;
    } else if (soloSedeUnico) {
      bodyInner = `
        <h3 id="dash-transport-finalize-title" class="dash-remove-cart-item-modal__title">Transporte asignado</h3>
        <div class="dash-transport-assigned">SEDE</div>
        <p class="dash-transport-lead">El pago es contra reembolso (abonás el total del pedido + envío al recibirlo).</p>
        <div class="dash-transport-block">
          <p class="dash-transport-block__text">¿Tenés dudas? Escribinos por ${waLink}.</p>
        </div>
      `;
    } else {
      const selectAria = escapeHtmlAttr("Elegí cómo querés recibir tu pedido");
      let selectHtml;
      if (opciones.length === 1) {
        const only = opciones[0];
        selectHtml = `<select id="dash-transport-select" class="dash-transport-select" aria-label="${selectAria}">
            <option value="${escapeHtmlAttr(only)}">${escapeHtmlAttr(only)}</option>
          </select>`;
      } else {
        selectHtml = `<select id="dash-transport-select" class="dash-transport-select" aria-label="${selectAria}">
            <option value="" disabled selected>Elegí cómo querés recibir tu pedido</option>
            ${opciones
              .map(
                (o) =>
                  `<option value="${escapeHtmlAttr(o)}">${escapeHtmlAttr(o)}</option>`
              )
              .join("")}
          </select>`;
      }

      bodyInner = `
        <h3 id="dash-transport-finalize-title" class="dash-remove-cart-item-modal__title">Seleccioná tu transporte</h3>
        <p class="dash-transport-sub">Te mostramos las opciones disponibles según tu localidad.</p>
        <div class="dash-transport-select-wrap">${selectHtml}</div>
        <div class="dash-transport-block" id="dash-transport-pago-block">
          <div class="dash-transport-block__title">Forma de pago</div>
          <p class="dash-transport-block__text">Acordar en el local.</p>
        </div>
        <div class="dash-transport-block dash-transport-block--muted" id="dash-transport-correo-block" style="display:none;">
          <div class="dash-transport-block__title">Correo Argentino</div>
          <p class="dash-transport-block__text">Si elegís Correo Argentino, te informaremos el costo total (pedido + envío) para abonarlo antes del despacho.</p>
        </div>
        <div class="dash-transport-block">
          <p class="dash-transport-block__text">¿Tenés dudas? Escribinos por ${waLink}.</p>
        </div>
        <div class="dash-transport-config-hint">
          ${DASH_TRANSPORT_GEAR_SVG}
          <span class="dash-transport-config-hint__text">Podés cambiar tu transporte en cualquier momento desde la <a href="profile.html" class="dash-transport-profile-link">configuración</a>.</span>
        </div>
      `;
    }

    modal.innerHTML = `
      <div class="dash-remove-cart-item-modal__panel dash-transport-finalize-modal__panel">
        ${bodyInner}
        <div class="dash-remove-cart-item-modal__actions">
          <button type="button" class="btn btn-ghost" id="dash-transport-cancel">Cancelar</button>
          <button type="button" class="btn btn-primary" id="dash-transport-continue">Continuar</button>
        </div>
      </div>
    `;

    const cancelBtn = modal.querySelector("#dash-transport-cancel");
    const continueBtn = modal.querySelector("#dash-transport-continue");
    const selectEl = modal.querySelector("#dash-transport-select");
    const pagoBlock = modal.querySelector("#dash-transport-pago-block");
    const correoBlock = modal.querySelector("#dash-transport-correo-block");

    function syncPaymentBlocks() {
      if (!selectEl) return;
      const selected = selectEl.value;
      const showCorreo = selected === "Correo Argentino";
      if (correoBlock) correoBlock.style.display = showCorreo ? "" : "none";
      if (pagoBlock) pagoBlock.style.display = showCorreo ? "none" : "";
    }

    function syncContinueDisabled() {
      if ((soloSedeUnico || soloRetiroLocalUnico) || !selectEl) {
        continueBtn.disabled = false;
        return;
      }
      continueBtn.disabled = !selectEl.value;
    }

    if (selectEl) {
      selectEl.addEventListener("change", () => {
        syncContinueDisabled();
        syncPaymentBlocks();
      });
    }
    syncContinueDisabled();
    syncPaymentBlocks();

    const cleanup = () => {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      modal.onclick = null;
      cancelBtn.onclick = null;
      continueBtn.onclick = null;
      document.removeEventListener("keydown", onKeyDown);
    };

    const done = (result) => {
      cleanup();
      resolve(result);
    };

    function onKeyDown(e) {
      if (e.key === "Escape") done({ ok: false });
    }

    modal.onclick = (e) => {
      if (e.target === modal) done({ ok: false });
    };
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      done({ ok: false });
    };
    continueBtn.onclick = (e) => {
      e.stopPropagation();
      if (soloSedeUnico) {
        done({ ok: true, transportName: "SEDE" });
        return;
      }
      if (soloRetiroLocalUnico) {
        done({ ok: true, transportName: "Retiro de Local" });
        return;
      }
      const v = selectEl ? selectEl.value : "";
      if (!v) return;
      done({ ok: true, transportName: v });
    };

    document.addEventListener("keydown", onKeyDown);
    modal.setAttribute("aria-hidden", "false");
    modal.classList.add("is-open");
    if (selectEl && opciones.length > 1) {
      selectEl.focus();
    } else {
      continueBtn.focus();
    }
  });
}

function showGuestLoginRequiredModal() {
  let modal = document.getElementById("guest-login-required-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "guest-login-required-modal";
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      z-index: 1300;
    `;
    modal.innerHTML = `
      <div style="width:min(420px, 100%); background:#fff; border-radius:16px; padding:20px; box-shadow:0 10px 28px rgba(0,0,0,.22);">
        <h3 style="margin:0 0 8px 0; font-size:20px; color:#2d2d2d;">Inicia sesión para continuar</h3>
        <p style="margin:0 0 16px 0; color:#5f5f5f; font-size:14px; line-height:1.45;">
          Para hacer el pedido es necesario loguearse.
        </p>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button type="button" id="guest-login-cancel-btn" class="btn btn-ghost">Cancelar</button>
          <button type="button" id="guest-login-go-btn" class="btn btn-primary">Iniciar sesión</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const closeModal = () => {
      modal.remove();
    };

    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal();
    });

    const cancelBtn = modal.querySelector("#guest-login-cancel-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", closeModal);
    }

    const goBtn = modal.querySelector("#guest-login-go-btn");
    if (goBtn) {
      goBtn.addEventListener("click", () => {
        window.location.href = "./login.html?return=dashboard";
      });
    }
    return;
  }

  modal.style.display = "flex";
}

function attachGuestCartHandlers() {
  const cartInfo = document.getElementById("cart-info");
  if (!cartInfo) return;

  const readGuestCart = () => {
    try {
      const raw = localStorage.getItem("fyl_cart");
      const parsed = raw ? JSON.parse(raw) : [];
      const normalized = normalizeGuestCartStorageItems(
        Array.isArray(parsed) ? parsed : []
      );
      localStorage.setItem("fyl_cart", JSON.stringify(normalized));
      return normalized;
    } catch (_e) {
      return [];
    }
  };

  cartInfo.querySelectorAll(".cart-qty-select").forEach((sel) => {
    sel.onchange = (event) => {
      const idx = Number(event.currentTarget.dataset.id);
      let qty = Number(event.currentTarget.value) || 0;
      const items = readGuestCart();
      if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) return;
      if (qty <= 0) {
        items.splice(idx, 1);
      } else {
        const prev = items[idx] || {};
        items[idx] = {
          ...prev,
          cantidad: qty,
          quantity: qty,
          qty: qty,
        };
      }
      localStorage.setItem("fyl_cart", JSON.stringify(items));
      showNoSession();
    };
  });

  cartInfo.querySelectorAll(".item-row__menuitem[data-action='remove-bag-item']").forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.id);
      const items = readGuestCart();
      if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) return;
      const wrap = btn.closest(".item-row__menu-wrap");
      const popover = wrap?.querySelector(".item-row__popover");
      if (popover) {
        popover.classList.remove("is-open");
        popover.setAttribute("aria-hidden", "true");
        wrap?.querySelector(".item-row__kebab")?.setAttribute("aria-expanded", "false");
      }
      const confirmed = await confirmRemoveCartItemInApp();
      if (!confirmed) return;
      items.splice(idx, 1);
      localStorage.setItem("fyl_cart", JSON.stringify(items));
      showNoSession();
    };
  });

  cartInfo.querySelectorAll(".dash-bolsa-item .item-row__kebab").forEach((kebabBtn) => {
    kebabBtn.onclick = (e) => {
      e.stopPropagation();
      const wrap = kebabBtn.closest(".item-row__menu-wrap");
      const popover = wrap?.querySelector(".item-row__popover");
      if (!popover) return;
      const isOpen = popover.classList.contains("is-open");
      cartInfo.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
        p.classList.remove("is-open");
        p.setAttribute("aria-hidden", "true");
      });
      cartInfo.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
      if (!isOpen) {
        popover.classList.add("is-open");
        popover.setAttribute("aria-hidden", "false");
        kebabBtn.setAttribute("aria-expanded", "true");
      }
    };
  });
}

async function clearCurrentCart() {
  try {
    const clearBtn = document.getElementById("clear-cart-btn");
    if (clearBtn) clearBtn.disabled = true;

    if (!currentCartId) {
      const cartIds = currentCartItems.map((item) => item.id).filter(Boolean);
      if (!cartIds.length) {
        await loadCart(currentUserId);
        if (clearBtn) clearBtn.disabled = false;
        return;
      }
      const { error } = await supabase.from("cart_items").delete().in("id", cartIds);
      if (error) {
        alert("No se pudo limpiar el carrito. Intenta nuevamente.");
        if (clearBtn) clearBtn.disabled = false;
        return;
      }
    } else {
      const { error } = await supabase.from("cart_items").delete().eq("cart_id", currentCartId);
      if (error) {
        alert("No se pudo limpiar el carrito. Intenta nuevamente.");
        if (clearBtn) clearBtn.disabled = false;
        return;
      }
    }

    window.dispatchEvent(new CustomEvent("cart:synced"));
    await loadCart(currentUserId);
  } catch (error) {
    console.error("âŒ Error limpiando carrito:", error);
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
      alert(
        "No podés enviar el pedido: hay productos que superan el stock disponible (marcados en rosa). Ajustá las cantidades o quitá esos productos."
      );
      return;
    }

    // Confirmar con el usuario cuántos productos quiere enviar
    const totalUnits = (currentCartItems || []).reduce(
      (sum, item) => sum + (Number(item.quantity) || 0),
      0
    );
    if (!totalUnits) {
      alert("Tu carrito está vacío. Agrega productos antes de hacer un pedido.");
      return;
    }

    // Datos de perfil obligatorios antes de confirmar/enviar (ignora "modal ya visto" en la sesión)
    let profileReady = await hasInitialProfileComplete();
    if (!profileReady) {
      const saved = await maybeShowProfileOnboardingModal({ force: true });
      profileReady = saved && (await hasInitialProfileComplete());
    }
    if (!profileReady) {
      const msg =
        "Completá tus datos (nombre, teléfono, DNI, dirección, provincia y localidad) para hacer el pedido.";
      if (typeof window.showToast === "function") {
        window.showToast(msg, "info");
      } else {
        alert(msg);
      }
      return;
    }

    const productosLabel = totalUnits === 1 ? "1 producto" : `${totalUnits} productos`;

    const confirmed = await new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.className = "alternativas-modal active";
      modal.innerHTML = `
        <div class="alternativas-modal-content" style="max-width: 420px;">
          <div class="alternativas-modal-header">
            <h2>Confirmar pedido</h2>
            <button class="alternativas-modal-close" type="button">&times;</button>
          </div>
          <div class="alternativas-modal-body">
            <p class="alternativas-modal-message">¿Querés hacer un pedido de <strong>${productosLabel}</strong>?</p>
          </div>
          <div class="alternativas-modal-footer" style="gap: 12px; display: flex; justify-content: flex-end;">
            <button class="alternativas-cerrar-btn" type="button" data-action="cancelar-pedido">Cancelar</button>
            <button class="alternativa-select-btn" type="button" data-action="confirmar-pedido">Hacer pedido</button>
          </div>
        </div>
      `;

      const cleanup = (result) => {
        if (modal && modal.parentNode) {
          modal.parentNode.removeChild(modal);
        }
        resolve(result);
      };

      modal.addEventListener("click", (e) => {
        if (e.target === modal) {
          cleanup(false);
        }
      });

      const closeBtn = modal.querySelector(".alternativas-modal-close");
      const cancelBtn = modal.querySelector("[data-action='cancelar-pedido']");
      const confirmBtn = modal.querySelector("[data-action='confirmar-pedido']");

      if (closeBtn) {
        closeBtn.addEventListener("click", () => cleanup(false));
      }
      if (cancelBtn) {
        cancelBtn.addEventListener("click", () => cleanup(false));
      }
      if (confirmBtn) {
        confirmBtn.addEventListener("click", () => cleanup(true));
      }

      document.body.appendChild(modal);
    });

    if (!confirmed) {
      return;
    }

    const submitBtn = document.getElementById("submit-cart-btn");
    if (submitBtn) submitBtn.disabled = true;

    const { data, error } = await supabase.rpc("rpc_checkout_cart");
    if (error) {
      console.error("âŒ Error enviando pedido:", error);
      alert(error.message || "No se pudo enviar el pedido. Intenta nuevamente.");
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    if (window.showToast) {
      window.showToast("Pedido enviado. Lo verás en 'Mi pedido activo'.", "success");
    }
    window.dispatchEvent(new CustomEvent("cart:synced"));
    await loadCart(currentUserId);
    await loadOrders(currentUserId);
  } catch (error) {
    console.error("âŒ Error enviando pedido:", error);
    alert("OcurriÃ³ un error inesperado al enviar el pedido.");
  } finally {
    const submitBtn = document.getElementById("submit-cart-btn");
    if (submitBtn) submitBtn.disabled = false;
  }
}

function openPreviousOrdersModal() {
  const modal = document.getElementById("previous-orders-modal");
  const modalContent = document.getElementById("modal-orders-content");
  
  if (!modal || !modalContent) {
    console.error("âŒ No se encontrÃ³ el modal de pedidos anteriores");
    return;
  }
  
  // Abrir pantalla historial
  modal.classList.add("active");
  historyVisible = true;
  try {
    document.body.classList.add("history-open");
  } catch (_) {
    /* ignore */
  }

  // Deep-link: ?view=history
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") !== "history") {
      url.searchParams.set("view", "history");
      window.history.replaceState({}, "", url.toString());
    }
  } catch (_) {
    /* ignore */
  }
  
  // Cargar pedidos
  if (!currentUserId) {
    console.error("âŒ currentUserId no estÃ¡ disponible");
    modalContent.innerHTML = `<p style="text-align: center; color: #dc3545; padding: 40px;">Error: No se pudo identificar al usuario.</p>`;
    return;
  }
  
  modalContent.innerHTML = `<p style="text-align: center; color: #666; padding: 40px;">Cargando pedidos anteriores...</p>`;
  console.log("ðŸ“‹ Cargando pedidos anteriores para usuario:", currentUserId);
  loadClosedOrders(currentUserId);
}

function closePreviousOrdersModal() {
  const modal = document.getElementById("previous-orders-modal");
  
  if (!modal) {
    console.error("âŒ No se encontrÃ³ el modal de pedidos anteriores");
    return;
  }
  
  // Cerrar pantalla historial
  modal.classList.remove("active");
  historyVisible = false;
  try {
    document.body.classList.remove("history-open");
  } catch (_) {
    /* ignore */
  }

  // Limpiar deep-link
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") === "history") {
      url.searchParams.delete("view");
      window.history.replaceState({}, "", url.toString());
    }
  } catch (_) {
    /* ignore */
  }
}

function setupModalControls() {
  if (modalControlsInitialized) return;
  
  const modal = document.getElementById("previous-orders-modal");
  const closeBtn = document.getElementById("history-back-btn");
  
  if (!modal || !closeBtn) {
    console.warn("âš ï¸ No se encontraron los elementos del modal");
    return;
  }
  
  modalControlsInitialized = true;
  
  // Volver con flecha
  closeBtn.addEventListener("click", () => {
    closePreviousOrdersModal();
  });
  
  // Cerrar con tecla ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closePreviousOrdersModal();
    }
  });
  
  console.log("âœ… Controles del modal configurados");
}

function setupHistoryControls() {
  if (historyControlsInitialized) {
    console.log("â„¹ï¸ setupHistoryControls ya inicializado, omitiendo...");
    return;
  }

  const toggleBtn = document.getElementById("toggle-history-btn");
  
  if (!toggleBtn) {
    console.warn("âš ï¸ No se encontrÃ³ el botÃ³n de historial, reintentando en 100ms...");
    // Reintentar despuÃ©s de un breve delay
    setTimeout(() => {
      setupHistoryControls();
    }, 100);
    return;
  }

  historyControlsInitialized = true;
  console.log("âœ… Configurando controles del historial");

  // Configurar controles del modal (esto solo se hace una vez)
  setupModalControls();

  // Al hacer clic en "Ver pedidos anteriores", abrir el modal
  toggleBtn.addEventListener("click", () => {
    console.log("ðŸ”˜ BotÃ³n 'Ver pedidos anteriores' presionado");
    openPreviousOrdersModal();
  });
  
  console.log("âœ… Event listener agregado al botÃ³n 'Ver pedidos anteriores'");
}

/** Abre/cierra el bottom-sheet de cuenta (#account-trigger / #dash-account-sheet). Antes no tenía listeners. */
function setupAccountSheetControls() {
  if (accountSheetControlsInitialized) return;

  const trigger = document.getElementById("account-trigger");
  const sheet = document.getElementById("dash-account-sheet");
  const backdrop = document.getElementById("account-sheet-backdrop");
  const closeBtn = document.getElementById("account-sheet-close");

  if (!trigger || !sheet) {
    setTimeout(() => setupAccountSheetControls(), 100);
    return;
  }

  accountSheetControlsInitialized = true;

  function openAccountSheet() {
    sheet.classList.add("is-open");
    sheet.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    try {
      document.body.classList.add("modal-open");
    } catch (_) {
      /* ignore */
    }
  }

  function closeAccountSheet() {
    sheet.classList.remove("is-open");
    sheet.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-expanded", "false");
    try {
      document.body.classList.remove("modal-open");
    } catch (_) {
      /* ignore */
    }
  }

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    if (sheet.classList.contains("is-open")) {
      closeAccountSheet();
    } else {
      openAccountSheet();
    }
  });

  if (backdrop) {
    backdrop.addEventListener("click", () => closeAccountSheet());
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => closeAccountSheet());
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheet.classList.contains("is-open")) {
      closeAccountSheet();
    }
  });
}

// FunciÃ³n para cancelar un producto individual del pedido
async function cancelOrderItem(itemId) {
  try {
    console.log("ðŸ”„ Cancelando producto del pedido:", itemId);

    // Obtener estado actual del item para decidir la acciÃ³n y capturar el order_id
    const { data: itemRow, error: itemErr } = await supabase
      .from("order_items")
      .select("id, order_id, status, quantity, price_snapshot")
      .eq("id", itemId)
      .maybeSingle();

    if (itemErr || !itemRow) {
      console.error("âŒ No se pudo obtener el item del pedido:", itemErr);
      alert("No se encontrÃ³ el producto a cancelar.");
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
        console.error("âŒ Error eliminando item faltante:", delErr);
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

      alert("âœ… Producto faltante eliminado correctamente del pedido.");
      return;
    }

    // Para otros estados, usar el RPC estÃ¡ndar (puede notificar al admin si estaba picked)
    const { data, error } = await supabase.rpc("rpc_cancel_order_item", {
      p_item_id: itemId,
    });

    if (error) {
      console.error("âŒ Error cancelando producto:", error);
      alert(error.message || "No se pudo cancelar el producto.");
      return;
    }

    console.log("âœ… Producto cancelado correctamente:", data);

    // Si el pedido queda sin items, eliminar el pedido
    await maybeDeleteEmptyOrder(orderId);

    // Recargar pedidos para mostrar los cambios
    if (currentUserId) {
      await loadOrders(currentUserId);
    }

    // Mostrar mensaje segÃºn el estado del producto
    if (data?.was_picked) {
      alert("âœ… Producto cancelado correctamente. Se ha enviado una notificaciÃ³n al administrador ya que este producto estaba apartado.");
    } else {
      alert("âœ… Producto cancelado correctamente.");
    }
  } catch (error) {
    console.error("âŒ Error cancelando producto:", error);
    alert("OcurriÃ³ un error al cancelar el producto.");
  }
}

// Si un pedido no tiene items, eliminarlo para que no quede 'Activo' vacÃ­o
async function maybeDeleteEmptyOrder(orderId) {
  try {
    if (!orderId) return;
    const { count, error: countErr } = await supabase
      .from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId)
      .neq("status", "cancelled");
    if (!countErr && (Number(count) || 0) === 0) {
      const { error: delErr } = await supabase.rpc("rpc_delete_empty_order", { p_order_id: orderId });
      console.log(`ðŸ—‘ï¸ Pedido ${orderId} eliminado por quedar sin productos`);
    }
  } catch (e) {
    console.warn("âš ï¸ No se pudo verificar/eliminar pedido vacÃ­o:", e?.message || e);
  }
}

function isSupabaseRpcMissingError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    err?.code === "PGRST202" ||
    msg.includes("could not find the function") ||
    msg.includes("schema cache")
  );
}

async function closeOrder(orderId) {
  try {
    const customerRow = await fetchCustomerShippingRow();
    if (!customerRow) {
      alert(
        "No se pudieron cargar tus datos. Verificá tu conexión e intentá de nuevo."
      );
      return;
    }

    const { data: orderSnap } = await supabase
      .from("orders")
      .select("transport_id")
      .eq("id", orderId)
      .maybeSingle();

    const needTransportStep =
      !customerRow.transport_id && !orderSnap?.transport_id;

    let province = "";
    let city = "";
    let opciones = [];
    if (needTransportStep) {
      province = (customerRow.province || "").trim();
      city = (customerRow.city || "").trim();
      if (!province || !city) {
        await showDashboardMessageModal({
          title: "Completá tu perfil",
          bodyHtml:
            '<p class="dash-app-message-modal__text">Necesitamos tu provincia y localidad para asignar el envío. Entrá a <a href="profile.html">Mi perfil</a>, guardá los datos y volvé a finalizar el pedido.</p>',
          confirmLabel: "Entendido",
        });
        return;
      }

      opciones = getTransportesDisponibles(province, city);
      if (!opciones.length) {
        await showDashboardMessageModal({
          title: "No pudimos calcular el envío",
          bodyHtml:
            '<p class="dash-app-message-modal__text">Revisá provincia y localidad en <a href="profile.html">Mi perfil</a>. Si el problema sigue, escribinos por WhatsApp.</p>',
          confirmLabel: "Entendido",
        });
        return;
      }
    }

    const isPickupOnly =
      needTransportStep &&
      opciones.length === 1 &&
      ["retiro de local", "retiro del local"].includes(
        String(opciones[0] || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
      );

    const confirmClose = await showDashboardConfirmModal({
      title: "¿Cerrar tu pedido?",
      message:
        isPickupOnly
          ? "¿Estás seguro de que querés cerrar tu pedido?"
          : "¿Estás seguro de que querés cerrar tu pedido y que te lo enviemos?",
      confirmLabel: "Sí, enviar",
      cancelLabel: "Cancelar",
    });
    if (!confirmClose) return;

    let transportOnlyLocal = false;
    if (needTransportStep) {
      const transportResult = await showTransportFinalizeModal({
        province,
        city,
        opciones,
      });
      if (!transportResult.ok) return;

      const { error: trErr } = await supabase.rpc(
        "rpc_set_transport_before_close_order",
        {
          p_order_id: orderId,
          p_transport_name: transportResult.transportName,
        }
      );
      if (trErr) {
        if (isSupabaseRpcMissingError(trErr)) {
          transportOnlyLocal = true;
          guardarTransporteElegido(
            province,
            city,
            transportResult.transportName
          );
          console.warn(
            "rpc_set_transport_before_close_order no está en Supabase; transporte solo en localStorage.",
            trErr
          );
          if (typeof window.showToast === "function") {
            window.showToast(
              "El transporte quedó en este dispositivo. Para guardarlo en tu cuenta, ejecutá en Supabase el SQL: supabase/canonical/134_rpc_set_transport_before_close.sql",
              "info"
            );
          }
        } else {
          console.error("Error guardando transporte:", trErr);
          alert(
            trErr.message || "No se pudo guardar el transporte. Intentá de nuevo."
          );
          return;
        }
      } else {
        guardarTransporteElegido(
          province,
          city,
          transportResult.transportName
        );
      }
    }

    console.log("ðŸ”„ Cerrando pedido:", orderId);

    const { error } = await supabase.rpc("rpc_close_order", {
      p_order_id: orderId,
    });

    if (error) {
      console.error("âŒ Error cerrando pedido:", error);
      alert(error.message || "No se pudo cerrar el pedido.");
      return;
    }

    console.log("âœ… Pedido cerrado correctamente");

    await loadOrders(currentUserId);

    let successBody = `<p class="dash-app-message-modal__text dash-app-message-modal__text--status-line">Se está <span class="dash-app-status-chip">Preparando pedido</span>.</p><p class="dash-app-message-modal__text">Podrá cambiarlo o modificarlo presionando <strong>Modificar pedido</strong>. Cuando su pedido se envíe, podrá consultarlo en el historial <span class="dash-app-message-modal__clock-wrap" role="img" aria-label="Historial de pedidos">${DASH_MESSAGE_CLOCK_SVG}</span></p>`;
    if (transportOnlyLocal) {
      successBody +=
        '<p class="dash-app-message-modal__text" style="margin-top:14px;">El envío no se registró en el servidor todavía. Ejecutá la migración SQL <strong>134_rpc_set_transport_before_close.sql</strong> en Supabase para que quede guardado en tu cuenta.</p>';
    }

    await showDashboardMessageModal({
      title: "",
      bodyHtml: successBody,
      confirmLabel: "Entendido",
    });
  } catch (error) {
    console.error("âŒ Error cerrando pedido:", error);
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
      console.warn("âš ï¸ No se pudo obtener el item del carrito para actualizar.");
      return false;
    }

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

    const maxAllowed = Math.max(0, Math.floor(Number(variantInfo.available ?? 0) || 0));

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
      console.error("âŒ Error actualizando cantidad del carrito:", updateError);
      return false;
    }

    window.dispatchEvent(new CustomEvent("cart:synced"));
    return true;
  } catch (error) {
    console.error("âŒ Error actualizando cantidad:", error);
    return false;
  }
}

let isCleaningCart = false;

/**
 * Clave para agrupar solo líneas realmente duplicadas (mismo producto + color + talle).
 * Importante: `product_variants.id` es una fila por color; los talles viven en `variant_sizes`.
 * Por eso la misma variant_id puede tener 37, 38, etc. — no deben fusionarse en una sola línea.
 */
function cartItemDedupeKey(item) {
  const vid =
    item.variant_id != null && item.variant_id !== ""
      ? String(item.variant_id).trim()
      : "";
  const sizeKey =
    normalizeSize(item.size ?? "") || String(item.size ?? "").trim();
  const name = String(item.product_name ?? "").trim();
  const color = String(item.color ?? "").trim();
  if (vid) {
    return `variant:${vid}__sz:${sizeKey}`;
  }
  return `row:${name}__${color}__${sizeKey}`;
}

/**
 * Varias filas duplicadas por bug: si todas tienen la misma cantidad, NO sumar (416+416→832).
 * Si las cantidades difieren, sí sumar (p. ej. líneas legítimas distintas que tocaron el mismo key).
 */
function consolidatedQuantityForDuplicateGroup(primary, duplicates) {
  const rows = [primary, ...duplicates];
  const qtys = rows.map((r) => Number(r.quantity ?? r.qty ?? 0) || 0);
  if (qtys.length === 0) return 0;
  const first = qtys[0];
  const allSame = qtys.every((q) => q === first);
  if (allSame) {
    return first;
  }
  return qtys.reduce((a, b) => a + b, 0);
}

async function cleanupDuplicateCartItems(cartId, items) {
  if (isCleaningCart) return false;

  const groups = new Map();
  items.forEach((item) => {
    const key = cartItemDedupeKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        primary: item,
        duplicates: [],
      });
    } else {
      const group = groups.get(key);
      group.duplicates.push(item);
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

      const primary = group.primary;
      const totalQty = consolidatedQuantityForDuplicateGroup(
        group.primary,
        group.duplicates
      );

      // Insertar la fila consolidada ANTES de borrar las duplicadas.
      // Si el insert falla, no borramos: evita carrito vacío en DB con UI mostrando ítems fantasma.
      const { error: insertError } = await supabase.from("cart_items").insert({
        cart_id: cartId,
        product_name: primary.product_name,
        color: primary.color,
        size: normalizeSize(primary.size ?? "") || primary.size,
        quantity: totalQty,
        qty: totalQty,
        price_snapshot: primary.price_snapshot,
        status: primary.status || "reserved",
        imagen: primary.imagen || null,
        variant_id: primary.variant_id || null,
      });

      if (insertError) {
        console.warn(
          "âš ï¸ Error insertando item consolidado (duplicados no eliminados):",
          insertError.message
        );
        continue;
      }

      const { error: deleteError } = await supabase
        .from("cart_items")
        .delete()
        .in("id", idsToDelete);

      if (deleteError) {
        console.warn(
          "âš ï¸ Error eliminando duplicados tras consolidar:",
          deleteError.message
        );
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

  function getCartProductsCount(cartItems = []) {
    return cartItems.reduce((sum, item) => {
      const qty = Number(item?.quantity ?? item?.qty ?? 0);
      return sum + (Number.isFinite(qty) ? qty : 0);
    }, 0);
  }

  function formatProductsCount(count) {
    const n = Number(count) || 0;
    return `${n} ${n === 1 ? "producto" : "productos"} en el carrito`;
  }

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
          <p class="empty-cart">
            Todavía no agregaste productos
            <br><span class="subtext">Explorá el catálogo y armá tu pedido</span>
          </p>
          <a href="../index.html" class="btn" style="margin:12px auto 0; display:block; width:fit-content;">Explorar catálogo</a>
        `;
      const cartFooter = document.getElementById("cart-footer");
      if (cartFooter) cartFooter.style.display = "none";
      currentCartId = null;
      currentCartItems = [];
      return;
    }

    currentCartId = cart.id;

    const CART_ITEM_COLS =
      "id, product_name, color, size, quantity, qty, price_snapshot, imagen, status, variant_id";

    let { data: cartItems, error } = await supabase
      .from("cart_items")
      .select(CART_ITEM_COLS)
      .eq("cart_id", cart.id);

      if (error) {
        cartInfo.innerHTML = `
          <h3>Carrito Actual</h3>
          <p style="color: #dc3545;">Error cargando carrito</p>
        `;
      return;
    }

    cartItems = cartItems || [];

    const cleaned = await cleanupDuplicateCartItems(cart.id, cartItems);
    if (cleaned) {
      await loadCart(userId);
      return;
    }

    // Tras intentar deduplicar, siempre releer: evita UI desincronizada si hubo borrado parcial.
    const { data: cartItemsFresh, error: refreshErr } = await supabase
      .from("cart_items")
      .select(CART_ITEM_COLS)
      .eq("cart_id", cart.id);

    if (refreshErr) {
      cartInfo.innerHTML = `
          <h3>Carrito Actual</h3>
          <p style="color: #dc3545;">Error cargando carrito</p>
        `;
      return;
    }
    cartItems = cartItemsFresh || [];

    // Precargar SKUs para que "Ver producto" en carrito vaya al PDP real
    await ensureVariantSkusLoaded(cartItems.map((it) => it?.variant_id).filter(Boolean));

    if (!cartItems || cartItems.length === 0) {
        cartInfo.innerHTML = `
          <p class="empty-cart">
            Todavía no agregaste productos
            <br><span class="subtext">Explorá el catálogo y armá tu pedido</span>
          </p>
          <a href="../index.html" class="btn" style="margin:12px auto 0; display:block; width:fit-content;">Explorar catálogo</a>
        `;
      const cartFooter = document.getElementById("cart-footer");
      if (cartFooter) cartFooter.style.display = "none";
      currentCartId = null;
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
        
        // Verificar stock REAL disponible (sin contar lo que estÃ¡ en el carrito del usuario)
        // El stock disponible es: stock_qty - reserved_qty
        // No restamos qtyValue porque los productos en el carrito NO estÃ¡n reservados aÃºn
        const realAvailableStock = variantInfo
          ? Math.max(0, variantInfo.available ?? 0)
          : 0;
        
        // Si la cantidad en el carrito es mayor que el stock disponible REAL, estÃ¡ agotado
        const isOutOfStock = qtyValue > realAvailableStock;
        
        const remainingStock = Math.max(0, realAvailableStock - qtyValue);
        // Tope seleccionable = stock real (si hay más unidades en bolsa que stock, el desplegable debe ir hasta este máximo)
        const maxQty = Math.max(0, Math.floor(realAvailableStock));

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
    
    const cartFooter = document.getElementById("cart-footer");
    if (cartFooter) {
      if (enrichedItems.length > 0) {
        cartFooter.style.display = "block";
        
        // Deshabilitar botÃ³n de envÃ­o si hay productos agotados
        const submitBtn = document.getElementById("submit-cart-btn");
        if (submitBtn) {
          if (hasOutOfStockItems) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = "0.5";
            submitBtn.style.cursor = "not-allowed";
            submitBtn.title = "No puedes enviar el pedido mientras haya productos agotados. Elimina los productos agotados para continuar.";
            console.log("ðŸ”´ BotÃ³n de envÃ­o deshabilitado - hay productos agotados");
      } else {
            submitBtn.disabled = false;
            submitBtn.style.opacity = "1";
            submitBtn.style.cursor = "pointer";
            submitBtn.title = "";
            console.log("ðŸŸ¢ Botones de carrito visibles y habilitados");
          }
        }
        
        // Sin banner global extra: el aviso queda solo en cada ítem (p. ej. Máx. N disponibles).
        document.getElementById("cart-actions")?.querySelector(".out-of-stock-warning")?.remove();
        cartFooter
          .querySelector(".dash-bolsa-sticky-inner")
          ?.querySelector(":scope > .out-of-stock-warning")
          ?.remove();
      } else {
        cartFooter.style.display = "none";
      }
    }

    // Obtener ofertas y promociones para los items del carrito
    const offersData = await getOffersAndPromotionsForItems(enrichedItems);
    
    const totalUnits = getCartProductsCount(enrichedItems);

    const totalPrice = enrichedItems.reduce((sum, item) => {
      const qty = Number(item.quantity ?? item.qty ?? 0);
      // Preferir precio actual de la variante para que el total sea siempre cantidad × precio unitario actual
      const price = Number(item.variantInfo?.price ?? item.price_snapshot ?? 0) || 0;
      return sum + (Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0);
    }, 0);

    const itemsHtml = enrichedItems
      .map((item) => {
        const itemKey = item.id || `${item.product_name}-${item.color}-${item.size}`;
        const promoText = offersData.itemPromos?.get(itemKey);
        const offerInfo = offersData.itemOffers?.get(itemKey);
        
        const qty = Number(item.quantity ?? item.qty ?? 0) || 0;
        // Preferir precio actual de la variante para que Total = cantidad × precio unitario correcto
        let price = Number(item.variantInfo?.price ?? item.price_snapshot ?? 0) || 0;
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
        const colorFull = item.color || "Color único";
        const color = abbreviateColorLabel(colorFull);
        const size = item.size || "Talle único";
        const maxQty = Math.max(0, Math.floor(Number(item.maxQty) || 0));
        const remainingStock =
          Math.max(0, Math.floor(Number(item.remainingStock) || 0)) || 0;
        const isOutOfStock = item.isOutOfStock || false;
        const realAvailableStock = item.realAvailableStock || 0;
        
        // Mostrar leyenda de oferta o promoción
        let offerPromoBadge = '';
        if (promoText) {
          offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #ff9800; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">${promoText}</div>`;
        } else if (offerInfo) {
          offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #e74c3c; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">Oferta</div>`;
        }
        
        // Estilos para producto agotado (tonos rosas)
        const outOfStockStyles = isOutOfStock
          ? `background: #fce4ec; border: 2px solid #f48fb1; opacity: 0.9;`
          : ``;
        const outOfStockTextStyles = isOutOfStock
          ? `color: #c2185b; font-weight: 600;`
          : ``;

        const unitPriceFormatted = price.toLocaleString('es-AR');
        const unitPriceMeta = `· $${unitPriceFormatted} c/u`;
        
        return `
          <div class="dash-bolsa-item ${isOutOfStock ? 'cart-item-out-of-stock' : ''}" style="${outOfStockStyles}" data-item-id="${item.id}">
            <div class="dash-bolsa-item__row1">
              <img src="${thumb}" alt="${productName}" class="dash-bolsa-item__thumb" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" style="opacity: ${isOutOfStock ? '0.6' : '1'};">
              <div class="dash-bolsa-item__main">
                <div class="dash-bolsa-item__head">
                  <div class="dash-bolsa-item__line1">
                    <span class="dash-bolsa-item__title" style="${outOfStockTextStyles}">
                      <span class="dash-bolsa-item__title-main">${productName} · ${color}</span>
                      <span class="dash-bolsa-item__title-group">
                        <span class="dash-bolsa-item__title-sep" aria-hidden="true">·</span>
                        <span class="dash-bolsa-item__title-size">${size}</span>
                        ${isOutOfStock ? `
                          <span class="dash-bolsa-item__alt-sep" aria-hidden="true">·</span>
                          <button type="button" class="btn-ver-alternativas dash-bolsa-item__alt-link"
                                  data-articulo="${productName}" 
                                  data-color="${colorFull}" 
                                  data-talle="${size}"
                                  data-item-id="${item.id}">
                            Ver alternativas
                          </button>
                        ` : ""}
                      </span>
                    </span>
                  </div>
                  <div class="dash-bolsa-item__right order-item-actions">
                    <span class="dash-bolsa-item__price item-row__price-total" style="${outOfStockTextStyles}">$${lineTotal.toLocaleString('es-AR')}</span>
                    <div class="item-row__menu-wrap">
                      <button type="button" class="item-row__kebab" aria-label="Opciones" aria-haspopup="true" aria-expanded="false">⋯</button>
                      <div class="item-row__popover" role="menu" aria-hidden="true">
                        <button type="button" class="item-row__menuitem item-row__menuitem--danger" data-action="remove-bag-item" data-id="${item.id}">Quitar de la bolsa</button>
                        <a href="${buildCatalogHrefFromVariantOrName(item.variant_id || item.variantInfo?.id, productName)}" class="item-row__menuitem" data-action="view-product">Ver producto</a>
                      </div>
                    </div>
                  </div>
                </div>
                ${offerPromoBadge}
                ${isOutOfStock ? `
                <div class="dash-bolsa-item__stock-row">
                  <div class="dash-bolsa-item__out-of-stock-msg">
                    <span>⚠ Máx. ${realAvailableStock} disponibles</span>
                  </div>
                </div>
                ` : ""}
                <div class="dash-bolsa-item__line2">
                  <select class="cart-qty-select dash-bolsa-item__qty-select" data-id="${item.id}" data-max="${maxQty}" data-current-qty="${qty}" aria-label="Cantidad">
                    ${buildDashBolsaQtySelectOptions(qty, maxQty)}
                  </select>
                  <span class="dash-bolsa-item__unit-price">${unitPriceMeta}</span>
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
              <strong style="font-size: 15px;">Ofertas y promociones</strong>
              <div style="font-size: 14px; color: #ff9800; margin-top: 4px; font-weight: 600;">
                Descuento: -$${offersData.totalDiscount.toLocaleString('es-AR')}
              </div>
            </div>
          </div>
        </div>
      `;
    }

    const displayTotal = offersData.totalDiscount > 0 ? totalPrice - offersData.totalDiscount : totalPrice;
        cartInfo.innerHTML = `
      <p class="dash-bolsa-hint" aria-hidden="true">
        Enviá el pedido para reservarlos.
      </p>
      <div class="cart-items-list dash-bolsa-list">
        ${itemsHtml}
      </div>
      ${discountSummaryHtml}
    `;

    attachRemoveHandlers(userId);
    attachBolsaPopoverCloseOnOutsideClick();
    attachQuantityHandlers(userId);
    attachAlternativasHandlers(userId);

    const cartTotalValue = document.getElementById("cart-total-value");
    if (cartTotalValue) cartTotalValue.textContent = `$${displayTotal.toLocaleString("es-AR")}`;

    const cartProductsCount = document.getElementById("cart-products-count");
    if (cartProductsCount) cartProductsCount.textContent = formatProductsCount(totalUnits);
    const submitBtn = document.getElementById("submit-cart-btn");
    if (submitBtn) submitBtn.textContent = "Hacer pedido";

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
      console.warn("âš ï¸ No se pudo actualizar el carrito local:", storageError);
    }
  } catch (error) {
    console.warn("âš ï¸ Error cargando carrito:", error.message);
      cartInfo.innerHTML = `
        <h3>Carrito Actual</h3>
        <p style="color: #dc3545;">Error cargando carrito</p>
      `;
  }
}

async function loadOrders(userId) {
  const ordersSection = document.getElementById("orders-section");
  if (!ordersSection) return;

  function getOrderStatusSummary(orderItems = []) {
    const normStatus = (s) => String(s || "").toLowerCase().trim();
    const counters = {
      confirmed: 0, // picked -> confirmado
      pending: 0,   // reserved/waiting -> pendiente
      missing: 0,   // missing -> sin stock
    };

    orderItems.forEach((item) => {
      if (!item || normStatus(item.status) === "cancelled") return;
      const qty = Math.max(0, Number(item.quantity || 0) || 0);
      const st = normStatus(item.status);

      if (st === "missing") {
        counters.missing += qty;
        return;
      }
      if (st === "picked") {
        counters.confirmed += qty;
        return;
      }
      // reserved / waiting / otros se resumen como pendiente
      counters.pending += qty;
    });

    const formatPart = (count, singular, plural) =>
      `${count} ${count === 1 ? singular : plural}`;

    const hasConfirmed = counters.confirmed > 0;
    const hasPending = counters.pending > 0;
    const hasMissing = counters.missing > 0;

    // Máximo 2 estados visibles, siguiendo los casos solicitados.
    if (hasMissing) {
      if (hasConfirmed) {
        return `${formatPart(counters.confirmed, "confirmado", "confirmados")} · ${formatPart(counters.missing, "sin stock", "sin stock")}`;
      }
      if (hasPending) {
        return `${formatPart(counters.pending, "pendiente", "pendientes")} · ${formatPart(counters.missing, "sin stock", "sin stock")}`;
      }
      return formatPart(counters.missing, "sin stock", "sin stock");
    }

    if (hasConfirmed && hasPending) {
      return `${formatPart(counters.confirmed, "confirmado", "confirmados")} · ${formatPart(counters.pending, "pendiente", "pendientes")}`;
    }
    if (hasConfirmed) {
      return formatPart(counters.confirmed, "confirmado", "confirmados");
    }
    if (hasPending) {
      return formatPart(counters.pending, "pendiente", "pendientes");
    }
    return "Sin productos";
  }

  try {
    // Ejecutar mantenimiento de vencimientos (14 dÃ­as: expira pedido y devuelve stock a GENERAL)
    try {
      await supabase.rpc("rpc_orders_daily_maintenance");
    } catch (e) {
      console.warn("rpc_orders_daily_maintenance:", e?.message || e);
    }

    // Cargar pedidos activos y cerrados (excluir enviados y expirados)
    // Los pedidos "closed" aparecerán con aviso "En preparación"
    const { data: orders, error } = await supabase
      .from("orders")
      .select(
        "id, order_number, status, total_amount, created_at, updated_at, expires_at, dismantle_at, order_items(id, product_name, color, size, quantity, price_snapshot, imagen, status, variant_id)"
      )
      .eq("customer_id", userId)
      .in("status", ["active", "closing_soon", "closed"])
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
          <div class="section-title dash-title" style="margin-bottom:12px;">📦 Mi pedido</div>
          <p style="margin:0;">Todavía no tienes pedidos. Envía tu carrito para crear uno nuevo.</p>
        </div>
      `;
      return;
    }

    // Precargar SKUs para que "Ver producto" vaya al PDP real (index#/pdp/<sku>)
    const allVariantIds = [];
    for (const o of orders) {
      for (const it of (o?.order_items || [])) {
        if (it?.variant_id) allVariantIds.push(it.variant_id);
      }
    }
    await ensureVariantSkusLoaded(allVariantIds);

    // Precios: si vienen en "miles abreviados" (ej. 18 = $18.000, 16.5 = $16.500), convertir a pesos para cálculo y visual
    function normalizeOrderPrice(p) {
      const n = Number(p) || 0;
      if (n > 0 && n < 1000) return n * 1000;
      return n;
    }
    function formatOrderPrice(num) {
      return "$" + Math.round(normalizeOrderPrice(num)).toLocaleString("es-AR", { maximumFractionDigits: 0 });
    }

    const ordersHtml = await Promise.all(orders.map(async (order) => {
        const items = order.order_items || [];
        const orderStatus = (order.status || "").toLowerCase().trim();
        const isActive = orderStatus === "active";
        const isClosed = orderStatus === "closed";  // En preparación
        
        // Calcular total excluyendo items faltantes (con precios normalizados)
        const validItems = items.filter(item => item.status !== 'missing');
        const total = validItems.reduce((sum, item) => {
          const qty = Number(item.quantity || 0) || 0;
          const price = normalizeOrderPrice(item.price_snapshot || 0);
          return sum + (qty * price);
        }, 0);
        
        // Obtener nÃºmero de pedido o usar ID como fallback
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
        }        const visibleItems = items.filter((item) => item.status !== "cancelled");
        const normStatus = (s) => (String(s || "").toLowerCase().trim());
        const missingItems = visibleItems.filter((item) => normStatus(item.status) === "missing");
        const itemsForGroups = visibleItems.filter((item) => normStatus(item.status) !== "missing");

        const groupsMap = new Map();
        itemsForGroups.forEach((item) => {
          const key = `${(item.product_name || "Producto").trim()}|${(item.color || "Color unico").trim()}`;
          if (!groupsMap.has(key)) groupsMap.set(key, []);
          groupsMap.get(key).push(item);
        });

        const groupedItems = Array.from(groupsMap.values());
        const groupedHtml = groupedItems
          .map((group) => {
            const base = group[0];
            const productName = base.product_name || "Producto";
            const color = abbreviateColorLabel(base.color || "Color unico");
            const totalQty = group.reduce((sum, g) => sum + (Number(g.quantity || 0) || 0), 0);
            const unitPrice = normalizeOrderPrice(base.price_snapshot || 0);
            const lineTotal = group.reduce((sum, g) => {
              const qty = Number(g.quantity || 0) || 0;
              const price = normalizeOrderPrice(g.price_snapshot || 0);
              return sum + qty * price;
            }, 0);

            // Agrupar por combinación talla + estado para mostrar cada una como sublínea independiente
            const sizeStatusMap = new Map();
            group.forEach((g) => {
              const size = g.size || "Unico";
              const st = normStatus(g.status);
              const key = `${size}|${st || "reserved"}`;
              const qty = Number(g.quantity || 0) || 0;
              if (!sizeStatusMap.has(key)) {
                sizeStatusMap.set(key, { size, status: st || "reserved", qty: 0 });
              }
              sizeStatusMap.get(key).qty += qty;
            });

            const sizeStatusList = Array.from(sizeStatusMap.values());
            sizeStatusList.sort((a, b) => {
              const na = Number(a.size), nb = Number(b.size);
              if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
              const sa = String(a.size), sb = String(b.size);
              if (sa !== sb) return sa.localeCompare(sb);
              // Ordenar estados de forma consistente: picked, waiting, reserved, missing, otros
              const order = { picked: 0, waiting: 1, reserved: 2, missing: 3 };
              const ra = order[a.status] ?? 99;
              const rb = order[b.status] ?? 99;
              return ra - rb;
            });

            const distinctSizes = Array.from(new Set(sizeStatusList.map((s) => String(s.size))));
            const multiSize = distinctSizes.length > 1;
            const hasMultipleVariants = sizeStatusList.length > 1;

            const sizeLabel = String(distinctSizes[0] || "").trim();
            const normSize = sizeLabel
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .trim();
            const isUniqueSize =
              normSize === "unico" ||
              normSize === "talle unico" ||
              normSize === "talle unico." ||
              normSize === "talle: unico" ||
              normSize === "talle unico (unico)";

            const showInlineSize = !multiSize && sizeLabel && !isUniqueSize;

            const titleHtml = showInlineSize
              ? `<span class="item-row__title-name">${productName}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-color">${color}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-size">${sizeLabel}</span>`
              : `<span class="item-row__title-name">${productName}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-color">${color}</span>`;

            const sizeHtml =
              !multiSize && sizeLabel && !showInlineSize
                ? `<div class="item-row__variant-size">${sizeLabel}${totalQty > 1 ? ` · x ${totalQty} unidades` : ""}</div>`
                : "";

            const orderItemIds = group.map((g) => g.id).filter(Boolean).join(",");

            function getStatusMeta(status) {
              const st = normStatus(status);
              if (st === "picked") {
                return {
                  className: "item-row__status--st-picked",
                  text: "Apartado",
                  info: "Apartado: el producto ya se encuentra en su pedido.",
                };
              }
              if (st === "waiting") {
                return {
                  className: "item-row__status--st-waiting",
                  text: "Espera",
                  info: "Estamos preparando tu pedido. El vendedor confirmará estas unidades.",
                };
              }
              if (st === "missing") {
                return {
                  className: "item-row__status--st-missing",
                  text: "Sin stock",
                  info: "Esta unidad no tiene stock disponible.",
                };
              }
              // reserved u otros
              return {
                className: "item-row__status--st-reserved",
                text: "Reserva",
                info: "El vendedor está confirmando el stock.",
              };
            }

            // Estado principal del grupo (se muestra en la fila principal)
            const groupStatuses = new Set(group.map((g) => normStatus(g.status)));
            let mainStatus = "reserved";
            if (groupStatuses.size === 1) {
              mainStatus = groupStatuses.values().next().value || "reserved";
            } else if (groupStatuses.has("reserved")) {
              mainStatus = "reserved";
            } else if (groupStatuses.has("waiting")) {
              mainStatus = "waiting";
            } else if (groupStatuses.has("picked")) {
              mainStatus = "picked";
            } else if (groupStatuses.has("missing")) {
              mainStatus = "missing";
            }

            const mainMeta = getStatusMeta(mainStatus);
            const statusPicked = `<span class="item-row__status ${mainMeta.className}" data-status-info="${mainMeta.info.replace(/"/g, "&quot;")}" tabindex="0" role="button"><span class="item-row__status-full">${mainMeta.text}</span><span class="item-row__status-short">${mainMeta.text}</span></span><div class="item-row__status-tooltip" aria-hidden="true"></div>`;

            const subitemLabel = (s) => `${color} · ${s.size} x${s.qty}`;
            const sizesLineHtml = hasMultipleVariants
              ? sizeStatusList
                  .map((s) => {
                    const meta = getStatusMeta(s.status);
                    return `<div class="item-row__size-subitem"><span class="item-row__size-subitem-label">${subitemLabel(s)}</span><span class="item-row__size-subitem-spacer" aria-hidden="true"></span><span class="item-row__size-subitem-badge ${meta.className}">${meta.text}</span></div>`;
                  })
                  .join("")
              : "";

            return `
              <div class="item-row item-row--order">
                <div class="item-row__left">
                  <img class="item-row__thumb" src="${base.imagen || FALLBACK_IMAGE}" alt="${productName}" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
                  <div class="item-row__body">
                    <div class="item-row__line1">
                      <div class="item-row__title">${titleHtml}</div>
                    </div>
                    ${sizeHtml}
                    <div class="item-row__line2">
                      <div class="item-row__order-meta">${totalQty} uni · ${formatOrderPrice(unitPrice)} c/u</div>
                    </div>
                  </div>
                </div>
                <div class="item-row__right">
                  <div class="item-row__col-toggle">${multiSize ? `<button type="button" class="item-row__sizes-toggle" aria-expanded="false">▾</button>` : ""}</div>
                  <div class="item-row__col-status">${statusPicked}</div>
                  <span class="item-row__price-total">${formatOrderPrice(lineTotal)}</span>
                  <div class="item-row__menu-wrap">
                    <button type="button" class="item-row__kebab" aria-label="Opciones" aria-haspopup="true" aria-expanded="false">⋯</button>
                    <div class="item-row__popover" role="menu" aria-hidden="true">
                      <button type="button" class="item-row__menuitem item-row__menuitem--danger" data-action="remove-order-item" data-order-item-ids="${orderItemIds.replace(/"/g, "&quot;")}">Quitar del pedido</button>
                      <a href="${buildCatalogHrefFromVariantOrName(base.variant_id, productName)}" class="item-row__menuitem" data-action="view-product">Ver producto</a>
                    </div>
                  </div>
                </div>
                ${multiSize ? `<div class="item-row__sizes-line" hidden>${sizesLineHtml}</div>` : ""}
              </div>
            `;
          })
          .join("");

        const missingCardsHtml = missingItems
          .map((m) => {
            const productName = m.product_name || "Producto";
            const color = abbreviateColorLabel(m.color || "Color unico");
            const size = m.size || "Unico";
            const sizeLabel = String(m.size || "").trim();
            const qty = Number(m.quantity || 0) || 1;
            const unitPrice = normalizeOrderPrice(m.price_snapshot || 0);
            const lineTotal = qty * unitPrice;
            const normSize = sizeLabel
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .trim();
            const isUniqueSize =
              normSize === "unico" ||
              normSize === "talle unico" ||
              normSize === "talle unico." ||
              normSize === "talle: unico" ||
              normSize === "talle unico (unico)";
            const showInlineSize = Boolean(sizeLabel) && !isUniqueSize;

            const titleHtml = showInlineSize
              ? `<span class="item-row__title-name">${productName}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-color">${color}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-size">${sizeLabel}</span>`
              : `<span class="item-row__title-name">${productName}</span><span class="item-row__title-sep" aria-hidden="true">·</span><span class="item-row__title-color">${color}</span>`;

            const sizeHtml =
              sizeLabel && !showInlineSize
                ? `<div class="item-row__variant-size">${sizeLabel}${qty > 1 ? ` · x ${qty} unidades` : ""}</div>`
                : "";
            const missingMeta = { className: "item-row__status--st-missing", text: "Sin stock", info: "Esta unidad no tiene stock disponible." };
            const statusHtml = `<span class="item-row__status ${missingMeta.className}" data-status-info="${missingMeta.info.replace(/"/g, "&quot;")}" tabindex="0" role="button"><span class="item-row__status-full">${missingMeta.text}</span><span class="item-row__status-short">${missingMeta.text}</span></span><div class="item-row__status-tooltip" aria-hidden="true"></div>`;
            return `
              <div class="item-row item-row--order item-row--missing-standalone">
                <div class="item-row__left">
                  <img class="item-row__thumb" src="${m.imagen || FALLBACK_IMAGE}" alt="${productName}" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
                  <div class="item-row__body">
                    <div class="item-row__line1">
                      <div class="item-row__title">${titleHtml}</div>
                    </div>
                    ${sizeHtml}
                    <div class="item-row__line2">
                      <div class="item-row__order-meta">${qty} uni · ${formatOrderPrice(unitPrice)} c/u</div>
                    </div>
                  </div>
                </div>
                <div class="item-row__right">
                  <div class="item-row__col-toggle"></div>
                  <div class="item-row__col-status">${statusHtml}</div>
                  <span class="item-row__price-total">${formatOrderPrice(lineTotal)}</span>
                  <div class="item-row__menu-wrap">
                    <button type="button" class="item-row__kebab" aria-label="Opciones" aria-haspopup="true" aria-expanded="false">⋯</button>
                    <div class="item-row__popover" role="menu" aria-hidden="true">
                      <button type="button" class="item-row__menuitem item-row__menuitem--danger" data-action="remove-order-item" data-order-item-ids="${(m.id || "").replace(/"/g, "&quot;")}">Quitar del pedido</button>
                      <a href="../index.html?similares=1&articulo=${encodeURIComponent(productName)}&talle=${encodeURIComponent(size)}" class="item-row__menuitem" data-action="view-similares">Ver similares</a>
                      <a href="${buildCatalogHrefFromVariantOrName(m.variant_id, productName)}" class="item-row__menuitem" data-action="view-product">Ver producto</a>
                    </div>
                  </div>
                </div>
              </div>
            `;
          })
          .join("");

        const itemsHtmlAll = missingCardsHtml + groupedHtml;

        const created = new Date(order.created_at).getTime();
        const now = Date.now();
        const oneDayMs = 1000 * 60 * 60 * 24;
        const daysElapsed = Math.floor((now - created) / oneDayMs);
        const dismantleAt = order.dismantle_at ? new Date(order.dismantle_at).getTime() : null;
        const daysRemaining = dismantleAt != null
          ? Math.max(0, Math.ceil((dismantleAt - now) / oneDayMs))
          : Math.max(0, 14 - daysElapsed);

        const totalUnits = visibleItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
        const MIN_UNITS_TO_FINALIZE = 4;
        const allPickedForOrder = visibleItems.length > 0 && visibleItems.every((item) => (item.status || "").toLowerCase() === "picked");
        const hasReservedInOrder = visibleItems.some((item) => (item.status || "").toLowerCase() === "reserved");
        const hasMissingItems = missingItems.length > 0;
        // Regla UX: 4+ productos habilita, y los items "reservados" no bloquean.
        const canFinalize = totalUnits >= MIN_UNITS_TO_FINALIZE && !hasMissingItems && (allPickedForOrder || hasReservedInOrder);
        const finalizeBtnClass = canFinalize ? "btn-finalize-order--enabled" : "btn-finalize-order--disabled";
        const missingForFinalize = Math.max(0, MIN_UNITS_TO_FINALIZE - totalUnits);
        let finalizeTitle = "";
        if (hasMissingItems) {
          finalizeTitle = "Para finalizar el pedido elimine o cambie el producto sin stock.";
        } else if (totalUnits < MIN_UNITS_TO_FINALIZE && missingForFinalize > 0) {
          finalizeTitle = missingForFinalize === 1 ? "Te falta 1 par para cerrar el pedido" : `Te faltan ${missingForFinalize} pares para cerrar el pedido`;
        } else if (!allPickedForOrder && !hasReservedInOrder) {
          finalizeTitle = "Para finalizar el pedido debe esperar a que el vendedor confirme el stock de la reserva.";
        }

        return `
          <div class="dash-order order-item" data-order-id="${order.id}" data-order-closed="${isClosed ? 'true' : 'false'}">
            <div class="dash-order__head--compact dash-order__head--summary">
              <div class="dash-order__head-left">
                <div class="dash-order__title">📦 Mi pedido</div>
                <span class="dash-order-header-chip dash-order-header-chip--state ${isClosed ? 'dash-order-header-chip--preparing' : ''}">${isClosed ? 'Preparando pedido' : getOrderStatusSummary(visibleItems)}</span>
              </div>
              <div class="dash-order__head-right">
                ${!isClosed ? `<span class="dash-order-header-chip dash-order-header-chip--days" title="Quedan ${daysRemaining} días para cerrar el pedido (14 días desde la creación)">${daysRemaining} días</span>` : ''}
                ${
                  isActive
                    ? `<div class="dash-order-header-menu-wrap">
                         <button type="button" class="dash-order-header-kebab" aria-label="Opciones del pedido" aria-haspopup="true" aria-expanded="false">…</button>
                         <div class="dash-order-header-popover" role="menu" aria-hidden="true">
                           <button type="button" class="dash-order-header-menuitem" data-cancel-entire-order="${order.id}">Cancelar pedido</button>
                         </div>
                       </div>`
                    : isClosed
                      ? `<div class="dash-order-header-menu-wrap">
                           <button type="button" class="dash-order-header-kebab" aria-label="Opciones del pedido" aria-haspopup="true" aria-expanded="false">…</button>
                           <div class="dash-order-header-popover" role="menu" aria-hidden="true">
                             <button type="button" class="dash-order-header-menuitem" data-modify-order="${order.id}">Modificar pedido</button>
                             <a class="dash-order-header-menuitem" href="${WHATSAPP_ENVIOS_HREF}" target="_blank" rel="noopener noreferrer">Contactar</a>
                           </div>
                         </div>`
                      : `<span class="dash-order-header-kebab" aria-hidden="true">…</span>`
                }
              </div>
            </div>
            <div class="dash-divider"></div>
            <div class="dash-order__head--compact">
              <div>
                <div class="dash-order__number">Pedido #${orderDisplayNumber}</div>
                <div class="dash-order__total-line">Total: ${formatOrderPrice(total)}</div>
              </div>
              ${isActive ? `<div class="dash-order__cta"><div class="dash-order-finalize-wrap"><button type="button" class="btn btn-finalize-order close-order-btn ${finalizeBtnClass}" data-order-id="${order.id}" data-order-items-count="${totalUnits}" data-all-picked="${allPickedForOrder ? "true" : "false"}" data-has-reserved="${hasReservedInOrder ? "true" : "false"}" data-has-missing-items="${hasMissingItems ? "true" : "false"}" data-finalize-title="${(finalizeTitle || "").replace(/"/g, "&quot;")}" ${canFinalize ? "" : (totalUnits < MIN_UNITS_TO_FINALIZE ? "disabled" : "")} ${finalizeTitle ? `title="${finalizeTitle.replace(/"/g, "&quot;")}"` : ""}>Finalizar pedido</button><div class="dash-order-finalize-tooltip" id="finalize-tooltip-${order.id}" role="tooltip" aria-hidden="true"></div></div></div>` : ""}
              ${isClosed ? `<div class="dash-order__cta"><button type="button" class="dash-order-modify-link" data-order-id="${order.id}">Modificar pedido</button></div>` : ""}
            </div>
            <div class="dash-divider"></div>
            <div class="dash-order__sub">Productos del pedido (${totalUnits})</div>
            <div class="dash-order__list cart-items-list dash-order__list--collapsible" style="margin-top:8px;" data-max-collapsed-items="4">
              ${itemsHtmlAll || "<p>No hay productos asociados al pedido.</p>"}
            </div>
            ${(groupedItems.length + missingItems.length) > 4
              ? `<button type="button" class="dash-order__list-toggle" data-order-id="${order.id}" aria-expanded="false">
                  Ver todo el pedido ▾
                </button>`
              : ""}
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
        const itemsCount = parseInt(btn.dataset.orderItemsCount || "0", 10);
        const allPicked = btn.dataset.allPicked === "true";
        const hasReserved = btn.dataset.hasReserved === "true";
        const hasMissingItems = btn.dataset.hasMissingItems === "true";
        const finalizeTitle = (btn.dataset.finalizeTitle || "").replace(/&quot;/g, '"');
        if (!orderId) return;

        if (hasMissingItems) {
          const text =
            finalizeTitle || "Para finalizar el pedido elimine o cambie el producto sin stock.";
          const wrap = btn.closest(".dash-order-finalize-wrap");
          const tooltip = wrap ? wrap.querySelector(".dash-order-finalize-tooltip") : null;
          if (tooltip) {
            tooltip.textContent = text;
            tooltip.classList.add("is-visible");
            tooltip.setAttribute("aria-hidden", "false");
            setTimeout(() => {
              tooltip.classList.remove("is-visible");
              tooltip.setAttribute("aria-hidden", "true");
            }, 5000);
          } else {
            alert(text);
          }
          return;
        }

        // Permitir finalizar si el pedido tiene "reservados" (regla nueva).
        if (!allPicked && !hasReserved) {
          const text = finalizeTitle || "Para finalizar el pedido debe esperar a que el vendedor confirme el stock de la reserva.";
          const wrap = btn.closest(".dash-order-finalize-wrap");
          const tooltip = wrap ? wrap.querySelector(".dash-order-finalize-tooltip") : null;
          if (tooltip) {
            tooltip.textContent = text;
            tooltip.classList.add("is-visible");
            tooltip.setAttribute("aria-hidden", "false");
            setTimeout(() => {
              tooltip.classList.remove("is-visible");
              tooltip.setAttribute("aria-hidden", "true");
            }, 5000);
          } else {
            alert(text);
          }
          return;
        }

        const MIN_ITEMS_TO_CLOSE = 4;
        if (itemsCount < MIN_ITEMS_TO_CLOSE) {
          const missing = MIN_ITEMS_TO_CLOSE - itemsCount;
          const text = missing === 1
            ? "Te falta 1 par para cerrar el pedido"
            : `Te faltan ${missing} pares para cerrar el pedido`;
          const wrap = btn.closest(".dash-order-finalize-wrap");
          const tooltip = wrap ? wrap.querySelector(".dash-order-finalize-tooltip") : null;
          if (tooltip) {
            tooltip.textContent = text;
            tooltip.classList.add("is-visible");
            tooltip.setAttribute("aria-hidden", "false");
            setTimeout(() => {
              tooltip.classList.remove("is-visible");
              tooltip.setAttribute("aria-hidden", "true");
            }, 4000);
          } else {
            alert(text);
          }
          return;
        }

        if (hasReserved) {
          const confirmText =
            "Tu pedido incluye productos en reserva, pendientes de confirmación. Si alguno no tuviera stock, te avisaremos. ?quiere finalizar el pedido?";
          const confirmed = await showDashboardConfirmModal({
            title: "Finalizar pedido",
            message: confirmText,
            confirmLabel: "Aceptar",
            cancelLabel: "Cancelar",
          });
          if (!confirmed) return;
        }

        await closeOrder(orderId);
      };
    });

    ordersSection.querySelectorAll(".dash-order-modify-link").forEach((btn) => {
      btn.onclick = async () => {
        const orderId = btn.dataset.orderId;
        if (!orderId || !currentUserId) return;
        btn.disabled = true;
        try {
          const { error } = await supabase.rpc("rpc_reopen_order", { p_order_id: orderId });
          if (error) {
            alert(error.message || "No se pudo modificar el pedido.");
            return;
          }
          await loadOrders(currentUserId);
          await showDashboardMessageModal({
            title: "Pedido listo para modificar",
            bodyHtml:
              '<p class="dash-app-message-modal__text">Podés agregar o quitar productos.</p>',
            confirmLabel: "Aceptar",
          });
        } catch (e) {
          alert(e?.message || "Error al reabrir el pedido.");
        } finally {
          btn.disabled = false;
        }
      };
    });

    ordersSection.querySelectorAll(".item-row__sizes-toggle").forEach((btn) => {
      btn.onclick = () => {
        const line = btn.closest(".item-row")?.querySelector(".item-row__sizes-line");
        if (!line) return;
        const row = btn.closest(".item-row");
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", expanded ? "false" : "true");
        btn.textContent = expanded ? "▸" : "▾";
        line.hidden = expanded;
        if (row) row.classList.toggle("is-expanded", !expanded);
      };
    });

    // Lista de productos del pedido: mostrar solo 4 y expandir/colapsar
    ordersSection.querySelectorAll(".dash-order__list--collapsible").forEach((listEl) => {
      const maxItems = parseInt(listEl.dataset.maxCollapsedItems || "4", 10);
      const itemRows = Array.from(listEl.querySelectorAll(".item-row--order"));
      if (itemRows.length <= maxItems) return;

      listEl.dataset.collapsed = "true";
      itemRows.forEach((row, index) => {
        if (index >= maxItems) {
          row.classList.add("is-hidden-collapsed");
        }
      });
    });

    ordersSection.querySelectorAll(".dash-order__list-toggle").forEach((toggleBtn) => {
      toggleBtn.addEventListener("click", () => {
        const orderCard = toggleBtn.closest(".dash-order");
        if (!orderCard) return;
        const listEl = orderCard.querySelector(".dash-order__list--collapsible");
        if (!listEl) return;
        const isCollapsed = listEl.dataset.collapsed !== "false";
        const itemRows = Array.from(listEl.querySelectorAll(".item-row--order"));

        if (isCollapsed) {
          listEl.dataset.collapsed = "false";
          itemRows.forEach((row) => row.classList.remove("is-hidden-collapsed"));
          toggleBtn.setAttribute("aria-expanded", "true");
          toggleBtn.textContent = "Ver menos ▴";
        } else {
          const maxItems = parseInt(listEl.dataset.maxCollapsedItems || "4", 10);
          listEl.dataset.collapsed = "true";
          itemRows.forEach((row, index) => {
            if (index >= maxItems) {
              row.classList.add("is-hidden-collapsed");
            }
          });
          toggleBtn.setAttribute("aria-expanded", "false");
          toggleBtn.textContent = "Ver todo el pedido ▾";
        }
      });
    });

    // Información al pulsar sobre el estado del producto (Reserva / Apartado)
    ordersSection.querySelectorAll(".item-row__status[data-status-info]").forEach((el) => {
      const infoText = el.getAttribute("data-status-info");
      if (!infoText) return;
      const actions = el.closest(".item-row__col-status") || el.closest(".order-item-actions");
      const tooltip = actions ? actions.querySelector(".item-row__status-tooltip") : null;
      if (!tooltip) return;
      let hideTimeout;

      const showInfo = (evt) => {
        if (evt) evt.preventDefault();
        tooltip.textContent = infoText;
        tooltip.classList.add("is-visible");
        tooltip.setAttribute("aria-hidden", "false");
        clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
          tooltip.classList.remove("is-visible");
          tooltip.setAttribute("aria-hidden", "true");
        }, 4000);
      };

      el.addEventListener("click", showInfo);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          showInfo(e);
        }
      });
    });

    // Menú ⋯ en ítems del pedido: abrir/cerrar popover
    ordersSection.querySelectorAll(".item-row__kebab").forEach((kebabBtn) => {
      kebabBtn.onclick = (e) => {
        e.stopPropagation();
        const wrap = kebabBtn.closest(".item-row__menu-wrap");
        const popover = wrap?.querySelector(".item-row__popover");
        if (!popover) return;
        const isOpen = popover.classList.contains("is-open");
        ordersSection.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
          p.classList.remove("is-open");
          p.setAttribute("aria-hidden", "true");
        });
        ordersSection.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
        if (!isOpen) {
          popover.classList.add("is-open");
          popover.setAttribute("aria-hidden", "false");
          kebabBtn.setAttribute("aria-expanded", "true");
        }
      };
    });
    if (!document.body.dataset.orderItemPopoverCloseBound) {
      document.body.dataset.orderItemPopoverCloseBound = "true";
      document.addEventListener("click", (e) => {
        if (e.target.closest(".item-row__menu-wrap") || e.target.closest(".item-row__popover")) return;
        document.querySelectorAll(".item-row__popover.is-open").forEach((p) => {
          p.classList.remove("is-open");
          p.setAttribute("aria-hidden", "true");
        });
        document.querySelectorAll(".item-row__kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
      });
    }

    ordersSection.querySelectorAll(".item-row__menuitem[data-action='remove-order-item']").forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        const orderCard = btn.closest(".dash-order");
        const isOrderClosed = orderCard?.dataset.orderClosed === "true";
        if (isOrderClosed) {
          const wrap = btn.closest(".item-row__menu-wrap");
          const popover = wrap?.querySelector(".item-row__popover");
          if (popover) {
            popover.classList.remove("is-open");
            popover.setAttribute("aria-hidden", "true");
            wrap?.querySelector(".item-row__kebab")?.setAttribute("aria-expanded", "false");
          }
          alert("Para quitar productos del pedido primero debes presionar \"Modificar pedido\".");
          return;
        }
        const idsStr = btn.dataset.orderItemIds || "";
        const ids = idsStr.split(",").map((id) => id.trim()).filter(Boolean);
        if (ids.length === 0) return;
        const wrap = btn.closest(".item-row__menu-wrap");
        const popover = wrap?.querySelector(".item-row__popover");
        if (popover) {
          popover.classList.remove("is-open");
          popover.setAttribute("aria-hidden", "true");
          wrap?.querySelector(".item-row__kebab")?.setAttribute("aria-expanded", "false");
        }
        // Obtener cantidades reales para permitir quitar unidades (no solo líneas)
        const { data: rows, error: rowsErr } = await supabase
          .from("order_items")
          .select("id, quantity, size")
          .in("id", ids);
        if (rowsErr || !rows || rows.length === 0) {
          console.error("No se pudieron cargar cantidades de order_items:", rowsErr);
          alert("No se pudo obtener la cantidad de este producto.");
          return;
        }

        // Elegir talle primero (si hay más de uno)
        const sizeCounts = new Map(); // size -> total units
        rows.forEach((r) => {
          const size = String(r?.size ?? "Unico").trim() || "Unico";
          const q = Math.max(0, Number(r?.quantity || 0) || 0);
          if (!sizeCounts.has(size)) sizeCounts.set(size, 0);
          sizeCounts.set(size, (sizeCounts.get(size) || 0) + q);
        });
        const sizes = Array.from(sizeCounts.entries())
          .map(([size, q]) => ({ size, q }))
          .filter((x) => x.q > 0);

        let chosenSize = sizes[0]?.size || "Unico";
        if (sizes.length > 1) {
          const pickedSize = await showDashboardOptionButtonsModal({
            title: "¿Qué talle desea quitar?",
            options: sizes.map((s) => ({
              value: s.size,
              label: s.size,
              sublabel: `${s.q} Uni`,
            })),
            confirmLabel: "Aceptar",
            cancelLabel: "Cancelar",
          });
          if (!pickedSize) return;
          chosenSize = String(pickedSize).trim() || chosenSize;
        }

        const rowsForSize = rows.filter((r) => String(r?.size ?? "Unico").trim() === chosenSize);
        const totalUnitsForSize = rowsForSize.reduce((sum, r) => sum + (Math.max(0, Number(r?.quantity || 0) || 0)), 0);
        const maxUnits = Math.max(1, totalUnitsForSize || 1);

        let unitsToRemove = 1;
        // El modal de cantidad SOLO aparece si ese talle tiene más de 1 unidad
        if (maxUnits > 1) {
          const pickedUnits = await showDashboardQuantitySelectModal({
            title: "¿Cuántas unidades querés quitar?",
            max: maxUnits,
            confirmLabel: "Aceptar",
            cancelLabel: "Cancelar",
          });
          if (!pickedUnits) return;
          unitsToRemove = Math.max(1, Math.min(maxUnits, Number(pickedUnits) | 0));
        }

        const secondConfirm = await showDashboardConfirmModal({
          title:
            unitsToRemove === 1
              ? "¿Quiere quitar 1 producto de su pedido?"
              : `¿Quiere quitar ${unitsToRemove} productos de su pedido?`,
          message: "",
          confirmLabel: "Quitar",
          cancelLabel: "Cancelar",
        });
        if (!secondConfirm) return;

        // Quitar unidades distribuyéndolas entre líneas (si una línea tiene quantity > 1, se cancela parcialmente).
        let remaining = unitsToRemove;
        for (const r of rowsForSize) {
          if (remaining <= 0) break;
          const rowQty = Math.max(0, Number(r.quantity || 0) || 0);
          if (!r.id || rowQty <= 0) continue;
          const cancelQty = Math.min(remaining, rowQty);

          const { error: rpcErr } = await supabase.rpc("rpc_cancel_order_item_units", {
            p_item_id: r.id,
            p_units: cancelQty,
          });
          if (rpcErr) {
            console.error("Error quitando unidades del pedido:", rpcErr);
            alert(rpcErr.message || "No se pudo quitar el producto del pedido.");
            return;
          }

          remaining -= cancelQty;
        }

        if (currentUserId) await loadOrders(currentUserId);
      };
    });

    // Menú ⋯ del encabezado de la tarjeta (Pedido abierto | 12 días): abrir/cerrar y opción Cancelar pedido
    ordersSection.querySelectorAll(".dash-order-header-menu-wrap .dash-order-header-kebab").forEach((kebabBtn) => {
      kebabBtn.onclick = (e) => {
        e.stopPropagation();
        const wrap = kebabBtn.closest(".dash-order-header-menu-wrap");
        const popover = wrap?.querySelector(".dash-order-header-popover");
        if (!popover) return;
        const isOpen = popover.classList.contains("is-open");
        document.querySelectorAll(".dash-order-header-popover.is-open").forEach((p) => {
          p.classList.remove("is-open");
          p.setAttribute("aria-hidden", "true");
        });
        document.querySelectorAll(".dash-order-header-menu-wrap .dash-order-header-kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
        if (!isOpen) {
          popover.classList.add("is-open");
          popover.setAttribute("aria-hidden", "false");
          kebabBtn.setAttribute("aria-expanded", "true");
        }
      };
    });
    if (!document.body.dataset.orderHeaderPopoverCloseBound) {
      document.body.dataset.orderHeaderPopoverCloseBound = "true";
      document.addEventListener("click", (e) => {
        if (e.target.closest(".dash-order-header-menu-wrap") || e.target.closest(".dash-order-header-popover")) return;
        document.querySelectorAll(".dash-order-header-popover.is-open").forEach((p) => {
          p.classList.remove("is-open");
          p.setAttribute("aria-hidden", "true");
        });
        document.querySelectorAll(".dash-order-header-kebab[aria-expanded='true']").forEach((k) => k.setAttribute("aria-expanded", "false"));
      });
    }

    // Nuevo: cancelar pedido completo
    document.querySelectorAll("[data-cancel-entire-order]").forEach((btn) => {
      btn.onclick = async () => {
        const orderId = btn.dataset.cancelEntireOrder;
        if (!orderId) return;
        const popover = btn.closest(".dash-order-header-popover");
        if (popover) {
          popover.classList.remove("is-open");
          popover.setAttribute("aria-hidden", "true");
          popover.closest(".dash-order-header-menu-wrap")?.querySelector(".dash-order-header-kebab")?.setAttribute("aria-expanded", "false");
        }
        await cancelEntireOrder(orderId);
      };
    });

    // Pedido cerrado: menú ⋯ -> Modificar pedido (misma acción que el botón)
    document.querySelectorAll("[data-modify-order]").forEach((btn) => {
      btn.onclick = async () => {
        const orderId = btn.dataset.modifyOrder;
        if (!orderId) return;
        const popover = btn.closest(".dash-order-header-popover");
        if (popover) {
          popover.classList.remove("is-open");
          popover.setAttribute("aria-hidden", "true");
          popover
            .closest(".dash-order-header-menu-wrap")
            ?.querySelector(".dash-order-header-kebab")
            ?.setAttribute("aria-expanded", "false");
        }
        const card = document.querySelector(`.dash-order[data-order-id="${CSS.escape(orderId)}"]`);
        const modifyBtn = card?.querySelector(`.dash-order-modify-link[data-order-id="${CSS.escape(orderId)}"]`);
        if (modifyBtn) {
          modifyBtn.click();
          return;
        }
      };
    });
    
    // Configurar botones de cancelar producto
    document.querySelectorAll(".btn-cancel-item").forEach((btn) => {
      btn.onclick = async () => {
        const itemId = btn.dataset.itemId;
        const productName = btn.dataset.productName || "este producto";
        if (!itemId) return;

        const picked = !!btn
          .closest(".order-item-product")
          ?.querySelector(".item-status-picked");
        const detail = picked
          ? "Este producto ya fue apartado por el administrador; se le enviará una notificación."
          : "Este producto está en proceso de reserva y no afectará al administrador.";

        const confirmed = await showDashboardConfirmModal({
          title: `¿Cancelar "${productName}"?`,
          message: detail,
          confirmLabel: "Sí, cancelar",
          cancelLabel: "No",
        });

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
          alert("No se pudo obtener la informaciÃ³n del producto faltante.");
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
    console.warn("âš ï¸ Error cargando pedidos:", error.message);
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
    console.error("âŒ No se encontrÃ³ el contenedor del modal");
    return;
  }

  if (!userId) {
    console.error("âŒ userId no proporcionado");
    historyContainer.innerHTML = `
      <p style="text-align: center; color: #dc3545; padding: 40px;">Error: No se pudo identificar al usuario.</p>
    `;
    return;
  }

  try {
    console.log("ðŸ“‹ Buscando pedidos cerrados/enviados para usuario:", userId);
    
    // Primero, verificar todos los pedidos del usuario para depuraciÃ³n
    const { data: allOrders, error: allOrdersError } = await supabase
      .from("orders")
      .select("id, order_number, status, customer_id")
      .eq("customer_id", userId);
    
    if (allOrdersError) {
      console.error("âŒ Error obteniendo todos los pedidos:", allOrdersError);
    } else if (allOrders) {
      console.log("ðŸ“‹ Todos los pedidos del usuario:", allOrders.length, "pedidos encontrados");
      allOrders.forEach(o => {
        console.log(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}", customer_id="${o.customer_id}"`);
      });
      
      // Verificar cuÃ¡ntos pedidos tienen estado sent (solo estos aparecen en Pedidos Anteriores)
      const sentOrders = allOrders.filter(o => {
        const status = (o.status || "").toLowerCase().trim();
        return status === "sent";
      });
      console.log(`ðŸ“‹ Pedidos con estado "sent" (Pedidos Anteriores):`, sentOrders.length);
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
        console.log(`ðŸ“‹ Pedidos con otros estados:`, otherStatuses.length);
        otherStatuses.forEach(o => {
          console.log(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}"`);
        });
      }
      } else {
      console.log("âš ï¸ No se encontraron pedidos para el usuario");
    }
    
    // Intentar obtener pedidos cerrados/enviados
    // Primero intentar con consultas separadas que son mÃ¡s confiables
    console.log("ðŸ“‹ Intentando consultas separadas para closed y sent...");
    
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
      console.error("âŒ Error obteniendo pedidos enviados:", sentError);
    } else {
      console.log("ðŸ“‹ Pedidos enviados encontrados:", sentOrders?.length || 0);
    }
    
    const finalOrders = sentOrders || [];
    const error = sentError || null;

    if (error) {
      console.error("âŒ Error cargando pedidos anteriores:", error);
      console.error("âŒ Detalles del error:", JSON.stringify(error, null, 2));
      
      historyContainer.innerHTML = `
        <div class="order-item" style="border:1px solid #f5c6cb; background:#f8d7da; padding:16px; border-radius:8px;">
          <p style="color:#721c24; margin:0;">Error cargando pedidos anteriores: ${error.message}</p>
          <p style="color:#721c24; margin:4px 0 0 0; font-size:12px;">Por favor, revisa la consola para mÃ¡s detalles.</p>
        </div>
      `;
      return;
    }

    console.log("ðŸ“‹ Total de pedidos enviados (sent):", finalOrders.length);
    if (finalOrders && finalOrders.length > 0) {
      finalOrders.forEach(o => {
        console.log(`  - Pedido ${o.order_number || o.id.substring(0, 8)}: estado="${o.status}", items=${o.order_items?.length || 0}`);
      });
    }
    
    if (!finalOrders || finalOrders.length === 0) {
      console.log("â„¹ï¸ No se encontraron pedidos enviados (estado 'sent')");
      console.log("ℹ️ Nota: Los pedidos 'closed' aparecen en 'Mis Pedidos' con aviso 'En preparación'");
      
      historyContainer.innerHTML = `
        <p style="text-align: center; color: #666; padding: 40px;">No tienes pedidos anteriores. Los pedidos en preparación aparecen en "Mis Pedidos".</p>
      `;
      return;
    }

    console.log("âœ… Mostrando", finalOrders.length, "pedidos anteriores");
    
    // Ordenar pedidos por fecha mÃ¡s reciente primero
    const sortedOrders = [...finalOrders].sort((a, b) => {
      const dateA = new Date(a.updated_at || a.created_at);
      const dateB = new Date(b.updated_at || b.created_at);
      return dateB - dateA; // MÃ¡s reciente primero
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
              <span class="order-date">${formattedDate} <span class="order-expand-icon">â–¼</span></span>
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
    console.warn("âš ï¸ Error cargando pedidos anteriores:", error.message);
    historyContainer.innerHTML = `
      <p style="text-align: center; color: #dc3545; padding: 40px;">Error cargando pedidos anteriores.</p>
    `;
  }
}

function showNoSession() {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (!dashboardContent) return;
    setupCartActions();
    const cartInfo = document.getElementById("cart-info");
    const cartFooter = document.getElementById("cart-footer");
    const ordersSection = document.getElementById("orders-section");
    const activeOrderChips = document.getElementById("active-order-chips");
    const activeOrderActions = document.getElementById("active-order-actions");
    const userName = document.getElementById("user-name");
    const userEmail = document.getElementById("user-email");
    const userAvatar = document.getElementById("user-avatar");

    if (userName) {
      userName.textContent = "Invitada";
    }
    const userNameSheet = document.getElementById("user-name-sheet");
    if (userNameSheet) {
      userNameSheet.textContent = "Invitada";
    }
    if (userEmail) {
      userEmail.textContent = "";
    }
    if (userAvatar) {
      userAvatar.src = GUEST_AVATAR_ICON;
      userAvatar.alt = "Perfil";
    }

    if (cartInfo) {
      let guestItems = [];
      try {
        const raw = localStorage.getItem("fyl_cart");
        const parsed = raw ? JSON.parse(raw) : [];
        guestItems = normalizeGuestCartStorageItems(
          Array.isArray(parsed) ? parsed : []
        );
        localStorage.setItem("fyl_cart", JSON.stringify(guestItems));
      } catch (_error) {
        guestItems = [];
      }

      const normalizedGuestItems = guestItems.filter(
        (item) => (Number(item?.cantidad) || 0) > 0
      );

      if (normalizedGuestItems.length === 0) {
        cartInfo.innerHTML = `
          <p class="empty-cart">
            Todavía no agregaste productos
            <br><span class="subtext">Explorá el catálogo y armá tu pedido</span>
          </p>
          <a href="../index.html" class="btn" style="margin:12px auto 0; display:block; width:fit-content;">Explorar catálogo</a>
        `;
      } else {
        const totalUnits = normalizedGuestItems.reduce((sum, item) => sum + (Number(item.cantidad) || 0), 0);
        const totalPrice = normalizedGuestItems.reduce((sum, item) => {
          const qty = Number(item.cantidad) || 0;
          const price = Number(item.precio) || 0;
          return sum + qty * price;
        }, 0);

        const itemsHtml = normalizedGuestItems
          .map((item, idx) => {
            const lineTotal = (Number(item.cantidad) || 0) * (Number(item.precio) || 0);
            return `
              <div class="dash-bolsa-item">
                <div class="dash-bolsa-item__row1">
                  <img src="${item.imagen}" alt="${item.articulo}" class="dash-bolsa-item__thumb" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}';">
                  <div class="dash-bolsa-item__main">
                    <div class="dash-bolsa-item__head">
                      <div class="dash-bolsa-item__line1">
                        <span class="dash-bolsa-item__title">${item.articulo} · ${abbreviateColorLabel(item.color || "Color único")} · ${item.talle}</span>
                      </div>
                      <div class="dash-bolsa-item__right order-item-actions">
                        <span class="dash-bolsa-item__price item-row__price-total">$${lineTotal.toLocaleString("es-AR")}</span>
                        <div class="item-row__menu-wrap">
                          <button type="button" class="item-row__kebab" aria-label="Opciones" aria-haspopup="true" aria-expanded="false">⋯</button>
                          <div class="item-row__popover" role="menu" aria-hidden="true">
                            <button type="button" class="item-row__menuitem item-row__menuitem--danger" data-action="remove-bag-item" data-id="${idx}">Quitar de la bolsa</button>
                            <a href="${buildCatalogHrefFromVariantOrName(item.variant_id || item.variantInfo?.id, item.articulo)}" class="item-row__menuitem" data-action="view-product">Ver producto</a>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="dash-bolsa-item__line2">
                      <select class="cart-qty-select dash-bolsa-item__qty-select" data-id="${idx}">
                        ${[0,1,2,3,4].map((n) => `<option value="${n}" ${n === Number(item.cantidad || 0) ? "selected" : ""}>${n === 0 ? "0" : `${n} uni`}</option>`).join("")}
                        ${(Number(item.cantidad || 0) > 4) ? `<option value="${Number(item.cantidad)}" selected>${Number(item.cantidad)} uni</option>` : ""}
                      </select>
                      <span class="dash-bolsa-item__unit-price">· $${(Number(item.precio) || 0).toLocaleString("es-AR")} c/u</span>
                    </div>
                  </div>
                </div>
              </div>
            `;
          })
          .join("");

        cartInfo.innerHTML = `
          <p class="dash-bolsa-hint">Enviá el pedido para reservarlos.</p>
          <div class="cart-items-list dash-bolsa-list">
            ${itemsHtml}
          </div>
        `;
        const cartProductsCount = document.getElementById("cart-products-count");
        if (cartProductsCount) {
          cartProductsCount.textContent = `${totalUnits} ${totalUnits === 1 ? "producto" : "productos"} en el carrito`;
        }
        const cartTotalValue = document.getElementById("cart-total-value");
        if (cartTotalValue) {
          cartTotalValue.textContent = `$${totalPrice.toLocaleString("es-AR")}`;
        }
        const submitBtn = document.getElementById("submit-cart-btn");
        if (submitBtn) submitBtn.textContent = "Hacer pedido";
        if (cartFooter) {
          cartFooter.style.display = "block";
        }
        attachGuestCartHandlers();
        attachBolsaPopoverCloseOnOutsideClick();
      }
    }
    if (cartFooter && !cartInfo?.querySelector(".dash-bolsa-item")) {
      cartFooter.style.display = "none";
    }
    currentCartId = null;
    currentCartItems = [];

    if (activeOrderChips) {
      activeOrderChips.innerHTML = "";
    }
    if (activeOrderActions) {
      activeOrderActions.style.display = "none";
      activeOrderActions.innerHTML = "";
    }
    if (ordersSection) {
      ordersSection.innerHTML = `
        <div class="order-item" style="border:1px solid #e0e0e0; padding:16px; border-radius:8px; background:#fafafa;">
          <div class="section-title dash-title" style="margin-bottom:12px;">📦 Mi pedido</div>
          <div style="border:1px solid #f5c6cb; background:#f8d7da; padding:16px; border-radius:8px;">
            <div style="display:flex; align-items:center; gap:10px; color:#721c24;">
              <span style="font-size:18px;">🔒</span>
              <div>
                <strong>No hay sesión activa</strong>
                <p style="margin:5px 0 0 0; font-size:14px;">
                  <a href="./login.html?return=dashboard" style="color:#CD844D; text-decoration:underline;">Inicia sesión</a> para acceder a tu área personal.
                </p>
              </div>
            </div>
          </div>
        </div>
      `;
    }
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

/** Primer nombre para el saludo corto del header: "Cuenta de [nombre]" */
function getFirstNameForGreeting(displayName) {
  const s = String(displayName || "").trim();
  if (!s) return "Usuario";
  return s.split(/\s+/)[0] || "Usuario";
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

        const customerProfile = await fetchCustomerProfileRow();

        if (userName) {
          const displayName =
            customerProfile?.full_name ||
            user.user_metadata?.full_name ||
            user.email?.split("@")[0] ||
            "Usuario";
          const greeting = getFirstNameForGreeting(displayName);
          userName.textContent = greeting;
          const userNameSheet = document.getElementById("user-name-sheet");
          if (userNameSheet) {
            userNameSheet.textContent = greeting;
          }
        }
        if (userEmail) {
          userEmail.textContent = customerProfile?.email || user.email;
        }
        if (userAvatar) {
          const displayName =
            customerProfile?.full_name ||
            user.user_metadata?.full_name ||
            user.email?.split("@")[0] ||
            "Usuario";
          const avatarUrl =
            customerProfile?.avatar_url ||
            user.user_metadata?.avatar_url ||
            user.user_metadata?.picture;
          setUserAvatarWithFallback(userAvatar, displayName, avatarUrl);
          userAvatar.dataset.identitySet = "true";
        }

        setupCartActions();

        await loadCart(user.id);
        await loadOrders(user.id);
        
        // Asegurar que los controles del historial estÃ©n configurados
        // Esto es necesario incluso si no hay pedidos para que el botÃ³n funcione
        setupHistoryControls();

        // Deep-link: abrir historial solo DESPUÉS de auth (cuando currentUserId ya existe)
        try {
          const url = new URL(window.location.href);
          if (url.searchParams.get("view") === "history") {
            setTimeout(() => {
              try {
                openPreviousOrdersModal();
              } catch (_) {
                /* ignore */
              }
            }, 0);
          }
        } catch (_) {
          /* ignore */
        }

        if (!cartSyncedListenerRegistered) {
          window.addEventListener("cart:synced", () => loadCart(user.id));
          cartSyncedListenerRegistered = true;
        }

        // Configurar suscripciÃ³n en tiempo real para pedidos
        setupOrdersRealtimeSubscription(user.id);

        setContentVisibility(true);
        hideLoader();
        if (typeof window.runDashboardOnboardingIfNeeded === "function") {
          window.runDashboardOnboardingIfNeeded();
        }
      },
      async () => {
        showNoSession();
        setContentVisibility(true);
        hideLoader();
      }
    );
  } catch (error) {
    console.warn("âš ï¸ Error cargando datos del dashboard:", error.message);
    showError("Error de conexión");
    setContentVisibility(true);
    hideLoader();
  }
}

function initDashboard() {
  // Mantener el layout moderno definido en dashboard.html.
  // El template legacy de showContent() no debe sobrescribir el DOM.
  setContentVisibility(false);
  setupAccountSheetControls();
  loadData();
}

// FunciÃ³n para configurar suscripciÃ³n en tiempo real para pedidos
async function setupOrdersRealtimeSubscription(userId) {
  if (!supabase || !userId) return;
  
  // Cancelar suscripciÃ³n anterior si existe
  if (ordersRealtimeSubscription) {
    try {
      await supabase.removeChannel(ordersRealtimeSubscription);
      ordersRealtimeSubscription = null;
    } catch (error) {
      console.warn("âš ï¸ Error eliminando suscripciÃ³n anterior:", error);
    }
  }
  
  // Suscribirse a cambios en orders del cliente
  // Nota: Supabase Realtime solo permite filtros simples, asÃ­ que nos suscribimos a todos los cambios
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
          console.log("ðŸ”„ Cambio en pedidos detectado:", payload.eventType);
          if (currentUserId) {
            await loadOrders(currentUserId);
            // Si el modal estÃ¡ abierto, recargar pedidos anteriores tambiÃ©n
            const modal = document.getElementById("previous-orders-modal");
            if (modal && modal.classList.contains("active")) {
              await loadClosedOrders(currentUserId);
            }
          }
        } else if (payload.old && payload.old.customer_id === userId) {
          // Para DELETE, payload.old contiene los datos antiguos
          console.log("ðŸ”„ EliminaciÃ³n de pedido detectada:", payload.eventType);
          if (currentUserId) {
            await loadOrders(currentUserId);
            // Si el modal estÃ¡ abierto, recargar pedidos anteriores tambiÃ©n
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
          // Verificar rÃ¡pidamente si el pedido pertenece al usuario
          const { data: order } = await supabase
            .from("orders")
            .select("customer_id")
            .eq("id", orderId)
            .maybeSingle();
          
          if (order && order.customer_id === userId) {
            console.log("ðŸ”„ Cambio en items de pedido detectado:", payload.eventType);
            if (currentUserId) {
              await loadOrders(currentUserId);
              // Si el modal estÃ¡ abierto, recargar pedidos anteriores tambiÃ©n
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
        console.log("âœ… SuscripciÃ³n en tiempo real de pedidos activa");
      } else if (status === "CHANNEL_ERROR") {
        console.error("âŒ Error en suscripciÃ³n en tiempo real de pedidos");
      } else if (status === "TIMED_OUT") {
        console.warn("âš ï¸ SuscripciÃ³n en tiempo real expirÃ³, reintentando...");
        // Reintentar despuÃ©s de un delay
        setTimeout(() => {
          if (currentUserId) {
            setupOrdersRealtimeSubscription(currentUserId);
          }
        }, 2000);
      }
    });
}

// FunciÃ³n para mostrar alternativas cuando un producto estÃ¡ marcado como faltante
async function mostrarAlternativasParaProductoFaltante({ articulo, color, talle, itemId }) {
  try {
    if (!window.buscarProductosAlternativos || !window.mostrarModalAlternativas) {
      alert(
        `Este producto no estÃ¡ disponible en el talle ${talle}. Por favor selecciona otro talle o producto.`
      );
      return;
    }

    // Intentar obtener los tags del producto original desde el catÃ¡logo
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
      console.warn("âš ï¸ No se pudieron obtener los tags del producto:", error);
    }

    const mensaje = `El producto "${articulo}" no estÃ¡ disponible en el talle ${talle} (faltante). Â¿QuerÃ©s ver alternativas similares en talle ${talle}?`;

    // Crear un modal inicial con dos opciones
    const confirmacion = await new Promise((resolve) => {
      const modalInicial = document.createElement("div");
      modalInicial.className = "alternativas-modal active";
      modalInicial.innerHTML = `
        <div class="alternativas-modal-content" style="max-width: 500px;">
          <div class="alternativas-modal-header">
            <h2>âš ï¸ Producto Faltante</h2>
            <button class="alternativas-modal-close" onclick="window.__verAlternativasFaltanteResolve(false)">Ã—</button>
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
            // Si tenemos el itemId faltante, cancelarlo automÃ¡ticamente
            if (itemId) {
              try {
                const { error: cancelError } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: itemId });
                if (cancelError) {
                  console.warn("âš ï¸ No se pudo cancelar el item faltante:", cancelError.message || cancelError);
                }
              } catch (e) {
                console.warn("âš ï¸ Error cancelando item faltante:", e?.message || e);
              }
            }
            
            alert(`âœ… ${productoSeleccionado.articulo} agregado al carrito`);
            // Recargar el carrito y pedidos para reflejar cambios
            if (currentUserId) {
              await loadCart(currentUserId);
              await loadOrders(currentUserId);
            }
          } else {
            alert(`No se pudo agregar ${productoSeleccionado.articulo} al carrito.`);
          }
        } else {
          alert("No se pudo agregar el producto al carrito. Por favor, recarga la pÃ¡gina.");
        }
      },
      onCerrar: () => {
        console.log("Modal de alternativas cerrado");
      },
    });
  } catch (error) {
    console.error("âŒ Error mostrando alternativas para producto faltante:", error);
    alert(
      `No se pudieron cargar alternativas para el producto. Por favor intenta de nuevo.`
    );
  }
}

// Limpiar suscripciÃ³n cuando se cierra la pÃ¡gina
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
    const confirmed = await showDashboardConfirmModal({
      title: "¿Seguro que querés cancelar todo el pedido?",
      bodyHtml: `<ul class="dash-confirm-bullets">
        <li>Los productos ya apartados notificarán al administrador y el pedido quedará como <strong>Cerrado</strong>.</li>
        <li>Los productos que aún no fueron apartados se cancelarán sin notificar y, si no había nada apartado, el pedido se eliminará.</li>
      </ul>`,
      confirmLabel: "Sí, cancelar",
      cancelLabel: "No",
    });
    if (!confirmed) return;

    // Obtener items del pedido
    const { data: items, error } = await supabase
      .from("order_items")
      .select("id, status")
      .eq("order_id", orderId);

    if (error) {
      alert("No se pudieron obtener los productos del pedido.");
      console.error("âŒ Error listando items:", error);
      return;
    }

    if (!items || items.length === 0) {
      // Si ya no tiene items, eliminar el pedido
      await supabase.from("orders").delete().eq("id", orderId);
      await loadOrders(currentUserId);
      return;
    }

    let hadPicked = false;

    // Cancelar cada item usando la misma lÃ³gica de cancelaciÃ³n
    for (const it of items) {
      // Reusar cancelOrderItem para cada Ã­tem
      // Pero sin confirmaciÃ³n individual
      try {
        if ((it.status || '').toLowerCase() === 'missing') {
          // Forzar eliminaciÃ³n directa (ramas de missing ya manejan total/update)
          await cancelOrderItem(it.id);
        } else {
          const { data: res, error: rpcErr } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: it.id });
          if (rpcErr) {
            console.warn("âš ï¸ No se pudo cancelar item:", it.id, rpcErr.message);
          } else if (res?.was_picked) {
            hadPicked = true;
          }
        }
      } catch (e) {
        console.warn("âš ï¸ Error cancelando item:", it.id, e?.message || e);
      }
    }

    // Si hubo algÃºn 'picked', dejar el pedido como 'closed' (visible para admin)
    if (hadPicked) {
      await supabase.from("orders").update({ status: "closed", updated_at: new Date().toISOString() }).eq("id", orderId);
      await loadOrders(currentUserId);
      return;
    }

    // Si no hubo 'picked', verificar si quedÃ³ vacÃ­o y eliminar pedido entero
    const { count } = await supabase
      .from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId);

    if ((Number(count) || 0) === 0) {
      await supabase.from("orders").delete().eq("id", orderId);
    } else {
      // AÃºn hay items cancelados, borrar tambiÃ©n los cancelados y eliminar pedido
      await supabase.from("order_items").delete().eq("order_id", orderId);
      await supabase.from("orders").delete().eq("id", orderId);
    }

    await loadOrders(currentUserId);
  } catch (e) {
    console.error("âŒ Error cancelando pedido completo:", e);
    alert("No se pudo cancelar el pedido.");
  }
}

