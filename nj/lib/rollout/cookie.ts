import {
  codeToSource,
  sourceToCode,
  type Experience,
  type GrantSource,
} from "./constants";

/**
 * EXPERIENCE_COOKIE = `v1.<f|c>.<sourceCode>.<YYYY-MM-DD>.<hmac>`
 * La firma cubre también el visitor_id: copiar la cookie a otro dispositivo
 * (otro fyl_vid) la invalida.
 */
export interface SignedExperience {
  experience: Experience;
  source: GrantSource | null;
  /** Día ART en que se emitió. */
  day: string;
}

const VERSION = "v1";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
    keyCache.set(secret, key);
  }
  return key;
}

function toBase64Url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function payload(visitorId: string, expCode: string, sourceCode: string, day: string) {
  return `${VERSION}|${visitorId}|${expCode}|${sourceCode}|${day}`;
}

export async function signExperience(
  secret: string,
  visitorId: string,
  value: SignedExperience
): Promise<string> {
  const expCode = value.experience === "full" ? "f" : "c";
  const sourceCode = value.experience === "full" ? sourceToCode(value.source) : "-";
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload(visitorId, expCode, sourceCode, value.day))
  );
  return `${VERSION}.${expCode}.${sourceCode}.${value.day}.${toBase64Url(sig)}`;
}

/** Devuelve null si falta, está malformada, la firma no coincide o es de otro visitante. */
export async function verifyExperience(
  secret: string,
  visitorId: string,
  raw: string | undefined | null
): Promise<SignedExperience | null> {
  if (!raw || !secret || !visitorId) return null;
  const parts = raw.split(".");
  if (parts.length !== 5) return null;
  const [version, expCode, sourceCode, day, sig] = parts;
  if (version !== VERSION || (expCode !== "f" && expCode !== "c") || !DAY_RE.test(day)) {
    return null;
  }
  const sigBytes = fromBase64Url(sig);
  if (!sigBytes) return null;
  const key = await importKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    encoder.encode(payload(visitorId, expCode, sourceCode, day))
  );
  if (!ok) return null;
  return expCode === "f"
    ? { experience: "full", source: codeToSource(sourceCode), day }
    : { experience: "catalog", source: null, day };
}
