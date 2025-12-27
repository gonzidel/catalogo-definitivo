// admin/admin-auth.js (simple y fiable)
import { supabase } from "../scripts/supabase-client.js";

// Función para obtener elementos del DOM de forma segura
function getDOMElements() {
  return {
    loginForm: document.getElementById("login-form"),
    loggedBox: document.getElementById("logged"),
    loginBtn: document.getElementById("login-btn"),
    signupBtn: document.getElementById("signup-btn"),
    resetBtn: document.getElementById("reset-btn"),
    logoutBtn: document.getElementById("logout-btn"),
    forceLogoutBtn: document.getElementById("force-logout"),
    emailEl: document.getElementById("email"),
    passEl: document.getElementById("password"),
    loginErr: document.getElementById("login-error"),
    userEmail: document.getElementById("user-email")
  };
}

function isIndexPage() {
  const currentPath = window.location.pathname || "";
  const currentHref = window.location.href || "";
  // Detectar si estamos en la página index (panel principal)
  return (
    currentPath.includes("index.html") ||
    currentPath.endsWith("/admin/") ||
    currentPath.endsWith("/admin") ||
    currentHref.includes("admin/index.html") ||
    (currentPath === "/admin/" && !currentHref.includes(".html"))
  );
}

function redirectToPanel() {
  // Si estamos en index.html, mostrar el dashboard en lugar de redirigir
  if (isIndexPage()) {
    updateSessionUI();
    return;
  }
  // En otras páginas, redirigir al panel principal
  try {
    const target = window.redirectTarget || "./index.html";
    window.location.replace(target);
  } catch {
    const fallback = window.redirectTarget || "./index.html";
    window.location.href = fallback;
  }
}

