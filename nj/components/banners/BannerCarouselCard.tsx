import Image from "next/image";
import Link from "next/link";
import { resolveImageSrc } from "@/lib/cloudinary";
import { formatARS } from "@/lib/utils/catalog";
import { pickDisplayColorDetail } from "@/lib/utils/catalog-variant-enrich";
import { getColorEffectivePrice } from "@/lib/utils/variant-price";
import { productIsOutOfStock } from "@/lib/stock/catalog-availability";
import type { GroupedProduct } from "@/types/catalog";

export function BannerCarouselCard({ product }: { product: GroupedProduct }) {
  const displayColor = pickDisplayColorDetail(product);
  const pricing = getColorEffectivePrice(displayColor, product);
  const src = resolveImageSrc(
    displayColor?.images?.[0] ?? product.VariantePrincipal
  );
  const colors = product.DetalleColor ?? [];
  const hasOffer = pricing.isOffer;
  const precio = pricing.effectivePrice || product.Precio;
  const showSinStock = productIsOutOfStock(product);
  const hrefColor = displayColor?.color ?? "";
  const href = hrefColor
    ? `/producto/${encodeURIComponent(product.Articulo)}?color=${encodeURIComponent(hrefColor)}`
    : `/producto/${encodeURIComponent(product.Articulo)}`;

  return (
    <Link
      href={href}
      className={`fyl-originals-card${hasOffer ? " fyl-originals-card--offer" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div className="fyl-originals-card-image" style={{ position: "relative" }}>
        {src ? (
          <Image
            src={src}
            alt={product.Articulo}
            fill
            sizes="110px"
            style={{ objectFit: "cover" }}
          />
        ) : (
          <div className="skeleton-shimmer" style={{ width: "100%", height: "100%" }} />
        )}
        {showSinStock && (
          <div className="card-stock-overlay" aria-hidden="true">
            <span className="card-stock-overlay__label">Sin stock</span>
          </div>
        )}
        <div className="fyl-originals-badge">{product.Articulo}</div>
        {hasOffer && (
          <span
            className="fyl-originals-offer-fire"
            title="Oferta"
            aria-label="Oferta"
          >
            🔥
          </span>
        )}
      </div>
      {colors.length > 0 && (
        <div className="fyl-originals-colors">
          {colors.slice(0, 3).map((c) => (
            <span
              key={c.color}
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: c.hex_color ?? "#ccc",
                display: "inline-block",
                flexShrink: 0,
                opacity: c.hasStock === false ? 0.35 : 1,
              }}
              title={c.hasStock === false ? `${c.color} (sin stock)` : c.color}
            />
          ))}
          {colors.length > 3 && (
            <span className="color-dot color-dot-more" aria-hidden="true">
              +{colors.length - 3}
            </span>
          )}
        </div>
      )}
      <div className="fyl-originals-card-content">
        <div
          className={`fyl-originals-card-price${hasOffer ? " fyl-originals-card-price--offer" : ""}`}
        >
          {formatARS(precio)}
        </div>
        <div className="fyl-originals-card-wholesale">Precio por Mayor</div>
      </div>
    </Link>
  );
}

export function BannerCarouselSkeleton() {
  return (
    <div
      className="fyl-originals-card"
      style={{ flexDirection: "column", pointerEvents: "none" }}
      aria-hidden="true"
    >
      <div className="fyl-originals-card-image skeleton-shimmer" aria-hidden="true" />
      <div className="fyl-originals-card-content">
        <div
          className="skeleton-shimmer"
          style={{ width: "60%", height: 14, borderRadius: 4 }}
        />
      </div>
    </div>
  );
}
