export const CANONICAL_SITE_URL = "https://www.fylmoda.com.ar";
export const DASHBOARD_ACTIVE_ORDER_PATH = "/dashboard?tab=active-order";
/** Link absoluto en WhatsApp / mensajes copiados. Por ahora el deploy de testeo. */
export const CUSTOMER_DASHBOARD_MESSAGE_URL =
  "https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart";

export function getSiteUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return CANONICAL_SITE_URL;
}

export function getPublicAppPrefix(pathname?: string): string {
  const path =
    pathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
  if (path === "/nj" || path.startsWith("/nj/")) return "/nj";
  return "";
}

export function getBrowserOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return getSiteUrl();
}

export function getDashboardActiveOrderPath(pathname?: string): string {
  return `${getPublicAppPrefix(pathname)}${DASHBOARD_ACTIVE_ORDER_PATH}`;
}

export function getDashboardActiveOrderUrl(_pathname?: string): string {
  const fromEnv = process.env.NEXT_PUBLIC_CUSTOMER_DASHBOARD_URL?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return CUSTOMER_DASHBOARD_MESSAGE_URL;
}

export function getAuthCallbackUrl(next: string, pathname?: string): string {
  const prefix = getPublicAppPrefix(pathname);
  const pfx = prefix === "/nj" ? "nj" : "";
  const qs = new URLSearchParams({ next });
  if (pfx) qs.set("pfx", pfx);
  return `${getBrowserOrigin()}${prefix}/auth/callback?${qs.toString()}`;
}

export function resolveAuthRedirectBase(input: {
  nextUrlPathname: string;
  requestUrl: string;
  forwardedHost: string | null;
  forwardedProto: string | null;
  host: string | null;
  pfx?: string | null;
}): string {
  const proto = input.forwardedProto || "https";
  const host = input.forwardedHost || input.host;
  const origin = host ? `${proto}://${host}` : new URL(input.requestUrl).origin;
  if (input.pfx === "nj" || getPublicAppPrefix(input.nextUrlPathname) === "/nj") {
    return `${origin}/nj`;
  }
  const incomingPath = new URL(input.requestUrl).pathname;
  if (incomingPath === "/nj" || incomingPath.startsWith("/nj/")) {
    return `${origin}/nj`;
  }
  return origin;
}

export function stripPublicAppPrefix(pathname: string): string {
  if (pathname === "/nj") return "/";
  if (pathname.startsWith("/nj/")) return pathname.slice(3) || "/";
  return pathname;
}
