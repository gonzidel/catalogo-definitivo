import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { isInitialProfileComplete } from "@/lib/auth/profile-complete";
import { resolveAuthRedirectBase } from "@/lib/site-url";
import { EXPERIENCE_MIRROR_COOKIE, VISITOR_COOKIE } from "@/lib/rollout/constants";
import { rolloutDay } from "@/lib/rollout/day";
import { isVisitorId } from "@/lib/rollout/decide";
import { writeExperienceCookies } from "@/lib/rollout/response";
import {
  isRolloutMisconfigured,
  isStaffUser,
  linkUserExperience,
  readRolloutEnv,
  type RolloutDecision,
} from "@/lib/rollout/server";

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

      const env = readRolloutEnv();
      const rolloutActive = env.enabled && !isRolloutMisconfigured(env) && !env.forceExperience;
      let decision: RolloutDecision | null = null;
      const cookieVid = cookieStore.get(VISITOR_COOKIE)?.value;
      const visitorId = isVisitorId(cookieVid) ? cookieVid : crypto.randomUUID();

      if (user && rolloutActive) {
        try {
          decision = await linkUserExperience(env, { visitorId, authUserId: user.id });
        } catch (err) {
          // El middleware vuelve a decidir en /dashboard con la sesión ya creada.
          console.error("[rollout] link_user failed", err);
        }
      }

      // En kill el grant se conserva firmado, pero /dashboard queda solo para staff verificado.
      const killMode = decision?.reason === "kill";
      const keepsGrant = killMode && decision?.hasGrant === true;
      const entersFullArea =
        decision !== null &&
        (decision.experience === "full" || (killMode && user !== null && (await isStaffUser(env, user.id))));

      if (decision && !entersFullArea) {
        const res = NextResponse.redirect(`${redirectBase}/`);
        await writeExperienceCookies(res, {
          secure: request.nextUrl.protocol === "https:",
          visitorId,
          setVisitor: !isVisitorId(cookieVid),
          sign: keepsGrant
            ? { experience: "full", source: decision.source, mode: decision.mode, day: rolloutDay() }
            : killMode
              ? null
              : { experience: "catalog", source: null, mode: decision.mode, day: rolloutDay() },
          cookieSecret: env.cookieSecret,
          display: "catalog",
          displaySource: null,
          currentMirror: cookieStore.get(EXPERIENCE_MIRROR_COOKIE)?.value,
          notice: true,
        });
        return res;
      }

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

      const res = NextResponse.redirect(`${redirectBase}${safeNext}`);
      if (decision && entersFullArea) {
        await writeExperienceCookies(res, {
          secure: request.nextUrl.protocol === "https:",
          visitorId,
          setVisitor: !isVisitorId(cookieVid),
          sign: decision.hasGrant
            ? { experience: "full", source: decision.source, mode: decision.mode, day: rolloutDay() }
            : null,
          cookieSecret: env.cookieSecret,
          display: decision.experience,
          displaySource: decision.experience === "full" ? decision.source : null,
          currentMirror: cookieStore.get(EXPERIENCE_MIRROR_COOKIE)?.value,
        });
      }
      return res;
    }
  }

  return NextResponse.redirect(`${redirectBase}/login?error=auth_error`);
}
