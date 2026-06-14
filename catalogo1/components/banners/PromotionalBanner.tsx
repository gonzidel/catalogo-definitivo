import Link from "next/link";
import type { PromotionalBannerData } from "@/types/banners";

interface Props {
  banner: PromotionalBannerData;
}

function resolveHref(banner: PromotionalBannerData): string {
  switch (banner.link_type) {
    case "category":
      return `/${banner.link.toLowerCase()}`;
    case "tag":
      return `/tags/${encodeURIComponent(banner.link.toLowerCase())}`;
    case "url":
    default:
      return banner.link || "#";
  }
}

export default function PromotionalBanner({ banner }: Props) {
  const href = resolveHref(banner);
  const isExternal = banner.link_type === "url" && banner.link.startsWith("http");

  return (
    <div className="promotional-banner-container" style={{ display: "block" }}>
      {isExternal ? (
        <a
          href={href}
          className="promotional-banner"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="promotional-banner-text">{banner.text}</span>
          <span className="promotional-banner-arrow">→</span>
        </a>
      ) : (
        <Link href={href} className="promotional-banner">
          <span className="promotional-banner-text">{banner.text}</span>
          <span className="promotional-banner-arrow">→</span>
        </Link>
      )}
    </div>
  );
}
