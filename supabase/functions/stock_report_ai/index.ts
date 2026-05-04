// supabase/functions/stock_report_ai/index.ts
// Edge Function: inteligencia operativa para el módulo "Salud de stock".
//
// Modos:
//   mode = "report"   → análisis completo estructurado del estado del catálogo
//   mode = "question" → respuesta concisa a pregunta puntual del operador
//
// IMPORTANTE: esta función NO accede a la base de datos.
// Recibe el payload ya construido desde el frontend (stock-audit.js).
// Solo actúa como adaptador thin entre el frontend y OpenAI.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

// ─────────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────────

interface TagSummaryRow {
  tag1_nombre: string;
  category: string;
  tag2_nombre: string | null;
  productos_activos: number;
  unidades_30d: number;
  unidades_90d: number;
  stock_total: number;
  unidades_por_dia: number;
}

interface StockPayload {
  fecha: string;
  catalogo: Record<string, number | boolean>;
  fast_sellers:     Array<{ nombre: string; categoria: string; unidades_90d: number; dias_stock: number | null; velocidad: number }>;
  stock_acumulado:  Array<{ nombre: string; categoria: string; meses_stock: number; stock_total: number; velocidad: number }>;
  dead_stock:       Array<{ nombre: string; categoria: string; stock_total: number; dias_sin_movimiento: number; fuente: string }>;
  pub_ineficiente:  Array<{ nombre: string; categoria: string; dias_desde_pub: number; stock_total: number }>;
  sin_imagenes:     Array<{ nombre: string; stock_total: number }>;
  alta_incompleta:  Array<{ nombre: string; status: string; stock_total: number }>;
  tags_resumen:     TagSummaryRow[];
}

interface StockReportRequest {
  mode: "report" | "question";
  pregunta?: string;
  payload: StockPayload;
}

interface StockReportResponse {
  resumen: string;
  alertas: string[];
  oportunidades: string[];
  recomendaciones: string[];
  acciones_sugeridas: string[];
  confianza: "alta" | "media" | "baja";
}

