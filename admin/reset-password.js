// admin/reset-password.js
import { supabase } from "../scripts/supabase-client.js";

const form = document.getElementById("reset-form");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirm-password");
const submitBtn = document.getElementById("submit-btn");
const messageContainer = document.getElementById("message-container");

// Verificar si hay un token de reset en la URL
async function checkResetToken() {
  try {
    // Obtener el hash de la URL
    const hash = window.location.hash;
    console.log("Hash de URL:", hash);

    // Verificar si hay parámetros de error
    if (hash.includes("error=")) {
      const params = new URLSearchParams(hash.substring(1));
      const error = params.get("error");
      const errorDescription = params.get("error_description");
      
      if (error === "access_denied" || error === "otp_expired") {
        showMessage(
          "El enlace de restablecimiento de contraseña ha expirado o es inválido. Por favor, solicita un nuevo enlace desde la página de login.",
          "error"
        );
        submitBtn.disabled = true;
        return false;
      }
    }

    // Esperar a que Supabase procese el hash (puede tomar un momento)
    console.log("Esperando a que Supabase procese el token del hash...");
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verificar si hay un token de sesión válido
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    
    if (sessionError) {
      console.error("Error obteniendo sesión:", sessionError);
      // No es necesariamente un error, puede que el token aún no se haya procesado
    }

    if (session) {
      console.log("✅ Sesión encontrada, token válido");
      showMessage("Enlace válido. Ingresa tu nueva contraseña.", "info");
      submitBtn.disabled = false;
      return true;
    }

    // Si no hay sesión, verificar si hay un token en el hash
    // Los tokens de reset de Supabase vienen en formato: #access_token=...&type=recovery
    if (hash.includes("access_token") || hash.includes("type=recovery")) {
      console.log("Token de recuperación detectado en el hash, esperando procesamiento...");
      // Esperar un poco más para que Supabase procese el token
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const { data: { session: newSession } } = await supabase.auth.getSession();
      if (newSession) {
        console.log("✅ Sesión creada después de procesar el token");
        showMessage("Enlace válido. Ingresa tu nueva contraseña.", "info");
        submitBtn.disabled = false;
        return true;
      }
    }

    // Si llegamos aquí, no hay sesión ni token válido
    showMessage(
      "No se pudo verificar el enlace. El enlace puede haber expirado. Por favor, solicita un nuevo enlace de restablecimiento de contraseña desde la página de login.",
      "error"
    );
    submitBtn.disabled = true;
    return false;
  } catch (error) {
    console.error("Error verificando token:", error);
    showMessage("Error al verificar el enlace. Por favor, intenta de nuevo.", "error");
    submitBtn.disabled = true;
    return false;
  }
}

// Manejar el envío del formulario
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const password = passwordInput.value;
  const confirmPassword = confirmPasswordInput.value;

  // Validaciones
  if (password.length < 6) {
    showMessage("La contraseña debe tener al menos 6 caracteres", "error");
    return;
  }

  if (password !== confirmPassword) {
    showMessage("Las contraseñas no coinciden", "error");
    return;
  }

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = "Cambiando contraseña...";

    // Actualizar la contraseña usando Supabase
    const { data, error } = await supabase.auth.updateUser({
      password: password
    });

    if (error) {
      throw error;
    }

    showMessage("✅ Contraseña cambiada exitosamente. Redirigiendo al login...", "success");

    // Esperar un momento y redirigir al login
    setTimeout(() => {
      window.location.href = "./index.html";
    }, 2000);

  } catch (error) {
    console.error("Error cambiando contraseña:", error);
    
    let errorMessage = "Error al cambiar la contraseña";
    if (error.message.includes("expired") || error.message.includes("invalid")) {
      errorMessage = "El enlace ha expirado. Por favor, solicita un nuevo enlace de restablecimiento de contraseña.";
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    showMessage(errorMessage, "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Cambiar Contraseña";
  }
});

// Mostrar mensaje
function showMessage(message, type = "info") {
  messageContainer.innerHTML = `<div class="message ${type}">${message}</div>`;
}

// Escuchar cambios en el hash de la URL (para cuando Supabase procesa el token)
window.addEventListener("hashchange", async () => {
  console.log("Hash cambió, verificando token...");
  await checkResetToken();
});

// Verificar token al cargar la página
checkResetToken();

// También escuchar eventos de autenticación de Supabase
supabase.auth.onAuthStateChange((event, session) => {
  console.log("Estado de autenticación cambió:", event, session);
  
  if (event === "PASSWORD_RECOVERY") {
    console.log("Recuperación de contraseña detectada");
    showMessage("Enlace válido. Ingresa tu nueva contraseña.", "info");
    submitBtn.disabled = false;
  } else if (event === "SIGNED_IN") {
    console.log("Usuario autenticado");
  }
});

