// admin/meta-feed.js
// Módulo admin para gestionar Meta Catalog Feed
// Usa Edge Function (NO RPC directo) para evitar problemas de RLS/privilegios

import { supabase } from "../scripts/supabase-client.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../scripts/config.js";

// Configuración desde localStorage
const CONFIG_KEY = "meta_feed_config";
const ERROR_LOG_KEY = "meta_feed_errors";
const MAX_ERRORS = 50;

// Obtener URL de Edge Function
function getEdgeFunctionURL() {
  // Obtener URL de Supabase desde config importado
  const supabaseUrl = SUPABASE_URL || "";
  
  if (!supabaseUrl) {
    console.error("No se pudo obtener SUPABASE_URL");
    return "";
  }
  
  const basePath = `${supabaseUrl}/functions/v1/meta-feed`;
  return basePath;
}

// Obtener configuración desde localStorage
function getConfig() {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error("Error leyendo configuración:", e);
  }
  return {
    baseUrl: "https://tudominio.com",
    currency: "ARS",
    availabilityRule: "available > 0",
    feedToken: "",
  };
}

// Guardar configuración en localStorage
function saveConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    return true;
  } catch (e) {
    console.error("Error guardando configuración:", e);
    return false;
  }
}

// Agregar error al log
function addError(message) {
  try {
    const errors = getErrors();
    errors.unshift({
      time: new Date().toISOString(),
      message,
    });
    if (errors.length > MAX_ERRORS) {
      errors.pop();
    }
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(errors));
  } catch (e) {
    console.error("Error guardando log:", e);
  }
}

// Obtener errores del log
function getErrors() {
  try {
    const stored = localStorage.getItem(ERROR_LOG_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error("Error leyendo log:", e);
  }
  return [];
}

// Generar token aleatorio
function generateToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Llamar Edge Function
async function callEdgeFunction(params = {}) {
  try {
    const url = new URL(getEdgeFunctionURL());
    Object.entries(params).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, value);
      }
    });

    // Obtener token de sesión si está disponible
    const { data: { session } } = await supabase.auth.getSession();
    const headers = {};

    // Agregar apikey de Supabase (requerido para Edge Functions)
    if (SUPABASE_ANON_KEY) {
      headers["apikey"] = SUPABASE_ANON_KEY;
    }

    // Si hay sesión, usar JWT
    if (session?.access_token) {
      headers["Authorization"] = `Bearer ${session.access_token}`;
    } else {
      // Si no hay sesión, usar token configurado
      const config = getConfig();
      if (config.feedToken) {
        url.searchParams.set("token", config.feedToken);
      }
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      mode: "cors",
      credentials: "omit",
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error ${response.status}: ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Error llamando Edge Function:", error);
    const errorMessage = error.message || "Error desconocido";
    addError(errorMessage);
    
    // Si es un error de CORS o red, dar mensaje más claro
    if (errorMessage.includes("Failed to fetch") || errorMessage.includes("CORS")) {
      throw new Error("Error de conexión. Verifica que la Edge Function esté desplegada y que CORS esté configurado correctamente.");
    }
    
    throw error;
  }
}

