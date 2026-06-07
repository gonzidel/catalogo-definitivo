// scripts/auth-status.js - Manejo del estado de autenticación en la página principal

import { supabase } from "./supabase-client.js?v=m260607";
import { checkPasskeySupport, authenticateWithPasskey } from "./passkeys.js?v=m260607";
import {
  getPostLoginRedirectUrl,
  savePreAuthReturnTarget,
  restorePostAuthNavigation,
  remindSupabaseRedirectUrlsIfLocal,
} from "./auth-redirect-url.js?v=m260607";
import {
  maybeShowProfileOnboardingModal,
  clearProfileOnboardingSessionFlag,
} from "./profile-onboarding-modal.js?v=m260607";
import { fylAnalytics } from "./analytics.js?v=m260607";

remindSupabaseRedirectUrlsIfLocal();

/** Logs de arranque (auth / carrito). Activar: `window.FYL_DEBUG_CATALOG = true` o `?debug=catalog`. */
function fylDevLog(...args) {
  if (
    typeof window !== "undefined" &&
    (window.FYL_DEBUG_CATALOG === true ||
      /(?:^|[&?])debug=catalog(?:&|$)/.test(window.location.search || ""))
  ) {
    console.log.apply(console, args);
  }
}

function isExpectedAuthError(error) {
  if (!error) return false;
  const name = String(error.name || "");
  const message = String(error.message || "");
  const status = Number(error.status || error.statusCode || 0);
  const url = String(error.url || error.request?.url || error.config?.url || "");

  if (name === "AuthSessionMissingError") return true;
  if (status === 401 && url.includes("/auth/v1/user")) return true;
  if (url.includes("/auth/v1/user") && /401|jwt|session missing/i.test(message)) return true;
  return false;
}

function isExpectedAuthErrorHandled(error, context) {
  try {
    if (
      typeof window !== "undefined" &&
      typeof window.__FYL_handleExpectedAuthError === "function"
    ) {
      return window.__FYL_handleExpectedAuthError(error, context);
    }
  } catch (_e) {}

  if (!isExpectedAuthError(error)) return false;
  if (
    typeof window !== "undefined" &&
    (window.FYL_DEBUG_CATALOG === true || window.localStorage?.getItem("fyl_debug_auth") === "1")
  ) {
    console.info("[FYL auth] error esperado suprimido", context || "", error);
  }
  return true;
}

/** Evita múltiples `syncCartWithSupabase` cuando `showAuthenticatedUser` se llama seguido. */
let fylCartSyncDebounceTimer = null;
function scheduleDebouncedCartSyncAfterAuth() {
  if (!window.syncCartWithSupabase) return;
  if (fylCartSyncDebounceTimer) clearTimeout(fylCartSyncDebounceTimer);
  fylCartSyncDebounceTimer = setTimeout(() => {
    fylCartSyncDebounceTimer = null;
    window.syncCartWithSupabase();
  }, 1000);
}

const loginModal = document.getElementById("login-modal");
const loginModalMsg = document.getElementById("login-modal-msg");
const loginGoogleBtnStep1 = document.getElementById("login-google-btn-step1");
const loginModalClose = document.getElementById("login-modal-close");

// Elementos del flujo de login
const loginStep1 = document.getElementById("login-step-1");
const loginStep3 = document.getElementById("login-step-3");
const loginEmailInput = document.getElementById("login-email-input");
const loginContinueBtn = document.getElementById("login-continue-btn");
const loginEmailConfirmation = document.getElementById("login-email-confirmation");
const loginCloseAfterEmail = document.getElementById("login-close-after-email");
const loginResendEmailBtn = document.getElementById("login-resend-email-btn");
const loginResendMsg = document.getElementById("login-resend-msg");

let currentLoginEmail = "";

