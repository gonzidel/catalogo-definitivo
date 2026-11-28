/**
 * Meta Pixel en NJ. El script lo carga MetaPixelLoader solo en www.
 * Si fbq todavía no existe, un reintento corto cubre la carrera de carga.
 */

type Fbq = (...args: unknown[]) => void;

function fbqFn(): Fbq | null {
  if (typeof window === "undefined") return null;
  const fbq = (window as Window & { fbq?: Fbq }).fbq;
  return typeof fbq === "function" ? fbq : null;
}

function sendOrRetry(send: () => boolean): void {
  if (send()) return;
  window.setTimeout(send, 300);
}

/** Evento propio, el mismo tipo que BannerProductClick del catálogo anterior. */
export function trackMetaCustom(eventName: string, params: Record<string, string>): void {
  const name = eventName.trim();
  if (!name) return;
  sendOrRetry(() => {
    const fbq = fbqFn();
    if (!fbq) return false;
    fbq("trackCustom", name, params);
    return true;
  });
}

let lastPageKey = "";

/** PageView de una navegación interna. No repite la URL que ya se midió. */
export function trackMetaPageView(pageKey: string): void {
  if (!pageKey || pageKey === lastPageKey) return;
  lastPageKey = pageKey;
  sendOrRetry(() => {
    const fbq = fbqFn();
    if (!fbq) return false;
    fbq("track", "PageView");
    return true;
  });
}
