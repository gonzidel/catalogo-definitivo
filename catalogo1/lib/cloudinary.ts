import type { CatalogImage } from "@/types/catalog";

const CLOUD_NAME = "dnuedzuzm";

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
  const q = quality ?? "auto";
  // If src is already a full URL (legacy), transform the /upload/ segment
  if (src.startsWith("http")) {
    return src.replace(
      "/upload/",
      `/upload/f_auto,q_${q},c_scale,w_${width}/`
    );
  }
  // Otherwise treat as public_id
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_auto,q_${q},c_scale,w_${width}/${src}`;
}

// ─── Helpers for use outside next/image ─────────────────────────────────────

export function cloudinaryUrl(publicId: string, width: number): string {
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_auto,q_auto,c_scale,w_${width}/${publicId}`;
}

export function cloudinaryUrlFromLegacy(url: string, width: number): string {
  if (!url || typeof url !== "string") return "";
  const clean = url.startsWith("//") ? `https:${url}` : url;
  return clean.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_${width}/`);
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
  return cloudinaryLoader({ src, width: 1600 });
}

/** Miniatura muy liviana + blur para feedback instantáneo en PDP al cambiar foto. */
export function cloudinaryPlaceholderSrc(src: string): string {
  if (!src) return "";
  const transform = "f_auto,q_10,c_scale,w_56,e_blur:400";
  if (src.startsWith("http")) {
    if (src.includes("res.cloudinary.com")) {
      return src.replace("/upload/", `/upload/${transform}/`);
    }
    return src;
  }
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${transform}/${src}`;
}