function resetLoginModal() {
  if (loginModalMsg) {
    loginModalMsg.textContent = "";
    loginModalMsg.classList.remove("visible");
    loginModalMsg.style.color = "#c0392b";
  }
  if (loginContinueBtn) {
    loginContinueBtn.disabled = false;
    loginContinueBtn.textContent = "Enviarme un enlace de inicio de sesión";
  }
  if (loginGoogleBtnStep1) {
    loginGoogleBtnStep1.disabled = false;
    loginGoogleBtnStep1.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 533.5 544.3" aria-hidden="true">
        <path fill="#4285f4" d="M533.5 278.4c0-17.4-1.5-34.1-4.3-50.3H272.1v95.1h147.1c-6.3 34-25 62.8-53.3 82l86.1 66.9c50.3-46.4 81.5-114.8 81.5-193.7z"/>
        <path fill="#34a853" d="M272.1 544.3c72.8 0 134-24 178.7-65.3l-86.1-66.9c-24 16.1-54.8 25.7-92.6 25.7-71.2 0-131.7-48.1-153.3-112.8l-89 68.7c44.4 88 135.4 150.6 242.3 150.6z"/>
        <path fill="#fbbc04" d="M118.8 324.9c-10.7-31.9-10.7-66.3 0-98.2l-89-68.7c-39.2 78.6-39.2 171.7 0 250.3l89-68.7z"/>
        <path fill="#ea4335" d="M272.1 107.7c39.6 0 75.2 13.6 103.3 40.3l77.4-77.4C406.1 24.4 344.9 0 272.1 0 165.2 0 74.2 62.6 29.8 150.6l89 68.7c21.6-64.7 82.1-111.6 153.3-111.6z"/>
      </svg>
      Continuar con Gmail
    `;
  }
}

function showLoginModal(message) {
  if (!loginModal) {
    console.log("[FYL DEBUG AUTH] auth-status.js window.location.href = client/login.html");
    window.location.href = "client/login.html";
    return;
  }
  resetLoginModal();
  if (message && loginModalMsg) {
    loginModalMsg.textContent = message;
    loginModalMsg.classList.add("visible");
  }
  loginModal.classList.add("active");
  document.body.classList.add("modal-open");
  try {
    if (fylAnalytics.isReady()) fylAnalytics.event("login_start", { surface: "modal_message" });
  } catch (_e) {}
}

// Mostrar paso 1 del modal (solicitar email)
function showLoginModalStep1() {
  if (!loginModal) {
    console.log("[FYL DEBUG AUTH] auth-status.js window.location.href = client/login.html");
    window.location.href = "client/login.html";
    return;
  }

  resetLoginModalToStep1Hidden();
  if (loginEmailInput) loginEmailInput.focus();

  loginModal.classList.add("active");
  document.body.classList.add("modal-open");
  try {
    if (fylAnalytics.isReady()) fylAnalytics.event("login_start", { surface: "modal_step1" });
  } catch (_e) {}
}

// Mostrar paso 3 del modal (confirmación de email enviado)
function showLoginModalStep3(email) {
  if (!loginModal || !email) return;
  
  // Ocultar paso 1, mostrar paso 3
  if (loginStep1) loginStep1.style.display = "none";
  if (loginStep3) loginStep3.style.display = "block";
  if (loginEmailConfirmation) {
    loginEmailConfirmation.textContent = email;
  }
}

// Función eliminada - ya no se usa el paso 2
// showLoginModalStep2() fue eliminada porque unificamos todo en el paso 1

/** Solo resetea pasos/UI del modal sin abrirlo (evita reabrir al cerrar). */
function resetLoginModalToStep1Hidden() {
  resetLoginModal();
  currentLoginEmail = "";
  if (loginStep1) loginStep1.style.display = "block";
  if (loginStep3) loginStep3.style.display = "none";
  if (loginEmailInput) loginEmailInput.value = "";
  if (loginContinueBtn) {
    loginContinueBtn.disabled = false;
    loginContinueBtn.textContent = "Enviarme un enlace de inicio de sesión";
  }
}

function hideLoginModal() {
  if (!loginModal) return;
  loginModal.classList.remove("active");
  document.body.classList.remove("modal-open");
  // Dejar el modal listo para la próxima apertura, sin volver a mostrarlo
  resetLoginModalToStep1Hidden();
}

function promptLogin(reason) {
  if (loginModal) {
    showLoginModal(reason);
  } else {
    console.log("[FYL DEBUG AUTH] auth-status.js window.location.href = client/login.html");
    window.location.href = "client/login.html";
  }
}

loginModalClose?.addEventListener("click", hideLoginModal);

loginModal?.addEventListener("click", (event) => {
  if (event.target === loginModal) {
    hideLoginModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && loginModal?.classList.contains("active")) {
    hideLoginModal();
  }
});

// Handler para botón "Enviarme un enlace de inicio de sesión" del paso 1
loginContinueBtn?.addEventListener("click", async () => {
  const email = loginEmailInput?.value.trim();
  
  if (!email) {
    if (loginModalMsg) {
      loginModalMsg.textContent = "Por favor ingresá tu email";
      loginModalMsg.classList.add("visible");
    }
    return;
  }
  
  // Validar formato básico de email
  if (!email.includes("@") || !email.includes(".")) {
    if (loginModalMsg) {
      loginModalMsg.textContent = "Por favor ingresá un email válido";
      loginModalMsg.classList.add("visible");
    }
    return;
  }
  
  // Guardar email para próxima vez
  localStorage.setItem("last_login_email", email);
  currentLoginEmail = email.toLowerCase().trim();
  
  // Deshabilitar botón y mostrar estado de carga
  if (loginContinueBtn) {
    loginContinueBtn.disabled = true;
    loginContinueBtn.textContent = "Enviando enlace...";
  }
  if (loginModalMsg) {
    loginModalMsg.textContent = "";
    loginModalMsg.classList.remove("visible");
  }

  try {
    savePreAuthReturnTarget();
    const { error } = await supabase.auth.signInWithOtp({
      email: currentLoginEmail,
      options: {
        emailRedirectTo: getPostLoginRedirectUrl(),
      },
    });

    if (error) {
      console.error("❌ Error enviando magic link:", error);
      if (loginModalMsg) {
        loginModalMsg.textContent = `Error: ${error.message}`;
        loginModalMsg.classList.add("visible");
      }
      if (loginContinueBtn) {
        loginContinueBtn.disabled = false;
        loginContinueBtn.textContent = "Enviarme un enlace de inicio de sesión";
      }
    } else {
      // Mostrar paso 3 con confirmación
      showLoginModalStep3(currentLoginEmail);
    }
  } catch (error) {
    console.error("❌ Error en magic link:", error);
    if (loginModalMsg) {
      loginModalMsg.textContent = `Error inesperado: ${error.message || String(error)}`;
      loginModalMsg.classList.add("visible");
    }
    if (loginContinueBtn) {
      loginContinueBtn.disabled = false;
      loginContinueBtn.textContent = "Enviarme un enlace de inicio de sesión";
    }
  }
});

// Permitir Enter en el input de email
loginEmailInput?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    loginContinueBtn?.click();
  }
});

// Handler para botón "Continuar con Gmail" del paso 1 (sin email)
loginGoogleBtnStep1?.addEventListener("click", async () => {
  if (!loginGoogleBtnStep1) return;

  loginGoogleBtnStep1.disabled = true;
  loginGoogleBtnStep1.textContent = "Conectando con Google...";
  if (loginModalMsg) {
    loginModalMsg.textContent = "";
    loginModalMsg.classList.remove("visible");
  }

  try {
    savePreAuthReturnTarget();
    const oauthRedirectUrl = getPostLoginRedirectUrl();
    console.log("[FYL DEBUG AUTH] auth-status.js signInWithOAuth redirectTo =", oauthRedirectUrl);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: oauthRedirectUrl,
        queryParams: {
          prompt: "select_account",
          access_type: "offline",
        },
      },
    });

    if (error) {
      console.error("❌ Error en OAuth:", error);
      if (loginModalMsg) {
        loginModalMsg.textContent = `No se pudo iniciar sesión: ${error.message}`;
        loginModalMsg.classList.add("visible");
      }
      loginGoogleBtnStep1.disabled = false;
      loginGoogleBtnStep1.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 533.5 544.3" aria-hidden="true">
          <path fill="#4285f4" d="M533.5 278.4c0-17.4-1.5-34.1-4.3-50.3H272.1v95.1h147.1c-6.3 34-25 62.8-53.3 82l86.1 66.9c50.3-46.4 81.5-114.8 81.5-193.7z"/>
          <path fill="#34a853" d="M272.1 544.3c72.8 0 134-24 178.7-65.3l-86.1-66.9c-24 16.1-54.8 25.7-92.6 25.7-71.2 0-131.7-48.1-153.3-112.8l-89 68.7c44.4 88 135.4 150.6 242.3 150.6z"/>
          <path fill="#fbbc04" d="M118.8 324.9c-10.7-31.9-10.7-66.3 0-98.2l-89-68.7c-39.2 78.6-39.2 171.7 0 250.3l89-68.7z"/>
          <path fill="#ea4335" d="M272.1 107.7c39.6 0 75.2 13.6 103.3 40.3l77.4-77.4C406.1 24.4 344.9 0 272.1 0 165.2 0 74.2 62.6 29.8 150.6l89 68.7c21.6-64.7 82.1-111.6 153.3-111.6z"/>
        </svg>
        Continuar con Gmail
      `;
    } else {
      if (loginModalMsg) {
        loginModalMsg.textContent = "Redirigiendo a Google...";
        loginModalMsg.style.color = "#2e7d32";
        loginModalMsg.classList.add("visible");
      }
    }
  } catch (loginError) {
    console.error("❌ Error en login:", loginError);
    if (loginModalMsg) {
      loginModalMsg.textContent = `Error inesperado: ${loginError.message || String(loginError)}`;
      loginModalMsg.classList.add("visible");
    }
    loginGoogleBtnStep1.disabled = false;
    loginGoogleBtnStep1.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 533.5 544.3" aria-hidden="true">
        <path fill="#4285f4" d="M533.5 278.4c0-17.4-1.5-34.1-4.3-50.3H272.1v95.1h147.1c-6.3 34-25 62.8-53.3 82l86.1 66.9c50.3-46.4 81.5-114.8 81.5-193.7z"/>
        <path fill="#34a853" d="M272.1 544.3c72.8 0 134-24 178.7-65.3l-86.1-66.9c-24 16.1-54.8 25.7-92.6 25.7-71.2 0-131.7-48.1-153.3-112.8l-89 68.7c44.4 88 135.4 150.6 242.3 150.6z"/>
        <path fill="#fbbc04" d="M118.8 324.9c-10.7-31.9-10.7-66.3 0-98.2l-89-68.7c-39.2 78.6-39.2 171.7 0 250.3l89-68.7z"/>
        <path fill="#ea4335" d="M272.1 107.7c39.6 0 75.2 13.6 103.3 40.3l77.4-77.4C406.1 24.4 344.9 0 272.1 0 165.2 0 74.2 62.6 29.8 150.6l89 68.7c21.6-64.7 82.1-111.6 153.3-111.6z"/>
      </svg>
      Continuar con Gmail
    `;
  }
});

// Handlers del paso 2 eliminados - ya no se usa el paso 2

// Handler para botón "Reenviar email" del paso 3
loginResendEmailBtn?.addEventListener("click", async () => {
  if (!loginResendEmailBtn || !currentLoginEmail) return;

  loginResendEmailBtn.disabled = true;
  loginResendEmailBtn.textContent = "Reenviando...";
  if (loginResendMsg) {
    loginResendMsg.textContent = "";
    loginResendMsg.classList.remove("visible");
    loginResendMsg.style.display = "none";
  }

  try {
    savePreAuthReturnTarget();
    const { error } = await supabase.auth.signInWithOtp({
      email: currentLoginEmail,
      options: {
        emailRedirectTo: getPostLoginRedirectUrl(),
      },
    });

    if (error) {
      console.error("❌ Error reenviando magic link:", error);
      if (loginResendMsg) {
        loginResendMsg.textContent = `Error: ${error.message}`;
        loginResendMsg.classList.add("visible");
        loginResendMsg.style.display = "block";
      }
      loginResendEmailBtn.disabled = false;
      loginResendEmailBtn.textContent = "Reenviar email";
    } else {
      if (loginResendMsg) {
        loginResendMsg.textContent = "✅ Email reenviado correctamente";
        loginResendMsg.style.color = "#2e7d32";
        loginResendMsg.classList.add("visible");
        loginResendMsg.style.display = "block";
      }
      loginResendEmailBtn.textContent = "Reenviado";
      
      // Habilitar el botón después de 3 segundos
      setTimeout(() => {
        loginResendEmailBtn.disabled = false;
        loginResendEmailBtn.textContent = "Reenviar email";
      }, 3000);
    }
  } catch (error) {
    console.error("❌ Error en reenvío:", error);
    if (loginResendMsg) {
      loginResendMsg.textContent = `Error inesperado: ${error.message || String(error)}`;
      loginResendMsg.classList.add("visible");
      loginResendMsg.style.display = "block";
    }
    loginResendEmailBtn.disabled = false;
    loginResendEmailBtn.textContent = "Reenviar email";
  }
});

// Handler para botón "Cerrar" del paso 3 (después de enviar email)
loginCloseAfterEmail?.addEventListener("click", () => {
  hideLoginModal();
});

// Variable para evitar logs repetidos
let lastLoggedUser = null;
let lastLoggedTime = 0;

// Función para actualizar el enlace del área de clientes
async function updateClientAreaLink() {
  if (!supabase?.auth?.getSession) {
    showDefaultLink();
    return;
  }
  try {
    // Solo loguear la primera vez o si pasó más de 5 segundos desde el último log
    const now = Date.now();
    const shouldLog = !lastLoggedTime || (now - lastLoggedTime) > 5000;
    
    if (shouldLog) {
      // console.log("🔍 Verificando estado de autenticación...");
      lastLoggedTime = now;
    }

    const clienteLink = document.querySelector(".cliente-link");
    if (!clienteLink) {
      if (shouldLog) {
        console.warn("⚠️ No se encontró el enlace del área de clientes");
      }
      return;
    }

    // Verificar sesión con timeout (10s para redes lentas)
    const sessionPromise = supabase.auth.getSession();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), 10000)
    );

    const {
      data: { session },
      error,
    } = await Promise.race([sessionPromise, timeoutPromise]);

    if (error) {
      if (shouldLog && !isExpectedAuthErrorHandled(error, "auth-status:updateClientAreaLink:getSession:error")) {
        console.error("❌ Error obteniendo sesión:", error);
      }
      showDefaultLink();
      return;
    }

    if (!session) {
      if (shouldLog && lastLoggedUser !== null) {
        fylDevLog("👤 No hay sesión activa");
        lastLoggedUser = null;
      }
      showDefaultLink();
      return;
    }

    // Solo loguear si cambió el usuario o si pasó tiempo suficiente
    if (shouldLog && lastLoggedUser !== session.user.email) {
      fylDevLog("✅ Usuario autenticado:", session.user.email);
      lastLoggedUser = session.user.email;
      // console.log("📊 Datos del usuario:", {
      //   email: session.user.email,
      //   avatar_url: session.user.user_metadata?.avatar_url,
      //   picture: session.user.user_metadata?.picture,
      //   full_name: session.user.user_metadata?.full_name,
      // });
    }

    // Obtener datos del cliente si existen (sin bloquear)
    let customer = null;
    try {
      const { data: customerData } = await supabase
        .from("customers")
        .select("full_name")
        .eq("id", session.user.id)
        .single();
      customer = customerData;
    } catch (customerError) {
      console.warn(
        "⚠️ No se pudo obtener datos del cliente:",
        customerError.message
      );
    }

    // Mostrar avatar y nombre
    showAuthenticatedUser(session.user, customer);
  } catch (error) {
    if (error?.message === "Timeout") {
      if (shouldLog) {
        console.warn("⚠️ Verificación de sesión tardó demasiado, mostrando Área de Clientes");
      }
    } else {
      if (!isExpectedAuthErrorHandled(error, "auth-status:updateClientAreaLink:catch")) {
        console.error("❌ Error verificando autenticación:", error);
      }
    }
    showDefaultLink();
  }
}

// Mostrar enlace por defecto (no autenticado)
function showDefaultLink() {
  const clienteLink = document.querySelector(".cliente-link");
  if (clienteLink) {
    clienteLink.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="8" r="4"/>
      </svg>
    `;
    clienteLink.classList.add("cliente-link--guest");
    clienteLink.style.padding = "0";
    clienteLink.style.minWidth = "32px";
    clienteLink.style.width = "32px";
    clienteLink.style.height = "32px";
    clienteLink.style.borderRadius = "50%";
    clienteLink.style.display = "inline-flex";
    clienteLink.style.alignItems = "center";
    clienteLink.style.justifyContent = "center";
    clienteLink.style.color = "#CD844D";
    clienteLink.style.borderColor = "#E6D2C2";
    clienteLink.style.background = "#fff";
    clienteLink.style.boxShadow = "0 2px 6px rgba(0, 0, 0, 0.08)";
    clienteLink.setAttribute("aria-label", "Iniciar sesión");
    clienteLink.title = "Iniciar sesión";
  }
}

