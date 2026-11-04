// BORRADOR SIN PROBAR. NO DESPLEGADO. Sin secretos en el código.
// Edge function `meta-capi`: envía eventos a la Conversions API de Meta.
//
// Variables de entorno (Supabase > Edge Functions > Secrets), NUNCA en el código ni en el chat:
//   META_CAPI_ENABLED   "true" para enviar de verdad. Por defecto (ausente) = desactivada.
//   META_PIXEL_ID       ID del dataset/pixel
//   META_CAPI_TOKEN     token de acceso de Conversions API
//   META_TEST_EVENT_CODE (opcional) código de "Test Events" de Meta
//   META_GRAPH_VERSION  (opcional) por defecto v21.0, SUPUESTO: verificar versión vigente
//   INTERNAL_SECRET     para llamadas servidor-a-servidor (Purchase)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (los provee Supabase)
//
// Dos modos de llamada:
//  A) Navegador (JWT de la clienta): Lead / CompleteRegistration. El email/teléfono se leen de la base, no del cuerpo.
//  B) Servidor (header x-internal-secret): Purchase con { order_id }. Datos tomados de `orders`/`customers`.
// `dry_run` (por defecto TRUE): arma y registra el payload en meta_capi_events con status 'dry_run' y NO llama a Meta.

import { createClient } from "npm:@supabase/supabase-js@2";

const GRAPH = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";
const ALLOWED_BROWSER_EVENTS = new Set(["Lead", "CompleteRegistration"]);

async function sha256(v: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const normEmail = (e?: string | null) => (e ? e.trim().toLowerCase() : null);
function normPhone(p?: string | null) {
  if (!p) return null;
  let d = p.replace(/\D/g, "");
  if (!d) return null;
  if (!d.startsWith("54")) d = "54" + d.replace(/^0+/, "");   // supuesto: Argentina
  return d;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const enabled = Deno.env.get("META_CAPI_ENABLED") === "true";
  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false || !enabled;       // dry_run salvo pedido explícito Y habilitada

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // --- Autorización ---
  const internal = req.headers.get("x-internal-secret");
  const isInternal = !!internal && internal === Deno.env.get("INTERNAL_SECRET");
  let customerId: string | null = null;
  let eventName: string = body.event_name;

  if (!isInternal) {
    const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return new Response("unauthorized", { status: 401 });
    if (!ALLOWED_BROWSER_EVENTS.has(eventName)) return new Response("event not allowed", { status: 403 });
    // misma resolución que fn_register_attribution
    const { data: link } = await admin.from("customer_auth_links").select("customer_id")
      .eq("auth_user_id", u.user.id).order("linked_at", { ascending: false }).limit(1).maybeSingle();
    customerId = link?.customer_id ?? u.user.id;
  } else if (body.order_id) {
    eventName = "Purchase";
  }

  // --- Datos del evento ---
  let eventId: string = body.event_id;
  const custom: Record<string, unknown> = {};
  let orderId: string | null = null;

  if (eventName === "Purchase") {
    orderId = body.order_id;
    const { data: o } = await admin.from("orders").select("id, customer_id, total_amount, status").eq("id", orderId).maybeSingle();
    if (!o) return new Response("order not found", { status: 404 });
    customerId = o.customer_id;
    custom.value = Number(o.total_amount ?? 0);
    custom.currency = "ARS";
    eventId = `purchase_${o.id}`;                          // determinístico: nunca se duplica
  }
  if (!eventId || !eventName || !customerId) return new Response("bad request", { status: 400 });

  // --- Idempotencia ---
  const { data: prev } = await admin.from("meta_capi_events").select("event_id, status").eq("event_id", eventId).maybeSingle();
  if (prev && prev.status !== "error") return Response.json({ ok: true, skipped: "duplicate", status: prev.status });

  const { data: c } = await admin.from("customers").select("email, phone, whatsapp_invalid_at").eq("id", customerId).maybeSingle();
  const em = normEmail(c?.email), ph = normPhone(c?.phone);
  const user_data: Record<string, unknown> = {
    ...(em ? { em: [await sha256(em)] } : {}),
    ...(ph ? { ph: [await sha256(ph)] } : {}),
    ...(body.fbp ? { fbp: body.fbp } : {}),
    ...(body.fbc ? { fbc: body.fbc } : {}),
    client_user_agent: req.headers.get("user-agent") ?? undefined,
    client_ip_address: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
  };

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url: body.source_url,
    user_data,
    custom_data: custom,
  };

  // --- Envío ---
  let status = "dry_run", response: unknown = { payload_preview: { ...event, user_data: Object.keys(user_data) } }, sentAt: string | null = null;
  if (!dryRun) {
    const url = `https://graph.facebook.com/${GRAPH}/${Deno.env.get("META_PIXEL_ID")}/events?access_token=${Deno.env.get("META_CAPI_TOKEN")}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: [event], ...(Deno.env.get("META_TEST_EVENT_CODE") ? { test_event_code: Deno.env.get("META_TEST_EVENT_CODE") } : {}) }),
    });
    response = await r.json().catch(() => ({}));
    status = r.ok ? "sent" : "error";
    sentAt = r.ok ? new Date().toISOString() : null;
  }

  await admin.from("meta_capi_events").upsert({
    event_id: eventId, event_name: eventName, customer_id: customerId, order_id: orderId,
    status, response, sent_at: sentAt,
  });
  return Response.json({ ok: status !== "error", status, dry_run: dryRun });
});
