import type { CatalogImage } from "@/types/catalog";

const CLOUD_NAME = "dnuedzuzm";

/** Anchos canónicos = named transformations en Cloudinary (t_fyl_*). */
const FYL_WIDTHS = [64, 200, 384, 400, 800, 1200] as const;
const FYL_NAMED: Record<(typeof FYL_WIDTHS)[number], string> = {
  64: "fyl_mini",
  200: "fyl_thumb",
  384: "fyl_sm",
  400: "fyl_card",
  800: "fyl_pdp",
  1200: "fyl_hero",
};

function snapFylWidth(width: number): (typeof FYL_WIDTHS)[number] {
  for (const w of FYL_WIDTHS) {
    if (width <= w) return w;
  }
  return 1200;
}

function fylDeliveryTransform(width: number, quality?: number | string): string {
  const w = snapFylWidth(width);
  const q = quality ?? "auto";
  return `t_${FYL_NAMED[w]}/f_auto/q_${q}`;
}

function withUploadTransform(src: string, transform: string): string {
  if (src.startsWith("http") || src.startsWith("//")) {
    const clean = src.startsWith("//") ? `https:${src}` : src;
    if (!clean.includes("res.cloudinary.com")) return clean;
    return clean.replace("/upload/", `/upload/${transform}/`);
  }
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${transform}/${src}`;
}

// ─── Next.js custom image loader ─────────────────────────────────────────────
// Used in next.config.ts as `loaderFile: "./lib/cloudinary.ts"`
// Exported as default — Next.js calls this at build + runtime

export default function cloudinaryLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}): string {
  return withUploadTransform(src, fylDeliveryTransform(width, quality));
}

// ─── Helpers for use outside next/image ─────────────────────────────────────

export function cloudinaryUrl(publicId: string, width: number): string {
  return withUploadTransform(publicId, fylDeliveryTransform(width));
}

export function cloudinaryUrlFromLegacy(url: string, width: number): string {
  if (!url || typeof url !== "string") return "";
  return withUploadTransform(url, fylDeliveryTransform(width));
}

/**
 * Resolves a CatalogImage (string URL, { public_id }, or null)
 * to an optimized URL string.
 */
export function resolveImageUrl(img: CatalogImage, width: number): string {
  if (!img) return "";
  if (typeof img === "string") {
    if (img.includes("res.cloudinary.com")) return cloudinaryUrlFromLegacy(img, width);
    return img;
  }
  if (img.public_id) return cloudinaryUrl(img.public_id, width);
  const url = img.url ?? img.secure_url ?? "";
  if (url.includes("res.cloudinary.com")) return cloudinaryUrlFromLegacy(url, width);
  return url;
}

/**
 * Returns the `src` value to pass to next/image.
 * - public_id images: return the public_id (loader handles the URL)
 * - legacy URL images: return the full URL (loader handles transform)
 * - null/undefined: return empty string
 */
export function resolveImageSrc(img: CatalogImage): string {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (img.public_id) return img.public_id;
  return img.url ?? img.secure_url ?? "";
}

/** URL alta resolución para lightbox PDP (~pantalla completa). */
export function lightboxImageUrl(src: string): string {
  if (!src) return "";
  return cloudinaryLoader({ src, width: 1200 });
}

/** Miniatura muy liviana + blur para feedback instantáneo en PDP al cambiar foto. */
export function cloudinaryPlaceholderSrc(src: string): string {
  if (!src) return "";
  return withUploadTransform(src, "t_fyl_blur/f_auto");
}