// Mostrar usuario autenticado con avatar
function showAuthenticatedUser(user, customer) {
  const clienteLink = document.querySelector(".cliente-link");
  if (!clienteLink) return;
  clienteLink.classList.remove("cliente-link--guest");

  const displayName =
    customer?.full_name ||
    user.user_metadata?.full_name ||
    user.email?.split("@")[0] ||
    "Usuario";

  if (window.syncCartWithSupabase) {
    fylDevLog("🔄 Programando sincronización de carrito (debounced)…");
    scheduleDebouncedCartSyncAfterAuth();
  }

  // Usar avatar de Google si está disponible, sino generar uno
  const avatarUrl =
    user.user_metadata?.avatar_url ||
    user.user_metadata?.picture ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(
      displayName
    )}&background=CD844D&color=fff&size=32`;

  // En mobile solo mostrar el avatar, sin nombre ni ícono
  // Usar media query para determinar si es mobile
  const isMobile = window.matchMedia('(max-width: 414px)').matches;
  
  if (isMobile) {
    // Solo avatar en mobile - sin nombre, sin ícono dropdown
    clienteLink.innerHTML = `
      <img src="${avatarUrl}" 
           alt="Avatar de ${displayName}" 
           class="cliente-avatar"
           onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(
             displayName
           )}&background=CD844D&color=fff&size=28'">
    `;
    clienteLink.style.padding = '2px';
    clienteLink.style.minWidth = '28px';
    clienteLink.style.width = '28px';
    clienteLink.style.height = '28px';
    clienteLink.style.borderRadius = '50%';
  } else {
    // Desktop: avatar + nombre + ícono
  clienteLink.innerHTML = `
    <img src="${avatarUrl}" 
         alt="Avatar de ${displayName}" 
         style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 2px solid #CD844D; margin-right: 8px;"
         onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(
           displayName
         )}&background=CD844D&color=fff&size=32'">
    <span style="font-weight: 500; color: #333;">${displayName}</span>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: 4px; color: #666;">
      <polyline points="6,9 12,15 18,9"/>
    </svg>
  `;
    clienteLink.style.padding = '';
    clienteLink.style.minWidth = '';
    clienteLink.style.width = '';
    clienteLink.style.height = '';
    clienteLink.style.borderRadius = '';
  }
  clienteLink.title = "Mi área personal - " + displayName;

  // Agregar indicador visual de sesión activa
  clienteLink.style.background = "#f8f9fa";
  clienteLink.style.borderColor = "#CD844D";
  clienteLink.style.color = "#333";
  clienteLink.style.boxShadow = "0 2px 8px rgba(205, 132, 77, 0.2)";
}

// Función para manejar el clic en el área de clientes
async function handleClientAreaClick(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  fylDevLog("🖱️ Click en área de clientes detectado");

  if (!supabase?.auth?.getSession) {
    showLoginModalStep1();
    return;
  }

  // Verificar si el usuario ya está autenticado
  try {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    
    if (!sessionError && session) {
      fylDevLog("✅ Usuario autenticado, mostrando menú de cuenta");
      toggleUserDropdown();
      return;
    }
  } catch (error) {
    if (!isExpectedAuthErrorHandled(error, "auth-status:handleClientAreaClick:getSession")) {
      console.error("❌ Error verificando sesión:", error);
    }
    // Si hay error, continuar con el modal de login
  }

  fylDevLog("👤 Usuario no autenticado, mostrando modal de login");

  // Mostrar modal de login (paso 1: email)
  showLoginModalStep1();
}

// Override de la función original que estaba causando problemas
window.redirectToClientArea = async function () {
  fylDevLog("🔄 Función redirectToClientArea llamada");

  if (!supabase?.auth?.getSession) {
    showLoginModalStep1();
    return false;
  }

  // Verificar si el usuario ya está autenticado
  try {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    
    if (!sessionError && session) {
      fylDevLog("✅ Usuario ya autenticado, redirigiendo a dashboard");
      // Usuario ya está autenticado, redirigir directamente
      console.log("[FYL DEBUG AUTH] auth-status.js window.location.href = client/dashboard.html");
      window.location.href = "client/dashboard.html";
      return false;
    }
  } catch (error) {
    if (!isExpectedAuthErrorHandled(error, "auth-status:redirectToClientArea:getSession")) {
      console.error("❌ Error verificando sesión:", error);
    }
    // Si hay error, continuar con el modal de login
  }

  fylDevLog("👤 Usuario no autenticado, mostrando modal de login");

  // Mostrar modal de login (paso 1: email)
  showLoginModalStep1();
  return false; // Prevenir redirección adicional
};

// Función para crear menú desplegable del usuario
function createUserDropdown(user, customer) {
  const dropdown = document.createElement("div");
  dropdown.className = "user-dropdown";
  dropdown.style.cssText = `
    position: absolute;
    top: 100%;
    right: 0;
    background: white;
    border: 1px solid #ddd;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 1000;
    min-width: 170px;
    display: none;
  `;

  const displayName =
    customer?.full_name ||
    user.user_metadata?.full_name ||
    user.email?.split("@")[0] ||
    "Usuario";
  const userEmail = user.email;

  dropdown.innerHTML = `
    <div style="padding: 12px; border-bottom: 1px solid #eee;">
      <div style="font-weight: 600; color: #333;">${displayName}</div>
      <div style="font-size: 12px; color: #666;">${userEmail}</div>
    </div>
    <div style="padding: 8px 0;">
      <a href="client/profile.html" style="display: block; padding: 8px 12px; color: #333; text-decoration: none; transition: background 0.2s;">
        👤 Perfil
      </a>
      <hr style="margin: 8px 0; border: none; border-top: 1px solid #eee;">
      <button onclick="logoutUser()" style="display: block; width: 100%; padding: 8px 12px; background: none; border: none; color: #dc3545; text-align: left; cursor: pointer; transition: background 0.2s;">
        🚪 Cerrar sesión
      </button>
    </div>
  `;

  // Agregar estilos hover
  const links = dropdown.querySelectorAll("a, button");
  links.forEach((link) => {
    link.addEventListener("mouseenter", () => {
      link.style.background = "#f8f9fa";
    });
    link.addEventListener("mouseleave", () => {
      link.style.background = "transparent";
    });
  });

  return dropdown;
}

// Función para logout
window.logoutUser = async function () {
  try {
    if (!supabase?.auth?.signOut) {
      console.warn("🚪 logout: supabase no disponible, recargando…");
      window.location.reload();
      return;
    }
    fylDevLog("🚪 Cerrando sesión...");
    clearProfileOnboardingSessionFlag();
    await supabase.auth.signOut();
    window.location.reload();
  } catch (error) {
    console.error("❌ Error cerrando sesión:", error);
  }
};

// Función para mostrar/ocultar dropdown
function toggleUserDropdown() {
  fylDevLog("🔄 Toggle dropdown...");

  const clienteLink = document.querySelector(".cliente-link");
  const existingDropdown = document.querySelector(".user-dropdown");

  // Si ya existe, cerrarlo
  if (existingDropdown) {
    fylDevLog("❌ Cerrando dropdown existente");
    existingDropdown.remove();
    return;
  }

  if (!supabase?.auth?.getSession) {
    console.warn("⚠️ Dropdown: supabase no disponible");
    return;
  }

  // Verificar sesión y crear dropdown
  supabase.auth
    .getSession()
    .then(async ({ data: { session } }) => {
      if (!session) {
        fylDevLog("👤 No hay sesión, no se puede mostrar dropdown");
        return;
      }

      fylDevLog("✅ Creando dropdown para usuario:", session.user.email);

      // Obtener datos del cliente
      let customer = null;
      try {
        const { data: customerData } = await supabase
          .from("customers")
          .select("full_name")
          .eq("id", session.user.id)
          .single();
        customer = customerData;
      } catch (error) {
        console.warn("⚠️ No se pudo obtener datos del cliente:", error.message);
      }

      // Crear y mostrar dropdown
      const dropdown = createUserDropdown(session.user, customer);
      clienteLink.parentNode.appendChild(dropdown);
      dropdown.style.display = "block";

      fylDevLog("✅ Dropdown creado y mostrado");

      // Cerrar dropdown al hacer clic fuera
      setTimeout(() => {
        const closeDropdown = function (e) {
          if (!clienteLink.contains(e.target) && !dropdown.contains(e.target)) {
            fylDevLog("🔄 Cerrando dropdown por clic fuera");
            dropdown.remove();
            document.removeEventListener("click", closeDropdown);
          }
        };
        document.addEventListener("click", closeDropdown);
      }, 100);
    })
    .catch((error) => {
      console.error("❌ Error creando dropdown:", error);
    });
}

// Variable para evitar múltiples inicializaciones
let isInitializing = false;
let isInitialized = false;
let initTimeout = null;

// Función para inicializar (con protección contra múltiples ejecuciones)
async function initializeAuth() {
  if (window.__CATALOG_ONLY__) return;
  // Evitar múltiples ejecuciones simultáneas
  if (isInitializing) {
    return;
  }
  
  // Si ya se inicializó, solo actualizar el link sin limpiar listeners
  if (isInitialized) {
    await updateClientAreaLink();
    return;
  }

  isInitializing = true;
  fylDevLog("🔧 Inicializando estado de autenticación...");

  try {
    // Actualizar enlace del área de clientes
    await updateClientAreaLink();

    // Limpiar todos los listeners y configurar uno nuevo (solo la primera vez)
    const newClienteLink = clearAllListeners();
    if (newClienteLink) {
      // Agregar solo el listener principal
      newClienteLink.addEventListener("click", handleClientAreaClick);
      if (!window.__listenerConfigured) {
        fylDevLog("✅ Listener de click configurado (sin duplicados)");
        window.__listenerConfigured = true;
      }
    }

    isInitialized = true;
  } catch (error) {
    console.error("❌ Error inicializando auth:", error);
  } finally {
    isInitializing = false;
  }
}

// Función para inicializar con debounce
function debouncedInit() {
  if (initTimeout) {
    clearTimeout(initTimeout);
  }
  initTimeout = setTimeout(() => {
    initializeAuth();
  }, 100);
}

// Inicializar cuando se carga la página (solo una vez)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", debouncedInit);
} else {
  // DOM ya cargado, ejecutar después de un pequeño delay
  debouncedInit();
}

// Escuchar cambios de autenticación (solo actualizar, no reinicializar)
let lastAuthState = null;
let lastAuthEvent = null;

if (
  !supabase ||
  typeof supabase.auth?.onAuthStateChange !== "function"
) {
  console.warn(
    "[FYL auth] supabase no disponible: se omite onAuthStateChange (catálogo puede cargar sin sesión)"
  );
  globalThis.markBootStage?.("auth.skipped_no_supabase", {
    hasClient: !!supabase,
    hasOnAuthStateChange: typeof supabase?.auth?.onAuthStateChange === "function",
  });
} else {
  supabase.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT") {
    clearProfileOnboardingSessionFlag();
  }
  try {
    fylAnalytics.onSupabaseAuthEvent(event, session);
  } catch (_e) {}

  const currentState = session ? "SIGNED_IN" : "SIGNED_OUT";
  
  // Solo loguear si el estado realmente cambió o si es un evento diferente importante
  // Ignorar INITIAL_SESSION si ya estamos en el mismo estado
  if (currentState !== lastAuthState || (event !== lastAuthEvent && event !== 'INITIAL_SESSION')) {
    fylDevLog(
      "🔄 Cambio de estado de autenticación:",
      event,
      session ? "Usuario logueado" : "Usuario deslogueado"
    );
    lastAuthState = currentState;
    lastAuthEvent = event;
  }

  if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
    requestAnimationFrame(() => restorePostAuthNavigation());
    if (!window.__CATALOG_ONLY__) {
      maybeShowProfileOnboardingModal({
        onComplete: () => updateClientAreaLink(),
      }).catch(() => {});
    }
  }
  
  // Actualizar el link sin reinicializar todo (sin logs repetidos)
  updateClientAreaLink();
  });
}

// Escuchar cambios de tamaño de ventana para actualizar el cliente-link en mobile/desktop
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    // Solo actualizar si el usuario está autenticado
    const clienteLink = document.querySelector(".cliente-link");
    if (clienteLink && clienteLink.querySelector("img")) {
      updateClientAreaLink();
    }
  }, 250);
});

// Función de fallback inmediata
function forceUpdateAuth() {
  fylDevLog("🔄 Forzando actualización de autenticación...");
  updateClientAreaLink();
}

// Función para limpiar completamente todos los listeners
function clearAllListeners() {
  fylDevLog("🧹 Limpiando todos los listeners...");

  const clienteLink = document.querySelector(".cliente-link");
  if (clienteLink) {
    // Clonar el elemento para eliminar todos los listeners
    const newClienteLink = clienteLink.cloneNode(true);
    clienteLink.parentNode.replaceChild(newClienteLink, clienteLink);

    fylDevLog("✅ Todos los listeners eliminados");
    return newClienteLink;
  }

  return null;
}

// Función de debug para verificar sesión
window.debugSession = async function () {
  console.log("🔧 Debug de sesión iniciado...");

  if (!supabase?.auth?.getSession) {
    console.error("❌ supabase no disponible");
    return { success: false, error: "no_supabase_client" };
  }

  try {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();

    if (error) {
      if (!isExpectedAuthErrorHandled(error, "auth-status:debugSession:getSession:error")) {
        console.error("❌ Error obteniendo sesión:", error);
      }
      return { success: false, error: error.message };
    }

    if (!session) {
      console.log("👤 No hay sesión activa");
      return { success: false, message: "No hay sesión" };
    }

    console.log("✅ Sesión activa:", session.user.email);
    console.log("📊 Datos del usuario:", {
      email: session.user.email,
      id: session.user.id,
      avatar_url: session.user.user_metadata?.avatar_url,
      full_name: session.user.user_metadata?.full_name,
    });

    return {
      success: true,
      session: session,
      user: session.user,
    };
  } catch (error) {
    if (!isExpectedAuthErrorHandled(error, "auth-status:debugSession:catch")) {
      console.error("❌ Error en debug de sesión:", error);
    }
    return { success: false, error: error.message };
  }
};

// Función para debug completo
window.debugButton = function () {
  console.log("🔧 Debug completo del botón...");

  const clienteLink = document.querySelector(".cliente-link");
  if (clienteLink) {
    console.log("✅ Botón encontrado:", clienteLink);
    console.log("📋 Contenido:", clienteLink.innerHTML);

    // Limpiar y reconfigurar
    clearAllListeners();
    const newClienteLink = document.querySelector(".cliente-link");
    if (newClienteLink) {
      newClienteLink.addEventListener("click", handleClientAreaClick);
      console.log("✅ Botón reconfigurado");
    }
  } else {
    console.error("❌ Botón no encontrado");
  }
};

// Exportar funciones para uso global
window.updateClientAreaLink = updateClientAreaLink;
window.forceUpdateAuth = forceUpdateAuth;
window.initializeAuth = initializeAuth;
window.clearAllListeners = clearAllListeners;

// El script se inicializa automáticamente cuando el DOM está listo
// No necesitamos ejecutarlo manualmente aquí para evitar duplicados
