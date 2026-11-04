import type { MetadataRoute } from "next";
import { LEGACY_LANDING_PATHS, NJ_INDEXING_ENABLED } from "@/lib/seo/indexing";
import { CANONICAL_SITE_URL } from "@/lib/site-url";

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

  const now = new Date();
  return [
    ...PUBLIC_PATHS.map((path) => ({
      url: path === "/" ? `${CANONICAL_SITE_URL}/` : `${CANONICAL_SITE_URL}${path}`,
      lastModified: now,
      changeFrequency: path === "/" ? ("daily" as const) : ("weekly" as const),
      priority: path === "/" ? 1 : 0.7,
    })),
    ...LEGACY_LANDING_PATHS.map((path) => ({
      url: `${CANONICAL_SITE_URL}${path}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
