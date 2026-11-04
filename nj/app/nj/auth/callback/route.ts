import { NextRequest } from "next/server";
import { GET as handleAuthCallback } from "@/app/auth/callback/route";

/** Compatibilidad pre-cutover: www.fylmoda.com.ar/nj/auth/callback. */
export function GET(request: NextRequest) {
  const url = request.nextUrl.clone();
  if (!url.searchParams.get("pfx")) {
    url.searchParams.set("pfx", "nj");
  }
  return handleAuthCallback(new NextRequest(url, request));
}
