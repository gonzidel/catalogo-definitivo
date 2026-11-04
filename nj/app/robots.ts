import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { NJ_INDEXING_ENABLED } from "@/lib/seo/indexing";
import { CANONICAL_SITE_URL } from "@/lib/site-url";
import { isCanonicalHost } from "@/lib/rollout/request";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");

  if (!NJ_INDEXING_ENABLED || !isCanonicalHost(host)) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
      sitemap: undefined,
    };
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/dashboard", "/login", "/api/", "/auth/", "/client/"],
      },
    ],
    sitemap: `${CANONICAL_SITE_URL}/sitemap.xml`,
  };
}
