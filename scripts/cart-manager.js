// scripts/cart-manager.js - Gestión del carrito de compras
/**
 * Gestión del carrito de compras con persistencia local y sincronización con Supabase
 */

// Estado del carrito
let cartItems = [];
let cartCount = 0;

// Cargar carrito desde localStorage
function loadCartFromStorage() {
  try {
    const savedCart = localStorage.getItem("fyl_cart");
    if (savedCart) {
      cartItems = JSON.parse(savedCart);
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

// Guardar carrito en localStorage
function saveCartToStorage() {
  try {
    localStorage.setItem("fyl_cart", JSON.stringify(cartItems));
    console.log("💾 Carrito guardado en localStorage");
  } catch (error) {
    console.error("❌ Error guardando carrito:", error);
  }
}

// Actualizar contador del carrito
function updateCartCount() {
  cartCount = cartItems.reduce((total, item) => total + item.cantidad, 0);

  // Actualizar botón del carrito
  const cartButton = document.getElementById("cart-button");
  if (cartButton) {
    cartButton.textContent = `Pedido: ${cartCount} items`;
    cartButton.style.display = cartCount > 0 ? "block" : "none";
  }

  console.log("📊 Contador del carrito actualizado:", cartCount);
}

// Agregar producto al carrito
async function addToCart(productData) {
  try {
    console.log("🛒 Agregando producto al carrito:", productData);

    const authResult = window.requireAuth ? await window.requireAuth() : null;
    const user = authResult?.user;
    if (!user) {
      window.location.href = "client/login.html";
      return;
    }

    if (window.ensureCartItemInDatabase) {
      await window.ensureCartItemInDatabase(productData, user);
      loadCartFromStorage();
    } else {
      const existingItem = cartItems.find(
        (item) =>
          item.articulo === productData.articulo &&
          item.color === productData.color &&
          item.talle === productData.talle
      );

      if (existingItem) {
        existingItem.cantidad += productData.cantidad || 1;
      } else {
        const newItem = {
          id: Date.now(),
          articulo: productData.articulo,
          color: productData.color || "Único",
          talle: productData.talle || "Único",
          cantidad: productData.cantidad || 1,
          precio: productData.precio,
          imagen: productData.imagen,
          descripcion: productData.descripcion,
        };
        cartItems.push(newItem);
      }

      cartItems = normalizeCartItems(cartItems);
      saveCartToStorage();
      updateCartCount();
      if (window.syncCartWithSupabase) {
        await window.syncCartWithSupabase();
        loadCartFromStorage();
      }
    }

    showCartNotification(productData.articulo);
  } catch (error) {
    console.error("❌ Error agregando al carrito:", error);
  }
}

// Remover producto del carrito
function removeFromCart(itemId) {
  try {
    cartItems = cartItems.filter((item) => item.id !== itemId);
    saveCartToStorage();
    updateCartCount();
    console.log("🗑️ Producto removido del carrito");
  } catch (error) {
    console.error("❌ Error removiendo del carrito:", error);
  }
}

// Ir al carrito
function goToCart() {
  try {
    console.log("🛒 Redirigiendo al carrito...");

    // Verificar autenticación
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
      // Fallback: ir al dashboard
      window.location.href = "client/dashboard.html";
    }
  } catch (error) {
    console.error("❌ Error redirigiendo al carrito:", error);
    window.location.href = "client/dashboard.html";
  }
}

// Enviar carrito
function submitCart() {
  try {
    console.log("📤 Enviando carrito...");

    if (cartItems.length === 0) {
      alert("El carrito está vacío");
      return;
    }

    // Verificar autenticación
    if (window.requireAuth) {
      window
        .requireAuth()
        .then(async (authResult) => {
          const user = authResult?.user;
          if (!user) {
            window.location.href = "client/login.html";
            return;
          }
          await createCartInSupabase(user);
        })
        .catch(() => {
          window.location.href = "client/login.html";
        });
    } else {
      // Fallback: crear carrito local
      createCartInSupabase();
    }
  } catch (error) {
    console.error("❌ Error enviando carrito:", error);
  }
}

// Crear carrito en Supabase
async function createCartInSupabase(authUser = null) {
  try {
    console.log("🔧 Creando carrito en Supabase...");

    if (!window.supabase) {
      console.warn("⚠️ Supabase no disponible");
      return;
    }

    let user = authUser;
    if (!user) {
      const {
        data: { user: currentUser },
        error: userError,
      } = await window.supabase.auth.getUser();
      if (userError) {
        console.error("❌ Error obteniendo usuario:", userError);
        window.location.href = "client/login.html";
        return;
      }
      user = currentUser;
    }

    if (!user) {
      console.warn("⚠️ Usuario no autenticado, cancelando creación de carrito");
      window.location.href = "client/login.html";
      return;
    }

    // Reutilizar carrito abierto existente si lo hay
    const { data: existingCart } = await window.supabase
      .from("carts")
      .select("id")
      .eq("customer_id", user.id)
      .eq("status", "open")
      .maybeSingle();

    let cart = existingCart;

    if (!cart) {
      const { data: newCart, error: cartError } = await window.supabase
        .from("carts")
        .insert({
          customer_id: user.id,
          status: "open",
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (cartError) {
        console.error("❌ Error creando carrito:", cartError);
        return;
      }

      cart = newCart;
    }

    // Agregar items al carrito
    for (const item of cartItems) {
      await window.supabase.from("cart_items").insert({
        cart_id: cart.id,
        product_name: item.articulo,
        color: item.color,
        size: item.talle,
        quantity: item.cantidad,
        price_snapshot: item.precio,
        status: "reserved",
      });
    }

    // Limpiar carrito local
    cartItems = [];
    saveCartToStorage();
    updateCartCount();

    // Redirigir al dashboard
    window.location.href = "client/dashboard.html";

    console.log("✅ Carrito enviado exitosamente");
  } catch (error) {
    console.error("❌ Error creando carrito en Supabase:", error);
  }
}

// Mostrar notificación del carrito
function showCartNotification(productName) {
  try {
    // Crear notificación temporal
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

    // Remover después de 3 segundos
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 3000);
  } catch (error) {
    console.error("❌ Error mostrando notificación:", error);
  }
}

// Inicializar carrito
function initCart() {
  try {
    console.log("🛒 Inicializando carrito...");

    // Cargar carrito desde localStorage
    loadCartFromStorage();

    // Configurar botón del carrito
    const cartButton = document.getElementById("cart-button");
    if (cartButton) {
      cartButton.addEventListener("click", goToCart);
    }

    // Exponer funciones globalmente
    window.addToCart = addToCart;
    window.removeFromCart = removeFromCart;
    window.goToCart = goToCart;
    window.submitCart = submitCart;
    window.updateCartCount = updateCartCount;

    console.log("✅ Carrito inicializado correctamente");
  } catch (error) {
    console.error("❌ Error inicializando carrito:", error);
  }
}

// Ejecutar cuando se carga la página
document.addEventListener("DOMContentLoaded", initCart);

// También ejecutar si la página ya está cargada
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCart);
} else {
  initCart();
}

export { addToCart, removeFromCart, goToCart, submitCart, updateCartCount };
