"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { resolveImageSrc } from "@/lib/cloudinary";
import { formatARS, colorDetailHasImage } from "@/lib/utils/catalog";
import { pickDisplayColorDetail } from "@/lib/utils/catalog-variant-enrich";
import type { GroupedProduct } from "@/types/catalog";

interface ProductCardProps {
  product: GroupedProduct;
  href: string;
  priority?: boolean;
  activeSizes?: string[];
  categoria?: string;
}

function pickCardColor(
  product: GroupedProduct,
  activeSizes: string[],
  categoria: string
): string {
  return (
    pickDisplayColorDetail(product, { activeSizes, categoria })?.color ?? ""
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
        <div className="talle tag-chip oferta-chip">Oferta</div>
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
  activeSizes = [],
  categoria = "all",
}: ProductCardProps) {
  const [activeColor, setActiveColor] = useState(() =>
    pickCardColor(product, activeSizes, categoria)
  );
  const [userPickedColor, setUserPickedColor] = useState(false);

  const sizesKey = activeSizes.join(",");

  // Tras enriquecer o cambiar filtro de talle, elegir variante que lo tenga.
  useEffect(() => {
    if (userPickedColor) return;
    const next = pickCardColor(product, activeSizes, categoria);
    setActiveColor((prev) => (prev === next ? prev : next));
  }, [product, userPickedColor, sizesKey, categoria]);

  useEffect(() => {
    setUserPickedColor(false);
    setActiveColor(pickCardColor(product, activeSizes, categoria));
  }, [product.Articulo, sizesKey, categoria]);

  const passColorInHref = userPickedColor || activeSizes.length > 0;
  const productHref =
    passColorInHref && activeColor
      ? `${href}${href.includes("?") ? "&" : "?"}color=${encodeURIComponent(activeColor)}`
      : href;

  const activeDetail = useMemo(() => {
    const visible = (product.DetalleColor ?? []).filter(colorDetailHasImage);
    return (
      visible.find((d) => d.color.toLowerCase() === activeColor.toLowerCase()) ??
      visible[0] ??
      null
    );
  }, [product.DetalleColor, activeColor]);

  const showSinStock = activeDetail?.hasStock === false;
  const mainImage = resolveImageSrc(activeDetail?.images?.[0]);
  const artCode = String(product.Articulo ?? "").trim();

  const colors = useMemo(() => {
    const list = (product.DetalleColor ?? []).filter(colorDetailHasImage);
    if (!activeColor) return list;
    const idx = list.findIndex(
      (d) => d.color.toLowerCase() === activeColor.toLowerCase()
    );
    if (idx <= 0) return list;
    return [list[idx], ...list.filter((_, i) => i !== idx)];
  }, [product.DetalleColor, activeColor]);
  const visible = colors.slice(0, 3);
  const overflow = colors.length - 3;

  const onColorClick = useCallback((e: React.MouseEvent, color: string) => {
    e.preventDefault();
    e.stopPropagation();
    setUserPickedColor(true);
    setActiveColor(color);
  }, []);

  return (
    <Link
      href={productHref}
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
        {showSinStock && (
          <div className="card-stock-overlay" aria-hidden="true">
            <span className="card-stock-overlay__label">Sin stock</span>
          </div>
        )}
        {artCode && (
          <div className="product-name-badge product-art-badge">
            Art. {artCode}
          </div>
        )}
      </div>

      {renderBadges(product)}

      <div className="card-footer">
        <div className="card-footer-top">
          <div className="card-price">
            {renderPrice(product)}
            <div className="price-wholesale">Precio por mayor</div>
          </div>
        </div>
        <div className="colors-row">
          <div className="colors">
            {visible.map((dc) => {
              const selected =
                dc.color.toLowerCase() === activeColor.toLowerCase();
              const oos = dc.hasStock === false;
              return (
                <button
                  key={dc.color}
                  type="button"
                  className={[
                    "color-btn",
                    selected ? "color-btn--selected" : "",
                    oos ? "color-btn--no-stock" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={
                    dc.hex_color
                      ? { background: dc.hex_color }
                      : { background: "#ccc" }
                  }
                  title={dc.color}
                  aria-label={`${dc.color}${oos ? " (sin stock)" : ""}`}
                  aria-pressed={selected}
                  onClick={(e) => onColorClick(e, dc.color)}
                />
              );
            })}
            {overflow > 0 && (
              <span className="color-more-chip">+{overflow}</span>
            )}
          </div>
        </div>
        <div className="card-footer-size" data-articulo={product.Articulo} />
      </div>
    </Link>
  );
}
