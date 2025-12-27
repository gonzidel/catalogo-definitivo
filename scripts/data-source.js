// scripts/data-source.js
// Proveedor de datos con fallback: Supabase si está configurado, OpenSheet si no.

import { supabase } from "./supabase-client.js";
import { USE_SUPABASE, USE_OPEN_SHEET_FALLBACK } from "./config.js";
import {
  errorHandler,
  handlePromise,
  withRetry,
  withTimeout,
} from "./error-handler.js";

function parseFecha(str) {
  if (!str) return null;
  const [d, m, y] = str.split("/").map((n) => parseInt(n, 10));
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

async function fetchOpenSheetCategory(cat, sheetID) {
  const url = `https://opensheet.elk.sh/${sheetID}/${cat}`;

  try {
    const response = await withTimeout(
      fetch(url),
      10000,
      `fetchOpenSheetCategory-${cat}`
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    errorHandler.log(
      `OpenSheet data loaded for ${cat}: ${data.length} items`,
      "data-source",
      "info"
    );
    return data;
  } catch (error) {
    errorHandler.log(error, `fetchOpenSheetCategory-${cat}`);
    return [];
  }
}

export async function getCategoryData(
  cat,
  { categorias = [], sheetID = "" } = {}
) {
  try {
    // 1) Supabase si está disponible
    if (USE_SUPABASE && supabase) {
      const supabaseData = await withRetry(
        () => fetchFromSupabase(cat, categorias),
        2,
        1000
      )();

      if (supabaseData && supabaseData.length > 0) {
        errorHandler.log(
          `Supabase data loaded for ${cat}: ${supabaseData.length} items`,
          "data-source",
          "info"
        );
        return supabaseData;
      }
    }

    // 2) Fallback OpenSheet (solo si está permitido)
    if (!USE_OPEN_SHEET_FALLBACK) {
      errorHandler.log(
        `OpenSheet deshabilitado por configuración para: ${cat}`,
        "data-source",
        "warn"
      );
      return [];
    }

    if (cat === "Novedades" || cat === "Ofertas") {
      const chunks = await Promise.all(
        categorias.map((c) => fetchOpenSheetCategory(c, sheetID))
      );
      const flatData = chunks.flat();
      errorHandler.log(
        `OpenSheet special category loaded for ${cat}: ${flatData.length} items`,
        "data-source",
        "info"
      );
      return flatData;
    } else {
      const data = await fetchOpenSheetCategory(cat, sheetID);
      return data;
    }
  } catch (error) {
    errorHandler.log({ ...error, critical: true }, `getCategoryData-${cat}`);
    return [];
  }
}

async function fetchFromSupabase(cat, categorias) {
  try {
    // Intentar primero con vista normalizada
    let query = supabase.from("catalog_public_view").select("*");
    if (categorias.includes(cat)) {
      query = query.eq("Categoria", cat);
    }

    const { data, error } = await withTimeout(
      query,
      8000,
      `supabase-catalog_public_view-${cat}`
    );

    if (!error && Array.isArray(data) && data.length > 0) {
      return normalizeSupabaseData(data);
    }

    // Fallback a tabla plana
    query = supabase.from("catalog_items").select("*");
    if (categorias.includes(cat)) {
      query = query.eq("Categoria", cat);
    }

    const { data: fallbackData, error: fallbackError } = await withTimeout(
      query,
      8000,
      `supabase-catalog_items-${cat}`
    );

    if (
      !fallbackError &&
      Array.isArray(fallbackData) &&
      fallbackData.length > 0
    ) {
      return normalizeSupabaseData(fallbackData, true);
    }

    throw new Error("No data found in Supabase");
  } catch (error) {
    errorHandler.log(error, `fetchFromSupabase-${cat}`);
    throw error;
  }
}

function normalizeSupabaseData(data, isFallback = false) {
  return data.map((row) => {
    const out = { ...row };

    // Normalizar booleanos
    if (typeof out.Mostrar === "boolean") {
      out.Mostrar = out.Mostrar ? "TRUE" : "FALSE";
    }
    if (typeof out.Oferta === "boolean") {
      out.Oferta = out.Oferta ? "TRUE" : "FALSE";
    }

    // Asegurar campos requeridos
    const requiredFields = [
      "Imagen Principal",
      "Imagen 1",
      "Imagen 2",
      "Imagen 3",
      "Filtro1",
      "Filtro2",
      "Filtro3",
      "Precio",
      "Descripcion",
      "FechaIngreso",
    ];

    requiredFields.forEach((k) => {
      if (out[k] == null) out[k] = "";
    });

    // Mapeo para fallback
    if (isFallback) {
      out["Imagen Principal"] =
        out["Imagen Principal"] || out.imagen_principal || "";
      out["Imagen 1"] = out["Imagen 1"] || out.imagen_1 || "";
      out["Imagen 2"] = out["Imagen 2"] || out.imagen_2 || "";
      out["Imagen 3"] = out["Imagen 3"] || out.imagen_3 || "";
    }

    return out;
  });
}

// Exponer global para uso desde main.js sin imports adicionales
window.getCategoryData = getCategoryData;
