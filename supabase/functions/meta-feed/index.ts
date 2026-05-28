// supabase/functions/meta-feed/index.ts
// Edge Function para generar feed CSV de Meta Catalog
// Soporta formato CSV (default) y JSON (para admin preview)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { META_CSV_HEADERS_PHASE1 } from "./csv-schema.ts";
import { applyPhase1Enrichment } from "./enrichment-phase1.ts";

// Whitelist de origins permitidos
const ALLOWED_ORIGINS = [
  "http://localhost:5500",
  "https://fylmoda.com.ar",
  "https://www.fylmoda.com.ar",
];

// Headers CORS base
const corsHeadersBase = {
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// Función para obtener origin permitido
function getAllowedOrigin(origin: string | null): string {
  if (!origin) return "*";
  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  // Si no está en whitelist, retornar * para permitir (o cambiar a null para bloquear)
  return "*";
}

// Función para obtener headers CORS completos
function getCorsHeaders(origin: string | null) {
  return {
    ...corsHeadersBase,
    "Access-Control-Allow-Origin": getAllowedOrigin(origin),
  };
}

// Obtener variables de entorno
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";
const META_FEED_TOKEN = Deno.env.get("META_FEED_TOKEN") || "";

// Crear cliente Supabase con service role
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Escapar valor CSV según RFC 4180
function escapeCSV(value: string): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  // Si contiene coma, comilla o salto de línea, envolver en comillas y duplicar comillas internas
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Generar CSV desde array de objetos (solo columnas exportadas; category/filtro1 son internas)
function generateCSV(data: any[], headers: readonly string[]): string {
  const metaHeaders = [...headers];

  if (!data || data.length === 0) {
    return `${metaHeaders.join(",")}\n`;
  }

  const rows = data.map((row) => {
    return metaHeaders.map((header) => escapeCSV(row[header] || "")).join(",");
  });

  return [metaHeaders.join(","), ...rows].join("\n");
}

// Normalizar URL de Cloudinary para optimización
// Solo normalizar si contiene '/image/upload/v' (versión sin transformaciones)
// Si ya tiene transformaciones, no tocar
function normalizeCloudinaryURL(url: string): string {
  if (!url || typeof url !== "string") return url;
  
  // Verificar si es una URL de Cloudinary
  if (url.includes("res.cloudinary.com") && url.includes("/image/upload/")) {
    const uploadIndex = url.indexOf("/image/upload/");
    const afterUpload = url.substring(uploadIndex + "/image/upload/".length);
    
    // Solo normalizar si contiene '/image/upload/v' (versión sin transformaciones)
    // Si ya tiene transformaciones (f_auto, w_, q_, c_, etc.), no tocar
    if (afterUpload.match(/^(f_|w_|q_|c_|h_|ar_)/)) {
      return url; // Ya tiene transformaciones, retornar sin cambios
    }
    
    // Solo insertar transformaciones si después de upload/ hay 'v' (versión)
    if (afterUpload.startsWith("v")) {
      const before = url.substring(0, uploadIndex + "/image/upload/".length);
      return `${before}f_auto,q_auto,w_1200/${afterUpload}`;
    }
    
    // Si no tiene versión ni transformaciones, no tocar (caso especial)
    return url;
  }
  
  return url;
}

function isAbsoluteUrl(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeAvailability(value: string | null | undefined): "in stock" | "out of stock" {
  const t = value == null ? "" : String(value).trim().toLowerCase();
  if (t === "in stock") return "in stock";
  return "out of stock";
}

/** Quita NBSP y caracteres invisibles que Meta a veces no parsea bien. */
function sanitizeAsciiSpaces(s: string): string {
  return String(s)
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();
}

function parsePriceValue(priceText: string): number {
  if (!priceText || typeof priceText !== "string") return Number.NaN;
  const cleaned = sanitizeAsciiSpaces(priceText.replace(/\s+ARS$/i, ""));
  return Number.parseFloat(cleaned);
}

/** Meta: número + un espacio + código ISO 4217 (ej. "15000 ARS"). */
function normalizePriceForMeta(priceText: string | null | undefined): string {
  if (priceText == null || typeof priceText !== "string") return "";
  const parsed = parsePriceValue(priceText);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  const isInteger = Number.isInteger(parsed);
  const amount = isInteger ? String(parsed) : parsed.toFixed(2);
  return `${amount} ARS`;
}

function hasRealImage(imageUrl: string): boolean {
  if (!imageUrl || typeof imageUrl !== "string") return false;
  const normalized = imageUrl.toLowerCase();
  return !normalized.includes("placeholder");
}

// Calcular métricas
function calculateMetrics(data: any[]): any {
  const total = data.length;
  const sinImagen = data.filter((row) => 
    !row.image_link || 
    row.image_link === "" || 
    row.image_link.includes("placeholder")
  ).length;
  const sinPrecio = data.filter((row) => {
    const p = row.price == null ? "" : String(row.price);
    return !p || !/^\d+(\.\d{1,2})?\s+ARS$/i.test(sanitizeAsciiSpaces(p));
  }).length;
  const inactivas = data.filter((row) => 
    row.availability === "out of stock"
  ).length;
  const conPlaceholder = data.filter((row) => 
    row.image_link && 
    (row.image_link.includes("/v1/meta-placeholder") || 
     row.image_link.includes("meta-placeholder.jpg"))
  ).length;
  const sinDescripcion = data.filter((row) => 
    !row.description || 
    row.description === "" || 
    row.description.trim() === ""
  ).length;

  return {
    total,
    sin_imagen: sinImagen,
    sin_precio: sinPrecio,
    inactivas,
    con_placeholder: conPlaceholder,
    sin_descripcion: sinDescripcion,
  };
}

serve(async (req) => {
  // Obtener origin de la request
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  // Manejar CORS preflight (OPTIONS) - DEBE SER LO PRIMERO
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const format = url.searchParams.get("format") || "csv";
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : null;

    // Validar token si está configurado
    if (META_FEED_TOKEN && META_FEED_TOKEN !== "" && token !== META_FEED_TOKEN) {
      return new Response(
        JSON.stringify({ error: "Token inválido" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Log seguro del host de Supabase
    const supabaseHost = SUPABASE_URL ? new URL(SUPABASE_URL).hostname : 'not-set';
    console.log(`[meta-feed] Supabase host: ${supabaseHost}`);

    // Llamar RPC get_meta_feed()
    const { data, error } = await supabaseAdmin.rpc("get_meta_feed");

    if (error) {
      console.error("Error llamando get_meta_feed:", error);
      return new Response(
        JSON.stringify({ error: "Error obteniendo datos del feed", details: error.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!data || !Array.isArray(data)) {
      return new Response(
        JSON.stringify({ error: "No se obtuvieron datos" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Log de cantidad de filas devueltas por RPC
    console.log(`[meta-feed] RPC returned ${data.length} rows`);

    const fallbackBaseUrl = "https://fylmoda.com.ar";
    const catalogLinkBase = `${fallbackBaseUrl}/catalogo`;

    // Normalización defensiva de campos críticos para Meta
    const normalizedData = data.map((row) => {
      const safeId = row.id ? String(row.id).trim() : "";
      const rawLink = row.link ? String(row.link).trim() : "";
      const fallbackLink = `${catalogLinkBase}?sku=${encodeURIComponent(safeId)}`;
      const safeLink = isAbsoluteUrl(rawLink) ? rawLink : fallbackLink;

      const base = {
        ...row,
        id: safeId,
        title: row.title ? String(row.title).trim() : "",
        description: row.description ? String(row.description).trim() : "",
        price: normalizePriceForMeta(row.price != null ? String(row.price) : ""),
        link: safeLink,
        image_link: normalizeCloudinaryURL(row.image_link || ""),
        availability: normalizeAvailability(row.availability),
        condition: "new",
        brand: row.brand ? String(row.brand).trim() : "FYL",
      };
      return applyPhase1Enrichment(base as Record<string, unknown>);
    });

    // Filtro de calidad para catálogo de producción (RPC ya excluye sin stock)
    let excludedSinSku = 0;
    let excludedSinTitulo = 0;
    let excludedSinImagen = 0;
    let excludedSinPrecio = 0;
    let excludedSinStock = 0;

    const filteredData = normalizedData.filter((row) => {
      if (!row.id) {
        excludedSinSku += 1;
        return false;
      }

      if (row.availability !== "in stock") {
        excludedSinStock += 1;
        return false;
      }

      if (!row.title) {
        excludedSinTitulo += 1;
        return false;
      }

      if (!hasRealImage(row.image_link)) {
        excludedSinImagen += 1;
        return false;
      }

      const parsedPrice = parsePriceValue(row.price);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        excludedSinPrecio += 1;
        return false;
      }

      return true;
    });

    const sampleExportedSkus = filteredData.slice(0, 10).map((row) => row.id);

    console.log(
      `[meta-feed] Filtering summary: rpc_rows=${normalizedData.length}, excluded_sin_stock=${excludedSinStock}, excluded_sin_sku=${excludedSinSku}, excluded_sin_titulo=${excludedSinTitulo}, excluded_sin_imagen=${excludedSinImagen}, excluded_sin_precio=${excludedSinPrecio}, published=${filteredData.length}`
    );
    console.log(`[meta-feed] Sample exported SKUs: ${sampleExportedSkus.join(", ") || "(none)"}`);
    console.log(`[meta-feed] CSV phase=1 headers=${META_CSV_HEADERS_PHASE1.join("|")}`);

    // Aplicar limit si se especifica
    const finalData = limit !== null && limit > 0 ? filteredData.slice(0, limit) : filteredData;

    // Calcular métricas
    const metrics = calculateMetrics(filteredData);

    // Si formato es JSON (para admin)
    if (format === "json") {
      const products = finalData.map((row) => ({
        title: row.title,
        price: row.price,
        availability: row.availability,
      }));
      return new Response(
        JSON.stringify({
          data: finalData,
          products,
          metrics,
          total: filteredData.length,
          returned: finalData.length,
          debug: {
            feed_phase: 1,
            csv_headers: [...META_CSV_HEADERS_PHASE1],
            rpc_rows: normalizedData.length,
            excluded_sin_stock: excludedSinStock,
            excluded_sin_sku: excludedSinSku,
            excluded_sin_titulo: excludedSinTitulo,
            excluded_sin_imagen: excludedSinImagen,
            excluded_sin_precio: excludedSinPrecio,
            published: filteredData.length,
            sample_exported_skus: sampleExportedSkus,
          },
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Default: CSV
    const csv = generateCSV(finalData, META_CSV_HEADERS_PHASE1);

    // Headers para Meta Commerce Manager
    // Nota: Meta requiere CSV puro con Content-Type correcto y sin Content-Disposition: attachment
    const csvHeaders: Record<string, string> = {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    };

    // Solo agregar CORS si hay origin (Meta no envía origin, así que no se agregan)
    // Esto asegura que Meta vea el CSV directamente sin interferencia de CORS
    if (origin) {
      Object.assign(csvHeaders, corsHeaders);
    }

    return new Response(csv, {
      status: 200,
      headers: csvHeaders,
    });
  } catch (error) {
    console.error("Error en meta-feed:", error);
    return new Response(
      JSON.stringify({ error: "Error interno", details: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

