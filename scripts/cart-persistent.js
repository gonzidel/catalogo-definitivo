import { supabase } from "./supabase-client.js";
import { normalizeSize } from "./utils/size-normalizer.js";

let cartItems = [];
let cartCount = 0;
let isInitialized = false;
let isDedupingSupabase = false;
let isSyncing = false;
let authListenerAttached = false;
let loadCartFromSupabaseInFlight = null;

async function ensureCustomerRecord(user) {
  try {
    console.log("🔍 Verificando/vinculando cliente para:", user.email);
    
    // Usar la función RPC que busca coincidencias y vincula automáticamente
    const email = user.email || null;
    const phone = user.user_metadata?.phone || null;
    const fullName = user.user_metadata?.full_name || user.user_metadata?.name || null;
    const dni = user.user_metadata?.dni || null;
    
    const { data: result, error } = await supabase.rpc('rpc_link_or_create_customer', {
      p_user_id: user.id,
      p_email: email,
      p_phone: phone,
      p_full_name: fullName,
      p_dni: dni
    });

    if (error) {
      console.error("❌ Error en rpc_link_or_create_customer:", error);
      console.error("❌ Detalles:", error.message, error.details, error.hint);
      return false;
    }

    if (!result) {
      console.error("❌ No se recibió respuesta de rpc_link_or_create_customer");
      return false;
    }

    console.log("✅ Resultado de vinculación/creación:", result);
    
    if (result.action === 'linked') {
      console.log(`✅ Cliente vinculado exitosamente por ${result.match_type}:`, result.customer_id);
      if (result.match_type) {
        console.log(`🔗 Se encontró coincidencia por ${result.match_type} y se vinculó el cliente`);
      }
    } else if (result.action === 'created') {
      console.log("🆕 Nuevo cliente creado:", result.customer_id);
    } else if (result.action === 'already_linked') {
      console.log("ℹ️ Cliente ya estaba vinculado:", result.customer_id);
    }

    return true;

  } catch (err) {
    console.error("❌ Error verificando/creando customers:", err);
    return false;
  }
}

async function getOrCreateOpenCart(user) {
  const { data: existingCart, error: cartError } = await supabase
    .from("carts")
    .select("id, created_at")
    .eq("customer_id", user.id)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cartError) {
    console.error("❌ Error consultando carrito:", cartError);
    return null;
  }

  if (existingCart) {
    return existingCart.id;
  }

  const { data: newCart, error: newCartError } = await supabase
    .from("carts")
    .insert({
      customer_id: user.id,
      status: "open",
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (newCartError) {
    console.error("❌ Error creando carrito:", newCartError);
    return null;
  }

  return newCart.id;
}

async function fetchPrimaryImage(articulo, color) {
  try {
    const { data, error } = await supabase
      .from("catalog_public_view")
      .select(`"Imagen Principal","Imagen 1","Imagen 2"`)
      .eq("Articulo", articulo)
      .eq("Color", color)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("⚠️ No se pudo resolver imagen de catálogo:", error.message);
      return null;
    }

    if (data) {
      return (
        data["Imagen Principal"] ||
        data["Imagen 1"] ||
        data["Imagen 2"] ||
        null
      );
    }
  } catch (err) {
    console.warn("⚠️ Error obteniendo imagen de catálogo:", err.message);
  }
  return null;
}

/** Obtener stock real desde variant_sizes y variant_size_warehouse_stock (NO desde product_variants) */
async function fetchVariantInfo(articulo, color, talle, variantId = null) {
  try {
    const normalizedArticulo = articulo?.trim();
    const normalizedColor = (color || "Único")?.trim();
    const normalizedSize = normalizeSize(talle) || (talle || "").trim();

    if (!normalizedArticulo || !normalizedColor || !normalizedSize) {
      return null;
    }

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
    } else {
      const { data: product, error: prodErr } = await supabase
        .from("products")
        .select("id")
        .ilike("name", normalizedArticulo)
        .maybeSingle();
      if (prodErr || !product) return null;

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

    // Stock desde variant_sizes (tabla principal de talles)
    const { data: sizeData, error: sizeErr } = await supabase
      .from("variant_sizes")
      .select("variant_id, size, stock_qty")
      .eq("variant_id", vid);
    if (sizeErr) return null;

    const sizeRow = (sizeData || []).find((r) => normalizeSize(r.size) === normalizedSize);
    let sizeStockQty = sizeRow ? (sizeRow.stock_qty || 0) : 0;

    // Fallback/enriquecimiento desde variant_size_warehouse_stock (general + venta-publico)
    const { data: whs } = await supabase.from("warehouses").select("id, code").in("code", ["general", "venta-publico"]);
    const whMap = new Map((whs || []).map((w) => [w.code, w.id]));
    const generalId = whMap.get("general");
    const ventaId = whMap.get("venta-publico");

    let stockTotal = 0;
    if (generalId && ventaId) {
      const { data: sws } = await supabase
        .from("variant_size_warehouse_stock")
        .select("size, warehouse_id, stock_qty")
        .eq("variant_id", vid)
        .in("warehouse_id", [generalId, ventaId]);
      (sws || []).forEach((s) => {
        if (normalizeSize(s.size) === normalizedSize) stockTotal += s.stock_qty || 0;
      });
    }
    if (stockTotal === 0 && sizeStockQty > 0) stockTotal = sizeStockQty;
    const available = Math.max(0, stockTotal - reserved);

    return {
      id: vid,
      stock: stockTotal,
      reserved,
      available,
      price,
      color: normalizedColor,
      size: normalizedSize,
    };
  } catch (error) {
    console.error("❌ Error obteniendo información de variante:", error);
    return null;
  }
}

