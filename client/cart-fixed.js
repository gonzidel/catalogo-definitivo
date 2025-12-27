// client/cart-fixed.js - Carrito de compras del cliente (versión corregida)
/**
 * Gestión del carrito de compras del cliente
 */

// Bandera global para prevenir redirecciones múltiples
let redirectingToLogin = false;

// Verificar autenticación y cargar carrito
async function initCart() {
  try {
    console.log("🛒 Inicializando carrito...");

    // Verificar que Supabase esté disponible
    if (!window.supabase) {
      console.error("❌ Supabase no disponible");
      // Evitar redirección múltiple
      if (
        !redirectingToLogin &&
        !window.location.pathname.includes("login.html")
      ) {
        redirectingToLogin = true;
        console.log("Supabase no disponible, redirigiendo a login...");
        setTimeout(() => {
          if (!window.location.pathname.includes("login.html")) {
            window.location.href = "login.html";
          }
        }, 500);
      }
      return;
    }

    // Esperar a que la sesión esté disponible (máximo 2 segundos)
    let user = null;
    let attempts = 0;
    const maxAttempts = 10;

    while (!user && attempts < maxAttempts) {
      const {
        data: { user: currentUser },
        error: userError,
      } = await window.supabase.auth.getUser();

      if (currentUser && !userError) {
        user = currentUser;
        console.log("✅ Usuario autenticado:", user.email);
        break;
      }

      if (userError && userError.message !== "Auth session missing!") {
        console.error("❌ Error de autenticación:", userError.message);
        break;
      }

      attempts++;
      console.log(
        `⏳ Esperando autenticación... (intento ${attempts}/${maxAttempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (!user) {
      console.log("👤 Usuario no autenticado");

      // Evitar redirección múltiple
      if (
        !redirectingToLogin &&
        !window.location.pathname.includes("login.html")
      ) {
        redirectingToLogin = true;
        console.log("Redirigiendo a login...");
        window.location.href = "login.html";
      }
      return;
    }

    // Cargar items del carrito
    await loadCartItems();

    // Configurar botones
    setupButtons();

    console.log("✅ Carrito inicializado correctamente");
  } catch (error) {
    console.error("❌ Error inicializando carrito:", error);
    // Solo redirigir si hay un error crítico
    if (error.message && error.message.includes("session")) {
      if (
        !redirectingToLogin &&
        !window.location.pathname.includes("login.html")
      ) {
        redirectingToLogin = true;
        console.log("Error de sesión, redirigiendo a login...");
        window.location.href = "login.html";
      }
    }
  }
}

// Cargar items del carrito
async function loadCartItems() {
  try {
    console.log("🛒 Cargando items del carrito...");

    if (!window.supabase) {
      console.warn("⚠️ Supabase no disponible");
      return;
    }

    // Obtener usuario actual
    const {
      data: { user },
    } = await window.supabase.auth.getUser();
    if (!user) {
      console.log("👤 Usuario no autenticado");
      showEmptyCart();
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
      showEmptyCart();
      return;
    }

    // Obtener items del carrito con todos los campos
    const { data: items, error: itemsError } = await window.supabase
      .from("cart_items")
      .select(
        `
        id,
        product_name,
        color,
        size,
        quantity,
        qty,
        price_snapshot,
        status,
        imagen
      `
      )
      .eq("cart_id", cart.id);

    if (itemsError) {
      console.error("❌ Error cargando items del carrito:", itemsError);
      return;
    }

    if (items && items.length > 0) {
      try {
        displayCartItems(items);
      } catch (displayError) {
        console.error("❌ Error mostrando items del carrito:", displayError);
        // No redirigir a login por errores de display
        showEmptyCart();
      }
    } else {
      showEmptyCart();
    }
  } catch (error) {
    console.error("❌ Error cargando items del carrito:", error);
  }
}

// Mostrar items del carrito
function displayCartItems(items) {
  try {
    const cartContentEl = document.getElementById("cart-content");
    const cartSummaryEl = document.getElementById("cart-summary");

    if (!cartContentEl) return;

    let html = "";
    let subtotal = 0;

    items.forEach((item) => {
      // Validar que el item tenga datos básicos
      if (!item || !item.id) {
        console.warn("⚠️ Item inválido encontrado:", item);
        return;
      }

      const itemQuantity = item.quantity || item.qty || 1;
      const itemTotal = itemQuantity * (item.price_snapshot || 0);
      subtotal += itemTotal;

      // Usar imagen real si está disponible, sino placeholder seguro
      const productName = item.product_name || "Producto";
      const productImage =
        item.imagen || `https://picsum.photos/80/80?random=${item.id}`;

      html += `
        <div class="cart-item" data-item-id="${item.id}">
          <img src="${productImage}" alt="${productName}" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHZpZXdCb3g9IjAgMCA4MCA4MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjRjBGMEYwIi8+Cjx0ZXh0IHg9IjQwIiB5PSI0NSIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjE0IiBmaWxsPSIjNjY2IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7wn5KMPC90ZXh0Pgo8L3N2Zz4K'">
          <div class="cart-item-info">
            <div class="cart-item-name">${productName}</div>
            <div class="cart-item-details">
              <strong>Color:</strong> ${item.color || "No especificado"} | 
              <strong>Talle:</strong> ${item.size || "No especificado"}
            </div>
            <div class="cart-item-price">$${(
              item.price_snapshot || 0
            ).toLocaleString()} c/u</div>
          </div>
          <div class="quantity-controls">
            <button class="quantity-btn" onclick="updateQuantity('${
              item.id
            }', ${itemQuantity - 1})">-</button>
            <input type="number" class="quantity-input" value="${itemQuantity}" min="1" onchange="updateQuantity('${
        item.id
      }', this.value)">
            <button class="quantity-btn" onclick="updateQuantity('${
              item.id
            }', ${itemQuantity + 1})">+</button>
          </div>
          <div class="cart-item-price">$${itemTotal.toLocaleString()}</div>
          <button class="remove-btn" onclick="removeItem('${
            item.id
          }')">Eliminar</button>
        </div>
      `;
    });

    cartContentEl.innerHTML = html;

    // Mostrar resumen
    if (cartSummaryEl) {
      cartSummaryEl.style.display = "block";
      document.getElementById(
        "subtotal"
      ).textContent = `$${subtotal.toLocaleString()}`;
      document.getElementById(
        "total"
      ).textContent = `$${subtotal.toLocaleString()}`;
    }

    console.log("✅ Items del carrito mostrados:", items.length);
  } catch (error) {
    console.error("❌ Error mostrando items del carrito:", error);
  }
}

