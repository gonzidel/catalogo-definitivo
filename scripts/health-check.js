// scripts/health-check.js - Verificación de salud del sistema
// Ejecutar en consola: window.runHealthCheck()

class HealthChecker {
  constructor() {
    this.checks = [];
    this.results = [];
  }

  async runAllChecks() {
    console.group("🏥 Health Check - Catálogo FYL");

    this.results = [];

    // Verificaciones básicas
    await this.checkConfiguration();
    await this.checkSupabaseConnection();
    await this.checkOpenSheetFallback();
    await this.checkAuthentication();
    await this.checkCartSystem();
    await this.checkPWA();
    await this.checkErrorHandler();

    // Mostrar resumen
    this.showSummary();

    console.groupEnd();

    return this.results;
  }

  async checkConfiguration() {
    console.log("🔧 Verificando configuración...");

    const config = {
      supabaseEnabled: window.USE_SUPABASE,
      opensheetEnabled: window.USE_OPEN_SHEET_FALLBACK,
      supabaseUrl: window.SUPABASE_URL,
      hasLocalConfig: false,
    };

    try {
      // Verificar si existe config.local.js
      const localConfig = await import("./config.local.js?v=m260607");
      config.hasLocalConfig = true;
      config.supabaseUrl = localConfig.SUPABASE_URL || window.SUPABASE_URL;
    } catch (e) {
      // No hay config local, usar la por defecto
    }

    const isValid =
      config.supabaseEnabled &&
      config.supabaseUrl &&
      config.supabaseUrl.includes("supabase.co");

    this.addResult("Configuration", isValid ? "PASS" : "FAIL", {
      supabaseEnabled: config.supabaseEnabled,
      opensheetEnabled: config.opensheetEnabled,
      hasLocalConfig: config.hasLocalConfig,
      supabaseUrl: config.supabaseUrl,
    });

    if (!isValid) {
      console.warn(
        "⚠️ Configuración incompleta. Verifica scripts/config.local.js"
      );
    }
  }

  async checkSupabaseConnection() {
    console.log("🗄️ Verificando conexión a Supabase...");

    try {
      if (!window.supabase) {
        throw new Error("Cliente de Supabase no disponible");
      }

      // Intentar una consulta simple
      const { data, error } = await window.supabase
        .from("catalog_public_view")
        .select("count")
        .limit(1);

      if (error) {
        throw new Error(`Error de Supabase: ${error.message}`);
      }

      this.addResult("Supabase Connection", "PASS", {
        message: "Conexión exitosa a Supabase",
        dataAvailable: data !== null,
      });
    } catch (error) {
      this.addResult("Supabase Connection", "FAIL", {
        error: error.message,
        suggestion: "Verifica la configuración de Supabase",
      });
    }
  }

