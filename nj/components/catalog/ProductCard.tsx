import Image from "next/image";
import Link from "next/link";
import { resolveImageSrc } from "@/lib/cloudinary";
import { formatARS } from "@/lib/utils/catalog";
import type { GroupedProduct } from "@/types/catalog";

interface ProductCardProps {
  product: GroupedProduct;
  href: string;
  priority?: boolean;
}

function renderColors(product: GroupedProduct) {
  const colors = product.DetalleColor ?? [];
  const visible = colors.slice(0, 3);
  const overflow = colors.length - 3;

  return (
    <div className="colors">
      {visible.map((dc) => (
        <span
          key={dc.color}
          className="color-btn"
          style={
            dc.hex_color
              ? { background: dc.hex_color }
              : { background: "#ccc" }
          }
          title={dc.color}
          aria-label={dc.color}
        />
      ))}
      {overflow > 0 && (
        <span className="color-more-chip">+{overflow}</span>
      )}
    </div>
  );
}

function renderBadges(product: GroupedProduct) {
  if (product.PromoActiva) {
    return (
      <div className="tags">
        <div className="talle tag-chip promo-chip">{product.PromoActiva}</div>
      </div>
    );
  }
  if (product.OfertaActiva) {
    return (
      <div className="tags">
        <div className="talle tag-chip oferta-chip">🔥 Oferta</div>
      </div>
    );
  }
  return null;
}

function renderPrice(product: GroupedProduct) {
  const hasOffer = product.OfertaActiva;
  const hasPromo = Boolean(product.PromoActiva);
  const original = formatARS(product.Precio);
  const offerPrice = formatARS(product.PrecioOferta);

  if (hasPromo) {
    return <div className="price">{original}</div>;
  }
  if (hasOffer && offerPrice) {
    return (
      <div className="price">
        <span className="price-original">{original}</span>
        <span className="price-offer">{offerPrice}</span>
      </div>
    );
  }
  return <div className="price">{original}</div>;
}

export default function ProductCard({
  product,
  href,
  priority = false,
}: ProductCardProps) {
  const mainImage = resolveImageSrc(product.VariantePrincipal);
  const artCode = String(product.Articulo ?? "").trim();

  return (
    <Link
      href={href}
      className="card producto"
      data-articulo={product.Articulo}
      data-filtro1={product.Filtro1 ?? ""}
      data-filtro2={product.Filtro2 ?? ""}
      data-filtro3={product.Filtro3 ?? ""}
      style={{ display: "block", textDecoration: "none", color: "inherit" }}
    >
      <div className="main-image-wrapper">
        {mainImage ? (
          <Image
            className="main-image"
            src={mainImage}
            alt={artCode}
            fill
            sizes="(max-width: 480px) 50vw, (max-width: 1024px) 33vw, 25vw"
            style={{ objectFit: "cover", objectPosition: "center" }}
            priority={priority}
          />
        ) : (
          <div
            className="main-image skeleton-shimmer"
            style={{ width: "100%", height: "100%" }}
          />
        )}
        {artCode && (
          <div className="product-name-badge product-art-badge">
            Art. {artCode}
          </div>
        )}
      </div>

      {renderBadges(product)}

      <div className="title-row">
        <h3>
          {product.OfertaActiva && !product.PromoActiva ? (
            <span className="article-fire">🔥</span>
          ) : null}
        </h3>
      </div>

      <div className="card-footer">
        <div className="card-footer-top">
          <div className="card-price">
            {renderPrice(product)}
            <div className="price-wholesale">Precio por mayor</div>
          </div>
        </div>
        <div className="colors-row">{renderColors(product)}</div>
        <div className="card-footer-size" data-articulo={product.Articulo} />
      </div>
    </Link>
  );
}
