/**
 * URL absoluta post-login para Supabase (OAuth / magic link).
 * Debe existir igual en Supabase → Authentication → URL Configuration → Redirect URLs.
 */

const PRE_AUTH_PAGE_KEY = "fyl_pre_auth_page";
const PRE_AUTH_HASH_KEY = "fyl_pre_auth_hash";

const ALLOWED_RETURN_PATHS = new Set([
  "/index.html",
  "/client/dashboard.html",
  "/client/complete-profile.html",
  "/client/profile.html",
]);

function isLocalDevHost(hostname) {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  if (hostname.startsWith("192.168.")) return true;
  if (hostname.startsWith("10.")) return true;
  const m = hostname.match(/^172\.(\d{1,3})\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function logLocalhostHint(redirectUrl) {
  try {
    const h = window.location.hostname;
    if (!isLocalDevHost(h)) return;
    console.info(
      "%c[FYL Auth]%c redirectTo / emailRedirectTo:\n%s\n\nSi terminás en catalogo-fyl-test.web.app, Supabase rechazó esta URL: agregala en Authentication → URL Configuration → Redirect URLs (o usá wildcard %s/**).",
      "color:#CD844D;font-weight:bold",
      "color:inherit",
      redirectUrl,
      window.location.origin
    );
  } catch (_) {
    /* ignore */
  }
}

/** Una vez por pestaña: recordatorio de URLs a dar de alta en Supabase (dev). */
export function remindSupabaseRedirectUrlsIfLocal() {
  if (typeof window === "undefined") return;
  const h = window.location.hostname;
  if (!isLocalDevHost(h)) return;
  try {
    if (sessionStorage.getItem("fyl_supabase_redirect_reminder")) return;
    sessionStorage.setItem("fyl_supabase_redirect_reminder", "1");
  } catch (_) {
    /* ignore */
  }
  const o = window.location.origin;
  console.warn(
    `[FYL Dev] Si al loguearte vas a producción (web.app), en Supabase → Authentication → URL configuration → Redirect URLs agregá:\n` +
      `  • ${o}/index.html\n` +
      `  • ${o}/client/dashboard.html\n` +
      `  • o wildcard: ${o}/**   (cubre ambas y login.html)\n` +
      `Repetí lo mismo si a veces abrís con 127.0.0.1 en lugar de localhost (otro origen).`
  );
}

/**
 * Antes de abrir Google / enviar magic link: guarda hash (#/) del catálogo para restaurarlo
 * después del callback (Supabase suele dejar la URL sin fragmento).
 */
export function savePreAuthReturnTarget() {
  if (typeof window === "undefined") return;
  try {
    const path = (window.location.pathname || "").replace(/\\/g, "/");
    if (path.endsWith("/index.html") || path.endsWith("index.html") || path === "/") {
      sessionStorage.setItem(PRE_AUTH_PAGE_KEY, "index");
      sessionStorage.setItem(PRE_AUTH_HASH_KEY, window.location.hash || "#/");
      return;
    }
    if (path.includes("/client/dashboard") || /\/dashboard\.html$/i.test(path)) {
      sessionStorage.setItem(PRE_AUTH_PAGE_KEY, "dashboard");
      sessionStorage.removeItem(PRE_AUTH_HASH_KEY);
    }
  } catch (_) {
    /* ignore */
  }
}

export function restorePostAuthNavigation() {
  if (typeof window === "undefined") return;
  try {
    const path = (window.location.pathname || "").replace(/\\/g, "/");
    const was = sessionStorage.getItem(PRE_AUTH_PAGE_KEY);
    if (was === "index" && (path === "/" || path.endsWith("/index.html") || path.endsWith("index.html"))) {
      const savedHash = sessionStorage.getItem(PRE_AUTH_HASH_KEY) || "#/";
      sessionStorage.removeItem(PRE_AUTH_PAGE_KEY);
      sessionStorage.removeItem(PRE_AUTH_HASH_KEY);
      if (!window.location.hash && savedHash) {
        window.history.replaceState(
          null,
          "",
          path + (window.location.search || "") + savedHash
        );
        try {
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        } catch (_) {
          window.dispatchEvent(new Event("hashchange"));
        }
      }
    } else if (was === "dashboard") {
      sessionStorage.removeItem(PRE_AUTH_PAGE_KEY);
      sessionStorage.removeItem(PRE_AUTH_HASH_KEY);
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * Desde client/login.html: ?return=dashboard guarda el destino tras OAuth.
 */
export function initLoginPageReturnPath() {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("return") === "dashboard") {
      sessionStorage.setItem("fyl_oauth_return_path", "/client/dashboard.html");
    }
  } catch (_) {
    /* ignore */
  }
}

export function clearOAuthReturnPath() {
  try {
    sessionStorage.removeItem("fyl_oauth_return_path");
  } catch (_) {
    /* ignore */
  }
}

export function getPostLoginRedirectUrl() {
  if (typeof window === "undefined") return "";
  const origin = window.location.origin;
  console.log("[FYL DEBUG AUTH] getPostLoginRedirectUrl origin =", origin);
  const path = (window.location.pathname || "").replace(/\\/g, "/");

  if (path.includes("/client/dashboard") || /\/dashboard\.html$/i.test(path)) {
    const url = `${origin}/client/dashboard.html`;
    logLocalhostHint(url);
    return url;
  }

  if (path.includes("/client/login") || /\/login\.html$/i.test(path)) {
    const stored = sessionStorage.getItem("fyl_oauth_return_path");
    if (stored && ALLOWED_RETURN_PATHS.has(stored)) {
      const url = `${origin}${stored}`;
      logLocalhostHint(url);
      return url;
    }
    const url = `${origin}/index.html`;
    logLocalhostHint(url);
    return url;
  }

  const url = `${origin}/index.html`;
  logLocalhostHint(url);
  return url;
}
