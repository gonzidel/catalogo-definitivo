import { getAdminContext } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import TvSettingsForm from "./tv-settings-form";

export const dynamic = "force-dynamic";

export default async function AdminTvPage() {
  const ctx = await getAdminContext();
  if (!ctx) {
    return (
      <AccessDenied reason="Tu cuenta no tiene acceso al panel de administración." />
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("tv_local_settings")
    .select("youtube_playlist_id, youtube_playlist_url, updated_at")
    .eq("id", 1)
    .maybeSingle();

  return (
    <main style={{ padding: "28px 20px", maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ margin: "0 0 8px", fontSize: 28 }}>TV del local</h1>
      <p style={{ margin: "0 0 20px", color: "#666", lineHeight: 1.45 }}>
        Configurá la playlist de YouTube de la pantalla del local. Requiere
        login de admin. La TV lee este valor del servidor (no del navegador de
        la tele). Usá una playlist pública o no listada con{" "}
        <code>list=PL…</code>.
      </p>
      <TvSettingsForm
        initialPlaylistId={data?.youtube_playlist_id ?? null}
        initialPlaylistUrl={data?.youtube_playlist_url ?? null}
        initialUpdatedAt={data?.updated_at ?? null}
      />
    </main>
  );
}
