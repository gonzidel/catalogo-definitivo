"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import cloudinaryLoader, {
  resolveImageSrc,
  cloudinaryPlaceholderSrc,
} from "@/lib/cloudinary";
import PdpLightbox, { type LightboxSlide } from "./PdpLightbox";
import type { ColorDetail } from "@/types/catalog";

interface PdpGalleryProps {
  allColors: ColorDetail[];
  activeColor: string;
  onColorChange: (color: string) => void;
  altText: string;
  onHeroSrcChange?: (src: string | null) => void;
  outOfStock?: boolean;
  onShareImage?: (url: string) => void;
  onDownloadImage?: (url: string) => void;
}

interface FlatImage {
  src: string;
  color: string;
  idx: number;
}

const HERO_PROBE_WIDTH = 800;
const HERO_LOAD_TIMEOUT_MS = 8000;

function heroProbeUrl(src: string): string {
  return cloudinaryLoader({ src, width: HERO_PROBE_WIDTH });
}

export default function PdpGallery({
  allColors,
  activeColor,
  onColorChange,
  altText,
  onHeroSrcChange,
  outOfStock = false,
  onShareImage,
  onDownloadImage,
}: PdpGalleryProps) {
  const flatImages: FlatImage[] = useMemo(() => {
    const result: FlatImage[] = [];
    for (const dc of allColors) {
      for (const img of dc.images) {
        if (!img) continue;
        const src = resolveImageSrc(img);
        if (src) result.push({ src, color: dc.color, idx: result.length });
      }
    }
    return result;
  }, [allColors]);

  const lightboxSlides: LightboxSlide[] = useMemo(
    () => flatImages.map(({ src, color }) => ({ src, color })),
    [flatImages]
  );

  const defaultIdx = useMemo(() => {
    const found = flatImages.findIndex(
      (f) => f.color.toLowerCase() === activeColor.toLowerCase()
    );
    return found >= 0 ? found : 0;
  }, [flatImages, activeColor]);

  const [activeIdx, setActiveIdx] = useState(defaultIdx);
  const [heroReady, setHeroReady] = useState(true);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const skipLoadFeedbackRef = useRef(true);
  const onHeroSrcChangeRef = useRef(onHeroSrcChange);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    onHeroSrcChangeRef.current = onHeroSrcChange;
  });

  useEffect(() => {
    setActiveIdx(defaultIdx);
  }, [defaultIdx]);

  const heroSrc = flatImages[activeIdx]?.src ?? flatImages[defaultIdx]?.src ?? null;
  const heroKey = heroSrc ? `${activeIdx}:${heroSrc}` : "";
  const placeholderSrc = heroSrc ? cloudinaryPlaceholderSrc(heroSrc) : "";

  useEffect(() => {
    if (!heroSrc) {
      onHeroSrcChangeRef.current?.(null);
      setHeroReady(true);
      return;
    }

    onHeroSrcChangeRef.current?.(heroSrc);

    if (skipLoadFeedbackRef.current) {
      skipLoadFeedbackRef.current = false;
      setHeroReady(true);
      return;
    }

    const gen = ++loadGenerationRef.current;
    setHeroReady(false);

    const markReady = () => {
      if (loadGenerationRef.current === gen) setHeroReady(true);
    };

    const url = heroProbeUrl(heroSrc);
    const probe = new window.Image();
    probe.decoding = "async";

    const onProbeDone = () => markReady();
    probe.addEventListener("load", onProbeDone);
    probe.addEventListener("error", onProbeDone);
    probe.src = url;

    if (probe.complete) markReady();

    const fallback = window.setTimeout(markReady, HERO_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(fallback);
      probe.removeEventListener("load", onProbeDone);
      probe.removeEventListener("error", onProbeDone);
    };
  }, [heroSrc]);

  const syncFromIndex = useCallback(
    (idx: number) => {
      const img = flatImages[idx];
      if (!img) return;
      setActiveIdx(idx);
      onColorChange(img.color);
    },
    [flatImages, onColorChange]
  );

  const handleLightboxClose = useCallback(
    (finalIndex: number) => {
      setLightboxOpen(false);
      syncFromIndex(finalIndex);
    },
    [syncFromIndex]
  );

  const handleLightboxNavigate = useCallback(
    (idx: number) => {
      syncFromIndex(idx);
    },
    [syncFromIndex]
  );

  const openLightbox = () => {
    if (!heroSrc || !heroReady) return;
    setLightboxOpen(true);
  };

  if (flatImages.length === 0) return null;

  const handleThumb = (img: FlatImage) => {
    if (img.idx === activeIdx) return;
    setActiveIdx(img.idx);
    onColorChange(img.color);
  };

  const heroLoading = Boolean(heroSrc && !heroReady);

  return (
    <>
      <div className="pdp-gallery">
        <button
          type="button"
          className="pdp-main-image-wrap"
          aria-label="Tocar para ampliar imagen"
          aria-busy={heroLoading}
          disabled={!heroReady}
          onClick={openLightbox}
        >
          {heroSrc && heroLoading && placeholderSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={placeholderSrc}
              alt=""
              aria-hidden
              className="pdp-hero-placeholder"
              decoding="async"
            />
          )}

          {heroSrc ? (
            <Image
              key={heroKey}
              src={heroSrc}
              alt={altText}
              fill
              sizes="(max-width: 480px) 100vw, (max-width: 1024px) 60vw, 50vw"
              className={`pdp-hero-image pdp-main-image product-modal-main-image${heroReady ? " is-ready" : ""}`}
              style={{ pointerEvents: "none" }}
              priority={activeIdx === defaultIdx}
              onLoad={() => setHeroReady(true)}
              onError={() => setHeroReady(true)}
            />
          ) : (
            <div className="skeleton-shimmer pdp-hero-skeleton" aria-hidden />
          )}

          {heroLoading && (
            <div className="pdp-hero-loading" aria-hidden>
              <div className="spinner" />
            </div>
          )}

          {outOfStock && (
            <div className="pdp-stock-overlay" aria-hidden="true">
              <span className="pdp-stock-overlay__label">Agotado</span>
            </div>
          )}
        </button>

        {flatImages.length > 1 && (
          <div
            className="pdp-thumbnails"
            style={{
              display: "flex",
              gap: 8,
              marginTop: 8,
              overflowX: "auto",
              padding: "4px 0",
            }}
          >
            {flatImages.map((img) => {
              const isActive = img.idx === activeIdx;
              const isLoadingThumb = isActive && heroLoading;
              return (
                <button
                  key={img.idx}
                  type="button"
                  onClick={() => handleThumb(img)}
                  className={[
                    "pdp-thumb-btn",
                    isActive ? "is-active" : "",
                    isLoadingThumb ? "is-loading" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-label={`${img.color} imagen ${img.idx + 1}`}
                  aria-pressed={isActive}
                  aria-busy={isLoadingThumb}
                >
                  <Image
                    src={img.src}
                    alt={img.color}
                    fill
                    sizes="60px"
                    style={{ objectFit: "cover" }}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <PdpLightbox
        open={lightboxOpen}
        slides={lightboxSlides}
        index={activeIdx}
        altText={altText}
        onClose={handleLightboxClose}
        onIndexChange={handleLightboxNavigate}
        onShare={onShareImage}
        onDownload={onDownloadImage}
      />
    </>
  );
}
