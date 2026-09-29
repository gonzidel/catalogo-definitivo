/**
 * Edge Function: transport-lookup
 *
 * Expone public.fn_transportes_disponibles(provincia, localidad) como HTTPS
 * para que el "Asistente FYL" (bot de YCloud) responda en vivo "¿a qué
 * localidad hacen envíos?" / "¿qué transporte llega a X?", usando la MISMA
 * cobertura por transporte que ya usa la web (ver supabase/canonical/
 * 360_transport_coverage_lookup.sql para el origen y algoritmo exacto).
 *
 * Pensada para consumirse desde un YCloud Data Connector (HTTPS en vivo).
 * No requiere JWT de Supabase (verify_jwt=false): el que llama es un
 * servicio externo (YCloud), no un cliente autenticado del catálogo. En su
 * lugar valida un secreto compartido propio, mismo patrón que wa-dispatch.
 *
 * Secrets requeridos (Supabase Dashboard → Edge Functions → transport-lookup → Secrets):
 *   TRANSPORT_LOOKUP_API_KEY  → compartido con el header configurado en el
 *                                 Data Connector de YCloud (header x-api-key)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (automáticos en Edge Functions)
 *
 * GET  /transport-lookup?provincia=Chaco&localidad=Resistencia
 * POST /transport-lookup { "provincia": "Chaco", "localidad": "Resistencia" }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const expectedKey = Deno.env.get("TRANSPORT_LOOKUP_API_KEY") || "";
  const receivedKey = req.headers.get("x-api-key") || "";
  if (!expectedKey || receivedKey !== expectedKey) {
    console.warn("transport-lookup: api key inválida o no configurada");
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let provincia = "";
  let localidad = "";

  if (req.method === "GET") {
    const url = new URL(req.url);
    provincia = url.searchParams.get("provincia") || "";
    localidad = url.searchParams.get("localidad") || "";
  } else {
    const body = await req.json().catch(() => ({}));
    provincia = String(body?.provincia || "");
    localidad = String(body?.localidad || "");
  }

  if (!provincia.trim() || !localidad.trim()) {
    return new Response(
      JSON.stringify({ ok: false, error: "provincia_and_localidad_required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data, error } = await supabase.rpc("fn_transportes_disponibles", {
    p_provincia: provincia,
    p_localidad: localidad,
  });

  if (error) {
    console.error("transport-lookup: error llamando fn_transportes_disponibles", error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const transportes: string[] = Array.isArray(data) ? data : [];

  return new Response(
    JSON.stringify({
      ok: true,
      provincia,
      localidad,
      transportes,
      hay_cobertura: transportes.length > 0,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