  async checkOpenSheetFallback() {
    console.log("📊 Verificando fallback a Google Sheets...");

    try {
      const response = await fetch(
        "https://opensheet.elk.sh/1kdhxSWHl3Rg0tXpaRsKhR_m30oTZhzqYj5ypsjtcTig/Calzado"
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      this.addResult("OpenSheet Fallback", "PASS", {
        message: "Google Sheets accesible",
        itemsCount: data.length,
      });
    } catch (error) {
      this.addResult("OpenSheet Fallback", "FAIL", {
        error: error.message,
        suggestion: "Verifica la conexión a internet",
      });
    }
  }

  async checkAuthentication() {
    console.log("🔐 Verificando sistema de autenticación...");

    try {
      if (!window.supabase) {
        throw new Error("Cliente de Supabase no disponible");
      }

      const {
        data: { session },
        error,
      } = await window.supabase.auth.getSession();

      if (error) {
        throw new Error(`Error de autenticación: ${error.message}`);
      }

      const isAuthenticated = !!session;

      this.addResult("Authentication", "PASS", {
        message: isAuthenticated
          ? "Usuario autenticado"
          : "Sistema de auth funcional",
        isAuthenticated,
        userEmail: session?.user?.email || null,
      });
    } catch (error) {
      this.addResult("Authentication", "FAIL", {
        error: error.message,
        suggestion: "Verifica la configuración de OAuth",
      });
    }
  }

  async checkCartSystem() {
    console.log("🛒 Verificando sistema de carrito...");

    try {
      const cartExists = typeof window.addToCart === "function";
      const cartPersistent = typeof window.syncCartWithSupabase === "function";
      const cartData = localStorage.getItem("cart");

      const isValid = cartExists && cartPersistent;

      this.addResult("Cart System", isValid ? "PASS" : "FAIL", {
        addToCartFunction: cartExists,
        persistentCart: cartPersistent,
        hasCartData: !!cartData,
        cartItemsCount: cartData ? JSON.parse(cartData).length : 0,
      });
    } catch (error) {
      this.addResult("Cart System", "FAIL", {
        error: error.message,
        suggestion: "Verifica que cart-persistent.js esté cargado",
      });
    }
  }

  async checkPWA() {
    console.log("📱 Verificando PWA...");

    try {
      const manifest = document.querySelector('link[rel="manifest"]');
      const serviceWorker = "serviceWorker" in navigator;
      const installable = window.deferredPrompt !== undefined;

      const isValid = manifest && serviceWorker;

      this.addResult("PWA", isValid ? "PASS" : "FAIL", {
        manifest: !!manifest,
        serviceWorker: serviceWorker,
        installable: installable,
        manifestHref: manifest?.href,
      });
    } catch (error) {
      this.addResult("PWA", "FAIL", {
        error: error.message,
        suggestion: "Verifica manifest.json y sw.js",
      });
    }
  }

  async checkErrorHandler() {
    console.log("⚠️ Verificando sistema de errores...");

    try {
      const errorHandlerExists = typeof window.errorHandler === "object";
      const errorFunctions = [
        "handlePromise",
        "handleFetchError",
        "withRetry",
        "withTimeout",
      ].every((fn) => typeof window[fn] === "function");

      const isValid = errorHandlerExists && errorFunctions;

      this.addResult("Error Handler", isValid ? "PASS" : "FAIL", {
        errorHandler: errorHandlerExists,
        utilityFunctions: errorFunctions,
        recentErrors: errorHandlerExists
          ? window.errorHandler.getErrors().length
          : 0,
      });
    } catch (error) {
      this.addResult("Error Handler", "FAIL", {
        error: error.message,
        suggestion: "Verifica que error-handler.js esté cargado",
      });
    }
  }

  addResult(check, status, details) {
    const result = {
      check,
      status,
      details,
      timestamp: new Date().toISOString(),
    };

    this.results.push(result);

    const icon = status === "PASS" ? "✅" : "❌";
    console.log(`${icon} ${check}: ${status}`);

    if (details && Object.keys(details).length > 0) {
      console.log("   Detalles:", details);
    }
  }

  showSummary() {
    const passed = this.results.filter((r) => r.status === "PASS").length;
    const total = this.results.length;
    const percentage = Math.round((passed / total) * 100);

    console.log(
      `\n📊 Resumen: ${passed}/${total} verificaciones pasaron (${percentage}%)`
    );

    const failed = this.results.filter((r) => r.status === "FAIL");
    if (failed.length > 0) {
      console.log("\n❌ Verificaciones fallidas:");
      failed.forEach((result) => {
        console.log(
          `   - ${result.check}: ${
            result.details?.error || "Error desconocido"
          }`
        );
      });
    }

    if (percentage >= 80) {
      console.log("🎉 ¡Sistema en buen estado!");
    } else if (percentage >= 60) {
      console.log("⚠️ Sistema funcional con algunos problemas");
    } else {
      console.log("🚨 Sistema necesita atención inmediata");
    }
  }

  // Función para verificación rápida
  async quickCheck() {
    console.log("⚡ Verificación rápida...");

    const criticalChecks = [
      "Configuration",
      "Supabase Connection",
      "OpenSheet Fallback",
    ];

    const results = await this.runAllChecks();
    const criticalResults = results.filter((r) =>
      criticalChecks.includes(r.check)
    );
    const criticalPassed = criticalResults.filter(
      (r) => r.status === "PASS"
    ).length;

    return {
      critical: criticalPassed === criticalResults.length,
      percentage: Math.round((criticalPassed / criticalResults.length) * 100),
      results: criticalResults,
    };
  }
}

// Instancia global
const healthChecker = new HealthChecker();

// Funciones globales para uso en consola
window.runHealthCheck = () => healthChecker.runAllChecks();
window.quickHealthCheck = () => healthChecker.quickCheck();
window.healthChecker = healthChecker;

// Auto-ejecutar verificación rápida al cargar (solo en desarrollo)
if (
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
) {
  setTimeout(() => {
    console.log("🔍 Ejecutando verificación automática...");
    healthChecker.quickCheck();
  }, 3000);
}

export { healthChecker };