async function updateSessionUI() {
  try {
    // Obtener elementos del DOM de forma segura
    let attempts = 0;
    let loginForm, loggedBox, userEmail, loginErr;
    
    // Solo intentar obtener elementos si estamos en una página que los tiene (index.html)
    // En otras páginas como orders.html, estos elementos no existen y no debemos intentar buscarlos
    const isIndexPage = window.location.pathname.includes("index.html") || 
                        window.location.pathname.endsWith("/admin/") ||
                        window.location.pathname.endsWith("/admin");
    
    if (!isIndexPage) {
      // Si no estamos en index.html, no intentar actualizar la UI de login
      // Las otras páginas manejan su propia autenticación
      return;
    }
    
    while (attempts < 10) {
      const elements = getDOMElements();
      loginForm = elements.loginForm;
      loggedBox = elements.loggedBox;
      userEmail = elements.userEmail;
      loginErr = elements.loginErr;
      
      if (loginForm && loggedBox) {
        break;
      }
      
      // Solo mostrar advertencia si realmente estamos esperando (no en el primer intento)
      if (attempts > 0) {
        console.warn(`Elementos del DOM no están listos (intento ${attempts + 1}/10), esperando...`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }

    if (!loginForm || !loggedBox) {
      // Solo mostrar error si realmente estamos en index.html y deberían existir
      if (isIndexPage) {
        console.error("❌ Elementos del DOM no están disponibles después de varios intentos");
      }
      return;
    }

    console.log("🔍 Verificando sesión...");
    const { data, error } = await supabase.auth.getSession();
    
    if (error) {
      console.error("❌ Error obteniendo sesión:", error);
      // Marcar como loaded solo cuando vamos a mostrar el login
      const authSection = document.getElementById("auth-section");
      if (authSection) {
        authSection.classList.add("loaded");
      }
      hideLoadingSpinner();
      loginForm.style.display = "block";
      loggedBox.style.display = "none";
      if (userEmail) userEmail.textContent = "";
      return;
    }

    const has = !!data?.session;
    console.log(`📊 Estado de sesión: ${has ? "ACTIVA" : "INACTIVA"}`);

    // NO marcar como loaded aún - esperar a determinar si hay sesión o no
    // Esto evita que el CSS muestre el login automáticamente

    if (has) {
      // Verificar que el usuario sea admin antes de mostrar el dashboard
      const { isAdmin } = await import("./permissions-helper.js");
      const userIsAdmin = await isAdmin();
      
      if (!userIsAdmin) {
        console.log("⚠️ Usuario no autorizado como admin, mostrando mensaje");
        // Marcar como loaded solo cuando vamos a mostrar el login
        const authSection = document.getElementById("auth-section");
        if (authSection) {
          authSection.classList.add("loaded");
        }
        hideLoadingSpinner();
        loginForm.style.display = "block";
        loggedBox.style.display = "none";
        if (loginErr) {
          loginErr.textContent = "No tienes autorización para acceder al panel de administración. Solo los administradores autorizados pueden acceder.";
          loginErr.style.color = "#e74c3c";
        }
        // Cerrar sesión automáticamente
        await supabase.auth.signOut();
        return;
      }
      
      console.log("✅ Sesión activa y usuario autorizado");
      console.log("👤 Usuario:", data.session.user?.email || "Sin email");
      
      // Preparar el dashboard pero NO mostrarlo aún
      // El script de filtrado de módulos se encargará de mostrarlo cuando esté listo
      loginForm.style.display = "none";
      // NO mostrar loggedBox aún - el filtrado de módulos lo mostrará cuando esté listo
      loggedBox.style.display = "none";
      if (userEmail) {
        userEmail.textContent = `Conectado: ${
          data.session.user?.email || ""
        }`;
      }
      
      // Notificar que la autenticación está lista para que el filtrado de módulos continúe
      window.authReady = true;
      if (window.onAuthReady) {
        window.onAuthReady();
      }
    } else {
      console.log("⚠️ No hay sesión activa, mostrando login");
      // Marcar como loaded solo cuando vamos a mostrar el login
      const authSection = document.getElementById("auth-section");
      if (authSection) {
        authSection.classList.add("loaded");
      }
      hideLoadingSpinner();
      loginForm.style.display = "block";
      loggedBox.style.display = "none";
      if (userEmail) {
        userEmail.textContent = "";
      }
      // Asegurar que el spinner esté oculto
      const spinner = document.getElementById("loading-spinner");
      if (spinner) {
        spinner.style.display = "none";
      }
    }
  } catch (error) {
    console.error("❌ Error actualizando UI de sesión:", error);
    // Marcar como loaded solo cuando vamos a mostrar el login
    const authSection = document.getElementById("auth-section");
    if (authSection) {
      authSection.classList.add("loaded");
    }
    // En caso de error, mostrar formulario de login
    hideLoadingSpinner();
    if (loginForm) loginForm.style.display = "block";
    if (loggedBox) loggedBox.style.display = "none";
    if (userEmail) userEmail.textContent = "";
  }
}

// Función para ocultar el spinner de carga
function hideLoadingSpinner() {
  const spinner = document.getElementById("loading-spinner");
  if (spinner) {
    spinner.style.display = "none";
  }
}
window.hideLoadingSpinner = hideLoadingSpinner;
window.updateSessionUI = updateSessionUI;

// Entrar
document.addEventListener("DOMContentLoaded", () => {
  const { loginBtn, loginErr, emailEl, passEl } = getDOMElements();
  
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      const elements = getDOMElements();
      if (!elements.loginErr) return;

      elements.loginErr.textContent = "";
      const email = elements.emailEl?.value?.trim();
      const password = elements.passEl?.value;

      if (!email || !password) {
        elements.loginErr.textContent = "Ingresá email y contraseña";
        return;
      }

      try {
        elements.loginBtn.disabled = true;
        console.log("🔐 Intentando login para:", email);
        
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) {
          console.error("❌ Error en login:", error);
          console.error("Código de error:", error.status);
          console.error("Mensaje:", error.message);
          
          // Mensaje más descriptivo según el tipo de error
          if (error.message.includes("Invalid login credentials")) {
            elements.loginErr.textContent = "Credenciales inválidas. Si te registraste con Google, necesitas establecer una contraseña primero. Contacta al administrador.";
          } else {
            elements.loginErr.textContent = error.message;
          }
          elements.loginErr.style.color = "#e74c3c";
          return;
        }

        console.log("✅ Login exitoso para:", email);
        console.log("Usuario:", data.user);

        // Limpiar caché de permisos después del login
        if (window.clearPermissionsCache) {
          window.clearPermissionsCache();
        } else {
          // Importar y limpiar caché
          try {
            const { clearPermissionsCache } = await import("./permissions-helper.js");
            clearPermissionsCache();
          } catch (e) {
            console.warn("No se pudo limpiar caché de permisos:", e);
          }
        }

        // Esperar un momento para que la sesión se establezca completamente
        await new Promise(resolve => setTimeout(resolve, 300));

        redirectToPanel();
      } catch (e) {
        console.error("Error en login:", e);
        elements.loginErr.textContent = e.message || "Error inesperado";
        elements.loginErr.style.color = "#e74c3c";
      } finally {
        elements.loginBtn.disabled = false;
      }
    });
  }
  
  // Enter en contraseña
  const { passEl: passElForEnter, loginBtn: loginBtnForEnter } = getDOMElements();
  if (passElForEnter && loginBtnForEnter) {
    passElForEnter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        loginBtnForEnter?.click();
      }
    });
  }
  
  // Registro de nuevo usuario
  const { signupBtn } = getDOMElements();
  if (signupBtn) {
    signupBtn.addEventListener("click", async () => {
      const elements = getDOMElements();
      if (!elements.loginErr) return;

      elements.loginErr.textContent = "";
      const email = elements.emailEl?.value?.trim();
      const password = elements.passEl?.value;

      if (!email || !password) {
        elements.loginErr.textContent = "Ingresá email y contraseña para registrarte";
        elements.loginErr.style.color = "#e74c3c";
        return;
      }

      if (password.length < 6) {
        elements.loginErr.textContent = "La contraseña debe tener al menos 6 caracteres";
        elements.loginErr.style.color = "#e74c3c";
        return;
      }

      try {
        elements.signupBtn.disabled = true;
        elements.signupBtn.textContent = "Registrando...";
        
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/admin/index.html`
          }
        });

        if (error) {
          elements.loginErr.textContent = `Error: ${error.message}`;
          elements.loginErr.style.color = "#e74c3c";
          elements.signupBtn.textContent = "Registrarme (dev)";
          return;
        }

        // Verificar si el usuario fue creado
        if (!data?.user) {
          elements.loginErr.textContent = "Error: No se pudo crear el usuario. Verifica la configuración de Supabase.";
          elements.loginErr.style.color = "#e74c3c";
          elements.signupBtn.textContent = "Registrarme (dev)";
          return;
        }

        // IMPORTANTE: El usuario registrado NO se agrega automáticamente como admin
        // Solo el super_admin puede agregar colaboradores desde la página de Colaboradores
        // Esto previene que usuarios se auto-registren como administradores

        // Intentar confirmar el email automáticamente usando la función RPC
        // Esto evita el problema de que el email no se confirme automáticamente
        try {
          const { data: confirmData, error: confirmError } = await supabase
            .rpc('confirm_user_email', {
              p_user_id: data.user.id
            });
          
          if (confirmError) {
            console.warn("No se pudo confirmar el email automáticamente:", confirmError);
            // Intentar método alternativo por email
            const { error: confirmByEmailError } = await supabase
              .rpc('confirm_user_email_by_address', {
                p_email: email
              });
            
            if (confirmByEmailError) {
              console.warn("Método alternativo también falló:", confirmByEmailError);
            }
          } else {
            console.log("Email confirmado automáticamente:", confirmData);
          }
        } catch (confirmErr) {
          console.warn("Error al intentar confirmar email:", confirmErr);
        }

        // Verificar si se requiere confirmación de email
        // Si data.user.email_confirmed_at es null, significa que se requiere confirmación
        const requiresEmailConfirmation = !data.user.email_confirmed_at;
        
        // IMPORTANTE: Informar al usuario que debe ser autorizado por el super_admin
        if (requiresEmailConfirmation) {
          elements.loginErr.innerHTML = `
            <div style="color: #f39c12; background: #fff3cd; padding: 12px; border-radius: 6px; border: 1px solid #ffc107;">
              <strong>⚠️ Registro exitoso, pero el correo de confirmación puede no haberse enviado.</strong><br/>
              <small style="display:block; margin-top: 8px;">
                <strong>IMPORTANTE:</strong> Tu cuenta ha sido creada, pero NO tienes acceso al panel de administración.<br/>
                El super administrador debe autorizarte como colaborador desde la página de Colaboradores.<br/>
                Solo los usuarios autorizados pueden acceder al panel de administración.
              </small>
            </div>
          `;
          elements.loginErr.style.color = "#f39c12";
        } else {
          elements.loginErr.innerHTML = `
            <div style="color: #090; background: #d4edda; padding: 12px; border-radius: 6px; border: 1px solid #28a745;">
              <strong>✅ Registro exitoso. Tu cuenta está lista.</strong><br/>
              <small style="display:block; margin-top: 8px;">
                <strong>IMPORTANTE:</strong> Tu cuenta ha sido creada, pero NO tienes acceso al panel de administración.<br/>
                El super administrador debe autorizarte como colaborador desde la página de Colaboradores.<br/>
                Solo los usuarios autorizados pueden acceder al panel de administración.
              </small>
            </div>
          `;
          elements.loginErr.style.color = "#090";
        }
        
        // Limpiar campos
        if (elements.emailEl) elements.emailEl.value = "";
        if (elements.passEl) elements.passEl.value = "";
        
        // Cerrar sesión automáticamente ya que el usuario no está autorizado como admin
        setTimeout(async () => {
          await supabase.auth.signOut();
          elements.loginErr.textContent = "Por favor, contacta al super administrador para que te autorice como colaborador.";
          elements.loginErr.style.color = "#666";
        }, 5000);
        
      } catch (e) {
        console.error("Error en registro:", e);
        elements.loginErr.textContent = `Error inesperado: ${e.message || String(e)}`;
        elements.loginErr.style.color = "#e74c3c";
      } finally {
        elements.signupBtn.disabled = false;
        elements.signupBtn.textContent = "Registrarme (dev)";
      }
    });
  }

  // Reset contraseña
  const { resetBtn } = getDOMElements();
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      const elements = getDOMElements();
      if (!elements.loginErr) return;

      elements.loginErr.textContent = "";
      const email = elements.emailEl?.value?.trim();

      if (!email) {
        elements.loginErr.textContent = "Ingresá tu email";
        return;
      }

      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/admin/reset-password.html`,
        });

        elements.loginErr.textContent = error ? error.message : "Te enviamos un correo";
        if (!error) elements.loginErr.style.color = "#090";
      } catch (e) {
        console.error("Error en reset password:", e);
        elements.loginErr.textContent = "Error al enviar correo";
      }
    });
  }

  // Cerrar sesión (bloque logueado)
  const { logoutBtn } = getDOMElements();
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await supabase.auth.signOut();
        await updateSessionUI();
      } catch (error) {
        console.error("Error al cerrar sesión:", error);
      }
    });
  }

  // Cerrar sesión forzada (limpia tokens "sb-*")
  const { forceLogoutBtn } = getDOMElements();
  if (forceLogoutBtn) {
    forceLogoutBtn.addEventListener("click", async () => {
      try {
        await supabase.auth.signOut();
      } catch (error) {
        console.error("Error en signOut:", error);
      }

      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith("sb-") && k.includes("auth"))
          .forEach((k) => localStorage.removeItem(k));
      } catch (error) {
        console.error("Error limpiando localStorage:", error);
      }

      location.reload();
    });
  }
});


