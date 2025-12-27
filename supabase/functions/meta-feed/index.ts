// supabase/functions/meta-feed/index.ts
// Edge Function para generar feed CSV de Meta Catalog
// Soporta formato CSV (default) y JSON (para admin preview)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

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
const BASE_URL = Deno.env.get("BASE_URL") || "https://tudominio.com";

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

// Generar CSV desde array de objetos
function generateCSV(data: any[]): string {
  if (!data || data.length === 0) {
    return "id,item_group_id,title,description,price,availability,condition,brand,link,image_link,color,size\n";
  }

  const headers = ["id", "item_group_id", "title", "description", "price", "availability", "condition", "brand", "link", "image_link", "color", "size"];
  const rows = data.map((row) => {
    return headers.map((header) => escapeCSV(row[header] || "")).join(",");
  });

  return [headers.join(","), ...rows].join("\n");
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

// Calcular métricas
function calculateMetrics(data: any[]): any {
  const total = data.length;
  const sinImagen = data.filter((row) => 
    !row.image_link || 
    row.image_link === "" || 
    row.image_link.includes("placeholder")
  ).length;
  const sinPrecio = data.filter((row) => 
    !row.price || 
    row.price === "" || 
    !row.price.match(/\d+\.\d{2}\s+ARS/)
  ).length;
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

    // Agregar link y normalizar image_link (generado en Edge Function)
    const dataWithLinks = data.map((row) => ({
      ...row,
      link: `${BASE_URL}/index.html?sku=${encodeURIComponent(row.id)}`,
      image_link: normalizeCloudinaryURL(row.image_link || ""),
    }));

    // Aplicar limit si se especifica
    const finalData = limit !== null && limit > 0 ? dataWithLinks.slice(0, limit) : dataWithLinks;

    // Calcular métricas
    const metrics = calculateMetrics(dataWithLinks);

    // Si formato es JSON (para admin)
    if (format === "json") {
      return new Response(
        JSON.stringify({
          data: finalData,
          metrics,
          total: dataWithLinks.length,
          returned: finalData.length,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Default: CSV
    const csv = generateCSV(finalData);

    return new Response(csv, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="meta-feed.csv"',
      },
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