// Mostrar carrito vacío
function showEmptyCart() {
  try {
    const cartContentEl = document.getElementById("cart-content");
    const cartSummaryEl = document.getElementById("cart-summary");

    if (cartContentEl) {
      cartContentEl.innerHTML = `
        <div class="empty-cart" style="text-align: center; padding: 40px; color: #666;">
          <div style="font-size: 48px; margin-bottom: 20px;">🛒</div>
          <h2 style="color: #333; margin-bottom: 10px;">Tu carrito está vacío</h2>
          <p style="margin-bottom: 20px;">Agrega algunos productos para comenzar tu compra</p>
          <a href="../index.html" style="display: inline-block; padding: 12px 24px; background: #CD844D; color: white; text-decoration: none; border-radius: 6px; font-weight: 500; transition: background 0.2s;">Ver Productos</a>
        </div>
      `;
    }

    if (cartSummaryEl) {
      cartSummaryEl.style.display = "none";
    }
  } catch (error) {
    console.error("❌ Error mostrando carrito vacío:", error);
  }
}

// Actualizar cantidad de un item
async function updateQuantity(itemId, newQuantity) {
  try {
    console.log("🔄 Actualizando cantidad:", itemId, newQuantity);

    if (newQuantity < 1) {
      await removeItem(itemId);
      return;
    }

    if (!window.supabase) {
      console.warn("⚠️ Supabase no disponible");
      return;
    }

    // Actualizar cantidad en Supabase (tanto quantity como qty)
    const { error } = await window.supabase
      .from("cart_items")
      .update({
        quantity: newQuantity,
        qty: newQuantity,
      })
      .eq("id", itemId);

    if (error) {
      console.error("❌ Error actualizando cantidad:", error);
      return;
    }

    // Recargar carrito
    await loadCartItems();

    console.log("✅ Cantidad actualizada");
  } catch (error) {
    console.error("❌ Error actualizando cantidad:", error);
  }
}

