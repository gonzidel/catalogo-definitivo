import type { MetadataRoute } from "next";

const BASE = "https://fylmoda.com.ar";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date().toISOString();

  const staticPages: MetadataRoute.Sitemap = [
    { url: `${BASE}/catalogo`, lastModified: now, changeFrequency: "daily", priority: 1.0 },
    { url: `${BASE}/catalogo/calzado`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${BASE}/catalogo/ropa`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${BASE}/catalogo/lenceria`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/catalogo/marroquineria`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/catalogo/ofertas`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${BASE}/catalogo/como-comprar`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE}/catalogo/quienes-somos`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE}/revendedoras`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/calzado-femenino-por-mayor`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/ropa-femenina-por-mayor`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/accesorios-por-mayor`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE}/lenceria-por-mayor`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
  ];

  return staticPages;
}
