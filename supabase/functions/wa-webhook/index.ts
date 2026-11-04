/**
 * Edge Function: wa-webhook
 *
 * Receptor del webhook de YCloud. Recibe estados de mensajes salientes
 * (whatsapp.message.updated) y los aplica sobre public.wa_outbox por
 * externalId (que nosotros seteamos = wa_outbox.id al enviar, ver wa-dispatch).
 * Todo evento crudo se guarda en public.wa_webhook_events para trazabilidad,
 * incluidos los tipos que todavía no procesamos (mensajes entrantes, cambios
 * de categoría de plantilla, etc. — fases futuras).
 *
 * Seguridad: firma HMAC de YCloud (header `YCloud-Signature: t=<unix>,s=<hex>`),
 * NO el secreto de wa-dispatch (son cosas distintas, en sentidos opuestos).
 * Deployar con verify_jwt=false: YCloud no manda JWT de Supabase.
 *
 * Secrets requeridos:
 *   YCLOUD_WEBHOOK_SECRET      → el "secret" (whsec_...) que devuelve YCloud
 *                                  al crear el webhook endpoint en su consola
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (automáticos en Edge Functions)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Orden de avance de estado — no se permite retroceder (ej. un 'delivered'
// tardío que llega después de un 'read' no debe pisarlo). 'failed' es
// terminal pero solo se aplica si el mensaje no había avanzado más allá de
// 'sent' (evita marcar failed algo que YCloud ya había confirmado delivered/read).
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  failed: 1,
  delivered: 2,
  read: 3,
  skipped: 0,
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts["t"];
  const s = parts["s"];
  if (!t || !s) return false;

  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  if (!fresh) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return timingSafeEqual(hex, s);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const secret = Deno.env.get("YCLOUD_WEBHOOK_SECRET") || "";
  const signatureHeader = req.headers.get("ycloud-signature");

  const valid = await verifySignature(rawBody, signatureHeader, secret);
  if (!valid) {
    console.warn("wa-webhook: firma inválida o ausente");
    return new Response("Unauthorized", { status: 401 });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const eventId = String(event.id ?? "");
  const eventType = String(event.type ?? "");
  if (!eventId) {
    return new Response("OK", { status: 200 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Idempotencia: si el evento ya se procesó, no repetir.
  const { error: insertError } = await supabase
    .from("wa_webhook_events")
    .insert({ event_id: eventId, type: eventType, payload: event });

  if (insertError) {
    // Conflicto de PK (event_id repetido) → ya procesado, responder 200.
    return new Response("OK", { status: 200 });
  }

  if (eventType === "whatsapp.message.updated") {
    const msg = (event.whatsappMessage ?? {}) as Record<string, unknown>;
    const externalId = msg.externalId ? String(msg.externalId) : null;
    const newStatus = msg.status ? String(msg.status) : null;

    if (externalId && newStatus && newStatus in STATUS_RANK) {
      const { data: current } = await supabase
        .from("wa_outbox")
        .select("status")
        .eq("id", externalId)
        .maybeSingle();

      const currentRank = current ? (STATUS_RANK[current.status] ?? 0) : -1;
      const newRank = STATUS_RANK[newStatus];

      if (current && newRank >= currentRank) {
        await supabase
          .from("wa_outbox")
          .update({
            status: newStatus,
            ycloud_message_id: (msg.wamid as string | undefined) ?? undefined,
            error_code: (msg.errorCode as string | undefined) ?? null,
            error_message: (msg.errorMessage as string | undefined) ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", externalId);
      }
    }
  }
  // Otros tipos (inbound_message.received, template.category_updated, etc.)
  // ya quedaron guardados en wa_webhook_events — sin acción todavía
  // (bots/CRM son fases futuras fuera de alcance de esto).

  return new Response("OK", { status: 200 });
});