/** Clave estable misma línea (evita duplicar al fusionar local + Supabase por espacios/casing menor) */
function buildCartLineKey(item = {}) {
  const art = String(item.articulo ?? item.product_name ?? "").trim();
  const col = String(item.color ?? "").trim();
  const rawTalle = item.talle ?? item.size ?? "";
  const sizeKey = normalizeSize(rawTalle) || String(rawTalle).trim();
  return [art, col, sizeKey].join("__");
}

function normalizeCartItems(items = []) {
  const map = new Map();
  items.forEach((item) => {
    const rawTalle = item.talle ?? item.size ?? "";
    const sizeKey = normalizeSize(rawTalle) || String(rawTalle).trim();
    const key = buildCartLineKey(item);
    const cantidad =
      Number(item.cantidad ?? item.quantity ?? item.qty ?? 0) || 0;
    const precio = Number(item.precio ?? item.price_snapshot ?? 0) || 0;
    if (!map.has(key)) {
      map.set(key, {
        ...item,
        talle: sizeKey || item.talle || item.size,
        cantidad: cantidad,
        precio,
        supabaseIds: item.id ? [item.id] : [],
        variant_id: item.variant_id ?? item.variantId ?? null,
      });
    } else {
      const existing = map.get(key);
      existing.cantidad += cantidad;
      if (!existing.imagen && item.imagen) existing.imagen = item.imagen;
      if (!existing.descripcion && item.descripcion)
        existing.descripcion = item.descripcion;
      existing.precio = precio || existing.precio || 0;
      if (item.id) {
        if (!existing.supabaseIds) existing.supabaseIds = [];
        if (!existing.supabaseIds.includes(item.id)) {
          existing.supabaseIds.push(item.id);
        }
        existing.id = item.id;
      }
      if (!existing.variant_id && (item.variant_id || item.variantId)) {
        existing.variant_id = item.variant_id ?? item.variantId ?? null;
      }
    }
  });
  return Array.from(map.values());
}

function getCartItemKey(item = {}) {
  return buildCartLineKey(item);
}

/** Actualiza carrito en memoria al instante (UI sticky) antes de persistir en Supabase */
function applyOptimisticCartAdd(productData, variantInfo) {
  const articulo = productData.articulo;
  const color = productData.color || "Único";
  const rawTalle = productData.talle ?? productData.size ?? "Único";
  const sizeKey = normalizeSize(rawTalle) || String(rawTalle).trim();
  const qty = Number(productData.cantidad || 1) || 1;
  const price = Number(productData.precio || 0) || 0;
  const priceToUse =
    price > 0 ? price : Number(variantInfo?.price || 0) || 0;
  const incomingKey = getCartItemKey({ articulo, color, talle: sizeKey });

  const existingItem = cartItems.find(
    (item) => getCartItemKey(item) === incomingKey
  );
  if (existingItem) {
    existingItem.cantidad =
      (Number(existingItem.cantidad) || 0) + qty;
    if (!existingItem.variant_id && variantInfo?.id) {
      existingItem.variant_id = variantInfo.id;
    }
    if (priceToUse > 0) existingItem.precio = priceToUse;
    if (productData.imagen && !existingItem.imagen) {
      existingItem.imagen = productData.imagen;
    }
  } else {
    cartItems.push({
      id: Date.now(),
      articulo,
      color,
      talle: sizeKey,
      cantidad: qty,
      precio: priceToUse,
      imagen: productData.imagen,
      descripcion: productData.descripcion,
      variant_id: productData.variant_id || variantInfo?.id || null,
    });
  }
  cartItems = normalizeCartItems(cartItems);
}

