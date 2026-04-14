// scripts/auth-wait.js - Esperar autenticación completa
/**
 * Utilidad para esperar a que la autenticación esté completamente lista
 * antes de ejecutar cualquier lógica que dependa de ella
 */

import { fylDevLog } from "./config.js";

function hasLikelySupabaseSession() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    const raw = window.localStorage.getItem("sb-dtfznewwvsadkorxwzft-auth-token");
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed) return false;
    if (typeof parsed.access_token === "string" && parsed.access_token.length > 20) return true;
    if (
      typeof parsed.currentSession?.access_token === "string" &&
      parsed.currentSession.access_token.length > 20
    ) {
      return true;
    }
    return false;
  } catch (_e) {
    return false;
  }
}

// Función para esperar autenticación completa
// Reducimos la espera por defecto para que el fallback de no autenticado
// no demore tanto en páginas cliente.
async function waitForAuth(maxWaitTime = 1800) {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = Math.floor(maxWaitTime / 100);

    const checkAuth = async () => {
      attempts++;

      try {
        if (!window.supabase) {
          if (attempts >= maxAttempts) {
            fylDevLog("⏰ Timeout: Supabase no disponible");
            resolve({ user: null, error: "Supabase no disponible" });
            return;
          }
          setTimeout(checkAuth, 100);
          return;
        }

        // Si no hay token local de sesión, salir rápido para no demorar fallback de invitado.
        if (!hasLikelySupabaseSession() && attempts >= 2) {
          resolve({ user: null, error: "Sin sesión local" });
          return;
        }

        const {
          data: { user },
          error,
        } = await window.supabase.auth.getUser();

        if (user && !error) {
          fylDevLog("✅ Autenticación confirmada:", user.email);
          resolve({ user, error: null });
          return;
        }

        if (error && error.message !== "Auth session missing!") {
          fylDevLog("❌ Error de autenticación:", error.message);
          resolve({ user: null, error: error.message });
          return;
        }

        // Si no hay usuario pero tampoco error crítico, seguir esperando
        if (attempts >= maxAttempts) {
          fylDevLog("⏰ Timeout: No se pudo confirmar autenticación");
          resolve({ user: null, error: "Timeout de autenticación" });
          return;
        }

        fylDevLog(
          `⏳ Esperando autenticación... (${attempts}/${maxAttempts})`
        );
        setTimeout(checkAuth, 100);
      } catch (err) {
        console.error("❌ Error verificando autenticación:", err);
        if (attempts >= maxAttempts) {
          resolve({ user: null, error: err.message });
          return;
        }
        setTimeout(checkAuth, 100);
      }
    };

    checkAuth();
  });
}

// Función para ejecutar código solo cuando la autenticación esté lista
async function withAuth(callback, fallback = null) {
  try {
    const authResult = await waitForAuth();

    if (authResult.user) {
      return await callback(authResult.user);
    } else {
      fylDevLog("👤 Usuario no autenticado, ejecutando fallback");
      if (fallback) {
        return await fallback(authResult.error);
      }
      return null;
    }
  } catch (error) {
    console.error("❌ Error en withAuth:", error);
    if (fallback) {
      return await fallback(error.message);
    }
    return null;
  }
}

// Función para mostrar loader mientras espera autenticación
function showAuthLoader(message = "Verificando autenticación...") {
  const loader = document.createElement("div");
  loader.id = "auth-loader";
  loader.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(255, 255, 255, 0.9);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    z-index: 9999;
    font-family: Arial, sans-serif;
  `;

  loader.innerHTML = `
    <div style="text-align: center;">
      <div style="width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #CD844D; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px;"></div>
      <div style="color: #333; font-size: 16px;">${message}</div>
    </div>
    <style>
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    </style>
  `;

  document.body.appendChild(loader);
  return loader;
}

// Función para ocultar loader
function hideAuthLoader() {
  const loader = document.getElementById("auth-loader");
  if (loader) {
    loader.remove();
  }
}

// Función para inicializar página con autenticación
async function initPageWithAuth(
  authenticatedCallback,
  notAuthenticatedCallback = null
) {
  // Mostrar loader
  const loader = showAuthLoader();

  try {
    const authResult = await waitForAuth();

    // Ocultar loader
    hideAuthLoader();

    if (authResult.user) {
      fylDevLog("✅ Página inicializada con usuario autenticado");
      if (authenticatedCallback) {
        await authenticatedCallback(authResult.user);
      }
    } else {
      fylDevLog("👤 Usuario no autenticado");
      if (notAuthenticatedCallback) {
        await notAuthenticatedCallback(authResult.error);
      }
    }
  } catch (error) {
    console.error("❌ Error inicializando página:", error);
    hideAuthLoader();

    if (notAuthenticatedCallback) {
      await notAuthenticatedCallback(error.message);
    }
  }
}

// Exponer funciones globalmente
window.waitForAuth = waitForAuth;
window.withAuth = withAuth;
window.showAuthLoader = showAuthLoader;
window.hideAuthLoader = hideAuthLoader;
window.initPageWithAuth = initPageWithAuth;

fylDevLog("Auth-wait.js cargado - utilidades de autenticación disponibles");
