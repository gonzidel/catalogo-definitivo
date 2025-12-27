// client/dashboard-simple.js - Dashboard simplificado que no se bloquea

import { supabase } from "../scripts/supabase-client.js";

// Función principal para inicializar el dashboard (no bloqueante)
async function initDashboard() {
  console.log("🏠 Inicializando dashboard (modo simple)...");

  // Ocultar loader inmediatamente - FORZAR
  const loader = document.getElementById("loader");
  if (loader) {
    loader.style.display = "none";
    loader.style.visibility = "hidden";
    loader.style.opacity = "0";
    console.log("✅ Loader ocultado");
  } else {
    console.warn("⚠️ No se encontró el loader");
  }

  // Mostrar contenido básico inmediatamente
  showBasicDashboard();

  // Intentar cargar datos en segundo plano
  setTimeout(() => {
    loadUserData();
  }, 100);

  console.log("✅ Dashboard inicializado (modo simple)");
}

// Función para mostrar dashboard básico
function showBasicDashboard() {
  console.log("📋 Mostrando dashboard básico...");

  const dashboardContent = document.querySelector(".dashboard-content");
  if (dashboardContent) {
    dashboardContent.innerHTML = `
      <div class="cart-section">
        <h2 class="section-title">🛒 Carrito Actual</h2>
        <div id="cart-info">
          <p>Verificando carrito...</p>
        </div>
      </div>
      
      <div class="orders-section">
        <h2 class="section-title">📋 Mis Pedidos</h2>
        <div id="orders-section">
          <p>Verificando pedidos...</p>
        </div>
      </div>
    `;
    console.log("✅ Dashboard básico mostrado");
  } else {
    console.error("❌ No se encontró .dashboard-content");
  }
}

// Función para cargar datos del usuario (no bloqueante)
async function loadUserData() {
  try {
    console.log("🔍 Verificando sesión...");

    // Verificar sesión con timeout muy corto
    const sessionPromise = supabase.auth.getSession();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), 1000)
    );

    const {
      data: { session },
    } = await Promise.race([sessionPromise, timeoutPromise]);

    if (!session) {
      console.log("👤 No hay sesión activa");
      showNoSessionMessage();
      return;
    }

    console.log("✅ Usuario autenticado:", session.user.email);

    // Mostrar información del usuario
    displayUserInfo(session.user);

    // Cargar datos en segundo plano
    loadCartData(session.user.id);
    loadOrdersData(session.user.id);
  } catch (error) {
    console.warn("⚠️ Error cargando datos del usuario:", error.message);
    showErrorMessage("No se pudo verificar la sesión");
  }
}

// Función para mostrar información del usuario
function displayUserInfo(user) {
  try {
    const userName = document.getElementById("user-name");
    const userEmail = document.getElementById("user-email");

    if (userName) {
      userName.textContent =
        user.user_metadata?.full_name || user.email?.split("@")[0] || "Usuario";
    }

    if (userEmail) {
      userEmail.textContent = user.email;
    }

    console.log("✅ Información del usuario mostrada");
  } catch (error) {
    console.error("❌ Error mostrando información del usuario:", error);
  }
}

// Función para cargar datos del carrito
async function loadCartData(userId) {
  try {
    console.log("🛒 Cargando carrito...");

    const { data: cartItems, error } = await supabase
      .from("cart_items")
      .select("*")
      .eq("cart_id", userId);

    if (error) {
      console.warn("⚠️ Error cargando carrito:", error.message);
      showCartError();
      return;
    }

    const cartInfo = document.getElementById("cart-info");
    if (cartInfo) {
      if (cartItems && cartItems.length > 0) {
        const totalItems = cartItems.reduce(
          (sum, item) => sum + (item.quantity || 0),
          0
        );
        cartInfo.innerHTML = `
          <h3>Carrito Actual</h3>
          <p>Total de items: ${totalItems}</p>
          <p>Items: ${cartItems.length}</p>
        `;
      } else {
        cartInfo.innerHTML = `
          <h3>Carrito Actual</h3>
          <p>No hay items en el carrito</p>
        `;
      }
    }

    console.log("✅ Carrito cargado");
  } catch (error) {
    console.warn("⚠️ Error cargando carrito:", error.message);
    showCartError();
  }
}

// Función para cargar datos de pedidos
async function loadOrdersData(userId) {
  try {
    console.log("📋 Cargando pedidos...");

    const { data: orders, error } = await supabase
      .from("orders")
      .select("*")
      .eq("customer_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("⚠️ Error cargando pedidos:", error.message);
      showOrdersError();
      return;
    }

    const ordersSection = document.getElementById("orders-section");
    if (ordersSection) {
      if (orders && orders.length > 0) {
        ordersSection.innerHTML = `
          <h3>Mis Pedidos</h3>
          <div class="orders-list">
            ${orders
              .map(
                (order) => `
              <div class="order-item">
                <p><strong>Pedido #${order.id}</strong></p>
                <p>Estado: ${order.status || "Pendiente"}</p>
                <p>Total: $${order.total_amount || "0"}</p>
                <p>Fecha: ${new Date(order.created_at).toLocaleDateString()}</p>
              </div>
            `
              )
              .join("")}
          </div>
        `;
      } else {
        ordersSection.innerHTML = `
          <h3>Mis Pedidos</h3>
          <p>No tienes pedidos aún.</p>
        `;
      }
    }

    console.log("✅ Pedidos cargados");
  } catch (error) {
    console.warn("⚠️ Error cargando pedidos:", error.message);
    showOrdersError();
  }
}

// Función para mostrar mensaje de no sesión
function showNoSessionMessage() {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (dashboardContent) {
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
}

// Función para mostrar mensaje de error
function showErrorMessage(message) {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (dashboardContent) {
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
          <strong>Error cargando datos</strong>
          <p style="margin: 5px 0 0 0; font-size: 14px;">
            ${message}. <button onclick="window.location.reload()" style="color: #CD844D; text-decoration: underline; background: none; border: none; cursor: pointer;">Reintentar</button>
          </p>
        </div>
      </div>
    `;
    dashboardContent.insertBefore(messageDiv, dashboardContent.firstChild);
  }
}

// Función para mostrar error del carrito
function showCartError() {
  const cartInfo = document.getElementById("cart-info");
  if (cartInfo) {
    cartInfo.innerHTML = `
      <h3>Carrito Actual</h3>
      <p style="color: #dc3545;">Error cargando carrito</p>
      <button onclick="window.location.reload()" style="padding: 5px 10px; background: #6c757d; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">Reintentar</button>
    `;
  }
}

// Función para mostrar error de pedidos
function showOrdersError() {
  const ordersSection = document.getElementById("orders-section");
  if (ordersSection) {
    ordersSection.innerHTML = `
      <h3>Mis Pedidos</h3>
      <p style="color: #dc3545;">Error cargando pedidos</p>
      <button onclick="window.location.reload()" style="padding: 5px 10px; background: #6c757d; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">Reintentar</button>
    `;
  }
}

// Inicializar cuando se carga la página
document.addEventListener("DOMContentLoaded", initDashboard);

console.log("🔧 Script del dashboard simple cargado");
