// supabase/functions/search_profile_ai/index.ts
// Genera perfiles de búsqueda (borrador) con OpenAI o Claude Vision.
// Solo admins. No escribe products.description. Lote máx. 20.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const PROMPT_VERSION = "search-profile-v1-2026-11-11";
const MAX_BATCH = 20;
const DAILY_CAP = Number(Deno.env.get("SEARCH_PROFILE_AI_DAILY_CAP") || "200");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Provider = "openai" | "claude";

interface ProductInput {
  product_id: string;
  articulo: string;
  category: string;
  description?: string | null;
  tags?: string[];
  image_urls?: string[];
}

interface ProfileOut {
  search_terms: string[];
  style_terms: string[];
  occasion_terms: string[];
  color_families: string[];
  audience: "mujer" | "hombre" | "ninos" | "unisex" | null;
  season: "verano" | "invierno" | "todo_anio" | null;
  confidence: number;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

function buildPrompt(p: ProductInput): string {
  return `Sos el lexicógrafo del buscador mayorista B2B de FyL Moda (revendedoras en celular).
Generá un PERFIL DE BÚSQUEDA interno (NO una descripción comercial pública).

CONTEXTO:
- Artículo: ${p.articulo}
- Categoría: ${p.category}
- Descripción actual: ${p.description || "—"}
- Tags existentes: ${(p.tags || []).join(", ") || "—"}

REGLAS:
1) El nombre del artículo manda si hay ambigüedad con la foto.
2) NUNCA inventes material (cuero / eco cuero / tela) salvo que esté en texto o tags.
3) Términos como los buscaría una revendedora argentina (sandalia, chatita, jean, etc.).
4) color_families: solo familias (negro, blanco, beige, …). Sin códigos internos (var01).
5) Sin relleno ("ideal", "hermoso", "no te lo pierdas").
6) Máximo 12 search_terms, 8 style_terms, 6 occasion_terms.

Respondé SOLO JSON:
{
  "search_terms": ["..."],
  "style_terms": ["..."],
  "occasion_terms": ["..."],
  "color_families": ["..."],
  "audience": "mujer"|"hombre"|"ninos"|"unisex"|null,
  "season": "verano"|"invierno"|"todo_anio"|null,
  "confidence": 0.0-1.0
}`;
}

function validateProfile(raw: unknown): ProfileOut {
  const o = (raw ?? {}) as Record<string, unknown>;
  const arr = (v: unknown, max: number) =>
    Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter((x) => x.length >= 2).slice(0, max)
      : [];
  const audience = o.audience;
  const season = o.season;
  return {
    search_terms: arr(o.search_terms, 12),
    style_terms: arr(o.style_terms, 8),
    occasion_terms: arr(o.occasion_terms, 6),
    color_families: arr(o.color_families, 8),
    audience:
      audience === "mujer" || audience === "hombre" || audience === "ninos" || audience === "unisex"
        ? audience
        : null,
    season:
      season === "verano" || season === "invierno" || season === "todo_anio" ? season : null,
    confidence: typeof o.confidence === "number" ? Math.min(1, Math.max(0, o.confidence)) : 0.5,
  };
}

async function callOpenAI(prompt: string, imageUrls: string[]): Promise<{ profile: ProfileOut; model: string; costUsd: number }> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY no configurado");
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const url of imageUrls.slice(0, 4)) {
    content.push({ type: "image_url", image_url: { url } });
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
      max_tokens: 600,
    }),
  });
  if (!res.ok) throw new Error(`openai_${res.status}:${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "{}";
  const usage = data.usage ?? {};
  // Estimación barata gpt-4o-mini
  const costUsd =
    ((usage.prompt_tokens ?? 0) * 0.15 + (usage.completion_tokens ?? 0) * 0.6) / 1_000_000;
  return { profile: validateProfile(JSON.parse(text)), model: "gpt-4o-mini", costUsd };
}

async function callClaude(prompt: string, imageUrls: string[]): Promise<{ profile: ProfileOut; model: string; costUsd: number }> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY no configurado");
  const content: Array<Record<string, unknown>> = [];
  for (const url of imageUrls.slice(0, 4)) {
    content.push({
      type: "image",
      source: { type: "url", url },
    });
  }
  content.push({ type: "text", text: prompt });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`claude_${res.status}:${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const textBlock = (data.content ?? []).find((b: { type: string }) => b.type === "text");
  const text = String(textBlock?.text ?? "{}");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : "{}");
  const usage = data.usage ?? {};
  const costUsd =
    ((usage.input_tokens ?? 0) * 1.0 + (usage.output_tokens ?? 0) * 5.0) / 1_000_000;
  return { profile: validateProfile(parsed), model: "claude-haiku-4-5", costUsd };
}

