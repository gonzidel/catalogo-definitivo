/**
 * Edge Function: wa-dispatch
 *
 * Despacha avisos de vencimiento encolados en public.wa_outbox (status='queued')
 * hacia la API de YCloud (WhatsApp Cloud API). NO la llama el navegador ni
 * ningún cliente público — la dispara pg_cron vía rpc_wa_dispatch_trigger()
 * (net.http_post) con un secreto propio, no la firma de YCloud (esa es para
 * wa-webhook, que recibe eventos EN SENTIDO CONTRARIO).
 *
 * Mientras YCLOUD_API_KEY no esté configurada, o un canal no tenga
 * status='connected' + phone_e164, las filas correspondientes se DEJAN en
 * 'queued' (no se marcan failed) para que se reintenten solas en la próxima
 * corrida, sin perder el aviso.
 *
 * Secrets requeridos (Supabase Dashboard → Edge Functions → wa-dispatch → Secrets):
 *   WA_DISPATCH_CRON_SECRET   → compartido con el valor guardado en Supabase Vault
 *                                 (vault secret 'wa_dispatch_cron_secret', ver 353)
 *   YCLOUD_API_KEY            → se completa recién cuando haya cuenta/canal YCloud real
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (automáticos en Edge Functions)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const YCLOUD_MESSAGES_URL = "https://api.ycloud.com/v2/whatsapp/messages";
const BATCH_LIMIT = 20;

interface OutboxRow {
  id: string;
  order_id: string;
  kind: string;
  channel_owner: string;
  to_phone_e164: string;
  template_name: string;
  template_params: unknown;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const expectedSecret = Deno.env.get("WA_DISPATCH_CRON_SECRET") || "";
  const receivedSecret = req.headers.get("x-cron-secret") || "";
  if (!expectedSecret || receivedSecret !== expectedSecret) {
    console.warn("wa-dispatch: secreto inválido o no configurado");
    // 401 acá es seguro: esto no es un webhook público de un tercero que
    // reintente agresivamente, es nuestro propio cron.
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const ycloudApiKey = Deno.env.get("YCLOUD_API_KEY") || "";
  if (!ycloudApiKey) {
    console.log("wa-dispatch: YCLOUD_API_KEY no configurada todavía, nada para hacer");
    return new Response(JSON.stringify({ ok: true, note: "ycloud_api_key_not_set", processed: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: rows, error: fetchError } = await supabase
    .from("wa_outbox")
    .select("id, order_id, kind, channel_owner, to_phone_e164, template_name, template_params")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (fetchError) {
    console.error("wa-dispatch: error leyendo wa_outbox", fetchError);
    return new Response(JSON.stringify({ ok: false, error: fetchError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: channels, error: channelsError } = await supabase
    .from("wa_channels")
    .select("owner_key, phone_e164, status");

  if (channelsError) {
    console.error("wa-dispatch: error leyendo wa_channels", channelsError);
    return new Response(JSON.stringify({ ok: false, error: channelsError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const channelByOwner = new Map((channels || []).map((c) => [c.owner_key, c]));

  let sent = 0;
  let failed = 0;
  let skippedNoChannel = 0;

  for (const row of (rows || []) as OutboxRow[]) {
    const channel = channelByOwner.get(row.channel_owner);
    if (!channel || channel.status !== "connected" || !channel.phone_e164) {
      // Canal todavía no conectado (ej. Fati/Ani sin QR escaneado). No se
      // toca la fila: queda 'queued' y se reintenta sola en la próxima corrida.
      skippedNoChannel++;
      continue;
    }

    const params = Array.isArray(row.template_params) ? row.template_params : [];

    let res: Response;
    try {
      res = await fetch(YCLOUD_MESSAGES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": ycloudApiKey },
        body: JSON.stringify({
          from: channel.phone_e164,
          to: row.to_phone_e164,
          type: "template",
          externalId: row.id,
          filterUnsubscribed: true,
          template: {
            name: row.template_name,
            language: { code: "es_AR" },
            // Ninguna plantilla vigente usa variables (357): un componente
            // "body" con parameters:[] puede ser rechazado por la API para
            // una plantilla sin {{n}}, así que se omite directamente.
            ...(params.length > 0
              ? {
                  components: [
                    {
                      type: "body",
                      parameters: params.map((text) => ({ type: "text", text: String(text) })),
                    },
                  ],
                }
              : {}),
          },
        }),
      });
    } catch (err) {
      console.error(`wa-dispatch: fetch falló para ${row.id}`, err);
      await supabase
        .from("wa_outbox")
        .update({
          status: "failed",
          error_code: "network_error",
          error_message: err instanceof Error ? err.message : String(err),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      failed++;
      continue;
    }

    const out = await res.json().catch(() => ({}));

    if (res.ok) {
      await supabase
        .from("wa_outbox")
        .update({
          status: "sent",
          ycloud_message_id: out?.id ?? null,
          sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      // Refleja el envío automático en la misma tabla que ya usa el Kanban
      // para el aviso manual (evita que Ani/Fati reenvíen a mano por duplicado).
      await supabase
        .from("admin_order_expiry_warn_sent")
        .upsert(
          { order_id: row.order_id, sent_at: new Date().toISOString(), sent_by: null },
          { onConflict: "order_id" },
        );

      sent++;
    } else {
      await supabase
        .from("wa_outbox")
        .update({
          status: "failed",
          error_code: out?.error?.code ?? String(res.status),
          error_message: out?.error?.message ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      failed++;
      console.error(`wa-dispatch: YCloud rechazó ${row.id}`, res.status, out);
    }
  }

  const summary = { ok: true, processed: (rows || []).length, sent, failed, skippedNoChannel };
  console.log("wa-dispatch:", JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } });
});
