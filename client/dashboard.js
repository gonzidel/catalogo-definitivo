// client/dashboard.js - Dashboard del cliente
import { supabase } from "../scripts/supabase-client.js";
import { hasRegisteredPasskeys, registerPasskey, checkPasskeySupport } from "../scripts/passkeys.js";
import { hasInitialProfileComplete } from "./auth-helper.js";

// Función para verificar autenticación y perfil
async function checkAuthAndProfile() {
  try {
    console.log("🔍 Verificando autenticación y perfil...");

    // Verificar sesión
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError) {
      console.error("❌ Error obteniendo sesión:", sessionError);
      return {
        hasSession: false,
        hasProfile: false,
        error: sessionError.message,
      };
    }

    if (!session) {
      console.log("👤 No hay sesión activa");
      return { hasSession: false, hasProfile: false };
    }

    console.log("✅ Sesión activa encontrada:", session.user.email);

    // Verificar si tiene perfil inicial completo (DNI, provincia, ciudad)
    const hasInitialProfile = await hasInitialProfileComplete();
    
    if (!hasInitialProfile) {
      console.log("📝 Usuario no tiene perfil inicial completo, redirigiendo a complete-profile.html");
      window.location.replace("./complete-profile.html");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: true,
      };
    }

    // Verificar datos del cliente (con timeout)
    let customer = null;
    let customerError = null;

    try {
      const customerResult = await Promise.race([
        supabase
          .from("customers")
          .select("full_name, phone, address, dni, province, city, customer_number")
          .eq("id", session.user.id)
          .single(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 5000)
        ),
      ]);

      customer = customerResult.data;
      customerError = customerResult.error;
    } catch (timeoutError) {
      console.warn(
        "⚠️ Timeout obteniendo datos del cliente, continuando sin perfil"
      );
      customerError = { message: "Timeout" };
    }

    console.log("📊 Datos del cliente:");
    console.log("- customer:", customer);
    console.log("- customerError:", customerError);

    // Si no hay perfil, redirigir a complete-profile
    if (customerError && customerError.code !== "PGRST116") {
      console.log("📝 Error obteniendo perfil, redirigiendo a complete-profile");
      window.location.replace("./complete-profile.html");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: true,
      };
    }

    if (!customer) {
      console.log("📝 Sin perfil, redirigiendo a complete-profile");
      window.location.replace("./complete-profile.html");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: true,
      };
    }

    // Verificar campos obligatorios iniciales
    const hasAllInitialFields =
      customer.full_name && 
      customer.phone && 
      customer.dni && 
      customer.province && 
      customer.city;

    console.log("📋 Campos del cliente:");
    console.log("- full_name:", customer.full_name);
    console.log("- phone:", customer.phone);
    console.log("- dni:", customer.dni);
    console.log("- province:", customer.province);
    console.log("- city:", customer.city);
    console.log("- hasAllInitialFields:", hasAllInitialFields);

    if (!hasAllInitialFields) {
      console.log("📝 Perfil inicial incompleto, redirigiendo a complete-profile");
      window.location.replace("./complete-profile.html");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        customer: customer,
        redirecting: true,
      };
    }

    // Verificar si el cliente es de Resistencia-Chaco
    const isResistenciaChaco = 
      customer.city && 
      customer.province && 
      customer.city.toLowerCase().trim() === "resistencia" &&
      customer.province.toLowerCase().trim() === "chaco";

    if (isResistenciaChaco) {
      console.log("📍 Cliente de Resistencia-Chaco detectado, redirigiendo a customer.html");
      
      // Obtener customer_number (puede que necesite generarse)
      let customerNumber = customer.customer_number;
      
      if (!customerNumber) {
        // Si no tiene customer_number, intentar obtenerlo o generarlo
        console.log("⚠️ Cliente no tiene customer_number, intentando obtenerlo...");
        const { data: updatedCustomer, error: updateError } = await supabase
          .from("customers")
          .select("customer_number")
          .eq("id", session.user.id)
          .single();
        
        if (!updateError && updatedCustomer?.customer_number) {
          customerNumber = updatedCustomer.customer_number;
        } else {
          // Si aún no tiene, esperar un momento y reintentar (el trigger debería generarlo)
          console.log("⏳ Esperando generación de customer_number...");
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const { data: retryCustomer } = await supabase
            .from("customers")
            .select("customer_number")
            .eq("id", session.user.id)
            .single();
          
          if (retryCustomer?.customer_number) {
            customerNumber = retryCustomer.customer_number;
          }
        }
      }
      
      if (customerNumber) {
        console.log("✅ Redirigiendo a customer.html con código:", customerNumber);
        window.location.replace(`../customer.html?code=${encodeURIComponent(customerNumber)}`);
        return {
          hasSession: true,
          hasProfile: true,
          user: session.user,
          customer: customer,
          redirecting: true,
        };
      } else {
        console.error("❌ No se pudo obtener customer_number para cliente de Resistencia-Chaco");
        // Continuar al dashboard normal como fallback
      }
    }

    console.log("✅ Usuario tiene perfil inicial completo");
    return {
      hasSession: true,
      hasProfile: true,
      user: session.user,
      customer: customer,
    };
  } catch (error) {
    console.error("❌ Error verificando autenticación y perfil:", error);
    return { hasSession: false, hasProfile: false, error: error.message };
  }
}

