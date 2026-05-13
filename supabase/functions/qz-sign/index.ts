import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "", // Dynamic
  "Vary": "Origin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Max-Age": "86400",
};

const ALLOWED_ORIGINS = [
  "http://localhost:5500",
  "http://localhost:8080",
  "http://127.0.0.1:5500",
  "http://127.0.0.1:8080",
  "https://catalogo-fyl-test.web.app",
  "https://catalogo-fyl.web.app",
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    ...corsHeaders,
    "Access-Control-Allow-Origin": allowOrigin,
  };
}

async function assertAdmin(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    throw new Response("Unauthorized: missing bearer token", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!supabaseUrl || !anonKey) {
    throw new Response("Server misconfigured: missing Supabase auth env", { status: 500 });
  }

  const supabaseAuth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error: userError } = await supabaseAuth.auth.getUser();
  if (userError || !user) {
    throw new Response("Unauthorized: invalid token", { status: 401 });
  }

  const { data: adminRow, error: adminError } = await supabaseAuth
    .from("admins")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminError || !adminRow) {
    throw new Response("Forbidden: admin required", { status: 403 });
  }
}

// Robust Key Normalization
function normalizeKey(rawKey: string): string {
  // 0. Fail fast
  if (!rawKey || rawKey.trim().length === 0) {
    throw new Error("Key is empty");
  }

  // Helper to remove all whitespace (including newlines)
  const strip = (s: string) => s.replace(/[\s\r\n]/g, "");

  // 1. Is it a direct PEM string? (Contains BEGIN/END headers)
  if (rawKey.includes("-----BEGIN")) {
    const match = rawKey.match(/-----BEGIN[^-]+PRIVATE KEY-----([\s\S]+?)-----END[^-]+PRIVATE KEY-----/);
    if (match) {
      return strip(match[1]);
    }
    // If it has BEGIN but regex failed, try aggressive strip
    const aggressiveStrip = rawKey
      .replace(/-----BEGIN[^-]+-----/, "")
      .replace(/-----END[^-]+-----/, "")
      .replace(/[^A-Za-z0-9+/=]/g, "");
    return aggressiveStrip;
  }

  // 2. It might be "Double Base64" (Base64 of a PEM file) or "DER Base64" (MII...)
  const cleanRaw = strip(rawKey);

  try {
    const decoded = atob(cleanRaw);
    if (decoded.includes("-----BEGIN")) {
      // It WAS Double Base64. Now 'decoded' is the PEM string.
      const match = decoded.match(/-----BEGIN[^-]+PRIVATE KEY-----([\s\S]+?)-----END[^-]+PRIVATE KEY-----/);
      if (match) {
        return strip(match[1]);
      }
      const aggressiveStrip = decoded
        .replace(/-----BEGIN[^-]+-----/, "")
        .replace(/-----END[^-]+-----/, "")
        .replace(/[^A-Za-z0-9+/=]/g, "");
      return aggressiveStrip;
    }
  } catch (e) {
    // atob failed, likely not valid base64 or garbage.
    // Proceed to treat original as potential DER base64.
  }

  // 3. Assume it is plain DER Base64 (MII...)
  // Just return the stripped version.
  return cleanRaw;
}

serve(async (req) => {
  const headers = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    // 1. Authentication: JWT + admin row. No shared secret in browser.
    try {
      await assertAdmin(req);
    } catch (authResponse) {
      if (authResponse instanceof Response) {
        return new Response(await authResponse.text(), {
          status: authResponse.status,
          headers,
        });
      }
      throw authResponse;
    }

    // 2. Parse Body
    // IMPORTANTE: Leer como text/plain directamente (NO JSON, NO trim)
    // QZ Tray requiere que el string llegue exactamente igual, sin modificaciones
    const toSign = await req.text();
    
    if (!toSign || typeof toSign !== "string" || toSign.length === 0) {
      console.error("❌ toSign inválido:", { type: typeof toSign, length: toSign?.length, value: toSign?.substring(0, 50) });
      return new Response("Missing toSign", { status: 400, headers });
    }

    // NO hacer trim() - el string debe llegar exactamente como QZ Tray lo envió
    console.log("📥 toSign recibido (len=" + toSign.length + "):", toSign.substring(0, 100) + (toSign.length > 100 ? "..." : ""));

    // 3. Prepare Key
    const envKey = Deno.env.get("QZ_PRIVATE_KEY_B64");
    if (!envKey) {
      throw new Error("QZ_PRIVATE_KEY_B64 is not set");
    }

    let b64Key = "";
    try {
      b64Key = normalizeKey(envKey);
    } catch (e) {
      throw new Error(`Key normalization failed: ${e.message}`);
    }

    // Fix padding just in case
    while (b64Key.length % 4 !== 0) {
      b64Key += "=";
    }

    // Convert Base64 to ArrayBuffer (DER) - Manual implementation for Deno deploy compat
    const binaryString = atob(b64Key);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 4. Sign
    // IMPORTANTE: QZ Tray 2.1+ requiere SHA-512 (no SHA-256)
    // Según documentación oficial, QZ Tray 2.x espera SHA-512 por defecto
    console.log("🔐 Firmando toSign con SHA-512. Longitud:", toSign.length);
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
      false,
      ["sign"]
    );

    // IMPORTANTE: NO hacer trim() - usar toSign exactamente como llegó
    const signatureBuf = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(toSign)
    );

    // 5. Response (Clean Base64)
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuf)));
    
    // Asegurar que la firma base64 no tenga saltos de línea ni espacios
    const signatureClean = signatureB64.replace(/\s+/g, "").trim();
    console.log("✅ Firma generada. Longitud base64:", signatureClean.length, "Primeros 50 chars:", signatureClean.substring(0, 50));

    return new Response(signatureClean, {
      status: 200,
      headers: { ...headers, "Content-Type": "text/plain" },
    });

  } catch (err) {
    console.error("Sign Error:", err);

    // Construct safe debug info
    const rawVal = Deno.env.get("QZ_PRIVATE_KEY_B64") || "";
    const rawLen = rawVal.length;
    const start = rawVal.substring(0, 5); // Only 5 chars to be safe

    // Check if it's the 207-ish truncated thing
    const hint = rawLen < 300 ? " (Likely Truncated)" : "";

    return new Response(`Invalid key format or Sign Error: ${err.message}. EnvKeyLen:${rawLen}${hint}, Start:${start}`, {
      status: 500,
      headers: { ...headers, "Content-Type": "text/plain" }
    });
  }
});
