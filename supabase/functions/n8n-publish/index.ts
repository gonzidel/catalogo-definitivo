// supabase/functions/n8n-publish/index.ts
// Proxy server-side hacia webhook n8n (evita CORS desde admin/publications.js).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const N8N_WEBHOOK_PATH = "349a70b5-c37c-4657-8842-15d89ab6103c";
const N8N_WEBHOOK_BASE = "https://automation.fylmoda.com.ar";

type WebhookMode = "test" | "production";

interface PublishPayload {
  source?: string;
  published_at?: string;
  selection_count?: number;
  variant_count?: number;
  items?: Record<string, unknown>[];
  webhook_mode?: WebhookMode;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function resolveN8nWebhookUrl(mode: WebhookMode): string {
  const explicit =
    mode === "test"
      ? Deno.env.get("N8N_PUBLISH_WEBHOOK_TEST_URL")
      : Deno.env.get("N8N_PUBLISH_WEBHOOK_URL");

  if (explicit?.trim()) return explicit.trim();

  const prefix = mode === "test" ? "webhook-test" : "webhook";
  return `${N8N_WEBHOOK_BASE}/${prefix}/${N8N_WEBHOOK_PATH}`;
}

async function userCanPublish(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
): Promise<boolean> {
  const { data: isAdmin, error: adminError } = await supabaseAdmin.rpc("is_admin");
  if (!adminError && isAdmin === true) return true;

  const { data: hasPerm, error: permError } = await supabaseAdmin.rpc("has_permission", {
    check_user_id: userId,
    permission_key: "publications",
    action: "edit",
  });

  if (permError) {
    console.warn("[n8n-publish] has_permission error:", permError);
    return false;
  }

  return hasPerm === true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Método no permitido" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "No autorizado" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SERVICE_ROLE_KEY") || "";

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await supabaseAuth.auth.getUser();

    if (userError || !user) {
      return jsonResponse({ error: "No autenticado" }, 401);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
    const allowed = await userCanPublish(supabaseAdmin, user.id);
    if (!allowed) {
      return jsonResponse({ error: "Sin permiso para publicar" }, 403);
    }

    const payload = (await req.json()) as PublishPayload;
    const items = Array.isArray(payload.items) ? payload.items : [];

    if (items.length === 0) {
      return jsonResponse({ error: "items vacío" }, 400);
    }

    const webhookMode: WebhookMode = payload.webhook_mode === "test" ? "test" : "production";
    const n8nUrl = resolveN8nWebhookUrl(webhookMode);

    const forwardBody = {
      source: payload.source || "admin_publications",
      published_at: payload.published_at || new Date().toISOString(),
      selection_count: payload.selection_count ?? items.length,
      variant_count: payload.variant_count ?? items.length,
      items,
      triggered_by: user.id,
    };

    const n8nResponse = await fetch(n8nUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwardBody),
    });

    const n8nText = await n8nResponse.text().catch(() => "");

    if (!n8nResponse.ok) {
      console.error("[n8n-publish] n8n error:", n8nResponse.status, n8nText.slice(0, 500));
      return jsonResponse(
        {
          ok: false,
          error: `n8n respondió HTTP ${n8nResponse.status}`,
          n8n_status: n8nResponse.status,
          n8n_body: n8nText.slice(0, 500),
          webhook_mode: webhookMode,
        },
        502,
      );
    }

    return jsonResponse({
      ok: true,
      n8n_status: n8nResponse.status,
      webhook_mode: webhookMode,
      items_count: items.length,
      n8n_body: n8nText.slice(0, 500) || null,
    });
  } catch (error) {
    console.error("[n8n-publish] unexpected error:", error);
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Error interno",
      },
      500,
    );
  }
});
