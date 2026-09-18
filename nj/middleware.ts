import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { stripPublicAppPrefix } from "@/lib/site-url";

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = stripPublicAppPrefix(request.nextUrl.pathname);
  const prefix = pathname === request.nextUrl.pathname ? "" : "/nj";

  if (
    (pathname.startsWith("/dashboard") || pathname.startsWith("/admin")) &&
    !user
  ) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = `${prefix}/login`;
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/login" && user) {
    const dashUrl = request.nextUrl.clone();
    dashUrl.pathname = `${prefix}/dashboard`;
    dashUrl.searchParams.delete("next");
    return NextResponse.redirect(dashUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/admin/:path*",
    "/login",
    "/nj/dashboard/:path*",
    "/nj/admin/:path*",
    "/nj/login",
  ],
};
