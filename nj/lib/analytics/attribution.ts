import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Atribución first-touch: guarda utm_*, fbclid y cookies de Meta en el primer
 * ingreso y los envía una sola vez a `fn_register_attribution` cuando existe la
 * ficha de clienta. El servidor decide la clienta con auth.uid().
 */
const ATTR_KEY = "fyl_attr_v1";
const SENT_KEY = "fyl_attr_v1_sent";

type AttributionPayload = {
  first_seen_at: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  fbclid: string | null;
  fbc: string | null;
  fbp: string | null;
  landing_url: string;
  referrer: string | null;
};

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Solo guarda si todavía no hay nada (first-touch). Seguro ante storage bloqueado. */
export function captureFirstTouch(): void {
  try {
    if (localStorage.getItem(ATTR_KEY)) return;
    const q = new URLSearchParams(location.search);
    const fbclid = q.get("fbclid");
    const data: AttributionPayload = {
      first_seen_at: new Date().toISOString(),
      utm_source: q.get("utm_source"),
      utm_medium: q.get("utm_medium"),
      utm_campaign: q.get("utm_campaign"),
      utm_content: q.get("utm_content"),
      utm_term: q.get("utm_term"),
      fbclid,
      fbc: readCookie("_fbc") || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : null),
      fbp: readCookie("_fbp"),
      // sin query, para no guardar datos de más
      landing_url: location.origin + location.pathname,
      referrer: document.referrer || null,
    };
    localStorage.setItem(ATTR_KEY, JSON.stringify(data));
  } catch {
    /* modo privado o storage bloqueado: se ignora */
  }
}

/** Envía la atribución guardada. Idempotente: marca como enviada solo si el RPC confirma. */
export async function sendAttribution(): Promise<void> {
  try {
    if (localStorage.getItem(SENT_KEY)) return;
    const raw = localStorage.getItem(ATTR_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw) as AttributionPayload;
    payload.fbp = readCookie("_fbp") || payload.fbp;
    const { data, error } = await getSupabaseBrowserClient().rpc(
      "fn_register_attribution",
      { p: payload }
    );
    if (!error && data === true) localStorage.setItem(SENT_KEY, "1");
  } catch {
    /* no bloquea el flujo de la clienta */
  }
}