function mergeCartItemsWithoutDoubleCount(remoteItems = [], localItems = []) {
  const mergedMap = new Map();

  const upsert = (item, source) => {
    const key = getCartItemKey(item);
    const qty = Number(item.cantidad ?? item.quantity ?? item.qty ?? 0) || 0;
    if (qty <= 0) return;

    if (!mergedMap.has(key)) {
      mergedMap.set(key, {
        ...item,
        cantidad: qty,
        _source: source,
      });
      return;
    }

    const existing = mergedMap.get(key);
    const existingQty =
      Number(existing.cantidad ?? existing.quantity ?? existing.qty ?? 0) || 0;

    // Critical for login merge: same SKU in local+remote must not be summed.
    // Keep the larger quantity to avoid 1->2->4 inflation on repeated merges.
    if (qty > existingQty) {
      mergedMap.set(key, {
        ...existing,
        ...item,
        cantidad: qty,
        _source: source,
      });
      return;
    }

    // Keep useful metadata without changing qty.
    if (!existing.imagen && item.imagen) existing.imagen = item.imagen;
    if (!existing.descripcion && item.descripcion)
      existing.descripcion = item.descripcion;
    if (!existing.variant_id && (item.variant_id || item.variantId)) {
      existing.variant_id = item.variant_id ?? item.variantId ?? null;
    }
    if (!existing.id && item.id) existing.id = item.id;
  };

  remoteItems.forEach((item) => upsert(item, "remote"));
  localItems.forEach((item) => upsert(item, "local"));

  return Array.from(mergedMap.values()).map(({ _source, ...item }) => item);
}

function loadCartFromStorage() {
  try {
    const savedCart = localStorage.getItem("fyl_cart");
    if (savedCart) {
      cartItems = normalizeCartItems(JSON.parse(savedCart));
      updateCartCount();
      console.log(
        "🛒 Carrito cargado desde localStorage:",
        cartItems.length,
        "items"
      );
    }
  } catch (error) {
    console.error("❌ Error cargando carrito:", error);
    cartItems = [];
  }
}

function saveCartToStorage() {
  try {
    cartItems = normalizeCartItems(cartItems);
    localStorage.setItem("fyl_cart", JSON.stringify(cartItems));
    // Solo loguear ocasionalmente para evitar spam
    // console.log("💾 Carrito guardado en localStorage");
  } catch (error) {
    console.error("❌ Error guardando carrito:", error);
  }
}

function getCartCount() {
  return cartItems.reduce((t, item) => t + Number(item.cantidad || 0), 0);
}

function getCartTotal() {
  let total = cartItems.reduce((total, item) => {
    const qty = Number(item.cantidad || 0);
    const raw = item.precio ?? item.price_snapshot ?? 0;
    let precio = parseFloat(String(raw).replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
    /* Si precio parece "miles abreviados" (ej. 16.5 = $16.500): típico cuando DB guarda 16.5 */
    if (precio > 0 && precio < 1000 && precio % 1 !== 0) {
      precio = precio * 1000;
    }
    return total + qty * precio;
  }, 0);
  return total;
}

function formatPriceLocal(precio) {
  if (precio == null || precio === '') return '$0';
  let n = parseFloat(String(precio).replace(/[^\d.,]/g, '').replace(',', '.'));
  if (isNaN(n)) return '$0';
  return (typeof window.formatARS === 'function' ? window.formatARS(n) : null) ||
    (typeof window.formatPrice === 'function' ? window.formatPrice(n) : null) ||
    ('$' + new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(n)));
}

function createFloatingCartButton() {
  if (window.__DASHBOARD__ === true) return;
  if (document.getElementById("sticky-cart")) return;
  const btn = document.createElement("button");
  btn.id = "sticky-cart";
  btn.type = "button";
  btn.className = "sticky-cart";
  btn.setAttribute("aria-label", "Ver carrito");
  btn.innerHTML = `
    <span class="sticky-cart__left">
      <span class="sticky-cart__icon-wrap">
        <svg class="sticky-cart__icon" viewBox="-2 -2 28 28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" preserveAspectRatio="xMidYMid meet">
          <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
          <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
        </svg>
      </span>
      <span class="sticky-cart__label"></span>
    </span>
    <span class="sticky-cart__right">
      <span class="sticky-cart__total"></span>
      <svg class="sticky-cart__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
    </span>
  `;
  btn.addEventListener("click", () => {
    if (typeof window.goToCart === "function") window.goToCart();
  });
  document.body.appendChild(btn);
}