function sourceHash(p: ProductInput): string {
  const raw = JSON.stringify({
    a: p.articulo,
    c: p.category,
    d: p.description ?? "",
    t: p.tags ?? [],
    i: p.image_urls ?? [],
  });
  // FNV-1a 32-bit simple
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const denied = await rejectIfNotAdmin(req);
    if (denied) return denied;

    const body = await req.json();
    const provider = (body.provider === "claude" ? "claude" : "openai") as Provider;
    const products: ProductInput[] = Array.isArray(body.products) ? body.products : [];
    const persist = body.persist === true;

    if (products.length === 0) {
      return jsonResponse(400, { error: "products[] requerido" });
    }
    if (products.length > MAX_BATCH) {
      return jsonResponse(400, { error: `Máximo ${MAX_BATCH} productos por lote` });
    }

    const results = [];
    let totalCost = 0;

    for (const p of products) {
      if (!p.product_id || !p.articulo) {
        results.push({ articulo: p.articulo, error: "product_id y articulo requeridos" });
        continue;
      }
      const images = (p.image_urls ?? []).filter((u) => /^https:\/\//i.test(u)).slice(0, 4);
      const prompt = buildPrompt(p);
      try {
        const out =
          provider === "claude"
            ? await callClaude(prompt, images)
            : await callOpenAI(prompt, images);
        totalCost += out.costUsd;
        if (totalCost > 5) {
          // salvaguarda dura por request
          results.push({ articulo: p.articulo, error: "tope_costo_request" });
          break;
        }
        const row = {
          product_id: p.product_id,
          articulo: p.articulo,
          status: "draft",
          ...out.profile,
          source_hash: sourceHash(p),
          provider,
          model: out.model,
          prompt_version: PROMPT_VERSION,
          cost_usd: out.costUsd,
          generated_at: new Date().toISOString(),
        };
        results.push(row);

        if (persist) {
          const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
          const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
          if (!serviceKey) throw new Error("SERVICE_ROLE requerido para persist");
          const admin = createClient(supabaseUrl, serviceKey, {
            auth: { autoRefreshToken: false, persistSession: false },
          });
          const { error } = await admin.from("product_search_profiles").upsert(
            {
              product_id: row.product_id,
              articulo: row.articulo,
              status: "draft",
              search_terms: row.search_terms,
              style_terms: row.style_terms,
              occasion_terms: row.occasion_terms,
              color_families: row.color_families,
              audience: row.audience,
              season: row.season,
              source_hash: row.source_hash,
              provider: row.provider,
              model: row.model,
              prompt_version: row.prompt_version,
              confidence: row.confidence,
              cost_usd: row.cost_usd,
              generated_at: row.generated_at,
            },
            { onConflict: "product_id" }
          );
          if (error) throw new Error(error.message);
        }
      } catch (e) {
        results.push({ articulo: p.articulo, error: (e as Error).message });
      }
    }

    return jsonResponse(200, {
      provider,
      prompt_version: PROMPT_VERSION,
      daily_cap_hint: DAILY_CAP,
      total_cost_usd: totalCost,
      results,
    });
  } catch (error) {
    console.error("search_profile_ai", error);
    return jsonResponse(500, { error: (error as Error).message || "Error interno" });
  }
});
