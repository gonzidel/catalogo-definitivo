"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { gaEvent } from "@/lib/analytics/ga";
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
export default function CatalogInteractionTracker() {
  const pathname = usePathname() ?? "/";
  const measured = isMeasuredPath(pathname);

  useEffect(() => {
    if (!measured) return;

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
        send(
          buildProductClickEvent({
            articulo: productEl.getAttribute(GA_PRODUCT_ATTR) ?? "",
            index: cards.indexOf(productEl) + 1,
            banner,
          })
        );
        return;
      }

      if (banner) {
        const link = target.closest("a");
        send(buildBannerClickEvent(banner, pathOf(link?.getAttribute("href") ?? null)));
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
