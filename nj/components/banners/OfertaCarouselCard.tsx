import Image from "next/image";
import Link from "next/link";
import { resolveImageSrc } from "@/lib/cloudinary";
import { formatARS } from "@/lib/utils/catalog";
import type { OfertaBannerItem } from "@/lib/banners/ofertas-destacadas";

/**
 * Tarjeta del banner de Ofertas: solo foto principal (con el código del artículo) y precio de oferta.
 * Sin círculos de colores ni leyenda "Precio por Mayor". El color mostrado es siempre el que está
 * en oferta, así que el precio coincide con el de la ficha (`?color=`).
 */
export function OfertaCarouselCard({ item }: { item: OfertaBannerItem }) {
  const { product, color, price } = item;
  const src = resolveImageSrc(color.images?.[0] ?? product.VariantePrincipal);
  const href = `/producto/${encodeURIComponent(product.Articulo)}?color=${encodeURIComponent(color.color)}`;

  return (
    <Link
      href={href}
      className="fyl-originals-card ofertas-card"
      data-ga-product={product.Articulo}
      aria-label={`${product.Articulo} en oferta a ${formatARS(price)}`}
    >
      <div className="fyl-originals-card-image ofertas-card__image">
        {src ? (
          <Image
            src={src}
            alt={product.Articulo}
            fill
            sizes="(min-width: 1024px) 220px, 110px"
            style={{ objectFit: "cover" }}
          />
        ) : (
          <div className="skeleton-shimmer" style={{ width: "100%", height: "100%" }} />
        )}
        <div className="fyl-originals-badge">{product.Articulo}</div>
      </div>
      <div className="fyl-originals-card-content ofertas-card__content">
        <div className="fyl-originals-card-price fyl-originals-card-price--offer ofertas-card__price">
          {formatARS(price)}
        </div>
      </div>
    </Link>
  );
}
