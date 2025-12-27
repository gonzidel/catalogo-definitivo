// supabase/functions/passkeys/index.ts
// Edge Function para WebAuthn/Passkeys
// Maneja registro y autenticación con passkeys

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Helper functions para base64url (Deno no tiene Buffer)
function uint8ArrayToBase64url(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlToUint8Array(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Intentar importar @simplewebauthn/server (Plan A)
let webauthn: any = null;
try {
  const webauthnModule = await import("npm:@simplewebauthn/server@^8.0.0");
  webauthn = webauthnModule;
  console.log("✅ @simplewebauthn/server cargado (Plan A)");
} catch (error) {
  console.error("❌ Error cargando @simplewebauthn/server:", error);
  console.log("⚠️ Plan A falló, se requiere implementación alternativa (Plan B)");
  // TODO: Implementar Plan B con WebCrypto nativo si es necesario
  throw new Error("WebAuthn library no disponible. Se requiere implementación alternativa.");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// Obtener secrets
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";
const RP_ID = Deno.env.get("RP_ID") || "fylmoda.com.ar";
const ORIGIN_PROD = Deno.env.get("ORIGIN_PROD") || "https://fylmoda.com.ar";
const ORIGIN_DEV = Deno.env.get("ORIGIN_DEV") || "http://localhost:5500";

// Crear cliente Supabase con service role
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Validar origin
function isValidOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return origin === ORIGIN_PROD || origin === ORIGIN_DEV;
}

// Obtener origin permitido
function getAllowedOrigin(requestOrigin: string | null): string {
  if (requestOrigin === ORIGIN_PROD) return ORIGIN_PROD;
  if (requestOrigin === ORIGIN_DEV) return ORIGIN_DEV;
  return ORIGIN_DEV; // default para dev
}

// Manejar CORS preflight
function handleCORS(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("origin");
    const allowedOrigin = isValidOrigin(origin) ? origin : null;
    
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Origin": allowedOrigin || "*",
      },
    });
  }
  return null;
}

// Helper para respuestas CORS
function corsResponse(data: any, status: number = 200, origin: string | null = null): Response {
  const allowedOrigin = isValidOrigin(origin) ? origin : "*";
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Access-Control-Allow-Origin": allowedOrigin,
      "Content-Type": "application/json",
    },
  });
}