interface StockQuestionResponse {
  respuesta: string;
  confianza: "alta" | "media" | "baja";
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─────────────────────────────────────────────────────────────────
// HELPERS: SERIALIZACIÓN DEL CONTEXTO
// ─────────────────────────────────────────────────────────────────

function formatCatalogSummary(p: StockPayload): string {
  const c = p.catalogo;
  return [
    `- Fast sellers (venta activa 90d): ${c.total_fast_sellers}`,
    `- Stock sin movimiento +90d: ${c.total_dead_stock}`,
    `- Stock acumulado (+180d de supply): ${c.total_stock_acumulado}`,
    `- Publicados sin conversión (últimos 180d): ${c.total_pub_ineficiente}`,
    `- Variantes sin imágenes con stock: ${c.total_sin_imagenes}`,
    `- Alta incompleta con stock: ${c.total_alta_incompleta}`,
    `- Variantes inactivas con stock: ${c.total_inactivas_con_stock}`,
    `- Release gate OK: ${c.gate_ok ? "sí" : "NO — hay problemas técnicos"}`,
  ].join("\n");
}

function formatFastSellers(items: StockPayload["fast_sellers"]): string {
  if (!items.length) return "  (ninguno)";
  return items.map(p =>
    `  · ${p.nombre} [${p.categoria}]: ${p.unidades_90d}u en 90d, ${p.velocidad}u/día, ${p.dias_stock !== null ? p.dias_stock + "d de stock restante" : "stock sin referencia de venta"}`
  ).join("\n");
}

function formatDeadStock(items: StockPayload["dead_stock"]): string {
  if (!items.length) return "  (ninguno)";
  return items.map(p =>
    `  · ${p.nombre} [${p.categoria}]: ${p.stock_total}u, ${p.dias_sin_movimiento}d sin actividad (dato: ${p.fuente})`
  ).join("\n");
}

function formatStockAcumulado(items: StockPayload["stock_acumulado"]): string {
  if (!items.length) return "  (ninguno)";
  return items.map(p =>
    `  · ${p.nombre} [${p.categoria}]: ~${p.meses_stock} meses de stock (${p.stock_total}u, vende ${p.velocidad}u/día)`
  ).join("\n");
}

function formatPubIneficiente(items: StockPayload["pub_ineficiente"]): string {
  if (!items.length) return "  (ninguno)";
  return items.map(p =>
    `  · ${p.nombre} [${p.categoria}]: publicado hace ${p.dias_desde_pub}d, ${p.stock_total}u sin vender desde entonces`
  ).join("\n");
}

function formatTagSummary(rows: TagSummaryRow[]): string {
  if (!rows.length) return "  (sin datos de tags)";
  return rows
    .filter(r => r.tag1_nombre)
    .map(r => {
      const tag2 = r.tag2_nombre ? ` / ${r.tag2_nombre}` : "";
      return `  · ${r.tag1_nombre}${tag2} [${r.category}]: ${r.unidades_90d}u/90d, ${r.unidades_30d}u/30d, stock ${r.stock_total}u, ${r.productos_activos} productos`;
    }).join("\n");
}

function buildContextBlock(p: StockPayload): string {
  return `
ESTADO DEL CATÁLOGO — ${p.fecha}

RESUMEN:
${formatCatalogSummary(p)}

FAST SELLERS (vendiendo activamente):
${formatFastSellers(p.fast_sellers)}

STOCK ACUMULADO (demasiado stock para la velocidad actual):
${formatStockAcumulado(p.stock_acumulado)}

SIN MOVIMIENTO (productos paralizados):
${formatDeadStock(p.dead_stock)}

PUBLICADOS SIN VENTAS (publicados pero sin conversión):
${formatPubIneficiente(p.pub_ineficiente)}

SIN IMÁGENES CON STOCK: ${p.sin_imagenes.map(i => i.nombre).join(", ") || "ninguno"}
ALTA INCOMPLETA: ${p.alta_incompleta.map(i => `${i.nombre} (${i.status})`).join(", ") || "ninguna"}

AGREGADOS POR TIPO DE PRODUCTO (tag1/tag2):
${formatTagSummary(p.tags_resumen)}
  `.trim();
}

// ─────────────────────────────────────────────────────────────────
// PROMPTS
// ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos un analista de inventario experto en negocios B2B de moda argentina (calzado y ropa).
Analizás el estado operativo del stock de forma objetiva y accionable.

REGLAS ESTRICTAS:
- Respondés SOLO en español rioplatense.
- Respondés SOLO con JSON válido. Cero texto fuera del JSON. Sin markdown.
- Cada alerta, oportunidad y recomendación DEBE incluir datos concretos (unidades, días, nombres de productos).
- PROHIBIDO usar frases genéricas como "revisar el inventario", "analizar la situación", "considerar opciones".
- Si un dato no está en el contexto, indicá "sin datos suficientes" en esa sección, no lo inventes.
- La confianza del análisis es:
    "alta"  → hay datos concretos de ventas reales para sustentar las conclusiones
    "media" → hay datos parciales (solo stock, sin historial de ventas reciente)
    "baja"  → los datos son muy escasos o el catálogo tiene poca actividad registrada`;

function buildReportPrompt(context: string): string {
  return `${context}

Generá un análisis operativo completo. Respondé con este JSON exacto:
{
  "resumen": "Párrafo de 3-4 oraciones describiendo el estado real del catálogo con datos concretos",
  "alertas": [
    "Descripción con producto, unidades y días. Máximo 5."
  ],
  "oportunidades": [
    "Oportunidad concreta con producto, categoría y acción sugerida. Máximo 5."
  ],
  "recomendaciones": [
    "Acción específica y ejecutable. Incluir nombre del producto o categoría. Máximo 5."
  ],
  "acciones_sugeridas": [
    "Próxima acción concreta ordenada por urgencia. Máximo 5."
  ],
  "confianza": "alta" | "media" | "baja"
}`;
}

function buildQuestionPrompt(context: string, pregunta: string): string {
  return `${context}

PREGUNTA DEL OPERADOR: "${pregunta}"

Respondé usando SOLO los datos del contexto. Si no hay datos suficientes, decilo explícitamente.
Respondé con este JSON exacto:
{
  "respuesta": "Respuesta directa y concreta en 4-8 líneas. Incluir números, nombres y días reales. Sin introducción.",
  "confianza": "alta" | "media" | "baja"
}`;
}

// ─────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY no está configurado en los secrets de la función");
    }

    const body: StockReportRequest = await req.json();
    const { mode, pregunta, payload } = body;

    if (!mode || !payload) {
      return new Response(
        JSON.stringify({ error: "mode y payload son requeridos" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (mode === "question" && (!pregunta || !pregunta.trim())) {
      return new Response(
        JSON.stringify({ error: "pregunta es requerida en mode=question" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const context = buildContextBlock(payload);
    const userPrompt = mode === "question"
      ? buildQuestionPrompt(context, pregunta!)
      : buildReportPrompt(context);

    const maxTokens = mode === "question" ? 600 : 1400;

    const openaiRes = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: maxTokens,
        temperature: 0.3, // más determinista para análisis de datos
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("OpenAI error:", errText);
      throw new Error(`OpenAI API ${openaiRes.status}: ${errText}`);
    }

    const openaiData = await openaiRes.json();
    const content = openaiData.choices?.[0]?.message?.content;
    if (!content) throw new Error("Respuesta vacía de OpenAI");

    let parsed: StockReportResponse | StockQuestionResponse;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("JSON parse error:", content);
      throw new Error("La IA devolvió una respuesta no válida. Intentá nuevamente.");
    }

    // Validaciones según modo
    if (mode === "report") {
      const r = parsed as StockReportResponse;
      if (!r.resumen) throw new Error("Respuesta incompleta: falta resumen");
      if (!Array.isArray(r.alertas))           r.alertas = [];
      if (!Array.isArray(r.oportunidades))     r.oportunidades = [];
      if (!Array.isArray(r.recomendaciones))   r.recomendaciones = [];
      if (!Array.isArray(r.acciones_sugeridas)) r.acciones_sugeridas = [];
      if (!["alta", "media", "baja"].includes(r.confianza)) r.confianza = "media";
    } else {
      const q = parsed as StockQuestionResponse;
      if (!q.respuesta) throw new Error("Respuesta incompleta: falta respuesta");
      if (!["alta", "media", "baja"].includes(q.confianza)) q.confianza = "media";
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error en stock_report_ai:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Error interno del servidor" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