function updateFloatingCartCta() {
  if (window.__DASHBOARD__ === true) return;
  const btn = document.getElementById("sticky-cart");
  if (!btn) return;
  const count = typeof window.getCartCount === "function" ? window.getCartCount() : 0;
  let total = typeof getCartTotal === "function" ? getCartTotal() : 0;

  /* DIAG: log antes/después para diagnosticar total "$37" sin miles */
  if (typeof console !== "undefined" && console.debug && count > 0) {
    const _fmt = (window.formatARS || formatPriceLocal);
    console.debug("[sticky-cart] render:", { totalNumerico: total, count, formatted: _fmt(total), cartItems: cartItems.map(i => ({ articulo: i.articulo, cantidad: i.cantidad, precio: i.precio, raw: i.precio ?? i.price_snapshot })) });
  }

  const formatted = window.formatARS ? window.formatARS(total) : formatPriceLocal(total);
  const labelEl = btn.querySelector(".sticky-cart__label");
  const totalEl = btn.querySelector(".sticky-cart__total");
  if (labelEl) labelEl.textContent = count === 1 ? "1 par en carrito" : `${count} pares en carrito`;
  if (totalEl) totalEl.textContent = formatted;
  btn.classList.toggle("is-visible", count > 0);
  document.body.classList.toggle("has-cart-bar", count > 0);
  const root = document.documentElement;
  if (count > 0 && btn) {
    const h = btn.getBoundingClientRect().height;
    root.style.setProperty("--sticky-cart-h", h > 0 ? `${Math.round(h)}px` : "48px");
  } else {
    root.style.setProperty("--sticky-cart-h", "0px");
  }
}

function updateCartCount() {
  cartCount = cartItems.reduce(
    (total, item) => total + (item.cantidad || 0),
    0
  );

  const cartButton = document.getElementById("cart-button");
  const cartCountElement = document.getElementById("cart-count");

  if (cartButton) {
    cartButton.style.display = cartCount > 0 ? "block" : "none";
  }

  if (cartCountElement) {
    cartCountElement.textContent = cartCount;
  }

  if (typeof window.updateFloatingCartCta === "function") {
    window.updateFloatingCartCta();
  }

  /* Señal de reserva activa en Pedidos (punto naranja o badge) */
  const navPedidos = document.getElementById("nav-pedidos");
  if (navPedidos) {
    navPedidos.classList.toggle("has-reserva", cartCount > 0);
  }
}

async function syncCartWithSupabase(options = {}) {
  const { mergeWithRemote = false } = options;
  if (isSyncing) {
    return;
  }

  isSyncing = true;
  try {
    // Solo loguear ocasionalmente para evitar spam
    // console.log("🔄 Sincronizando carrito con Supabase...");
    if (!supabase) return;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const ready = await ensureCustomerRecord(user);
    if (!ready) return;

    const cartId = await getOrCreateOpenCart(user);
    if (!cartId) return;

    cartItems = normalizeCartItems(cartItems);

    if (mergeWithRemote) {
      const { data: remoteItems, error: remoteItemsError } = await supabase
        .from("cart_items")
        .select("*")
        .eq("cart_id", cartId);

      if (!remoteItemsError && Array.isArray(remoteItems) && remoteItems.length > 0) {
        const normalizedRemote = normalizeCartItems(
          remoteItems.map((row) => ({
            id: row.id,
            articulo: row.product_name,
            color: row.color,
            talle: row.size,
            cantidad: row.quantity,
            precio: row.price_snapshot,
            imagen: row.imagen,
            descripcion: null,
            variant_id: row.variant_id,
          }))
        );
        // Merge login-safe: avoid adding local+remote qty for the same key.
        cartItems = normalizeCartItems(
          mergeCartItemsWithoutDoubleCount(normalizedRemote, cartItems)
        );
      }
    }

    if (!cartItems.length) {
      await supabase.from("cart_items").delete().eq("cart_id", cartId);
      saveCartToStorage();
      updateCartCount();
      window.dispatchEvent(new CustomEvent("cart:synced"));
      return;
    }

    await supabase.from("cart_items").delete().eq("cart_id", cartId);

    const rows = await Promise.all(
      cartItems.map(async (item) => {
        let imagen = item.imagen;
        if (!imagen) {
          imagen = await fetchPrimaryImage(item.articulo, item.color);
        }
        return {
          cart_id: cartId,
          product_name: item.articulo,
          color: item.color,
          size: normalizeSize(item.talle ?? item.size ?? "") || (item.talle ?? item.size),
          quantity: item.cantidad,
          qty: item.cantidad,
          price_snapshot: item.precio,
          status: "reserved",
          imagen: imagen || null,
          variant_id: item.variant_id || null,
        };
      })
    );

    const { data: insertedRows, error: insertError } = await supabase
      .from("cart_items")
      .insert(rows)
      .select("*");

    if (insertError) {
      console.error("❌ Error insertando items del carrito:", insertError);
      return;
    }

    const reloaded = await supabase
      .from("cart_items")
      .select("*")
      .eq("cart_id", cartId);

    if (!reloaded.error && reloaded.data) {
      const normalizedInserted = normalizeCartItems(
        reloaded.data.map((row) => ({
          id: row.id,
          articulo: row.product_name,
          color: row.color,
          talle: row.size,
          cantidad: row.quantity,
          precio: row.price_snapshot,
          imagen: row.imagen,
          descripcion: null,
          variant_id: row.variant_id,
        }))
      );

      cartItems = normalizedInserted;
      saveCartToStorage();
      updateCartCount();
    }

    window.dispatchEvent(new CustomEvent("cart:synced"));
  } catch (error) {
    console.error("❌ Error sincronizando carrito:", error);
  } finally {
    isSyncing = false;
  }
}

