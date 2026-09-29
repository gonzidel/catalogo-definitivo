import {
  isGrantSource,
  isRolloutMode,
  type Experience,
  type GrantSource,
  type RolloutMode,
} from "./constants";

/**
 * Solo server-side (middleware edge y route handlers). Nunca importar desde
 * componentes cliente: usa SUPABASE_SERVICE_ROLE_KEY y ROLLOUT_COOKIE_SECRET.
 */
export interface RolloutEnv {
  /** NEXT_PUBLIC_ROLLOUT_ENABLED=1 (compartida con el boot script). Apagado = nj actual: todos full, sin cookies. */
  enabled: boolean;
  supabaseUrl: string;
  serviceKey: string;
  cookieSecret: string;
  /** ROLLOUT_FORCE_MODE: pisa rollout_config.mode (kill de emergencia sin base). */
  forceMode: RolloutMode | null;
  /** ROLLOUT_FORCE_EXPERIENCE: solo fuera de producción, para revisar variantes en preview. */
  forceExperience: Experience | null;
}

export function readRolloutEnv(): RolloutEnv {
  const forceMode = process.env.ROLLOUT_FORCE_MODE?.trim();
  const forceExperience = process.env.ROLLOUT_FORCE_EXPERIENCE?.trim();
  const isProduction = process.env.VERCEL_ENV === "production";
  return {
    enabled: process.env.NEXT_PUBLIC_ROLLOUT_ENABLED === "1",
    supabaseUrl: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, ""),
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    cookieSecret: process.env.ROLLOUT_COOKIE_SECRET ?? "",
    forceMode: isRolloutMode(forceMode) ? forceMode : null,
    forceExperience:
      !isProduction && (forceExperience === "full" || forceExperience === "catalog")
        ? forceExperience
        : null,
  };
}

export function isRolloutMisconfigured(env: RolloutEnv): boolean {
  return env.enabled && (!env.supabaseUrl || !env.serviceKey || env.cookieSecret.length < 32);
}

function serviceHeaders(env: RolloutEnv): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: env.serviceKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // Las claves legacy (JWT) van también como Bearer; las sb_secret_* solo en apikey.
  if (env.serviceKey.startsWith("eyJ")) headers.Authorization = `Bearer ${env.serviceKey}`;
  return headers;
}

const MODE_TTL_MS = 30_000;
const MODE_TIMEOUT_MS = 800;
const RPC_TIMEOUT_MS = 1500;
let modeCache: { mode: RolloutMode; at: number } | null = null;

/** Modo vigente. Cache por isolate; si la base no responde, último conocido o `paused`. */
export async function getRolloutMode(env: RolloutEnv): Promise<RolloutMode> {
  if (env.forceMode) return env.forceMode;
  if (modeCache && Date.now() - modeCache.at < MODE_TTL_MS) return modeCache.mode;
  try {
    const res = await fetch(`${env.supabaseUrl}/rest/v1/rollout_config?id=eq.1&select=mode`, {
      headers: serviceHeaders(env),
      signal: AbortSignal.timeout(MODE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`rollout_config ${res.status}`);
    const rows = (await res.json()) as Array<{ mode?: unknown }>;
    const mode = isRolloutMode(rows[0]?.mode) ? rows[0].mode : "paused";
    modeCache = { mode, at: Date.now() };
    return mode;
  } catch (err) {
    console.error("[rollout] mode fetch failed", err);
    return modeCache?.mode ?? "paused";
  }
}

/** El modo que devolvió la RPC es el de la base: refresca el cache de este isolate. */
export function rememberRolloutMode(env: RolloutEnv, mode: RolloutMode) {
  if (!env.forceMode) modeCache = { mode, at: Date.now() };
}

export interface RolloutDecision {
  experience: Experience;
  reason: string;
  source: GrantSource | null;
  hasGrant: boolean;
  /** rollout_config.mode leído por la RPC en esta decisión. */
  mode: RolloutMode | null;
}

function parseDecision(value: unknown): RolloutDecision {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.experience !== "full" && v.experience !== "catalog") {
    throw new Error("rollout rpc: respuesta inválida");
  }
  return {
    experience: v.experience,
    reason: typeof v.reason === "string" ? v.reason : "",
    source: isGrantSource(v.source) ? v.source : null,
    hasGrant: v.has_grant === true,
    mode: isRolloutMode(v.mode) ? v.mode : null,
  };
}

async function callRpc(env: RolloutEnv, name: string, body: Record<string, unknown>) {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${name} ${res.status}: ${await res.text()}`);
  return parseDecision(await res.json());
}

/**
 * ¿La cuenta figura en public.admins (misma fuente que fn_rollout_staff_source)?
 * Se consulta en vivo, sin confiar en el source firmado. Ante error: false.
 */
export async function isStaffUser(env: RolloutEnv, authUserId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${env.supabaseUrl}/rest/v1/admins?user_id=eq.${encodeURIComponent(authUserId)}&select=user_id&limit=1`,
      {
        headers: serviceHeaders(env),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error(`admins ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length > 0;
  } catch (err) {
    console.error("[rollout] staff check failed", err);
    return false;
  }
}

export function resolveExperience(
  env: RolloutEnv,
  input: { visitorId: string; authUserId: string | null; testerLink: boolean }
): Promise<RolloutDecision> {
  return callRpc(env, "rpc_rollout_resolve", {
    p_visitor_id: input.visitorId,
    p_auth_user_id: input.authUserId,
    p_source_hint: input.testerLink ? "tester_link" : null,
  });
}

export function linkUserExperience(
  env: RolloutEnv,
  input: { visitorId: string | null; authUserId: string }
): Promise<RolloutDecision> {
  return callRpc(env, "rpc_rollout_link_user", {
    p_visitor_id: input.visitorId,
    p_auth_user_id: input.authUserId,
  });
}