// Remover item del carrito
async function removeItem(itemId) {
  try {
    console.log("🗑️ Removiendo item:", itemId);

    if (!window.supabase) {
      console.warn("⚠️ Supabase no disponible");
      return;
    }

    // Eliminar item de Supabase
    const { error } = await window.supabase
      .from("cart_items")
      .delete()
      .eq("id", itemId);

    if (error) {
      console.error("❌ Error removiendo item:", error);
      return;
    }

    // Recargar carrito
    await loadCartItems();

    console.log("✅ Item removido");
  } catch (error) {
    console.error("❌ Error removiendo item:", error);
  }
}

// Configurar botones
function setupButtons() {
  try {
    // Botón de finalizar compra
    const checkoutBtn = document.getElementById("checkout-btn");
    if (checkoutBtn) {
      checkoutBtn.addEventListener("click", async () => {
        try {
          console.log("💳 Finalizando compra...");

          if (!window.supabase) {
            console.warn("⚠️ Supabase no disponible");
            return;
          }

          // Obtener usuario actual
          const {
            data: { user },
          } = await window.supabase.auth.getUser();
          if (!user) {
            console.log("👤 Usuario no autenticado");
            return;
          }

          // Cambiar estado del carrito a 'pending'
          const { data: cart } = await window.supabase
            .from("carts")
            .select("id")
            .eq("customer_id", user.id)
            .eq("status", "open")
            .single();

          if (cart) {
            await window.supabase
              .from("carts")
              .update({ status: "pending" })
              .eq("id", cart.id);

            // Redirigir al dashboard
            window.location.href = "dashboard.html";
          }
        } catch (error) {
          console.error("❌ Error finalizando compra:", error);
        }
      });
    }

    // Botón de limpiar carrito
    const clearCartBtn = document.getElementById("clear-cart-btn");
    if (clearCartBtn) {
      clearCartBtn.addEventListener("click", async () => {
        try {
          if (confirm("¿Estás seguro de que quieres limpiar el carrito?")) {
            console.log("🧹 Limpiando carrito...");

            if (!window.supabase) {
              console.warn("⚠️ Supabase no disponible");
              return;
            }

            // Obtener usuario actual
            const {
              data: { user },
            } = await window.supabase.auth.getUser();
            if (!user) {
              console.log("👤 Usuario no autenticado");
              return;
            }

            // Obtener carrito abierto
            const { data: cart } = await window.supabase
              .from("carts")
              .select("id")
              .eq("customer_id", user.id)
              .eq("status", "open")
              .single();

            if (cart) {
              // Eliminar todos los items del carrito
              await window.supabase
                .from("cart_items")
                .delete()
                .eq("cart_id", cart.id);

              // Recargar carrito
              await loadCartItems();
            }
          }
        } catch (error) {
          console.error("❌ Error limpiando carrito:", error);
        }
      });
    }

    console.log("✅ Botones configurados");
  } catch (error) {
    console.error("❌ Error configurando botones:", error);
  }
}

// Exponer funciones globalmente
window.updateQuantity = updateQuantity;
window.removeItem = removeItem;

// Ejecutar cuando se carga la página
document.addEventListener("DOMContentLoaded", initCart);

// También ejecutar si la página ya está cargada
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCart);
} else {
  initCart();
}
