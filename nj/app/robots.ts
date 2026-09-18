import type { MetadataRoute } from "next";
import { NJ_INDEXING_ENABLED } from "@/lib/seo/indexing";
import { getSiteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  if (!NJ_INDEXING_ENABLED) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
      sitemap: undefined,
    };
  }

  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/admin", "/dashboard", "/api/"] },
    ],
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}