async function loadCartFromSupabase() {
  if (loadCartFromSupabaseInFlight) {
    return loadCartFromSupabaseInFlight;
  }
  loadCartFromSupabaseInFlight = (async () => {
    try {
      if (!supabase) return;
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data: cart } = await supabase
        .from("carts")
        .select("id, created_at")
        .eq("customer_id", user.id)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!cart) return;

      const { data: items, error: itemsError } = await supabase
        .from("cart_items")
        .select("*")
        .eq("cart_id", cart.id);

      if (itemsError || !items) return;

      const supabaseItems = items.map((item) => ({
        id: item.id,
        articulo: item.product_name,
        color: item.color,
        talle: item.size,
        cantidad: item.quantity,
        precio: item.price_snapshot,
        imagen: item.imagen,
        descripcion: null,
        variant_id: item.variant_id,
      }));

      const normalized = normalizeCartItems(supabaseItems);
      const hadDuplicates = normalized.length < supabaseItems.length;
      cartItems = normalized;
      saveCartToStorage();
      updateCartCount();

      if (hadDuplicates && !isDedupingSupabase) {
        try {
          isDedupingSupabase = true;
          await syncCartWithSupabase();
        } finally {
          isDedupingSupabase = false;
        }
      }
    } catch (error) {
      console.error("❌ Error cargando carrito desde Supabase:", error);
    } finally {
      loadCartFromSupabaseInFlight = null;
    }
  })();
  return loadCartFromSupabaseInFlight;
}

