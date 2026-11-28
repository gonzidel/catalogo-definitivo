"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { gaEvent } from "@/lib/analytics/ga";
import { shouldUseProductionAnalytics } from "@/lib/analytics/hosts";
import { trackMetaCustom, trackMetaPageView } from "@/lib/analytics/meta";
import { ROLLOUT_UI_ENABLED } from "@/lib/rollout/client";
import {
  GA_BANNER_ATTR,
  GA_BANNER_LABEL_ATTR,
  GA_PRODUCT_ATTR,
  buildBannerClickEvent,
  buildBannerSwipeEvent,
  buildBannerViewEvent,
  buildProductClickEvent,
  isBannerSwipe,
  type BannerContext,
  type GaEventPayload,
} from "@/lib/analytics/catalog-interactions";

const GA_PROMO_ATTR = "data-ga-promo";
const BANNER_SELECTOR = `[${GA_BANNER_ATTR}]`;
const PRODUCT_SELECTOR = `[${GA_PRODUCT_ATTR}]`;
/** Controles dentro de una tarjeta que no abren el producto (puntos de color). */
const IGNORE_CLICK_SELECTOR = ".color-btn, .color-dot";
const VIEW_THRESHOLD = 0.5;

function isMeasuredPath(pathname: string): boolean {
  return !pathname.startsWith("/admin") && !pathname.startsWith("/dashboard");
}

/** gtag lo define GaLoader (afterInteractive) y puede llegar después de hidratar. */
function gtagReady(): boolean {
  return typeof (window as Window & { gtag?: unknown }).gtag === "function";
}

const GTAG_WAIT_MS = 250;
const GTAG_WAIT_MAX_TRIES = 40;

function bannerContext(el: Element): BannerContext | null {
  const slot = el.getAttribute(GA_BANNER_ATTR);
  if (!slot) return null;
  const all = Array.from(document.querySelectorAll(BANNER_SELECTOR));
  return {
    slot,
    label: el.getAttribute(GA_BANNER_LABEL_ATTR) ?? undefined,
    position: all.indexOf(el) + 1,
  };
}

function pathOf(href: string | null): string {
  if (!href) return "";
  try {
    return new URL(href, window.location.origin).pathname;
  } catch {
    return href;
  }
}

/**
 * Listener delegado de banners y productos. Se monta una vez en el layout;
 * los componentes solo exponen data-attributes (ver catalog-interactions.ts).
 * No cambia ninguna navegación ni estilo.
 */
let lastMeasuredPath = "";

function markRoute(pathname: string): void {
  if (!lastMeasuredPath || lastMeasuredPath === pathname) {
    lastMeasuredPath = pathname;
    return;
  }
  lastMeasuredPath = pathname;
  const pageKey = `${window.location.pathname}${window.location.search}`;
  const clarity = (window as Window & { clarity?: (...args: unknown[]) => void }).clarity;
  if (typeof clarity === "function") clarity("set", "page", pageKey);
  if (!shouldUseProductionAnalytics(window.location.hostname, ROLLOUT_UI_ENABLED)) return;
  trackMetaPageView(pageKey);
  gaEvent("page_view", {
    page_path: pageKey,
    page_location: window.location.href,
    page_title: document.title,
  });
}

