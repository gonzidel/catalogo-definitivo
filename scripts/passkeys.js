// scripts/passkeys.js
// Módulo frontend para WebAuthn/Passkeys

import { supabase } from "./supabase-client.js";
import { SUPABASE_URL } from "./config.js";

const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/passkeys`;

// Verificar soporte WebAuthn
export function checkPasskeySupport() {
  return typeof window.PublicKeyCredential !== "undefined";
}

// Verificar disponibilidad de autenticador de plataforma (huella/rostro)
export async function isPlatformAuthenticatorAvailable() {
  if (!checkPasskeySupport()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (error) {
    console.warn("Error verificando autenticador de plataforma:", error);
    return false;
  }
}

// Verificar si usuario tiene passkeys registradas
export async function hasRegisteredPasskeys(userId) {
  try {
    const { data, error } = await supabase
      .from("passkeys")
      .select("id")
      .eq("user_id", userId)
      .limit(1);

    if (error) {
      console.error("Error verificando passkeys:", error);
      return false;
    }

    return data && data.length > 0;
  } catch (error) {
    console.error("Error en hasRegisteredPasskeys:", error);
    return false;
  }
}

// Registrar nueva passkey
export async function registerPasskey(deviceName = "Dispositivo") {
  try {
    // Obtener sesión actual
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      throw new Error("No hay sesión activa");
    }

    const accessToken = session.access_token;

    // 1. Obtener opciones de registro
    const optionsResponse = await fetch(`${EDGE_FUNCTION_URL}/register/options`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!optionsResponse.ok) {
      const errorData = await optionsResponse.json();
      throw new Error(errorData.error || "Error obteniendo opciones de registro");
    }

    const options = await optionsResponse.json();

    // Helper para convertir base64url a Uint8Array
    function base64urlToUint8Array(base64url) {
      const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64);
      return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    }

    // 2. Crear passkey en el dispositivo
    const credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: base64urlToUint8Array(options.challenge),
        user: {
          ...options.user,
          id: base64urlToUint8Array(options.user.id),
        },
      },
    });

    if (!credential) {
      throw new Error("No se pudo crear la passkey");
    }

    // 3. Convertir credential a formato para enviar (base64url)
    function arrayBufferToBase64url(buffer) {
      const bytes = new Uint8Array(buffer);
      const binary = String.fromCharCode(...bytes);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }

    const credentialForServer = {
      id: arrayBufferToBase64url(credential.rawId),
      rawId: arrayBufferToBase64url(credential.rawId),
      response: {
        clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON),
        attestationObject: arrayBufferToBase64url(credential.response.attestationObject),
      },
      type: credential.type,
    };

    // 4. Verificar con el servidor
    const verifyResponse = await fetch(`${EDGE_FUNCTION_URL}/register/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        credential: credentialForServer,
        expectedChallenge: options.challenge,
        deviceName,
      }),
    });

    if (!verifyResponse.ok) {
      const errorData = await verifyResponse.json();
      throw new Error(errorData.error || "Error verificando passkey");
    }

    const result = await verifyResponse.json();
    return result.success;
  } catch (error) {
    console.error("Error registrando passkey:", error);
    throw error;
  }
}

// Autenticar con passkey
export async function authenticateWithPasskey(email) {
  try {
    if (!email) {
      throw new Error("Email requerido");
    }

    // Normalizar email
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Obtener opciones de autenticación
    const optionsResponse = await fetch(`${EDGE_FUNCTION_URL}/authenticate/options`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: normalizedEmail }),
    });

    if (!optionsResponse.ok) {
      const errorData = await optionsResponse.json();
      throw new Error(errorData.error || "Error obteniendo opciones de autenticación");
    }

    const options = await optionsResponse.json();

    // Helper para convertir base64url a Uint8Array
    function base64urlToUint8Array(base64url) {
      const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64);
      return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    }

    // 2. Obtener passkey del dispositivo
    const credential = await navigator.credentials.get({
      publicKey: {
        ...options,
        challenge: base64urlToUint8Array(options.challenge),
        allowCredentials: options.allowCredentials?.map((cred) => ({
          ...cred,
          id: base64urlToUint8Array(cred.id),
        })),
      },
    });

    if (!credential) {
      throw new Error("No se pudo obtener la passkey");
    }

    // 3. Convertir credential a formato para enviar (base64url)
    function arrayBufferToBase64url(buffer) {
      const bytes = new Uint8Array(buffer);
      const binary = String.fromCharCode(...bytes);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }

    const credentialForServer = {
      id: arrayBufferToBase64url(credential.rawId),
      rawId: arrayBufferToBase64url(credential.rawId),
      response: {
        clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON),
        authenticatorData: arrayBufferToBase64url(credential.response.authenticatorData),
        signature: arrayBufferToBase64url(credential.response.signature),
        userHandle: credential.response.userHandle
          ? arrayBufferToBase64url(credential.response.userHandle)
          : null,
      },
      type: credential.type,
    };

    // 4. Verificar con el servidor
    const verifyResponse = await fetch(`${EDGE_FUNCTION_URL}/authenticate/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: normalizedEmail,
        credential: credentialForServer,
        expectedChallenge: options.challenge,
      }),
    });

    if (!verifyResponse.ok) {
      const errorData = await verifyResponse.json();
      throw new Error(errorData.error || "Error verificando passkey");
    }

    const result = await verifyResponse.json();

    if (result.success && result.action_link) {
      // Redirigir al magic link para completar sesión
      window.location.href = result.action_link;
      return true;
    } else {
      throw new Error("No se recibió action_link del servidor");
    }
  } catch (error) {
    console.error("Error autenticando con passkey:", error);
    throw error;
  }
}

