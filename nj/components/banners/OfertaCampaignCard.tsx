import Link from "next/link";
import Image from "next/image";
import { resolveImageSrc } from "@/lib/cloudinary";
import type { OfertaCampaignBanner } from "@/lib/banners/ofertas-destacadas";

/** Afiche de una oferta. Abre la lista filtrada a los productos de esa campaña. */
export function OfertaCampaignCard({ campaign }: { campaign: OfertaCampaignBanner }) {
  const src = resolveImageSrc(campaign.imageUrl);
  if (!src) return null;

  return (
    <Link
      href={campaign.href}
      className="fyl-originals-card ofertas-card ofertas-campaign-card"
      aria-label={campaign.title}
      data-ga-promo={campaign.title}
    >
      <div className="fyl-originals-card-image">
        <Image
          src={src}
          alt={campaign.title}
          fill
          sizes="(min-width: 1024px) 220px, 110px"
          style={{ objectFit: "cover" }}
        />
      </div>
      <div className="fyl-originals-card-content ofertas-card__content">
        <div className="ofertas-campaign-card__title">{campaign.title}</div>
      </div>
    </Link>
  );
}
