// scripts/cart-sync.js - Sincronización del carrito con Supabase
/**
 * Sincroniza el carrito local con Supabase y actualiza el contador
 */

// Sincronizar carrito con Supabase
async function syncCartWithSupabase() {
  try {
    console.log("🔄 Sincronizando carrito con Supabase...");

    if (!window.supabase) {
      console.warn("⚠️ Supabase no disponible");
      return;
    }

    // Obtener carrito local
    const localCart = JSON.parse(localStorage.getItem("fyl_cart") || "[]");

    if (localCart.length === 0) {
      console.log("📭 Carrito local vacío");
      return;
    }

    // Verificar autenticación
    const {
      data: { user },
    } = await window.supabase.auth.getUser();
    if (!user) {
      console.warn("⚠️ Usuario no autenticado");
      return;
    }

    // Buscar carrito abierto existente
    const { data: existingCart, error: cartError } = await window.supabase
      .from("carts")
      .select("id")
      .eq("customer_id", user.id)
      .eq("status", "open")
      .single();

    let cartId;

    if (existingCart) {
      cartId = existingCart.id;
      console.log("📦 Usando carrito existente:", cartId);
    } else {
      // Crear nuevo carrito
      const { data: newCart, error: newCartError } = await window.supabase
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
        return;
      }

      cartId = newCart.id;
      console.log("🆕 Nuevo carrito creado:", cartId);
    }

    // Limpiar items existentes del carrito
    await window.supabase.from("cart_items").delete().eq("cart_id", cartId);

    // Agregar items del carrito local
    for (const item of localCart) {
      await window.supabase.from("cart_items").insert({
        cart_id: cartId,
        product_name: item.articulo,
        color: item.color,
        size: item.talle,
        quantity: item.cantidad,
        price_snapshot: item.precio,
        status: "reserved",
      });
    }

    console.log("✅ Carrito sincronizado con Supabase");
  } catch (error) {
    console.error("❌ Error sincronizando carrito:", error);
  }
}

// Actualizar contador del carrito desde Supabase
async function updateCartCountFromSupabase() {
  try {
    console.log("📊 Actualizando contador del carrito desde Supabase...");

    if (!window.supabase) {
      console.warn("⚠️ Supabase no disponible");
      return;
    }

    // Verificar autenticación
    const {
      data: { user },
    } = await window.supabase.auth.getUser();
    if (!user) {
      console.warn("⚠️ Usuario no autenticado");
      return;
    }

    // Obtener carrito abierto
    const { data: cart, error: cartError } = await window.supabase
      .from("carts")
      .select("id")
      .eq("customer_id", user.id)
      .eq("status", "open")
      .single();

    if (cartError || !cart) {
      console.log("📭 No hay carrito abierto");
      updateCartButton(0);
      return;
    }

    // Obtener items del carrito
    const { data: items, error: itemsError } = await window.supabase
      .from("cart_items")
      .select("quantity")
      .eq("cart_id", cart.id);

    if (itemsError) {
      console.error("❌ Error obteniendo items del carrito:", itemsError);
      return;
    }

    // Calcular total
    const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);

    // Actualizar botón del carrito
    updateCartButton(totalItems);

    console.log("✅ Contador actualizado:", totalItems, "items");
  } catch (error) {
    console.error("❌ Error actualizando contador:", error);
  }
}

// Actualizar botón del carrito
function updateCartButton(count) {
  try {
    const cartButton = document.getElementById("cart-button");
    if (cartButton) {
      if (count > 0) {
        cartButton.textContent = `Pedido: ${count} items`;
        cartButton.style.display = "block";
      } else {
        cartButton.style.display = "none";
      }
    }
  } catch (error) {
    console.error("❌ Error actualizando botón del carrito:", error);
  }
}

// Configurar listener de autenticación
function setupAuthListener() {
  try {
    if (!window.supabase) {
      console.warn("⚠️ Supabase no disponible para listener");
      return;
    }

    // Escuchar cambios de autenticación
    window.supabase.auth.onAuthStateChange((event, session) => {
      console.log("🔐 Estado de autenticación cambiado:", event);

      if (event === "SIGNED_IN" && session) {
        // Usuario autenticado - sincronizar carrito
        syncCartWithSupabase();
        updateCartCountFromSupabase();
      } else if (event === "SIGNED_OUT") {
        // Usuario desautenticado - limpiar carrito
        updateCartButton(0);
      }
    });

    console.log("👂 Listener de autenticación configurado");
  } catch (error) {
    console.error("❌ Error configurando listener:", error);
  }
}

// Inicializar sincronización
function initCartSync() {
  try {
    console.log("🔄 Inicializando sincronización del carrito...");

    // Configurar listener de autenticación
    setupAuthListener();

    // Sincronizar carrito actual
    syncCartWithSupabase();
    updateCartCountFromSupabase();

    console.log("✅ Sincronización del carrito inicializada");
  } catch (error) {
    console.error("❌ Error inicializando sincronización:", error);
  }
}

// Ejecutar cuando se carga la página
document.addEventListener("DOMContentLoaded", initCartSync);

// También ejecutar si la página ya está cargada
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCartSync);
} else {
  initCartSync();
}

// Exponer funciones globalmente
window.syncCartWithSupabase = syncCartWithSupabase;
window.updateCartCountFromSupabase = updateCartCountFromSupabase;

export { syncCartWithSupabase, updateCartCountFromSupabase };
