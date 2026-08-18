import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { isInitialProfileComplete } from "@/lib/auth/profile-complete";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

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
      // Ensure `next` is a relative path to prevent open redirects
      let safeNext = next.startsWith("/") ? next : "/dashboard";

      // Cuenta nueva (Google/magic): si falta perfil, ir al dashboard con onboarding.
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

      return NextResponse.redirect(`${origin}/nj${safeNext}`);
    }
  }

  // Auth error — redirect to login with error param
  return NextResponse.redirect(`${origin}/nj/login?error=auth_error`);
}
