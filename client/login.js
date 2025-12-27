import { supabase } from "../scripts/supabase-client.js";
import { checkPasskeySupport, authenticateWithPasskey } from "../scripts/passkeys.js";
import { hasInitialProfileComplete } from "./auth-helper.js";

const btn = document.getElementById("google-btn");
const msg = document.getElementById("msg");
const biometricSection = document.getElementById("biometric-section");
const biometricBtn = document.getElementById("biometric-btn");
const biometricEmail = document.getElementById("biometric-email");

btn?.addEventListener("click", async () => {
  msg.textContent = "";
  msg.className = "";
  btn.disabled = true;
  btn.textContent = "Iniciando sesión...";

  try {
    console.log("🔐 Iniciando login con Google...");

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/client/dashboard.html`,
        queryParams: {
          prompt: "select_account",
          access_type: "offline",
        },
      },
    });

    if (error) {
      console.error("❌ Error en OAuth:", error);
      msg.textContent = `Error: ${error.message}`;
      msg.className = "msg error";
      btn.disabled = false;
      btn.textContent = "Continuar con Google";
    } else {
      console.log("✅ Redirigiendo a Google...");
      msg.textContent = "Redirigiendo a Google...";
      msg.className = "msg success";
    }
  } catch (e) {
    console.error("❌ Error en login:", e);
    msg.textContent = `Error: ${e.message || String(e)}`;
    msg.className = "msg error";
    btn.disabled = false;
    btn.textContent = "Continuar con Google";
  }
});

// Verificar soporte WebAuthn y mostrar sección biométrica
window.addEventListener("load", async () => {
  // Verificar soporte WebAuthn
  if (checkPasskeySupport()) {
    biometricSection.style.display = "block";
    biometricBtn.style.display = "flex";
    
    // Cargar último email usado si existe
    const lastEmail = localStorage.getItem("last_login_email");
    if (lastEmail) {
      biometricEmail.value = lastEmail;
    }
  }

  // Handler para botón biométrico
  biometricBtn?.addEventListener("click", async () => {
    const email = biometricEmail.value.trim();
    
    if (!email) {
      msg.textContent = "Por favor ingresá tu email";
      msg.className = "msg error";
      msg.style.display = "block";
      return;
    }

    // Validar formato de email básico
    if (!email.includes("@")) {
      msg.textContent = "Email inválido";
      msg.className = "msg error";
      msg.style.display = "block";
      return;
    }

    // Guardar email para próxima vez
    localStorage.setItem("last_login_email", email);

    biometricBtn.disabled = true;
    biometricBtn.textContent = "Verificando...";
    msg.textContent = "";
    msg.className = "";
    msg.style.display = "none";

    try {
      await authenticateWithPasskey(email);
      // Si authenticateWithPasskey tiene éxito, redirige automáticamente
    } catch (error) {
      console.error("❌ Error en autenticación biométrica:", error);
      msg.textContent = error.message || "Error al autenticar con passkey";
      msg.className = "msg error";
      msg.style.display = "block";
      biometricBtn.disabled = false;
      biometricBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          <path d="M9 12l2 2 4-4"/>
        </svg>
        Entrar con huella/rostro
      `;
    }
  });

  // Verificar la sesión al cargar la página
  try {
    console.log("🔍 Verificando si hay sesión activa...");

    const { data, error } = await supabase.auth.getSession();

    if (error || !data?.session) {
      console.log("👤 No hay sesión activa");
      return;
    }

    console.log("✅ Sesión activa encontrada:", data.session.user.email);

    // Verificar si tiene perfil inicial completo
    const hasInitialProfile = await hasInitialProfileComplete();

    if (!hasInitialProfile) {
      console.log("📝 Sin perfil inicial completo, redirigiendo a complete-profile");
      window.location.href = "./complete-profile.html";
      return;
    }

    console.log("✅ Perfil inicial completo, redirigiendo a dashboard");
    window.location.href = "./dashboard.html";
  } catch (error) {
    console.error("❌ Error verificando sesión:", error);
  }
});