// Descargar CSV
async function downloadCSV() {
  try {
    const url = new URL(getEdgeFunctionURL());
    const config = getConfig();
    
    // Agregar token si está configurado
    if (config.feedToken) {
      url.searchParams.set("token", config.feedToken);
    }

    // Obtener token de sesión si está disponible
    const { data: { session } } = await supabase.auth.getSession();
    const headers = {};

    // Agregar apikey de Supabase (requerido para Edge Functions)
    if (SUPABASE_ANON_KEY) {
      headers["apikey"] = SUPABASE_ANON_KEY;
    }

    if (session?.access_token) {
      headers["Authorization"] = `Bearer ${session.access_token}`;
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      mode: "cors",
      credentials: "omit",
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error ${response.status}: ${errorText}`);
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = `meta-feed-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(downloadUrl);

    // Actualizar última generación
    updateLastGeneration();
  } catch (error) {
    console.error("Error descargando CSV:", error);
    addError(error.message);
    alert(`Error descargando CSV: ${error.message}`);
  }
}

// Cargar preview y métricas
async function loadPreview() {
  const previewContainer = document.getElementById("preview-container");
  const previewTbody = document.getElementById("preview-tbody");
  const loadingEl = document.getElementById("loading-preview");

  try {
    previewContainer.style.display = "block";
    previewTbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando...</td></tr>';

    const result = await callEdgeFunction({
      format: "json",
      limit: 20,
    });

    if (!result.data || !Array.isArray(result.data)) {
      throw new Error("No se obtuvieron datos");
    }

    // Actualizar métricas
    if (result.metrics) {
      updateMetrics(result.metrics, result.total);
      updatePreviewMetricsBadges(result.metrics);
    }

    // Renderizar preview
    previewTbody.innerHTML = result.data
      .map(
        (row) => `
      <tr>
        <td>${escapeHtml(row.id)}</td>
        <td>${escapeHtml(row.item_group_id)}</td>
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.price)}</td>
        <td>${escapeHtml(row.availability)}</td>
        <td><img src="${escapeHtml(row.image_link)}" style="width: 50px; height: 50px; object-fit: cover;" onerror="this.src='https://via.placeholder.com/50'" /></td>
      </tr>
    `
      )
      .join("");

    updateLastGeneration();
  } catch (error) {
    console.error("Error cargando preview:", error);
    previewTbody.innerHTML = `<tr><td colspan="6" style="color: #e74c3c;">Error: ${escapeHtml(error.message)}</td></tr>`;
  }
}

// Actualizar métricas en UI
function updateMetrics(metrics, total) {
  document.getElementById("total-items").textContent = total || metrics.total || 0;
  document.getElementById("sin-imagen").textContent = metrics.sin_imagen || 0;
  document.getElementById("sin-precio").textContent = metrics.sin_precio || 0;
  document.getElementById("inactivas").textContent = metrics.inactivas || 0;
  document.getElementById("con-placeholder").textContent = metrics.con_placeholder || 0;
  document.getElementById("sin-descripcion").textContent = metrics.sin_descripcion || 0;
}

// Actualizar última generación
function updateLastGeneration() {
  const now = new Date();
  const formatted = now.toLocaleString("es-AR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  document.getElementById("last-generation").textContent = formatted;
}

// Actualizar badges de métricas en preview
function updatePreviewMetricsBadges(metrics) {
  const badgesContainer = document.getElementById("preview-metrics-badges");
  if (!badgesContainer) return;

  const badges = [];
  
  if (metrics.con_placeholder > 0) {
    badges.push(`<span class="metric-badge warning">Con placeholder: ${metrics.con_placeholder}</span>`);
  }
  
  if (metrics.sin_descripcion > 0) {
    badges.push(`<span class="metric-badge warning">Sin descripción: ${metrics.sin_descripcion}</span>`);
  }
  
  if (metrics.sin_imagen > 0) {
    badges.push(`<span class="metric-badge warning">Sin imagen: ${metrics.sin_imagen}</span>`);
  }
  
  if (metrics.sin_precio > 0) {
    badges.push(`<span class="metric-badge warning">Sin precio: ${metrics.sin_precio}</span>`);
  }
  
  if (metrics.inactivas > 0) {
    badges.push(`<span class="metric-badge error">Sin stock: ${metrics.inactivas}</span>`);
  }

  badgesContainer.innerHTML = badges.length > 0 
    ? badges.join("") 
    : '<span class="metric-badge">✓ Todos los ítems están completos</span>';
}

// Escapar HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Copiar URL del feed
function copyFeedURL() {
  const url = new URL(getEdgeFunctionURL());
  const config = getConfig();
  
  // Agregar token si existe
  if (config.feedToken) {
    url.searchParams.set("token", config.feedToken);
  }

  // Construir URL completa con extensión .csv
  const fullUrl = url.toString() + ".csv";

  navigator.clipboard
    .writeText(fullUrl)
    .then(() => {
      alert("URL del feed copiada al portapapeles");
    })
    .catch((err) => {
      console.error("Error copiando URL:", err);
      alert("Error copiando URL");
    });
}

// Mostrar log de errores
function showErrorLog() {
  const container = document.getElementById("error-log-container");
  const logEl = document.getElementById("error-log");
  const errors = getErrors();

  if (container.style.display === "none") {
    container.style.display = "block";
    logEl.innerHTML = errors.length
      ? errors
          .map(
            (err) => `
        <div class="error-log-item">
          <span class="error-time">${new Date(err.time).toLocaleString("es-AR")}</span>
          <span class="error-message">${escapeHtml(err.message)}</span>
        </div>
      `
          )
          .join("")
      : '<div style="color: #666;">No hay errores registrados</div>';
  } else {
    container.style.display = "none";
  }
}

// Inicializar UI
function initUI() {
  const config = getConfig();

  // Cargar configuración en inputs
  document.getElementById("base-url").value = config.baseUrl || "";
  document.getElementById("currency").value = config.currency || "ARS";
  document.getElementById("availability-rule").value = config.availabilityRule || "available > 0";
  document.getElementById("feed-token").value = config.feedToken || "";

  // Event listeners
  document.getElementById("btn-preview").addEventListener("click", loadPreview);
  document.getElementById("btn-download-csv").addEventListener("click", downloadCSV);
  document.getElementById("btn-copy-url").addEventListener("click", copyFeedURL);
  document.getElementById("btn-view-errors").addEventListener("click", showErrorLog);
  document.getElementById("btn-save-config").addEventListener("click", () => {
    const newConfig = {
      baseUrl: document.getElementById("base-url").value,
      currency: document.getElementById("currency").value,
      availabilityRule: document.getElementById("availability-rule").value,
      feedToken: document.getElementById("feed-token").value,
    };
    if (saveConfig(newConfig)) {
      alert("Configuración guardada");
    } else {
      alert("Error guardando configuración");
    }
  });

  document.getElementById("btn-generate-token").addEventListener("click", () => {
    const token = generateToken();
    document.getElementById("feed-token").value = token;
  });

  document.getElementById("btn-copy-token").addEventListener("click", () => {
    const token = document.getElementById("feed-token").value;
    if (token) {
      navigator.clipboard
        .writeText(token)
        .then(() => {
          alert("Token copiado al portapapeles");
        })
        .catch((err) => {
          console.error("Error copiando token:", err);
          alert("Error copiando token");
        });
    }
  });

  // Cargar métricas iniciales
  callEdgeFunction({ format: "json", limit: 0 })
    .then((result) => {
      if (result.metrics) {
        updateMetrics(result.metrics, result.total);
      }
    })
    .catch((err) => {
      console.error("Error cargando métricas iniciales:", err);
    });
}

// Inicializar cuando el DOM esté listo
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initUI);
} else {
  initUI();
}