async function ensureCartItemInDatabase(productData, authUser = null, options = {}) {
  try {
    if (!productData) return false;

    let user = authUser;
    if (!user) {
      const {
        data: { user: currentUser },
      } = await supabase.auth.getUser();
      user = currentUser;
    }

    if (!user) {
      console.warn("⚠️ No hay usuario autenticado, no se puede guardar en DB");
      return false;
    }

    const ready = await ensureCustomerRecord(user);
    if (!ready) return false;

    const cartId = await getOrCreateOpenCart(user);
    if (!cartId) return false;

    const articulo = productData.articulo;
    const color = productData.color || "Único";
    const size = normalizeSize(productData.talle ?? productData.size ?? "") || "Único";
    const quantity = Number(productData.cantidad || 1) || 1;
    const price = Number(productData.precio || 0) || 0;
    let imagen = productData.imagen;
    if (!imagen) {
      imagen = await fetchPrimaryImage(articulo, color);
    }

    let variantInfo = options.variantInfo || null;
    if (!variantInfo) {
      variantInfo = await fetchVariantInfo(
        articulo,
        color,
        size,
        productData.variant_id
      );
    }

    if (!variantInfo) {
      alert(
        `⚠️ No se encontró stock para ${articulo} (${color} • ${size}). Revisa la disponibilidad.`
      );
      return false;
    }

    // Verificar stock REAL disponible (sin contar lo que está en el carrito)
    // Stock REAL = stock_qty - reserved_qty
    const stockRealDisponible = variantInfo.available ?? 0;
    
    if (stockRealDisponible <= 0) {
      alert(
        `⚠️ Este producto está agotado. No hay unidades disponibles de ${articulo} (${color} • ${size}).`
      );
      return false;
    }

    const priceToUse = price > 0 ? price : variantInfo.price || 0;

    // Buscar por variant_id Y size: mismo variant puede tener varios talles (36, 37...) por separado
    const { data: existingRows, error: existingError } = await supabase
      .from("cart_items")
      .select("id, quantity, size")
      .eq("cart_id", cartId)
      .eq("variant_id", variantInfo.id)
      .eq("size", size);

    if (existingError) {
      console.error("❌ Error consultando item existente:", existingError);
      return false;
    }

    let candidateRows = existingRows;

    if ((!candidateRows || candidateRows.length === 0) && !productData.variant_id) {
      const { data: fallbackRows, error: fallbackError } = await supabase
        .from("cart_items")
        .select("id, quantity")
        .eq("cart_id", cartId)
        .eq("product_name", articulo)
        .eq("color", color)
        .eq("size", size);

      if (fallbackError) {
        console.warn(
          "⚠️ Error buscando items previos sin variante:",
          fallbackError.message
        );
      } else if (fallbackRows?.length) {
        candidateRows = fallbackRows;
      }
    }

    const currentQuantity =
      candidateRows?.reduce(
        (sum, row) => sum + (Number(row.quantity) || 0),
        0
      ) || 0;

    // Verificar que la cantidad deseada no exceda el stock real disponible
    const cantidadDeseada = quantity;
    if (cantidadDeseada > stockRealDisponible) {
      alert(
        `⚠️ Solo hay ${stockRealDisponible} unidad(es) disponible(s) de ${articulo} (${color} • ${size}). No se puede agregar ${cantidadDeseada} unidad(es).`
      );
      return false;
    }

    // Calcular el máximo permitido considerando lo que ya está en el carrito
    const remainingStock = Math.max(
      0,
      stockRealDisponible - currentQuantity
    );
    const maxAllowed = currentQuantity + remainingStock;

    if (maxAllowed <= currentQuantity) {
      alert(
        `⚠️ No queda stock disponible para ${articulo} (${color} • ${size}). Ya tienes ${currentQuantity} unidad(es) en tu carrito y no hay más disponibles.`
      );
      return false;
    }

    const desiredTotal = currentQuantity + quantity;
    const finalTotal = Math.min(desiredTotal, maxAllowed);
    const quantityToAdd = finalTotal - currentQuantity;

    if (quantityToAdd <= 0) {
      alert(
        `Solo puedes reservar ${maxAllowed} unidades de ${articulo} (${color} • ${size}).`
      );
      return false;
    }

    if (quantityToAdd < quantity) {
      alert(
        `Stock limitado: se agregaron ${quantityToAdd} unidades (máximo disponible ${maxAllowed}).`
      );
    }

    const primary = candidateRows?.[0] ?? null;
    const duplicates = candidateRows?.slice(1) ?? [];

    if (primary) {
      const { error: updateError } = await supabase
        .from("cart_items")
        .update({
          quantity: finalTotal,
          qty: finalTotal,
          price_snapshot: priceToUse || null,
          variant_id: variantInfo.id,
          imagen: imagen || null,
        })
        .eq("id", primary.id);
      if (updateError) {
        console.error("❌ Error actualizando item del carrito:", updateError);
        return false;
      }

      if (duplicates.length > 0) {
        const duplicateIds = duplicates.map((dup) => dup.id).filter(Boolean);
        const { error: deleteError } = await supabase
          .from("cart_items")
          .delete()
          .in("id", duplicateIds);
        if (deleteError) {
          console.warn("⚠️ No se pudieron eliminar duplicados:", deleteError);
        }
      }
    } else {
      // Evitar duplicado por doble clic: reconsultar por si otro request acaba de insertar; si ya existe, actualizar a finalTotal (no sumar de nuevo)
      const { data: recheck } = await supabase
        .from("cart_items")
        .select("id, quantity")
        .eq("cart_id", cartId)
        .eq("variant_id", variantInfo.id)
        .eq("size", size);
      const recheckRow = recheck?.[0];
      if (recheckRow) {
        const existingQty = Number(recheckRow.quantity) || 0;
        const targetQty = Math.max(existingQty, finalTotal);
        await supabase
          .from("cart_items")
          .update({ quantity: targetQty, qty: targetQty, price_snapshot: priceToUse || null, variant_id: variantInfo.id, imagen: imagen || null })
          .eq("id", recheckRow.id);
      } else {
        const { error: insertError } = await supabase.from("cart_items").insert({
          cart_id: cartId,
          product_name: articulo,
          color,
          size,
          quantity: finalTotal,
          qty: finalTotal,
          price_snapshot: priceToUse,
          status: "reserved",
          imagen: imagen || null,
          variant_id: variantInfo.id,
        });

        if (insertError) {
          console.error("❌ Error insertando item en Supabase:", insertError);
          return false;
        }
      }
    }

    await loadCartFromSupabase();
    window.dispatchEvent(new CustomEvent("cart:synced"));
    return true;
  } catch (error) {
    console.error("❌ Error asegurando item en Supabase:", error);
    return false;
  }
}