// POST /register/options - Genera challenge de registro
async function handleRegisterOptions(req: Request): Promise<Response> {
  try {
    const origin = req.headers.get("origin");
    if (!isValidOrigin(origin)) {
      return corsResponse({ error: "Origin no permitido" }, 403, origin);
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return corsResponse({ error: "Authorization header requerido" }, 401, origin);
    }

    // Obtener usuario desde token
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return corsResponse({ error: "Usuario no autenticado" }, 401, origin);
    }

    // Generar challenge
    const challenge = webauthn.generateChallenge();
    const challengeBase64 = uint8ArrayToBase64url(challenge);

    // Guardar challenge en DB
    const { error: challengeError } = await supabaseAdmin
      .from("webauthn_challenges")
      .insert({
        user_id: user.id,
        challenge: challengeBase64,
        type: "registration",
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

    if (challengeError) {
      console.error("Error guardando challenge:", challengeError);
      return corsResponse({ error: "Error generando challenge" }, 500, origin);
    }

    // Generar opciones de registro
    const rpName = "Catálogo FYL";
    const userDisplayName = user.user_metadata?.full_name || user.email?.split("@")[0] || "Usuario";

    const options = webauthn.generateRegistrationOptions({
      rpName,
      rpID: RP_ID,
      userID: user.id,
      userName: user.email || "",
      userDisplayName,
      timeout: 60000,
      attestationType: "none",
      excludeCredentials: [], // Permitir múltiples passkeys
      authenticatorSelection: {
        authenticatorAttachment: "platform", // Priorizar huella/rostro del dispositivo
        userVerification: "required",
        requireResidentKey: false,
      },
      supportedAlgorithmIDs: [-7, -257], // ES256, RS256
    });

    // Guardar challenge en las opciones
    options.challenge = challengeBase64;

    return corsResponse(options, 200, origin);
  } catch (error) {
    console.error("Error en register/options:", error);
    const origin = req.headers.get("origin");
    return corsResponse({ error: error.message || "Error interno" }, 500, origin);
  }
}

// POST /register/verify - Verifica y guarda passkey
async function handleRegisterVerify(req: Request): Promise<Response> {
  try {
    const origin = req.headers.get("origin");
    if (!isValidOrigin(origin)) {
      return corsResponse({ error: "Origin no permitido" }, 403, origin);
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return corsResponse({ error: "Authorization header requerido" }, 401, origin);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return corsResponse({ error: "Usuario no autenticado" }, 401, origin);
    }

    const body = await req.json();
    const { credential, expectedChallenge } = body;

    if (!credential || !expectedChallenge) {
      return corsResponse({ error: "Datos incompletos" }, 400, origin);
    }

    // Buscar challenge en DB
    const { data: challengeData, error: challengeError } = await supabaseAdmin
      .from("webauthn_challenges")
      .select("*")
      .eq("challenge", expectedChallenge)
      .eq("user_id", user.id)
      .eq("type", "registration")
      .gt("expires_at", new Date().toISOString())
      .single();

    if (challengeError || !challengeData) {
      return corsResponse({ error: "Challenge inválido o expirado" }, 400, origin);
    }

    // Verificar attestation
    let verification;
    try {
      verification = await webauthn.verifyRegistrationResponse({
        response: credential,
        expectedChallenge: expectedChallenge,
        expectedOrigin: getAllowedOrigin(origin),
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });
    } catch (verifyError) {
      console.error("Error verificando attestation:", verifyError);
      return corsResponse({ error: "Verificación fallida: " + verifyError.message }, 400, origin);
    }

    if (!verification.verified) {
      return corsResponse({ error: "Verificación fallida" }, 400, origin);
    }

    // Guardar passkey en DB
    const { credentialID, credentialPublicKey, counter, aaguid } = verification.registrationInfo || {};
    
    if (!credentialID || !credentialPublicKey) {
      return corsResponse({ error: "Datos de passkey incompletos" }, 400, origin);
    }

    const credentialIdBase64 = uint8ArrayToBase64url(credentialID);
    const publicKeyBase64 = uint8ArrayToBase64url(credentialPublicKey);

    const { error: insertError } = await supabaseAdmin
      .from("passkeys")
      .insert({
        user_id: user.id,
        credential_id: credentialIdBase64,
        public_key: publicKeyBase64,
        counter: counter || 0,
        device_name: body.deviceName || "Dispositivo",
        transports: credential.response?.transports || null,
        aaguid: aaguid ? uint8ArrayToHex(aaguid) : null,
      });

    if (insertError) {
      console.error("Error guardando passkey:", insertError);
      return corsResponse({ error: "Error guardando passkey" }, 500, origin);
    }

    // Eliminar challenge usado
    await supabaseAdmin
      .from("webauthn_challenges")
      .delete()
      .eq("id", challengeData.id);

    return corsResponse({ success: true }, 200, origin);
  } catch (error) {
    console.error("Error en register/verify:", error);
    const origin = req.headers.get("origin");
    return corsResponse({ error: error.message || "Error interno" }, 500, origin);
  }
}

// POST /authenticate/options - Genera challenge de autenticación
async function handleAuthenticateOptions(req: Request): Promise<Response> {
  try {
    const origin = req.headers.get("origin");
    if (!isValidOrigin(origin)) {
      return corsResponse({ error: "Origin no permitido" }, 403, origin);
    }

    const body = await req.json();
    const { email } = body;

    if (!email) {
      return corsResponse({ error: "Email requerido" }, 400, origin);
    }

    // Normalizar email
    const normalizedEmail = email.toLowerCase().trim();

    // Buscar user_id usando RPC function
    const { data: userId, error: rpcError } = await supabaseAdmin.rpc(
      "rpc_get_user_id_by_email",
      { p_email: normalizedEmail }
    );

    if (rpcError || !userId) {
      return corsResponse(
        { error: "No existe cuenta para ese email. Entrá primero con Google" },
        400,
        origin
      );
    }

    // Buscar passkeys del usuario
    const { data: passkeys, error: passkeysError } = await supabaseAdmin
      .from("passkeys")
      .select("credential_id")
      .eq("user_id", userId);

    if (passkeysError || !passkeys || passkeys.length === 0) {
      return corsResponse(
        { error: "No hay passkeys registradas para este usuario" },
        400,
        origin
      );
    }

    // Generar challenge
    const challenge = webauthn.generateChallenge();
    const challengeBase64 = uint8ArrayToBase64url(challenge);

    // Guardar challenge en DB
    const { error: challengeError } = await supabaseAdmin
      .from("webauthn_challenges")
      .insert({
        user_id: userId,
        email: normalizedEmail,
        challenge: challengeBase64,
        type: "authentication",
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

    if (challengeError) {
      console.error("Error guardando challenge:", challengeError);
      return corsResponse({ error: "Error generando challenge" }, 500, origin);
    }

    // Convertir credential_ids a Uint8Array
    const allowCredentials = passkeys.map((pk: any) => ({
      id: base64urlToUint8Array(pk.credential_id),
      type: "public-key",
      transports: pk.transports || undefined,
    }));

    // Generar opciones de autenticación
    const options = webauthn.generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials,
      userVerification: "required",
      timeout: 60000,
    });

    options.challenge = challengeBase64;

    return corsResponse(options, 200, origin);
  } catch (error) {
    console.error("Error en authenticate/options:", error);
    const origin = req.headers.get("origin");
    return corsResponse({ error: error.message || "Error interno" }, 500, origin);
  }
}

// POST /authenticate/verify - Verifica y crea sesión Supabase
async function handleAuthenticateVerify(req: Request): Promise<Response> {
  try {
    const origin = req.headers.get("origin");
    if (!isValidOrigin(origin)) {
      return corsResponse({ error: "Origin no permitido" }, 403, origin);
    }

    const body = await req.json();
    const { email, credential, expectedChallenge } = body;

    if (!email || !credential || !expectedChallenge) {
      return corsResponse({ error: "Datos incompletos" }, 400, origin);
    }

    // Normalizar email
    const normalizedEmail = email.toLowerCase().trim();

    // Buscar challenge en DB
    const { data: challengeData, error: challengeError } = await supabaseAdmin
      .from("webauthn_challenges")
      .select("*")
      .eq("challenge", expectedChallenge)
      .eq("email", normalizedEmail)
      .eq("type", "authentication")
      .gt("expires_at", new Date().toISOString())
      .single();

    if (challengeError || !challengeData) {
      return corsResponse({ error: "Challenge inválido o expirado" }, 400, origin);
    }

    const userId = challengeData.user_id;
    if (!userId) {
      return corsResponse({ error: "Challenge sin user_id" }, 400, origin);
    }

    // Buscar passkey (credential.id ya viene en base64url del frontend)
    const credentialIdBase64 = credential.id;
    const { data: passkeyData, error: passkeyError } = await supabaseAdmin
      .from("passkeys")
      .select("*")
      .eq("user_id", userId)
      .eq("credential_id", credentialIdBase64)
      .single();

    if (passkeyError || !passkeyData) {
      return corsResponse({ error: "Passkey no encontrada" }, 400, origin);
    }

    // Verificar assertion
    let verification;
    try {
      const publicKey = base64urlToUint8Array(passkeyData.public_key);
      
      verification = await webauthn.verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: expectedChallenge,
        expectedOrigin: getAllowedOrigin(origin),
        expectedRPID: RP_ID,
        authenticator: {
          credentialID: base64urlToUint8Array(passkeyData.credential_id),
          credentialPublicKey: publicKey,
          counter: passkeyData.counter,
        },
        requireUserVerification: true,
      });
    } catch (verifyError) {
      console.error("Error verificando assertion:", verifyError);
      return corsResponse({ error: "Verificación fallida: " + verifyError.message }, 400, origin);
    }

    if (!verification.verified) {
      return corsResponse({ error: "Verificación fallida" }, 400, origin);
    }

    // Actualizar counter y last_used_at
    await supabaseAdmin
      .from("passkeys")
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", passkeyData.id);

    // Eliminar challenge usado
    await supabaseAdmin
      .from("webauthn_challenges")
      .delete()
      .eq("id", challengeData.id);

    // Generar magic link para crear sesión
    const redirectTo = `${getAllowedOrigin(origin)}/client/dashboard.html`;
    
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: normalizedEmail,
      options: {
        redirectTo,
      },
    });

    if (linkError || !linkData) {
      console.error("Error generando magic link:", linkError);
      return corsResponse({ error: "Error generando sesión" }, 500, origin);
    }

    return corsResponse(
      { 
        success: true, 
        action_link: linkData.properties?.action_link || linkData.properties?.hashed_token 
      },
      200,
      origin
    );
  } catch (error) {
    console.error("Error en authenticate/verify:", error);
    const origin = req.headers.get("origin");
    return corsResponse({ error: error.message || "Error interno" }, 500, origin);
  }
}

// Router principal
serve(async (req) => {
  // Manejar CORS preflight
  const corsResponse = handleCORS(req);
  if (corsResponse) return corsResponse;

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (req.method === "POST") {
      if (path.endsWith("/register/options")) {
        return await handleRegisterOptions(req);
      } else if (path.endsWith("/register/verify")) {
        return await handleRegisterVerify(req);
      } else if (path.endsWith("/authenticate/options")) {
        return await handleAuthenticateOptions(req);
      } else if (path.endsWith("/authenticate/verify")) {
        return await handleAuthenticateVerify(req);
      } else {
        const origin = req.headers.get("origin");
        return corsResponse({ error: "Endpoint no encontrado" }, 404, origin);
      }
    } else {
      const origin = req.headers.get("origin");
      return corsResponse({ error: "Método no permitido" }, 405, origin);
    }
  } catch (error) {
    console.error("Error en handler:", error);
    const origin = req.headers.get("origin");
    return corsResponse({ error: error.message || "Error interno" }, 500, origin);
  }
});