// Función para inicializar la UI cuando la página carga
async function initializeUI() {
  try {
    console.log("🔍 Iniciando verificación de sesión...");
    console.log("📍 URL actual:", window.location.href);
    
    // Verificar si hay un error de reset de contraseña en la URL
    const hash = window.location.hash;
    if (hash.includes("error=") && hash.includes("otp_expired")) {
      const params = new URLSearchParams(hash.substring(1));
      const errorDescription = params.get("error_description") || "El enlace ha expirado";
      const elements = getDOMElements();
      if (elements.loginErr) {
        elements.loginErr.innerHTML = `
          <div style="color: #e74c3c; background: #f8d7da; padding: 12px; border-radius: 6px; border: 1px solid #f5c6cb;">
            <strong>⚠️ Enlace expirado</strong><br/>
            <small>${decodeURIComponent(errorDescription.replace(/\+/g, ' '))}</small><br/>
            <small style="display:block; margin-top: 8px;">Por favor, solicita un nuevo enlace de restablecimiento de contraseña.</small>
          </div>
        `;
        elements.loginErr.style.color = "#e74c3c";
      }
      // Limpiar el hash para evitar mostrar el error nuevamente
      window.history.replaceState(null, '', window.location.pathname);
    }
    
    // Verificar si estamos en orders.html o si skipPanelRedirect está activo
    const currentPath = window.location.pathname || window.location.href;
    const currentHref = window.location.href;
    const isOrdersPage = currentPath.includes("orders.html") || currentHref.includes("orders.html");
    
    // NO redirigir si estamos en orders.html - dejar que orders.js maneje su propia lógica
    if (isOrdersPage || window.skipPanelRedirect === true) {
      console.log("📋 Página de pedidos detectada, actualizando UI sin redirección");
      await updateSessionUI();
      return; // Salir temprano para no interferir
    }
    
    // Verificar sesión primero
    console.log("🔄 Verificando sesión...");
    const { data, error } = await supabase.auth.getSession();
    
    if (error) {
      console.error("❌ Error verificando sesión:", error);
      // Si hay error y no estamos en index.html, ir a index.html que mostrará login
      if (!isIndexPage()) {
        window.location.href = "./index.html";
      } else {
        await updateSessionUI();
      }
      return;
    }
    
    const hasSession = !!data?.session;
    
    // Si estamos en index.html, siempre actualizar la UI (mostrará login o dashboard según sesión)
    if (isIndexPage()) {
      console.log("🏠 Página index detectada, actualizando UI");
      // Esperar un momento para asegurar que el DOM esté completamente cargado
      await new Promise(resolve => setTimeout(resolve, 100));
      await updateSessionUI();
      return;
    }
    
    // Si NO hay sesión y estamos en otra página, redirigir al login (index.html)
    if (!hasSession) {
      console.log("⚠️ No hay sesión activa, redirigiendo a login");
      console.log("🔄 Redirigiendo a index.html (login)...");
      window.location.href = "./index.html";
      return;
    }
    
    // Si hay sesión y estamos en otra página (products, stock, orders, import-export),
    // NO redirigir - dejar que la página funcione normalmente
    // Las páginas individuales usarán requireAuth() para verificar sesión
    console.log("✅ Sesión activa - permitiendo acceso a la página");
  } catch (error) {
    console.error("❌ Error al cargar sesión:", error);
    await updateSessionUI();
  }
}

// Al cargar: si hay sesión, ir al panel; si no, mostrar login
document.addEventListener("DOMContentLoaded", initializeUI);

// También ejecutar cuando la página se carga completamente (por si acaso)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeUI);
} else {
  // DOM ya está listo, ejecutar inmediatamente
  initializeUI();
}

export async function requireAuth() {
  try {
    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      window.location.href = "./index.html";
      return null;
    }

    // Verificar que el usuario sea admin
    const { requireAdminAuth } = await import("./permissions-helper.js");
    const isAuthorized = await requireAdminAuth("./index.html");
    
    if (!isAuthorized) {
      return null;
    }

    return data.session.user || (await supabase.auth.getUser()).data?.user;
  } catch (error) {
    console.error("Error en requireAuth:", error);
    window.location.href = "./index.html";
    return null;
  }
}
