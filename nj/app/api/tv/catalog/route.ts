import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CATALOG_SELECT = [
  "variant_id",
  '"Articulo"',
  '"Descripcion"',
  '"Color"',
  '"Categoria"',
  '"FechaPublicacion"',
  '"Precio"',
  '"Imagen Principal"',
  '"Imagen 1"',
  '"Imagen 2"',
  '"Imagen 3"',
  '"OfertaActiva"',
  '"PrecioOferta"',
  '"OfferCampaignId"',
  '"OfferImageUrl"',
  '"OfferTitle"',
  '"ColorHex"',
  '"ColorDisplayNumber"',
].join(",");

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return NextResponse.json(
      { error: "missing_supabase_env" },
      { status: 500 }
    );
  }

  const qs =
    "select=" +
    encodeURIComponent(CATALOG_SELECT) +
    "&order=FechaPublicacion.desc.nullslast&limit=800";

  const res = await fetch(
    `${url}/rest/v1/catalog_public_available_view?${qs}`,
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
      { error: "catalog_fetch_failed", status: res.status, body },
      { status: 502 }
    );
  }

  const data = await res.json();
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
    },
  });
}
