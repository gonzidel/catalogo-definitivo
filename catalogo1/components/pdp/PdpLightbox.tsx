"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lightboxImageUrl } from "@/lib/cloudinary";

export interface LightboxSlide {
  /** src base para cloudinary loader */
  src: string;
  color: string;
}

interface PdpLightboxProps {
  open: boolean;
  slides: LightboxSlide[];
  index: number;
  altText: string;
  onClose: (finalIndex: number) => void;
  onIndexChange?: (index: number) => void;
  onShare?: (url: string) => void;
  onDownload?: (url: string) => void;
}

const ICON_SHARE = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
);

const ICON_DOWNLOAD = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const ICON_CLOSE = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const ICON_PREV = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const ICON_NEXT = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

export default function PdpLightbox({
  open,
  slides,
  index,
  altText,
  onClose,
  onIndexChange,
  onShare,
  onDownload,
}: PdpLightboxProps) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(index);
  const [swapping, setSwapping] = useState(false);
  const [currentUrl, setCurrentUrl] = useState("");

  const pushedHistoryRef = useRef(false);
  const consumingHistoryRef = useRef(false);
  const openRef = useRef(open);
  const touchRef = useRef<{ x0: number; y0: number; t0: number } | null>(null);
  const preloadedRef = useRef(new Set<string>());
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  openRef.current = open;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (open) setCurrentIndex(index);
  }, [open, index]);

  const total = slides.length;
  const showNav = total > 1;

  const preloadNeighbors = useCallback(
    (idx: number) => {
      if (total <= 1) return;
      const nextI = (idx + 1) % total;
      const prevI = (idx - 1 + total) % total;
      for (const i of [nextI, prevI]) {
        const url = lightboxImageUrl(slides[i]?.src ?? "");
        if (!url || preloadedRef.current.has(url)) continue;
        const im = new window.Image();
        im.decoding = "async";
        im.src = url;
        preloadedRef.current.add(url);
      }
    },
    [slides, total]
  );

  const go = useCallback(
    (delta: number) => {
      if (total <= 1) return;
      setCurrentIndex((prev) => {
        const next = (prev + delta + total) % total;
        onIndexChange?.(next);
        return next;
      });
    },
    [total, onIndexChange]
  );

  const finishClose = useCallback(
    (finalIndex: number) => {
      setLeaving(false);
      setVisible(false);
      document.body.classList.remove("pdp-lightbox-open");
      pushedHistoryRef.current = false;
      onClose(finalIndex);
    },
    [onClose]
  );

  const requestClose = useCallback(() => {
    if (!openRef.current) return;
    setLeaving(true);
    document.body.classList.remove("pdp-lightbox-open");
    window.setTimeout(() => finishClose(currentIndex), 220);
  }, [currentIndex, finishClose]);

  useEffect(() => {
    if (!open || !slides.length) return;
    const url = lightboxImageUrl(slides[currentIndex]?.src ?? "");
    setCurrentUrl((prev) => {
      if (wasOpenRef.current && url !== prev) setSwapping(true);
      return url;
    });
    preloadNeighbors(currentIndex);
    wasOpenRef.current = true;
  }, [open, currentIndex, slides, preloadNeighbors]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }

    document.body.classList.add("pdp-lightbox-open");
    if (!localStorage.getItem("fyl_pdp_lightbox_hint_seen")) {
      localStorage.setItem("fyl_pdp_lightbox_hint_seen", "1");
      document.body.setAttribute("data-pdp-lightbox-seen", "1");
    }

    requestAnimationFrame(() => setVisible(true));
    pushedHistoryRef.current = true;
    history.pushState({ pdpLightbox: true }, "");

    const onPopState = () => {
      if (!openRef.current) return;
      consumingHistoryRef.current = true;
      requestClose();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };

    window.addEventListener("popstate", onPopState);
    window.addEventListener("keydown", onKey);

    const t = window.setTimeout(() => closeBtnRef.current?.focus({ preventScroll: true }), 280);

    return () => {
      window.clearTimeout(t);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("pdp-lightbox-open");
    };
  }, [open, go, requestClose]);

  const handleCloseClick = () => {
    if (pushedHistoryRef.current && !consumingHistoryRef.current) {
      consumingHistoryRef.current = true;
      history.back();
      return;
    }
    consumingHistoryRef.current = false;
    requestClose();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".pdp-lightbox-image")) return;
    handleCloseClick();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    touchRef.current = { x0: t.clientX, y0: t.clientY, t0: Date.now() };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x0;
    const dy = t.clientY - start.y0;
    const dt = Date.now() - start.t0;
    if (Math.abs(dx) > 50 && Math.abs(dy) < 60 && dt < 600) {
      go(dx < 0 ? 1 : -1);
    }
  };

  if (!mounted || !open) return null;

  return createPortal(
    <div
      id="pdp-lightbox-root"
      className={[
        "pdp-lightbox",
        visible && !leaving ? "pdp-lightbox--open" : "",
        leaving ? "pdp-lightbox--leave" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="dialog"
      aria-modal="true"
      aria-label="Imagen ampliada del producto"
      aria-hidden={!visible}
      onClick={handleBackdropClick}
    >
      <div className="pdp-lightbox__backdrop" aria-hidden="true" />

      <div className="pdp-lightbox__toolbar" role="toolbar" aria-label="Acciones de imagen">
        {onShare && (
          <button
            type="button"
            className="pdp-lightbox-btn pdp-lightbox-btn--share"
            aria-label="Compartir foto"
            onClick={(e) => {
              e.stopPropagation();
              if (currentUrl) onShare(currentUrl);
            }}
          >
            {ICON_SHARE}
          </button>
        )}
        {onDownload && (
          <button
            type="button"
            className="pdp-lightbox-btn pdp-lightbox-btn--download"
            aria-label="Descargar foto"
            onClick={(e) => {
              e.stopPropagation();
              if (currentUrl) onDownload(currentUrl);
            }}
          >
            {ICON_DOWNLOAD}
          </button>
        )}
        <button
          ref={closeBtnRef}
          type="button"
          className="pdp-lightbox-btn pdp-lightbox-btn--close"
          aria-label="Cerrar imagen"
          onClick={(e) => {
            e.stopPropagation();
            handleCloseClick();
          }}
        >
          {ICON_CLOSE}
        </button>
      </div>

      {showNav && (
        <>
          <button
            type="button"
            className="pdp-lightbox-nav pdp-lightbox-nav--prev"
            aria-label="Imagen anterior"
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
          >
            {ICON_PREV}
          </button>
          <button
            type="button"
            className="pdp-lightbox-nav pdp-lightbox-nav--next"
            aria-label="Imagen siguiente"
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
          >
            {ICON_NEXT}
          </button>
        </>
      )}

      <div
        className="pdp-lightbox-stage"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={() => {
          touchRef.current = null;
        }}
      >
        {currentUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={currentUrl}
            className={`pdp-lightbox-image${swapping ? " is-swapping" : ""}`}
            src={currentUrl}
            alt={altText}
            decoding="async"
            draggable={false}
            onLoad={() => setSwapping(false)}
            onError={() => setSwapping(false)}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>

      {showNav && (
        <div className="pdp-lightbox-counter" aria-live="polite">
          {currentIndex + 1} / {total}
        </div>
      )}
    </div>,
    document.body
  );
}
