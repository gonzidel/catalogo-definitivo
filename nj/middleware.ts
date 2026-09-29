import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { stripPublicAppPrefix } from "@/lib/site-url";
import {
  EXPERIENCE_COOKIE,
  EXPERIENCE_MIRROR_COOKIE,
  VISITOR_COOKIE,
} from "@/lib/rollout/constants";
import { verifyExperience, type SignedExperience } from "@/lib/rollout/cookie";
import { rolloutDay } from "@/lib/rollout/day";
import {
  canEnterFullArea,
  displayExperience,
  evaluateSigned,
  isVisitorId,
  shouldResolve,
} from "@/lib/rollout/decide";
import {
  isBotUserAgent,
  isCanonicalHost,
  isDocumentNavigation,
  isLegacyCatalogoPath,
  isNjDoorPath,
  mapLegacyCatalogoPath,
} from "@/lib/rollout/request";
import { markNoindex, writeExperienceCookies } from "@/lib/rollout/response";
import { isLegacyLandingPath } from "@/lib/rollout/legacy-hosting";
import {
  getRolloutMode,
  isRolloutMisconfigured,
  isStaffUser,
  readRolloutEnv,
  resolveExperience,
  type RolloutEnv,
} from "@/lib/rollout/server";

type CookieToSet = { name: string; value: string; options?: Parameters<NextResponse["cookies"]["set"]>[2] };

/** Cliente Supabase de sesión (anon). getUser() se ejecuta como mucho una vez por request. */
function createAuthSession(request: NextRequest) {
  const pending: CookieToSet[] = [];
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          pending.push(...cookiesToSet);
        },
      },
    }
  );
  let userId: Promise<string | null> | null = null;
  return {
    getUserId(): Promise<string | null> {
      userId ??= supabase.auth
        .getUser()
        .then(({ data }) => data.user?.id ?? null)
        .catch(() => null);
      return userId;
    },
    hasAuthCookie(): boolean {
      return request.cookies
        .getAll()
        .some((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"));
    },
    apply<T extends NextResponse>(res: T): T {
      pending.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      return res;
    },
  };
}

function isAuthGatedPath(pathname: string) {
  return (
    pathname.startsWith("/dashboard") || pathname.startsWith("/admin") || pathname === "/login"
  );
}

/** Rollout apagado: exactamente el comportamiento previo de nj. */
async function legacyMiddleware(request: NextRequest) {
  const pathname = stripPublicAppPrefix(request.nextUrl.pathname);
  if (!isAuthGatedPath(pathname)) return NextResponse.next();

  const auth = createAuthSession(request);
  const userId = await auth.getUserId();
  const prefix = pathname === request.nextUrl.pathname ? "" : "/nj";

  if ((pathname.startsWith("/dashboard") || pathname.startsWith("/admin")) && !userId) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = `${prefix}/login`;
    loginUrl.searchParams.set("next", pathname);
    return auth.apply(NextResponse.redirect(loginUrl));
  }

  if (pathname === "/login" && userId) {
    const dashUrl = request.nextUrl.clone();
    dashUrl.pathname = `${prefix}/dashboard`;
    dashUrl.searchParams.delete("next");
    return auth.apply(NextResponse.redirect(dashUrl));
  }

  return auth.apply(NextResponse.next({ request }));
}

function redirectTo(request: NextRequest, pathname: string, keepSearch = true) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  if (!keepSearch) url.search = "";
  return NextResponse.redirect(url, 302);
}

function redirectToLogin(request: NextRequest, next: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", next);
  return NextResponse.redirect(url, 302);
}

