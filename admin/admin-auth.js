// admin/admin-auth.js (simple y fiable)
import { invalidate } from "./auth-state.js?v=m260607";
import { supabase, supabaseReady } from "../scripts/supabase-client.js?v=m260607";

// Funci�n para obtener elementos del DOM de forma segura
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
  // Detectar si estamos en la p�gina index (panel principal)
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
  // En otras p�ginas, redirigir al panel principal
  try {
    const target = window.redirectTarget || "./index.html";
    window.location.replace(target);
  } catch {
    const fallback = window.redirectTarget || "./index.html";
    window.location.href = fallback;
  }
}

async function updateSessionUI() {
  await supabaseReady;
  let loginForm, loggedBox, userEmail, loginErr;
  try {
    // Obtener elementos del DOM de forma segura
    let attempts = 0;
    
    // Solo intentar obtener elementos si estamos en una p�gina que los tiene (index.html)
    // En otras p�ginas como orders.html, estos elementos no existen y no debemos intentar buscarlos
    const isIndexPage = window.location.pathname.includes("index.html") || 
                        window.location.pathname.endsWith("/admin/") ||
                        window.location.pathname.endsWith("/admin");
    
    if (!isIndexPage) {
      // Si no estamos en index.html, no intentar actualizar la UI de login
      // Las otras p�ginas manejan su propia autenticaci�n
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
        console.warn(`Elementos del DOM no est�n listos (intento ${attempts + 1}/10), esperando...`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }

    if (!loginForm || !loggedBox) {
      // Solo mostrar error si realmente estamos en index.html y deber�an existir
      if (isIndexPage) {
        console.error("? Elementos del DOM no est�n disponibles despu�s de varios intentos");
      }
      return;
    }

    console.log("?? Verificando sesi�n...");
    const { data, error } = await supabase.auth.getSession();
    
    if (error) {
      console.error("? Error obteniendo sesi�n:", error);
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
    console.log(`?? Estado de sesi�n: ${has ? "ACTIVA" : "INACTIVA"}`);

    // NO marcar como loaded a�n - esperar a determinar si hay sesi�n o no
    // Esto evita que el CSS muestre el login autom�ticamente

    if (has) {
      // Verificar que el usuario sea admin antes de mostrar el dashboard
      const { isAdmin } = await import("./permissions-helper.js?v=m260607");
      const userIsAdmin = await isAdmin();
      
      if (!userIsAdmin) {
        console.log("?? Usuario no autorizado como admin, mostrando mensaje");
        const userEmail = data.session.user?.email || "";
        // Marcar como loaded solo cuando vamos a mostrar el login
        const authSection = document.getElementById("auth-section");
        if (authSection) {
          authSection.classList.add("loaded");
        }
        hideLoadingSpinner();
        loginForm.style.display = "block";
        loggedBox.style.display = "none";
        if (loginErr) {
          loginErr.innerHTML = `
            <div style="color: #e74c3c; background: #f8d7da; padding: 16px; border-radius: 8px; border: 1px solid #f5c6cb; margin-top: 12px;">
              <strong>?? Acceso no autorizado</strong>
              <p style="margin: 12px 0 8px 0; font-size: 14px;">
                Tu cuenta <strong>${userEmail}</strong> no tiene permisos para acceder al panel de administraci�n.
              </p>
              <p style="margin: 0; font-size: 13px; color: #721c24;">
                Para obtener acceso, un super administrador debe agregarte como colaborador desde la p�gina de <strong>Colaboradores</strong>.
              </p>
              <p style="margin: 8px 0 0 0; font-size: 12px; color: #856404;">
                Si crees que esto es un error, contacta al super administrador.
              </p>
            </div>
          `;
          loginErr.style.color = "#e74c3c";
        }
        // Cerrar sesi�n autom�ticamente
        await supabase.auth.signOut();
        return;
      }
      
      console.log("? Sesi�n activa y usuario autorizado");
      console.log("?? Usuario:", data.session.user?.email || "Sin email");
      
      // Preparar el dashboard pero NO mostrarlo a�n
      // El script de filtrado de m�dulos se encargar� de mostrarlo cuando est� listo
      loginForm.style.display = "none";
      // NO mostrar loggedBox a�n - el filtrado de m�dulos lo mostrar� cuando est� listo
      loggedBox.style.display = "none";
      if (userEmail) {
        userEmail.textContent = `Conectado: ${
          data.session.user?.email || ""
        }`;
      }
      
      // Notificar que la autenticaci�n est� lista para que el filtrado de m�dulos contin�e
      window.authReady = true;
      if (window.onAuthReady) {
        window.onAuthReady();
      }
    } else {
      console.log("?? No hay sesi�n activa, mostrando login");
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
      // Asegurar que el spinner est� oculto
      const spinner = document.getElementById("loading-spinner");
      if (spinner) {
        spinner.style.display = "none";
      }
    }
  } catch (error) {
    console.error("? Error actualizando UI de sesi�n:", error);
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

// Funci�n para ocultar el spinner de carga
function hideLoadingSpinner() {
  const spinner = document.getElementById("loading-spinner");
  if (spinner) {
    spinner.style.display = "none";
  }
}
window.hideLoadingSpinner = hideLoadingSpinner;
window.updateSessionUI = updateSessionUI;

let __fylAdminAuthFormListenersBound = false;

function runWhenDocumentInteractive(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => fn(), { once: true });
  } else {
    fn();
  }
}

// Entrar + OAuth + resto de acciones (debe correr aunque DOMContentLoaded ya haya ocurrido:
// admin-auth carga tras supabase-client con top-level await y puede inscribirse demasiado tarde.)
async function setupAuthFormListeners() {
  if (__fylAdminAuthFormListenersBound) {
    return;
  }
  __fylAdminAuthFormListenersBound = true;

  await supabaseReady;
  if (!supabase) {
    console.error(
      "[FYL admin-auth] supabase no est� disponible; no se configuran eventos de login"
    );
    return;
  }

  console.log("?? Configurando eventos de login (dom ready state:", document.readyState, ")");
  const { loginBtn, loginErr, emailEl, passEl } = getDOMElements();
  
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      const elements = getDOMElements();
      if (!elements.loginErr) return;

      elements.loginErr.textContent = "";
      const email = elements.emailEl?.value?.trim();
      const password = elements.passEl?.value;

      if (!email || !password) {
        elements.loginErr.textContent = "Ingres� email y contrase�a";
        return;
      }

      try {
        elements.loginBtn.disabled = true;
        console.log("?? Intentando login para:", email);
        
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) {
          console.error("? Error en login:", error);
          console.error("C�digo de error:", error.status);
          console.error("Mensaje:", error.message);
          
          // Mensaje m�s descriptivo seg�n el tipo de error
          let errorMessage = "";
          if (error.message.includes("Invalid login credentials")) {
            errorMessage = "Credenciales inv�lidas. Verifica tu email y contrase�a.";
          } else if (error.message.includes("Email not confirmed")) {
            errorMessage = "Tu email no est� confirmado. Revisa tu bandeja de entrada.";
          } else if (error.message.includes("Email rate limit")) {
            errorMessage = "Demasiados intentos. Espera unos minutos antes de intentar de nuevo.";
          } else if (error.message.includes("User not found")) {
            errorMessage = "Usuario no encontrado. �Necesitas registrarte? Usa el bot�n 'Registrarme (dev)'.";
          } else if (error.message.includes("redirect")) {
            errorMessage = "Error de redirecci�n. Verifica que la URL est� configurada en Supabase.";
          } else {
            errorMessage = error.message || "Error al iniciar sesi�n. Intenta de nuevo.";
          }
          
          elements.loginErr.textContent = errorMessage;
          elements.loginErr.style.color = "#e74c3c";
          
          // Mostrar sugerencias adicionales en la consola
          console.warn("?? Sugerencias:");
          console.warn("  1. Verifica que tu email y contrase�a sean correctos");
          console.warn("  2. Si te registraste con Google, necesitas establecer una contrase�a");
          console.warn("  3. Verifica que las URLs de redirecci�n est�n configuradas en Supabase");
          console.warn("  4. Revisa SOLUCION_LOGIN_ADMIN.md para m�s ayuda");
          return;
        }

        console.log("? Login exitoso para:", email);
        console.log("Usuario:", data.user);

        // Invalidar auth-state + permissions-helper para no mezclar permisos viejos
        try {
          invalidate();
        } catch (e) {
          console.warn("No se pudo invalidar auth-state tras login:", e);
          if (window.clearPermissionsCache) window.clearPermissionsCache();
        }

        // Esperar un momento para que la sesi�n se establezca completamente
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
  
  // Enter en contrase�a
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
        elements.loginErr.textContent = "Ingres� email y contrase�a para registrarte";
        elements.loginErr.style.color = "#e74c3c";
        return;
      }

      if (password.length < 6) {
        elements.loginErr.textContent = "La contrase�a debe tener al menos 6 caracteres";
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
          elements.loginErr.textContent = "Error: No se pudo crear el usuario. Verifica la configuraci�n de Supabase.";
          elements.loginErr.style.color = "#e74c3c";
          elements.signupBtn.textContent = "Registrarme (dev)";
          return;
        }

        // IMPORTANTE: El usuario registrado NO se agrega autom�ticamente como admin
        // Solo el super_admin puede agregar colaboradores desde la p�gina de Colaboradores
        // Esto previene que usuarios se auto-registren como administradores

        // Intentar confirmar el email autom�ticamente usando la funci�n RPC
        // Esto evita el problema de que el email no se confirme autom�ticamente
        try {
          const { data: confirmData, error: confirmError } = await supabase
            .rpc('confirm_user_email', {
              p_user_id: data.user.id
            });
          
          if (confirmError) {
            console.warn("No se pudo confirmar el email autom�ticamente:", confirmError);
            // Intentar m�todo alternativo por email
            const { error: confirmByEmailError } = await supabase
              .rpc('confirm_user_email_by_address', {
                p_email: email
              });
            
            if (confirmByEmailError) {
              console.warn("M�todo alternativo tambi�n fall�:", confirmByEmailError);
            }
          } else {
            console.log("Email confirmado autom�ticamente:", confirmData);
          }
        } catch (confirmErr) {
          console.warn("Error al intentar confirmar email:", confirmErr);
        }

        // Verificar si se requiere confirmaci�n de email
        // Si data.user.email_confirmed_at es null, significa que se requiere confirmaci�n
        const requiresEmailConfirmation = !data.user.email_confirmed_at;
        
        // IMPORTANTE: Informar al usuario que debe ser autorizado por el super_admin
        if (requiresEmailConfirmation) {
          elements.loginErr.innerHTML = `
            <div style="color: #f39c12; background: #fff3cd; padding: 12px; border-radius: 6px; border: 1px solid #ffc107;">
              <strong>?? Registro exitoso, pero el correo de confirmaci�n puede no haberse enviado.</strong><br/>
              <small style="display:block; margin-top: 8px;">
                <strong>IMPORTANTE:</strong> Tu cuenta ha sido creada, pero NO tienes acceso al panel de administraci�n.<br/>
                El super administrador debe autorizarte como colaborador desde la p�gina de Colaboradores.<br/>
                Solo los usuarios autorizados pueden acceder al panel de administraci�n.
              </small>
            </div>
          `;
          elements.loginErr.style.color = "#f39c12";
        } else {
          elements.loginErr.innerHTML = `
            <div style="color: #090; background: #d4edda; padding: 12px; border-radius: 6px; border: 1px solid #28a745;">
              <strong>? Registro exitoso. Tu cuenta est� lista.</strong><br/>
              <small style="display:block; margin-top: 8px;">
                <strong>IMPORTANTE:</strong> Tu cuenta ha sido creada, pero NO tienes acceso al panel de administraci�n.<br/>
                El super administrador debe autorizarte como colaborador desde la p�gina de Colaboradores.<br/>
                Solo los usuarios autorizados pueden acceder al panel de administraci�n.
              </small>
            </div>
          `;
          elements.loginErr.style.color = "#090";
        }
        
        // Limpiar campos
        if (elements.emailEl) elements.emailEl.value = "";
        if (elements.passEl) elements.passEl.value = "";
        
        // Cerrar sesi�n autom�ticamente ya que el usuario no est� autorizado como admin
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

  // Reset contrase�a
  const { resetBtn } = getDOMElements();
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      const elements = getDOMElements();
      if (!elements.loginErr) return;

      elements.loginErr.textContent = "";
      const email = elements.emailEl?.value?.trim();

      if (!email) {
        elements.loginErr.textContent = "Ingres� tu email";
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

  // Login con Google OAuth - usando event delegation para mayor robustez
  console.log("?? Configurando bot�n de Google OAuth...");

  function getOAuthRedirectCandidates() {
    const origin = window.location.origin;
    const currentPath = window.location.pathname || "/admin/index.html";
    const normalizedCurrentPath = currentPath.endsWith("/")
      ? `${currentPath}index.html`
      : currentPath;

    const candidates = [
      `${origin}${normalizedCurrentPath}`,
      `${origin}/admin/`,
      origin,
    ];

    return [...new Set(candidates)];
  }

  async function signInWithGoogleOAuthWithFallback() {
    const redirectCandidates = getOAuthRedirectCandidates();
    let lastError = null;

    for (const redirectUrl of redirectCandidates) {
      console.log("?? Intentando OAuth con redirectTo:", redirectUrl);
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: redirectUrl,
          queryParams: {
            prompt: "select_account",
            access_type: "offline",
          },
        },
      });

      if (!error) {
        return { data, redirectUrl };
      }

      lastError = error;
      const msg = String(error.message || "").toLowerCase();
      const isRedirectError =
        msg.includes("redirect") ||
        msg.includes("redirect_to") ||
        msg.includes("not allowed");

      if (!isRedirectError) {
        throw error;
      }
    }

    throw lastError || new Error("No se pudo iniciar OAuth con ninguna URL de redirecci�n");
  }
  
  // Funci�n para manejar el click del bot�n de Google
  async function handleGoogleLogin(e) {
    // Verificar si el click fue en el bot�n o en un elemento dentro del bot�n
    const btn = e.target.closest("#google-login-btn");
    if (!btn) return;
    
    e.preventDefault();
    e.stopPropagation();
    console.log("??? Click en bot�n de Google detectado");
    
    const elements = getDOMElements();
    if (!elements.loginErr) {
      console.error("? Elemento loginErr no encontrado");
      return;
    }

    elements.loginErr.textContent = "";
    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    btn.textContent = "Redirigiendo a Google...";

    try {
      console.log("?? Iniciando login con Google OAuth...");
      await signInWithGoogleOAuthWithFallback();
      console.log("? Redirigiendo a Google...");
      // La redirecci�n se har� autom�ticamente
    } catch (e) {
      console.error("? Error en login con Google:", e);
      const message = e?.message || String(e);
      if (/redirect|redirect_to|not allowed/i.test(message)) {
        elements.loginErr.innerHTML = `
          Error de redirecci�n OAuth.<br/>
          Verific� en Supabase Auth > URL Configuration que exista:<br/>
          <code>${window.location.origin}/admin/index.html</code> o <code>${window.location.origin}/admin/</code>
        `;
      } else {
        elements.loginErr.textContent = `Error: ${message}`;
      }
      elements.loginErr.style.color = "#e74c3c";
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  }
  
  // Usar event delegation en el documento para capturar clicks
  // Esto funciona incluso si el bot�n se carga despu�s
  document.addEventListener("click", handleGoogleLogin);
  console.log("? Event listener configurado con event delegation");

  // Cerrar sesi�n (bloque logueado)
  const { logoutBtn } = getDOMElements();
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await supabase.auth.signOut();
        invalidate();
        await updateSessionUI();
      } catch (error) {
        console.error("Error al cerrar sesi�n:", error);
      }
    });
  }

  // Cerrar sesi�n forzada (limpia tokens "sb-*")
  const { forceLogoutBtn } = getDOMElements();
  if (forceLogoutBtn) {
    forceLogoutBtn.addEventListener("click", async () => {
      try {
        await supabase.auth.signOut();
        invalidate();
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
}

runWhenDocumentInteractive(setupAuthFormListeners);

// Funci�n para inicializar la UI cuando la p�gina carga
async function initializeUI() {
  await supabaseReady;
  try {
    console.log("?? Iniciando verificaci�n de sesi�n...");
    console.log("?? URL actual:", window.location.href);
    
    // Verificar si hay un hash de OAuth o reset de contrase�a en la URL
    const hash = window.location.hash;
    
    // Manejar retorno de OAuth (Google)
    if (hash && (hash.includes("access_token") || hash.includes("type=recovery"))) {
      console.log("?? Procesando retorno de OAuth...");
      // Esperar un momento para que Supabase procese el hash
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Verificar si la sesi�n se estableci� correctamente
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError) {
        console.error("? Error procesando OAuth:", sessionError);
        const elements = getDOMElements();
        if (elements.loginErr) {
          elements.loginErr.textContent = `Error al procesar autenticaci�n: ${sessionError.message}`;
          elements.loginErr.style.color = "#e74c3c";
        }
      } else if (sessionData?.session) {
        console.log("? OAuth exitoso, sesi�n establecida");
        // Limpiar el hash de la URL
        window.history.replaceState(null, '', window.location.pathname);
        // Actualizar la UI para mostrar el dashboard
        await updateSessionUI();
        return;
      }
      
      // Limpiar el hash despu�s de procesarlo
      window.history.replaceState(null, '', window.location.pathname);
    }
    
    // Verificar si hay un error de reset de contrase�a en la URL
    if (hash.includes("error=") && hash.includes("otp_expired")) {
      const params = new URLSearchParams(hash.substring(1));
      const errorDescription = params.get("error_description") || "El enlace ha expirado";
      const elements = getDOMElements();
      if (elements.loginErr) {
        elements.loginErr.innerHTML = `
          <div style="color: #e74c3c; background: #f8d7da; padding: 12px; border-radius: 6px; border: 1px solid #f5c6cb;">
            <strong>?? Enlace expirado</strong><br/>
            <small>${decodeURIComponent(errorDescription.replace(/\+/g, ' '))}</small><br/>
            <small style="display:block; margin-top: 8px;">Por favor, solicita un nuevo enlace de restablecimiento de contrase�a.</small>
          </div>
        `;
        elements.loginErr.style.color = "#e74c3c";
      }
      // Limpiar el hash para evitar mostrar el error nuevamente
      window.history.replaceState(null, '', window.location.pathname);
    }
    
    // Verificar si estamos en orders.html o si skipPanelRedirect est� activo
    const currentPath = window.location.pathname || window.location.href;
    const currentHref = window.location.href;
    const isOrdersPage = currentPath.includes("orders.html") || currentHref.includes("orders.html");
    
    // NO redirigir si estamos en orders.html - dejar que orders.js maneje su propia l�gica
    if (isOrdersPage || window.skipPanelRedirect === true) {
      console.log("?? P�gina de pedidos detectada, actualizando UI sin redirecci�n");
      await updateSessionUI();
      return; // Salir temprano para no interferir
    }
    
    // Verificar sesi�n primero
    console.log("?? Verificando sesi�n...");
    const { data, error } = await supabase.auth.getSession();
    
    if (error) {
      console.error("? Error verificando sesi�n:", error);
      // Si hay error y no estamos en index.html, ir a index.html que mostrar� login
      if (!isIndexPage()) {
        window.location.href = "./index.html";
      } else {
        await updateSessionUI();
      }
      return;
    }
    
    const hasSession = !!data?.session;
    
    // Si estamos en index.html, siempre actualizar la UI (mostrar� login o dashboard seg�n sesi�n)
    if (isIndexPage()) {
      console.log("?? P�gina index detectada, actualizando UI");
      // Esperar un momento para asegurar que el DOM est� completamente cargado
      await new Promise(resolve => setTimeout(resolve, 100));
      await updateSessionUI();
      return;
    }
    
    // Si NO hay sesi�n y estamos en otra p�gina, redirigir al login (index.html)
    if (!hasSession) {
      console.log("?? No hay sesi�n activa, redirigiendo a login");
      console.log("?? Redirigiendo a index.html (login)...");
      window.location.href = "./index.html";
      return;
    }
    
    // Si hay sesi�n y estamos en otra p�gina (products, stock, orders, import-export),
    // NO redirigir - dejar que la p�gina funcione normalmente
    // Las p�ginas individuales usar�n requireAuth() para verificar sesi�n
    console.log("? Sesi�n activa - permitiendo acceso a la p�gina");
  } catch (error) {
    console.error("? Error al cargar sesi�n:", error);
    await updateSessionUI();
  }
}

// Al cargar: si hay sesión, ir al panel; si no, mostrar login
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeUI, { once: true });
} else {
  initializeUI();
}

export async function requireAuth() {
  await supabaseReady;
  try {
    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      window.location.href = "./index.html";
      return null;
    }

    // Verificar que el usuario sea admin
    const { requireAdminAuth } = await import("./permissions-helper.js?v=m260607");
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
