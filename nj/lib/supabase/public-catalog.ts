import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Cliente Supabase solo para catálogo público (SSR/Data Cache).
 * Sin cookies, sin persistencia de sesión, sin service role.
 */
let _publicCatalogClient: SupabaseClient | null = null;

export function getPublicCatalogClient(): SupabaseClient {
  if (!_publicCatalogClient) {
    _publicCatalogClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return _publicCatalogClient;
}
