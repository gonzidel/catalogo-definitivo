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
  details: string[];
  highlights: string[];
  confidence: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY no está configurado");
    }

    const { image_url, product_name, category_hint, description }: AutoTagsRequest = await req.json();

    if (!image_url || !product_name || !category_hint) {
      return new Response(
        JSON.stringify({ error: "image_url, product_name y category_hint son requeridos" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Construir prompt mejorado con contexto completo
    const prompt = `Analizá la imagen del producto y su nombre para inferir los tags jerárquicos.

CONTEXTO:
- Nombre del producto: ${product_name}
- Categoría: ${category_hint}
- Descripción: ${description || "No disponible"}

IMPORTANTE: El nombre del producto tiene PRIORIDAD si hay ambigüedad entre imagen y nombre.

Estructura de tags:
- category: "Calzado" | "Ropa" | "Otros" (debe coincidir con category_hint si es posible)
- tag1: Tipo (ej: "Sandalia", "Bota", "Chatita", "Zapatilla", "Zapato")
- tag2: Atributo funcional (ej: "Baja", "Alta", "Plataforma", "Tacón", "Sin tacón")
- details: Array de detalles (ej: ["Brillo", "Hebilla", "Bordada", "Plataforma anatómica"])
- highlights: Array de 0-2 detalles destacados (DEBE ser subset de details, máximo 2)

Responde SOLO con JSON válido en este formato exacto:
{
  "category": "Calzado" | "Ropa" | "Otros",
  "tag1": "string",
  "tag2": "string",
  "details": ["string", ...],
  "highlights": ["string", ...],
  "confidence": 0.0-1.0
}`;

    // Llamar a OpenAI Vision API
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
              {
                type: "text",
                text: prompt,
              },
              {
                type: "image_url",
                image_url: {
                  url: image_url,
                },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 500,
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

    // Parsear JSON response
    let aiResponse: AutoTagsResponse;
    try {
      aiResponse = JSON.parse(content);
    } catch (e) {
      throw new Error(`Error parseando JSON de OpenAI: ${e.message}`);
    }

    // Validar estructura
    if (!aiResponse.category || !aiResponse.tag1 || !aiResponse.tag2) {
      throw new Error("Respuesta de IA incompleta: faltan category, tag1 o tag2");
    }

    // Validar highlights
    if (!Array.isArray(aiResponse.details)) {
      aiResponse.details = [];
    }
    if (!Array.isArray(aiResponse.highlights)) {
      aiResponse.highlights = [];
    }

    // Asegurar que highlights sean subset de details
    aiResponse.highlights = aiResponse.highlights.filter((h) =>
      aiResponse.details.includes(h)
    );

    // Limitar highlights a 2
    if (aiResponse.highlights.length > 2) {
      aiResponse.highlights = aiResponse.highlights.slice(0, 2);
    }

    // Validar confidence
    if (typeof aiResponse.confidence !== "number") {
      aiResponse.confidence = 0.8; // default
    }

    return new Response(JSON.stringify(aiResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error en auto_tags:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Error interno del servidor" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

