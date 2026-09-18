import type { MetadataRoute } from "next";
import { NJ_INDEXING_ENABLED } from "@/lib/seo/indexing";
import { getSiteUrl } from "@/lib/site-url";

const PUBLIC_PATHS = [
  "/",
  "/calzado",
  "/ropa",
  "/lenceria",
  "/marroquineria",
  "/ofertas",
  "/como-comprar",
  "/quienes-somos",
];

export default function sitemap(): MetadataRoute.Sitemap {
  if (!NJ_INDEXING_ENABLED) return [];

  const base = getSiteUrl();
  const now = new Date();
  return PUBLIC_PATHS.map((path) => ({
    url: `${base}${path === "/" ? "" : path}`,
    lastModified: now,
    changeFrequency: path === "/" ? "daily" : "weekly",
    priority: path === "/" ? 1 : 0.7,
  }));
}