async function addToCart(productData, options = {}) {
  try {
    // VALIDACIÓN DE STOCK ANTES DE AGREGAR AL CARRITO
    // Verificar stock REAL disponible (sin contar lo que está en el carrito)
    const articulo = productData.articulo;
    const color = productData.color || "Único";
    const talle = productData.talle || "Único";
    const cantidadDeseada = Number(productData.cantidad || 1) || 1;
    
    // Obtener información de la variante
    const variantInfo = await fetchVariantInfo(
      articulo,
      color,
      talle,
      productData.variant_id || null
    );
    
    if (!variantInfo) {
      // Intentar mostrar modal de alternativas si está disponible
      if (window.mostrarAlternativasParaTalleSinStock && productData.tags) {
        const producto = {
          articulo,
          talle,
          tags: productData.tags || [],
          color: color !== "Único" ? color : null,
        };
        await window.mostrarAlternativasParaTalleSinStock(producto);
        return;
      }
      alert(`⚠️ No se encontró información de stock para ${articulo} (${color} • ${talle}). Por favor verifica la disponibilidad.`);
      return;
    }
    
    // Stock REAL disponible = stock_qty - reserved_qty
    // NO restamos lo que está en el carrito porque aún NO está reservado
    const stockRealDisponible = variantInfo.available ?? 0;
    
    if (stockRealDisponible <= 0) {
      // Intentar mostrar modal de alternativas si está disponible
      if (window.mostrarAlternativasParaTalleSinStock) {
        // Obtener tags del producto si no están en productData
        let tags = productData.tags || [];
        if (!tags || tags.length === 0) {
          // Intentar obtener tags desde el catálogo
          try {
            if (supabase) {
              const { data: productoCatalogo } = await supabase
                .from("catalog_public_view")
                .select('"Filtro1","Filtro2","Filtro3"')
                .eq("Articulo", articulo)
                .limit(1)
                .maybeSingle();
              
              if (productoCatalogo) {
                if (productoCatalogo.Filtro1) tags.push(productoCatalogo.Filtro1);
                if (productoCatalogo.Filtro2) tags.push(productoCatalogo.Filtro2);
                if (productoCatalogo.Filtro3) tags.push(productoCatalogo.Filtro3);
              }
            }
          } catch (error) {
            console.warn("⚠️ No se pudieron obtener tags del producto:", error);
          }
        }
        
        const producto = {
          articulo,
          talle,
          tags: tags.filter((t) => t && t.trim()),
          color: color !== "Único" ? color : null,
        };
        await window.mostrarAlternativasParaTalleSinStock(producto);
        return;
      }
      alert(`⚠️ Este producto está agotado. No hay unidades disponibles de ${articulo} (${color} • ${talle}). Por favor selecciona otro tamaño o producto.`);
      return;
    }
    
    if (cantidadDeseada > stockRealDisponible) {
      alert(`⚠️ Solo hay ${stockRealDisponible} unidad(es) disponible(s) de ${articulo} (${color} • ${talle}). Por favor ajusta la cantidad.`);
      return;
    }
    
    // Si hay stock suficiente, proceder con agregar al carrito
    let dbUser = null;
    if (supabase) {
      const {
        data: { user: sessionUser },
      } = await supabase.auth.getUser();
      dbUser = sessionUser || null;
    }

    let usedDatabase = false;

    if (dbUser) {
      applyOptimisticCartAdd(productData, variantInfo);
      saveCartToStorage();
      updateCartCount();
      if (!options.suppressNotification) {
        showCartNotification(productData.articulo);
      }
      const persisted = await ensureCartItemInDatabase(productData, dbUser, {
        variantInfo,
      });
      if (!persisted) {
        await loadCartFromSupabase();
        return false;
      }
      usedDatabase = true;
    } else {
      // Fallback local (invitado)
      const existingItem = cartItems.find(
        (item) =>
          item.articulo === productData.articulo &&
          item.color === productData.color &&
          item.talle === productData.talle
      );

      if (existingItem) {
        existingItem.cantidad += productData.cantidad || 1;
      } else {
        cartItems.push({
          id: Date.now(),
          articulo: productData.articulo,
          color: productData.color || "Único",
          talle: productData.talle || "Único",
          cantidad: productData.cantidad || 1,
          precio: productData.precio,
          imagen: productData.imagen,
          descripcion: productData.descripcion,
        });
      }

      cartItems = normalizeCartItems(cartItems);
      saveCartToStorage();
      updateCartCount();
      if (!options.suppressNotification) {
        showCartNotification(productData.articulo);
      }
    }

    if (!usedDatabase) {
      await syncCartWithSupabase();
    }
    
    // Retornar true para indicar que se agregó exitosamente
    return true;
  } catch (error) {
    console.error("❌ Error agregando al carrito:", error);
    // Retornar false para indicar que no se pudo agregar
    return false;
  }
}

