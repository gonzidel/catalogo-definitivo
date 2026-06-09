"use client";

import { useState, useMemo, useEffect } from "react";
import Image from "next/image";
import { resolveImageSrc } from "@/lib/cloudinary";
import type { ColorDetail } from "@/types/catalog";

interface PdpGalleryProps {
  allColors: ColorDetail[];
  activeColor: string;
  onColorChange: (color: string) => void;
  altText: string;
  onHeroSrcChange?: (src: string | null) => void;
}

interface FlatImage {
  src: string;
  color: string;
  idx: number; // global index in the flat list
}

export default function PdpGallery({
  allColors,
  activeColor,
  onColorChange,
  altText,
  onHeroSrcChange,
}: PdpGalleryProps) {
  // Flatten ALL images from ALL color variants into a single list
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

  // Default active thumbnail = first image of active color
  const defaultIdx = useMemo(() => {
    const found = flatImages.findIndex(
      (f) => f.color.toLowerCase() === activeColor.toLowerCase()
    );
    return found >= 0 ? found : 0;
  }, [flatImages, activeColor]);

  const [activeIdx, setActiveIdx] = useState(defaultIdx);

  // Sync internal activeIdx whenever the active color changes externally
  // (e.g. user clicks a color dot in PdpColorPicker).
  useEffect(() => {
    setActiveIdx(defaultIdx);
  }, [defaultIdx]);

  const heroSrc = flatImages[activeIdx]?.src ?? flatImages[defaultIdx]?.src ?? null;

  // Notify parent of current hero src so the download button can use it
  useEffect(() => { onHeroSrcChange?.(heroSrc); }, [heroSrc, onHeroSrcChange]);

  if (flatImages.length === 0) return null;

  const handleThumb = (img: FlatImage) => {
    setActiveIdx(img.idx);
    onColorChange(img.color);
  };

  return (
    <div className="pdp-gallery">
      {/* Hero image */}
      <div
        className="pdp-hero-wrapper"
        style={{ position: "relative", width: "100%", aspectRatio: "4 / 5" }}
      >
        {heroSrc ? (
          <Image
            src={heroSrc}
            alt={altText}
            fill
            sizes="(max-width: 480px) 100vw, (max-width: 1024px) 60vw, 50vw"
            style={{ objectFit: "cover", objectPosition: "center", borderRadius: 6 }}
            priority
          />
        ) : (
          <div
            className="skeleton-shimmer"
            style={{ width: "100%", height: "100%", borderRadius: 6 }}
          />
        )}
      </div>

      {/* All images as thumbnails — scroll horizontal */}
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
            return (
              <button
                key={img.idx}
                onClick={() => handleThumb(img)}
                style={{
                  flexShrink: 0,
                  width: 60,
                  height: 75,
                  padding: 0,
                  border: isActive ? "2px solid #CD844D" : "2px solid transparent",
                  borderRadius: 4,
                  overflow: "hidden",
                  cursor: "pointer",
                  background: "#f5f5f5",
                  position: "relative",
                }}
                aria-label={`${img.color} imagen ${img.idx + 1}`}
                aria-pressed={isActive}
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
  );
}