async function rolloutMiddleware(request: NextRequest, env: RolloutEnv) {
  const rawPath = request.nextUrl.pathname;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const noindex = !isCanonicalHost(host);
  const finish = <T extends NextResponse>(res: T): T => (noindex ? markNoindex(res) : res);

  if (isLegacyCatalogoPath(rawPath)) {
    return finish(redirectTo(request, mapLegacyCatalogoPath(rawPath)));
  }
  if (rawPath.startsWith("/auth/") || rawPath.startsWith("/nj/auth/") || isLegacyLandingPath(rawPath)) {
    return finish(NextResponse.next());
  }

  const door = isNjDoorPath(rawPath);
  const pathname = stripPublicAppPrefix(rawPath);
  const auth = createAuthSession(request);

  if (pathname.startsWith("/admin")) {
    if (door) return finish(redirectTo(request, pathname));
    if (!(await auth.getUserId())) {
      return finish(auth.apply(redirectToLogin(request, pathname)));
    }
    return finish(auth.apply(NextResponse.next({ request })));
  }

  const misconfigured = isRolloutMisconfigured(env);
  if (misconfigured) console.error("[rollout] NEXT_PUBLIC_ROLLOUT_ENABLED sin SUPABASE_SERVICE_ROLE_KEY / ROLLOUT_COOKIE_SECRET válidos");

  const bot = isBotUserAgent(request.headers.get("user-agent"));
  const docNav = isDocumentNavigation(request.method, request.headers);
  const today = rolloutDay();
  const cookieVid = request.cookies.get(VISITOR_COOKIE)?.value;
  const knownVisitor = isVisitorId(cookieVid);
  const visitorId = knownVisitor ? cookieVid : crypto.randomUUID();
  let mode = misconfigured ? "paused" : await getRolloutMode(env);

  const signed = misconfigured
    ? null
    : await verifyExperience(env.cookieSecret, visitorId, request.cookies.get(EXPERIENCE_COOKIE)?.value);
  const { usable, fresh } = evaluateSigned(signed, today, mode);
  let current: SignedExperience | null = usable ? signed : null;
  let sign: SignedExperience | null = null;

  const gated = pathname.startsWith("/dashboard") || pathname === "/login";
  const needsUser = gated || (auth.hasAuthCookie() && (!current || !fresh || door));
  const userId = needsUser ? await auth.getUserId() : null;

  if (env.forceExperience) {
    current = { experience: env.forceExperience, source: env.forceExperience === "full" ? "manual" : null, day: today };
  } else if (
    !misconfigured &&
    shouldResolve({
      mode,
      current,
      fresh,
      door,
      bot,
      eligibleRequest: docNav || door || (gated && Boolean(userId)),
    })
  ) {
    try {
      const decision = await resolveExperience(env, {
        visitorId,
        authUserId: userId,
        testerLink: door,
      });
      if (decision.reason === "kill") {
        // Cache de modo desfasado: la base ya está en kill. No firmar catalog sobre un grant.
        mode = "kill";
        if (decision.hasGrant) {
          current = { experience: "full", source: decision.source, day: today };
          sign = current;
        }
      } else {
        current = { experience: decision.experience, source: decision.source, day: today };
        sign = current;
      }
    } catch (err) {
      console.error("[rollout] resolve failed", err);
      // Sin respuesta: un full firmado (aunque vencido para revalidar) se respeta; si no, catalog sin firmar.
    }
  }

  const display = displayExperience(mode, current);
  const withCookies = async <T extends NextResponse>(res: T, notice = false): Promise<T> => {
    if (!bot) {
      await writeExperienceCookies(res, {
        secure: request.nextUrl.protocol === "https:",
        visitorId,
        setVisitor: !knownVisitor && (docNav || door || Boolean(sign)),
        sign,
        cookieSecret: env.cookieSecret,
        display,
        displaySource: display === "full" ? current?.source ?? null : null,
        currentMirror: request.cookies.get(EXPERIENCE_MIRROR_COOKIE)?.value,
        notice,
      });
    }
    return finish(auth.apply(res));
  };

  if (door) {
    return markNoindex(await withCookies(redirectTo(request, pathname)));
  }

  const fullAreaAllowed = async (uid: string) =>
    canEnterFullArea(mode, current, mode === "kill" && (await isStaffUser(env, uid)));

  if (pathname.startsWith("/dashboard")) {
    if (!userId) {
      return withCookies(redirectToLogin(request, pathname + request.nextUrl.search));
    }
    if (!(await fullAreaAllowed(userId))) {
      return withCookies(redirectTo(request, "/", false), true);
    }
  }

  if (pathname === "/login" && userId) {
    return (await fullAreaAllowed(userId))
      ? withCookies(redirectTo(request, "/dashboard", false))
      : withCookies(redirectTo(request, "/", false), true);
  }

  return withCookies(NextResponse.next({ request }));
}

export async function middleware(request: NextRequest) {
  const env = readRolloutEnv();
  if (!env.enabled) return legacyMiddleware(request);
  return rolloutMiddleware(request, env);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|api/|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.[a-zA-Z0-9]{2,5}$).*)",
  ],
};
