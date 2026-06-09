import { NextRequest, NextResponse } from "next/server";
import { getCatalogPage } from "@/lib/supabase/queries";
import { slugToCategoria } from "@/lib/utils/catalog";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const categoriaParam = searchParams.get("categoria") ?? "all";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
  const tagsParam = searchParams.get("tags") ?? "";
  const tags = tagsParam ? tagsParam.split(",").filter(Boolean) : [];

  // Normalize categoria from slug
  const categoria =
    categoriaParam === "all"
      ? "all"
      : slugToCategoria(categoriaParam) ?? categoriaParam;

  try {
    const { products, hasMore } = await getCatalogPage(categoria, page);
    return NextResponse.json({ products, hasMore }, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    console.error("[/api/catalog] error:", err);
    return NextResponse.json(
      { error: "catalog fetch failed" },
      { status: 500 }
    );
  }
}