// Función para mostrar información del usuario
function displayUserInfo(user, customer) {
  try {
    console.log("👤 Mostrando información del usuario...");

    const userProfile = document.getElementById("user-profile");
    const userAvatar = document.getElementById("user-avatar");
    const userName = document.getElementById("user-name");

    if (userProfile) {
      userProfile.style.display = "flex";
    }

    if (userAvatar && user.avatar_url) {
      userAvatar.src = user.avatar_url;
      userAvatar.style.display = "block";
    }

    if (userName && customer) {
      userName.textContent = customer.full_name || user.email;
    }

    console.log("✅ Información del usuario mostrada");
  } catch (error) {
    console.error("❌ Error mostrando información del usuario:", error);
  }
}

// Función para cargar items del carrito
async function loadCartItems(customerId) {
  try {
    console.log("🛒 Cargando items del carrito...");

    // Timeout para evitar carga infinita
    const cartPromise = supabase
      .from("cart_items")
      .select("*")
      .eq("cart_id", customerId);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout cargando carrito")), 3000)
    );

    const { data: cartItems, error } = await Promise.race([
      cartPromise,
      timeoutPromise,
    ]);

    if (error) {
      console.error("❌ Error cargando items del carrito:", error);
      showCartError();
      return;
    }

    console.log("📦 Items del carrito cargados:", cartItems);

    // Mostrar información del carrito
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
  } catch (error) {
    console.error("❌ Error cargando items del carrito:", error);
    showCartError();
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

// Función para cargar pedidos
async function loadOrders(customerId) {
  try {
    console.log("📋 Cargando pedidos...");

    // Timeout para evitar carga infinita
    const ordersPromise = supabase
      .from("orders")
      .select("*")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout cargando pedidos")), 3000)
    );

    const { data: orders, error } = await Promise.race([
      ordersPromise,
      timeoutPromise,
    ]);

    if (error) {
      console.error("❌ Error cargando pedidos:", error);
      showOrdersError();
      return;
    }

    console.log("📋 Pedidos cargados:", orders);

    // Mostrar pedidos
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
  } catch (error) {
    console.error("❌ Error cargando pedidos:", error);
    showOrdersError();
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

// Función principal para inicializar el dashboard
async function initDashboard() {
  console.log("🏠 Inicializando dashboard...");

  // Ocultar loader inmediatamente
  const loader = document.getElementById("loader");
  if (loader) {
    loader.style.display = "none";
  }

  // Mostrar contenido básico inmediatamente
  showBasicDashboard();

  // Intentar cargar datos en segundo plano (sin bloquear)
  setTimeout(async () => {
    try {
      const authResult = await checkAuthAndProfile();

      if (authResult.hasSession) {
        console.log("✅ Usuario autenticado, actualizando información...");
        displayUserInfo(authResult.user, authResult.customer);

        // Cargar datos en segundo plano
        loadDataInBackground(authResult.user.id);

        if (authResult.allowBasicAccess && !authResult.hasProfile) {
          showBasicAccessMessage();
        }
      } else {
        console.log("👤 No hay sesión, mostrando dashboard básico");
        showNoSessionMessage();
      }
    } catch (error) {
      console.warn(
        "⚠️ Error cargando datos, continuando con dashboard básico:",
        error
      );
      showErrorMessage(error.message);
    }
  }, 100);

  console.log("✅ Dashboard inicializado (modo no bloqueante)");
}

// Función para mostrar dashboard básico
function showBasicDashboard() {
  const dashboardContent = document.querySelector(".dashboard-content");
  if (dashboardContent) {
    dashboardContent.innerHTML = `
      <div class="cart-section">
        <h2 class="section-title">🛒 Carrito Actual</h2>
        <div id="cart-info">
          <p>Cargando información del carrito...</p>
        </div>
      </div>
      
      <div class="orders-section">
        <h2 class="section-title">📋 Mis Pedidos</h2>
        <div id="orders-section">
          <p>Cargando historial de pedidos...</p>
        </div>
      </div>
    `;
  }
}

// Función para cargar datos en segundo plano
async function loadDataInBackground(userId) {
  // Cargar carrito
  try {
    await loadCartItems(userId);
  } catch (error) {
    console.warn("⚠️ Error cargando carrito:", error);
    showCartError();
  }

  // Cargar pedidos
  try {
    await loadOrders(userId);
  } catch (error) {
    console.warn("⚠️ Error cargando pedidos:", error);
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
function showErrorMessage(errorMessage) {
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
            ${errorMessage}. <button onclick="window.location.reload()" style="color: #CD844D; text-decoration: underline; background: none; border: none; cursor: pointer;">Reintentar</button>
          </p>
        </div>
      </div>
    `;
    dashboardContent.insertBefore(messageDiv, dashboardContent.firstChild);
  }
}

// Función para mostrar mensaje de acceso básico
function showBasicAccessMessage() {
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
          <strong>Acceso Básico</strong>
          <p style="margin: 5px 0 0 0; font-size: 14px;">
            Para una experiencia completa, completa tu perfil 
            <a href="./profile.html" style="color: #CD844D; text-decoration: underline;">aquí</a>.
          </p>
        </div>
      </div>
    `;
    dashboardContent.insertBefore(messageDiv, dashboardContent.firstChild);
  }
}

// Función para verificar y mostrar modal de passkey
async function checkAndShowPasskeyModal() {
  try {
    // Verificar soporte WebAuthn
    if (!checkPasskeySupport()) {
      return; // No mostrar modal si no hay soporte
    }

    // Verificar si ya eligió "omitir" recientemente
    const dismissedAt = localStorage.getItem("passkeys_prompt_dismissed_at");
    if (dismissedAt) {
      const dismissedDate = new Date(dismissedAt);
      const daysSinceDismissed = (Date.now() - dismissedDate.getTime()) / (1000 * 60 * 60 * 24);
      
      // No mostrar si pasaron menos de 7 días
      if (daysSinceDismissed < 7) {
        console.log("Modal de passkey omitido recientemente");
        return;
      }
    }

    // Obtener sesión
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      return; // No hay sesión
    }

    // Verificar si ya tiene passkey registrada
    const hasPasskey = await hasRegisteredPasskeys(session.user.id);
    if (hasPasskey) {
      return; // Ya tiene passkey, no mostrar modal
    }

    // Mostrar modal
    const passkeyModal = document.getElementById("passkey-modal");
    if (passkeyModal) {
      passkeyModal.style.display = "flex";
    }
  } catch (error) {
    console.error("Error verificando passkey:", error);
  }
}

// Función para cerrar modal de passkey
function closePasskeyModal() {
  const passkeyModal = document.getElementById("passkey-modal");
  if (passkeyModal) {
    passkeyModal.style.display = "none";
  }
}

// Función para activar passkey
async function activatePasskey() {
  const activateBtn = document.getElementById("activate-passkey-btn");
  const skipBtn = document.getElementById("skip-passkey-btn");
  const msgDiv = document.getElementById("passkey-modal-msg");

  if (!activateBtn || !msgDiv) return;

  activateBtn.disabled = true;
  activateBtn.textContent = "Registrando...";
  skipBtn.disabled = true;
  msgDiv.style.display = "none";
  msgDiv.className = "";

  try {
    await registerPasskey();
    
    // Éxito
    msgDiv.textContent = "✅ Acceso biométrico activado correctamente";
    msgDiv.className = "msg success";
    msgDiv.style.display = "block";
    
    // Cerrar modal después de 2 segundos
    setTimeout(() => {
      closePasskeyModal();
    }, 2000);
  } catch (error) {
    console.error("Error registrando passkey:", error);
    msgDiv.textContent = error.message || "Error al activar acceso biométrico";
    msgDiv.className = "msg error";
    msgDiv.style.display = "block";
    
    activateBtn.disabled = false;
    activateBtn.textContent = "🔐 Activar Acceso Biométrico";
    skipBtn.disabled = false;
  }
}

// Función para omitir passkey
function skipPasskey() {
  // Guardar timestamp en localStorage
  localStorage.setItem("passkeys_prompt_dismissed_at", new Date().toISOString());
  closePasskeyModal();
}

// Configurar event listeners para modal de passkey
function setupPasskeyModal() {
  const passkeyModal = document.getElementById("passkey-modal");
  const passkeyModalClose = document.getElementById("passkey-modal-close");
  const activateBtn = document.getElementById("activate-passkey-btn");
  const skipBtn = document.getElementById("skip-passkey-btn");

  if (passkeyModalClose) {
    passkeyModalClose.addEventListener("click", closePasskeyModal);
  }

  if (activateBtn) {
    activateBtn.addEventListener("click", activatePasskey);
  }

  if (skipBtn) {
    skipBtn.addEventListener("click", skipPasskey);
  }

  // Cerrar al hacer click fuera del modal
  if (passkeyModal) {
    passkeyModal.addEventListener("click", (e) => {
      if (e.target === passkeyModal) {
        closePasskeyModal();
      }
    });
  }
}

// Inicializar cuando se carga la página
document.addEventListener("DOMContentLoaded", () => {
  initDashboard();
  setupPasskeyModal();
  
  // Verificar y mostrar modal de passkey después de un delay
  setTimeout(() => {
    checkAndShowPasskeyModal();
  }, 1000);
});

console.log("🔧 Script del dashboard cargado");
