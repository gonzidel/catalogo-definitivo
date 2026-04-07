import { supabase } from "./supabase-client.js";
import { fylAnalytics } from "./analytics.js";

let clientAuthHookAttached = false;

/** Paginas client (dashboard, login, etc.). Catalogo usa auth-status.js + misma API. */
export function attachClientAnalyticsAuthListener() {
  if (clientAuthHookAttached || typeof supabase?.auth?.onAuthStateChange !== "function") return;
  clientAuthHookAttached = true;
  supabase.auth.onAuthStateChange((event, session) => {
    fylAnalytics.onSupabaseAuthEvent(event, session);
  });
}