function removeFromCart(itemId) {
  try {
    const targetId = String(itemId);
    cartItems = cartItems.filter((item) => String(item.id) !== targetId);
    cartItems = normalizeCartItems(cartItems);
    saveCartToStorage();
    updateCartCount();
    syncCartWithSupabase();
  } catch (error) {
    console.error("❌ Error removiendo del carrito:", error);
  }
}

function goToCart() {
  if (window.requireAuth) {
    window
      .requireAuth()
      .then((authResult) => {
        const user = authResult?.user;
        if (user) {
          window.location.href = "client/dashboard.html";
        } else {
          window.location.href = "client/login.html";
        }
      })
      .catch(() => {
        window.location.href = "client/login.html";
      });
  } else {
    window.location.href = "client/dashboard.html";
  }
}

function showCartNotification(productName) {
  try {
    const notification = document.createElement("div");
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #4CAF50;
      color: white;
      padding: 15px 20px;
      border-radius: 5px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      z-index: 1000;
      font-size: 14px;
    `;
    notification.textContent = `✅ ${productName} agregado al carrito`;
    document.body.appendChild(notification);
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 3000);
  } catch (error) {
    console.error("❌ Error mostrando notificación:", error);
  }
}

function setupAuthListener() {
  if (!supabase || authListenerAttached) return;
  authListenerAttached = true;
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session) {
      const mergeSessionKey = `fyl_cart_merged_for_${session.user.id}`;
      const hasLocalGuestCart = (() => {
        try {
          const raw = localStorage.getItem("fyl_cart");
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) && parsed.length > 0;
        } catch (_e) {
          return false;
        }
      })();

      const alreadyMergedInSession =
        sessionStorage.getItem(mergeSessionKey) === "1";

      if (hasLocalGuestCart && !alreadyMergedInSession) {
        sessionStorage.setItem(mergeSessionKey, "1");
        syncCartWithSupabase({ mergeWithRemote: true });
      } else {
        loadCartFromSupabase();
      }
    }
  });
}

function setBottomNavHeightVar() {
  const bottomNav = document.getElementById("bottom-nav");
  if (bottomNav && window.innerWidth <= 768) {
    const h = bottomNav.offsetHeight || 56;
    document.documentElement.style.setProperty("--bottom-nav-h", `${h}px`);
  }
}

function initPersistentCart() {
  if (window.__CATALOG_ONLY__) return;
  if (isInitialized) return;
  isInitialized = true;
  setBottomNavHeightVar();
  createFloatingCartButton();
  window.updateFloatingCartCta = updateFloatingCartCta;
  updateFloatingCartCta();
  loadCartFromStorage();
  setupAuthListener();

  const cartButton = document.getElementById("cart-button");
  if (cartButton) cartButton.addEventListener("click", goToCart);

  window.addToCart = addToCart;
  window.getCartCount = getCartCount;
  window.getCartTotal = getCartTotal;
  window.__cartDiag = () => ({
    total: getCartTotal(),
    count: getCartCount(),
    formatARS_37000: window.formatARS?.(37000),
    formatARS_37: window.formatARS?.(37),
    formatARS_str: window.formatARS?.("37000"),
    fyl_cart: JSON.parse(localStorage.getItem("fyl_cart") || "null"),
    stickyTotalText: document.querySelector(".sticky-cart__total")?.textContent,
  });
  window.removeFromCart = removeFromCart;
  window.goToCart = goToCart;
  window.updateCartCount = updateCartCount;
  window.syncCartWithSupabase = syncCartWithSupabase;
  window.loadCartFromSupabase = loadCartFromSupabase;
  window.ensureCartItemInDatabase = ensureCartItemInDatabase;
  window.removeCartItem = async function (itemId) {
    try {
      const targetId = String(itemId);
      cartItems = cartItems.filter((item) => String(item.id) !== targetId);
      cartItems = normalizeCartItems(cartItems);
      saveCartToStorage();
      updateCartCount();
      await syncCartWithSupabase();
      window.dispatchEvent(new CustomEvent("cart:synced"));
      return true;
    } catch (error) {
      console.error("❌ Error removiendo item del carrito:", error);
      return false;
    }
  };

  setTimeout(() => {
    loadCartFromSupabase();
  }, 1000);
  window.addEventListener("focus", loadCartFromSupabase);

  window.addEventListener("resize", () => {
    setBottomNavHeightVar();
    if (typeof window.updateFloatingCartCta === "function") window.updateFloatingCartCta();
  });
}

document.addEventListener("DOMContentLoaded", initPersistentCart);
if (document.readyState !== "loading") {
  initPersistentCart();
}

export {
  addToCart,
  getCartCount,
  removeFromCart,
  goToCart,
  updateCartCount,
  syncCartWithSupabase,
  loadCartFromSupabase,
  ensureCartItemInDatabase,
};
