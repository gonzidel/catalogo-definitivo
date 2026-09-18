import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { isInitialProfileComplete } from "@/lib/auth/profile-complete";
import { resolveAuthRedirectBase } from "@/lib/site-url";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";
  const redirectBase = resolveAuthRedirectBase({
    nextUrlPathname: request.nextUrl.pathname,
    requestUrl: request.url,
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    host: request.headers.get("host"),
    pfx: searchParams.get("pfx"),
  });

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      let safeNext = next.startsWith("/") ? next : "/dashboard";
      if (safeNext.startsWith("/nj/")) safeNext = safeNext.slice(3) || "/";
      else if (safeNext === "/nj") safeNext = "/";

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data: customer } = await supabase
          .from("customers")
          .select("full_name, phone, dni, province, city, address")
          .eq("id", user.id)
          .maybeSingle();
        if (!isInitialProfileComplete(customer)) {
          safeNext = "/dashboard?onboarding=1";
        }
      }

      return NextResponse.redirect(`${redirectBase}${safeNext}`);
    }
  }

  return NextResponse.redirect(`${redirectBase}/login?error=auth_error`);
}
