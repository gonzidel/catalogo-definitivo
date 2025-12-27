import { supabase } from "./supabase-client.js";

let cartItems = [];
let cartCount = 0;
let isInitialized = false;
let isDedupingSupabase = false;
let isSyncing = false;

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

      if (variantByIdError) {
        console.warn(
          "⚠️ Error obteniendo variante por ID:",
          variantByIdError.message
        );
      }

      if (variantById) {
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

    if (productError) {
      console.warn("⚠️ Error obteniendo producto:", productError.message);
      return null;
    }
    if (!product) {
      console.warn("⚠️ Producto no encontrado para", normalizedArticulo);
      return null;
    }

    const { data: variant, error: variantError } = await supabase
      .from("product_variants")
      .select("id, stock_qty, reserved_qty, price, color, size")
      .eq("product_id", product.id)
      .ilike("color", normalizedColor)
      .eq("size", normalizedSize)
      .maybeSingle();

    if (variantError) {
      console.warn("⚠️ Error obteniendo variante:", variantError.message);
      return null;
    }

    if (!variant) {
      console.warn(
        "⚠️ Variante no encontrada:",
        normalizedArticulo,
        normalizedColor,
        normalizedSize
      );
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
    console.error("❌ Error obteniendo información de variante:", error);
    return null;
  }
}

function normalizeCartItems(items = []) {
  const map = new Map();
  items.forEach((item) => {
    const key = [
      item.articulo || item.product_name || "",
      item.color || "",
      item.talle || item.size || "",
    ].join("__");
    const cantidad =
      Number(item.cantidad ?? item.quantity ?? item.qty ?? 0) || 0;
    const precio = Number(item.precio ?? item.price_snapshot ?? 0) || 0;
    if (!map.has(key)) {
      map.set(key, {
        ...item,
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
}

async function syncCartWithSupabase() {
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

    cartItems = normalizeCartItems(cartItems);

    const cartId = await getOrCreateOpenCart(user);
    if (!cartId) return;

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
          size: item.talle,
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
  }
}

async function ensureCartItemInDatabase(productData, authUser = null) {
  try {
    if (!productData) return;

    let user = authUser;
    if (!user) {
      const {
        data: { user: currentUser },
      } = await supabase.auth.getUser();
      user = currentUser;
    }

    if (!user) {
      console.warn("⚠️ No hay usuario autenticado, no se puede guardar en DB");
      return;
    }

    const ready = await ensureCustomerRecord(user);
    if (!ready) return;

    const cartId = await getOrCreateOpenCart(user);
    if (!cartId) return;

    const articulo = productData.articulo;
    const color = productData.color || "Único";
    const size = productData.talle || "Único";
    const quantity = Number(productData.cantidad || 1) || 1;
    const price = Number(productData.precio || 0) || 0;
    let imagen = productData.imagen;
    if (!imagen) {
      imagen = await fetchPrimaryImage(articulo, color);
    }

    const variantInfo = await fetchVariantInfo(
      articulo,
      color,
      size,
      productData.variant_id
    );

    if (!variantInfo) {
      alert(
        `⚠️ No se encontró stock para ${articulo} (${color} • ${size}). Revisa la disponibilidad.`
      );
      return;
    }

    // Verificar stock REAL disponible (sin contar lo que está en el carrito)
    // Stock REAL = stock_qty - reserved_qty
    const stockRealDisponible = variantInfo.available ?? 0;
    
    if (stockRealDisponible <= 0) {
      alert(
        `⚠️ Este producto está agotado. No hay unidades disponibles de ${articulo} (${color} • ${size}).`
      );
      return;
    }

    const priceToUse = price > 0 ? price : variantInfo.price || 0;

    const { data: existingRows, error: existingError } = await supabase
      .from("cart_items")
      .select("id, quantity")
      .eq("cart_id", cartId)
      .eq("variant_id", variantInfo.id);

    if (existingError) {
      console.error("❌ Error consultando item existente:", existingError);
      return;
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
      return;
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
      return;
    }

    const desiredTotal = currentQuantity + quantity;
    const finalTotal = Math.min(desiredTotal, maxAllowed);
    const quantityToAdd = finalTotal - currentQuantity;

    if (quantityToAdd <= 0) {
      alert(
        `Solo puedes reservar ${maxAllowed} unidades de ${articulo} (${color} • ${size}).`
      );
      return;
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
        return;
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
        return;
      }
    }

    await loadCartFromSupabase();
    window.dispatchEvent(new CustomEvent("cart:synced"));
  } catch (error) {
    console.error("❌ Error asegurando item en Supabase:", error);
  }
}

async function addToCart(productData) {
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
    const authResult = window.requireAuth ? await window.requireAuth() : null;
    const user = authResult?.user;

    let usedDatabase = false;

    if (user) {
      await ensureCartItemInDatabase(productData, user);
      usedDatabase = true;
    } else {
      const {
        data: { user: sessionUser },
      } = await supabase.auth.getUser();

      if (sessionUser) {
        await ensureCartItemInDatabase(productData, sessionUser);
        usedDatabase = true;
      } else {
        // Fallback local
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
      }
    }

    showCartNotification(productData.articulo);
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
  if (!supabase) return;
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session) {
      loadCartFromSupabase();
    }
  });
}

function initPersistentCart() {
  if (isInitialized) return;
  loadCartFromStorage();
  setupAuthListener();

  const cartButton = document.getElementById("cart-button");
  if (cartButton) cartButton.addEventListener("click", goToCart);

  window.addToCart = addToCart;
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

  isInitialized = true;
}

document.addEventListener("DOMContentLoaded", initPersistentCart);
if (document.readyState !== "loading") {
  initPersistentCart();
}

export {
  addToCart,
  removeFromCart,
  goToCart,
  updateCartCount,
  syncCartWithSupabase,
  loadCartFromSupabase,
  ensureCartItemInDatabase,
};
