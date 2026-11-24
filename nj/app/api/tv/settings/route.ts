import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return NextResponse.json(
      { error: "missing_supabase_env" },
      { status: 500 }
    );
  }

  const res = await fetch(
    `${url}/rest/v1/tv_local_settings?id=eq.1&select=youtube_playlist_id&limit=1`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json(
      { error: "settings_fetch_failed", status: res.status, body },
      { status: 502 }
    );
  }

  const rows = (await res.json()) as Array<{
    youtube_playlist_id?: string | null;
  }>;
  const playlistId = rows?.[0]?.youtube_playlist_id ?? null;

  return NextResponse.json(
    { youtube_playlist_id: playlistId },
    {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    }
  );
}
