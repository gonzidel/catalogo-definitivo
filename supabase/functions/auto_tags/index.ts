// supabase/functions/auto_tags/index.ts
// Edge Function para analizar imagen de producto con OpenAI Vision API

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

interface AutoTagsRequest {
  image_url: string;
  product_name: string;
  category_hint: "Calzado" | "Ropa" | "Otros";
  description?: string;
}

interface AutoTagsResponse {
  category: "Calzado" | "Ropa" | "Otros";
  tag1: string;
  tag2: string;
  season: "verano" | "invierno" | "todo_anio";
  target_audience: "mujer" | "hombre" | "ninos" | "unisex";
  details: string[];
  highlights: string[];
  description: string;
  confidence: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_TEXT_LEN = 500;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Solo admins logueados. La clave anónima pública (anon key) es un JWT válido
 * para la plataforma, así que verify_jwt por sí solo NO alcanza: sin esto
 * cualquiera podía gastar crédito de OpenAI. Mismo patrón que qz-sign / n8n-publish.
 * Equivale a is_admin(): admins.user_id = auth.uid().
 * Devuelve una Response de error si no corresponde, o null si el usuario es admin.
 */
async function rejectIfNotAdmin(req: Request): Promise<Response | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return jsonResponse(401, { error: "No autenticado" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !anonKey) {
    return jsonResponse(500, { error: "Configuración de Supabase incompleta" });
  }

  const supabaseAuth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabaseAuth.auth.getUser();
  if (userError || !userData?.user) {
    return jsonResponse(401, { error: "Sesión inválida" });
  }

  const { data: adminRow, error: adminError } = await supabaseAuth
    .from("admins")
    .select("id")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (adminError || !adminRow) {
    return jsonResponse(403, { error: "Solo administradores" });
  }

  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const denied = await rejectIfNotAdmin(req);
    if (denied) return denied;

    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY no está configurado");
    }

    const { image_url, product_name, category_hint, description }: AutoTagsRequest =
      await req.json();

    if (!image_url || !product_name || !category_hint) {
      return jsonResponse(400, { error: "image_url, product_name y category_hint son requeridos" });
    }

    if (
      typeof image_url !== "string" ||
      !/^https:\/\//i.test(image_url) ||
      image_url.length > 2000 ||
      String(product_name).length > MAX_TEXT_LEN ||
      String(description ?? "").length > 2000
    ) {
      return jsonResponse(400, { error: "Parámetros inválidos (image_url debe ser https y de largo razonable)" });
    }

    const prompt = `Analizá la imagen del producto y su nombre para inferir tags, facetas y un borrador de descripción.

CONTEXTO:
- Nombre del producto: ${product_name}
- Categoría: ${category_hint}
- Descripción actual: ${description || "No disponible"}

IMPORTANTE: El nombre del producto tiene PRIORIDAD si hay ambigüedad entre imagen y nombre.

Estructura de campos:
- category: "Calzado" | "Ropa" | "Otros" (debe coincidir con category_hint si es posible)
- tag1: Tipo de producto (ej: "Sandalia", "Bota", "Remera", "Pantalón") — SOLO el tipo, nunca temporada ni estado comercial
- tag2: Atributo funcional/corte (ej: "Baja", "Alta", "Recto", "Baggy")
- season: "verano" | "invierno" | "todo_anio" — inferido del tipo de prenda/calzado
- target_audience: "mujer" | "hombre" | "ninos" | "unisex"
- details: Array de detalles (ej: ["Brillo", "Hebilla", "Bordada"])
- highlights: Array de 0-2 detalles destacados (DEBE ser subset de details, máximo 2)
- description: Borrador de descripción de producto, en español, siguiendo ESTA estructura estricta:
  1) Una línea de apertura mencionando tipo de producto y material/estilo si es visible
  2) Los atributos clave que ya identificaste (tag2, details) en una frase breve
  3) Una línea de uso/cuidado si aplica
  Máximo 280 caracteres. PROHIBIDO usar relleno genérico ("hermoso diseño", "ideal para toda ocasión", "no te lo podés perder"). Si mencionás un material o atributo, tiene que ser consistente con tag2/details.

Responde SOLO con JSON válido en este formato exacto:
{
  "category": "Calzado" | "Ropa" | "Otros",
  "tag1": "string",
  "tag2": "string",
  "season": "verano" | "invierno" | "todo_anio",
  "target_audience": "mujer" | "hombre" | "ninos" | "unisex",
  "details": ["string", ...],
  "highlights": ["string", ...],
  "description": "string",
  "confidence": 0.0-1.0
}`;

    const openaiResponse = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: image_url } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 700,
      }),
    });

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.text();
      console.error("OpenAI API error:", errorData);
      throw new Error(`OpenAI API error: ${openaiResponse.status} ${errorData}`);
    }

    const openaiData = await openaiResponse.json();
    const content = openaiData.choices[0]?.message?.content;

    if (!content) {
      throw new Error("No se recibió respuesta de OpenAI");
    }

    let aiResponse: AutoTagsResponse;
    try {
      aiResponse = JSON.parse(content);
    } catch (e) {
      throw new Error(`Error parseando JSON de OpenAI: ${(e as Error).message}`);
    }

    if (!aiResponse.category || !aiResponse.tag1 || !aiResponse.tag2) {
      throw new Error("Respuesta de IA incompleta: faltan category, tag1 o tag2");
    }

    if (!["verano", "invierno", "todo_anio"].includes(aiResponse.season)) {
      aiResponse.season = "todo_anio";
    }
    if (!["mujer", "hombre", "ninos", "unisex"].includes(aiResponse.target_audience)) {
      aiResponse.target_audience = "unisex";
    }

    if (!Array.isArray(aiResponse.details)) aiResponse.details = [];
    if (!Array.isArray(aiResponse.highlights)) aiResponse.highlights = [];

    aiResponse.highlights = aiResponse.highlights.filter((h) => aiResponse.details.includes(h));
    if (aiResponse.highlights.length > 2) aiResponse.highlights = aiResponse.highlights.slice(0, 2);

    if (typeof aiResponse.description !== "string") aiResponse.description = "";
    if (aiResponse.description.length > 280) {
      aiResponse.description = aiResponse.description.slice(0, 280);
    }

    if (typeof aiResponse.confidence !== "number") aiResponse.confidence = 0.8;

    return new Response(JSON.stringify(aiResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error en auto_tags:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message || "Error interno del servidor" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
