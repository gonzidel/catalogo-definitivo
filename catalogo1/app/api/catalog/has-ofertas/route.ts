import { NextResponse } from "next/server";
import { hasActiveOfertas } from "@/lib/supabase/queries";

export const revalidate = 300;

export async function GET() {
  const has = await hasActiveOfertas();
  return NextResponse.json(
    { has },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    }
  );
}