export default function CatalogInteractionTracker() {
  const pathname = usePathname() ?? "/";
  const measured = isMeasuredPath(pathname);

  useEffect(() => {
    if (!measured) return;
    markRoute(pathname);

    const viewed = new Set<string>();
    const swiped = new Set<string>();
    const scrollStart = new WeakMap<Element, number>();

    // Si gtag todavía no existe, el evento espera en cola en lugar de perderse.
    const queue: GaEventPayload[] = [];
    let waitTimer: number | undefined;
    let tries = 0;

    const flush = () => {
      for (const p of queue.splice(0)) gaEvent(p.name, p.params);
    };

    const send = (payload: GaEventPayload | null) => {
      if (!payload) return;
      if (gtagReady()) {
        flush();
        gaEvent(payload.name, payload.params);
        return;
      }
      queue.push(payload);
      if (waitTimer !== undefined) return;
      waitTimer = window.setInterval(() => {
        tries += 1;
        if (gtagReady()) flush();
        if (gtagReady() || tries >= GTAG_WAIT_MAX_TRIES) {
          window.clearInterval(waitTimer);
          waitTimer = undefined;
          queue.length = 0;
        }
      }, GTAG_WAIT_MS);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const ctx = bannerContext(entry.target);
          if (!ctx || viewed.has(ctx.slot)) continue;
          viewed.add(ctx.slot);
          observer.unobserve(entry.target);
          send(buildBannerViewEvent(ctx));
        }
      },
      { threshold: VIEW_THRESHOLD }
    );

    const observeBanners = () => {
      document.querySelectorAll(BANNER_SELECTOR).forEach((el) => {
        const slot = el.getAttribute(GA_BANNER_ATTR);
        // Los banners en carga (skeleton) no cuentan como vistos.
        if (!slot || viewed.has(slot) || el.classList.contains("is-loading")) return;
        observer.observe(el);
      });
    };

    // Los banners llegan por SWR después del primer render.
    let pending = 0;
    const mutations = new MutationObserver(() => {
      window.clearTimeout(pending);
      pending = window.setTimeout(observeBanners, 150);
    });
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    observeBanners();

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(IGNORE_CLICK_SELECTOR)) return;

      const bannerEl = target.closest(BANNER_SELECTOR);
      const banner = bannerEl ? bannerContext(bannerEl) : null;
      const productEl = target.closest(PRODUCT_SELECTOR);

      if (productEl) {
        const scope = bannerEl ?? document;
        const cards = Array.from(scope.querySelectorAll(PRODUCT_SELECTOR)).filter(
          (el) => bannerEl || !el.closest(BANNER_SELECTOR)
        );
        const articulo = productEl.getAttribute(GA_PRODUCT_ATTR) ?? "";
        send(
          buildProductClickEvent({
            articulo,
            index: cards.indexOf(productEl) + 1,
            banner,
          })
        );
        if (banner && articulo.trim()) {
          trackMetaCustom("BannerProductClick", {
            banner: banner.slot,
            articulo: articulo.trim(),
          });
        }
        return;
      }

      if (banner) {
        const link = target.closest("a");
        const targetPath = pathOf(link?.getAttribute("href") ?? null);
        const promoName = link?.getAttribute(GA_PROMO_ATTR) ?? "";
        send(buildBannerClickEvent(banner, targetPath, promoName));
        if (targetPath) {
          trackMetaCustom("BannerClick", {
            banner: banner.slot,
            banner_target: targetPath,
            ...(promoName.trim() ? { promo_name: promoName.trim() } : {}),
          });
        }
      }
    };

    // En captura: Next/Link hace preventDefault() en la navegación cliente.
    document.addEventListener("click", onClick, true);

    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const bannerEl = target.closest(BANNER_SELECTOR);
      if (!bannerEl) return;
      const slot = bannerEl.getAttribute(GA_BANNER_ATTR);
      if (!slot || swiped.has(slot)) return;
      if (!scrollStart.has(target)) scrollStart.set(target, 0);
      if (!isBannerSwipe(scrollStart.get(target) ?? 0, target.scrollLeft)) return;
      const ctx = bannerContext(bannerEl);
      if (!ctx) return;
      swiped.add(slot);
      send(buildBannerSwipeEvent(ctx));
    };

    // scroll no burbujea: se escucha en captura sobre document.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });

    return () => {
      window.clearTimeout(pending);
      if (waitTimer !== undefined) window.clearInterval(waitTimer);
      observer.disconnect();
      mutations.disconnect();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [pathname, measured]);

  return null;
}
