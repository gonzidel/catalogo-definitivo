"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import PdpColorPicker from "./PdpColorPicker";
import PdpSizePicker from "./PdpSizePicker";
import PdpGallery from "./PdpGallery";
import PdpRecommended from "./PdpRecommended";
import AddToCartButton from "@/components/cart/AddToCartButton";
import { formatARS } from "@/lib/utils/catalog";
import type { GroupedProduct, ColorDetail } from "@/types/catalog";

interface VariantSizeInfo {
  variantId: string;
  color: string;
  sku: string;
  sizes: Array<{ size: string; sku: string; stock_qty: number }>;
}

interface PdpInteractiveProps {
  product: GroupedProduct;
  variantSizes: VariantSizeInfo[];
  initialColor?: string;
  backUrl: string;
}

// ─── Share / Download helpers ─────────────────────────────────────────────────

async function shareProduct(articulo: string, price: string) {
  const url = window.location.href;
  const text = `Art. ${articulo} — ${price} (precio por mayor)`;
  if (navigator.share) {
    try {
      await navigator.share({ title: `Art. ${articulo}`, text, url });
    } catch {
      // user cancelled or not supported — fall back to clipboard
      await navigator.clipboard.writeText(`${text}\n${url}`);
    }
  } else {
    await navigator.clipboard.writeText(`${text}\n${url}`);
  }
}

async function downloadHeroImage(heroSrc: string | null, articulo: string) {
  if (!heroSrc) return;
  try {
    const res = await fetch(heroSrc);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `art-${articulo}.jpg`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    window.open(heroSrc, "_blank");
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PdpInteractive({
  product,
  variantSizes,
  initialColor,
  backUrl,
}: PdpInteractiveProps) {
  const firstColor = product.DetalleColor[0]?.color ?? "";
  const [activeColor, setActiveColor] = useState(() => {
    const requested = (initialColor ?? firstColor).trim();
    const exists = product.DetalleColor.some(
      (dc) => dc.color.toLowerCase() === requested.toLowerCase()
    );
    return exists ? requested : firstColor;
  });
  const [activeSize, setActiveSize] = useState("");
  const [currentHeroSrc, setCurrentHeroSrc] = useState<string | null>(null);

  // Always resolve to a valid color — fallback to first if not found
  const colorDetail: ColorDetail | null =
    product.DetalleColor.find(
      (dc) => dc.color.toLowerCase() === activeColor.toLowerCase()
    ) ?? product.DetalleColor[0] ?? null;

  const allColors: ColorDetail[] = useMemo(() => {
    return product.DetalleColor.map((dc) => {
      if (dc.images.some(Boolean)) return dc;
      return {
        ...dc,
        images: product.VariantePrincipal ? [product.VariantePrincipal] : [],
      };
    });
  }, [product.DetalleColor, product.VariantePrincipal]);

  const variantInfo = variantSizes.find(
    (v) => v.color.toLowerCase() === activeColor.toLowerCase()
  );
  const sizesWithStock = variantInfo?.sizes ?? [];

  // Cart button state
  const resolvedVariantId = variantInfo?.variantId ?? "";
  const sizeStock = variantInfo?.sizes.find((s) => s.size === activeSize)?.stock_qty ?? 1;
  const outOfStock = activeSize !== "" && sizeStock <= 0;

  const onColorChange = useCallback((color: string) => {
    setActiveColor(color);
    setActiveSize("");
  }, []);

  const price = formatARS(product.Precio);
  const offerPrice = product.OfertaActiva ? formatARS(product.PrecioOferta) : null;
  const displayPrice = offerPrice ?? price;

  const tags = [product.Filtro1, product.Filtro2, product.Filtro3].filter(Boolean);

  return (
    <div className="product-modal-body" style={{ paddingBottom: 80 }}>

      {/* ── Sticky header ─────────────────────────────────────────────── */}
      <div
        className="pdp-sticky-header"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "#fff",
          borderBottom: "1px solid #eee",
        }}
      >
        {/* Row 1 — navigation + identity + price + close */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px 6px",
        }}>
          {/* Back arrow — touch target 44px */}
          <Link
            href={backUrl}
            aria-label="Volver"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, marginLeft: -4,
              color: "#444", textDecoration: "none", flexShrink: 0,
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Link>

          {/* Article number — primary identity */}
          <span style={{
            flex: 1, fontSize: 15, fontWeight: 700, color: "#222",
            letterSpacing: "-0.01em",
          }}>
            Art. {product.Articulo}
          </span>

          {/* Price — most important commercial info */}
          <span style={{
            fontSize: 17, fontWeight: 800, color: "#CD844D",
            letterSpacing: "-0.02em", flexShrink: 0,
          }}>
            {displayPrice}
          </span>

          {/* Close */}
          <Link
            href={backUrl}
            aria-label="Cerrar"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, marginRight: -4,
              color: "#aaa", textDecoration: "none", flexShrink: 0,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </Link>
        </div>

        {/* Row 2 — tags (context) + actions */}
        {(tags.length > 0) && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 12px 8px",
            overflowX: "auto",
          }}>
            {/* Tag chips */}
            {tags.map((tag) => (
              <Link
                key={tag}
                href={`/tags/${encodeURIComponent(tag!)}`}
                className="talle tag-chip pdp-tag-chip"
                style={{ textDecoration: "none", fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 }}
              >
                {tag}
              </Link>
            ))}

            {/* Spacer */}
            <div style={{ flex: 1 }} />

            {/* Download */}
            <button
              onClick={() => downloadHeroImage(currentHeroSrc, product.Articulo)}
              aria-label="Descargar imagen"
              style={{
                display: "flex", alignItems: "center", gap: 4,
                background: "none", border: "none", cursor: "pointer",
                color: "#555", padding: "4px 8px", fontSize: 12,
                flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Descargar
            </button>

            {/* Share */}
            <button
              onClick={() => shareProduct(product.Articulo, displayPrice)}
              aria-label="Compartir"
              style={{
                display: "flex", alignItems: "center", gap: 4,
                background: "none", border: "none", cursor: "pointer",
                color: "#555", padding: "4px 8px", fontSize: 12,
                flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                strokeLinejoin="round" aria-hidden="true">
                <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
              Compartir
            </button>
          </div>
        )}
      </div>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div style={{ padding: "12px 16px" }}>
        {/* Gallery */}
        <PdpGallery
          allColors={allColors}
          activeColor={activeColor}
          onColorChange={onColorChange}
          altText={product.Articulo}
          onHeroSrcChange={setCurrentHeroSrc}
        />

        <div style={{ marginTop: 16 }}>
          {/* Price (full detail, below gallery) */}
          <div style={{ marginBottom: 16 }}>
            {offerPrice ? (
              <>
                <span style={{ fontSize: 14, color: "#999", textDecoration: "line-through", marginRight: 8 }}>
                  {price}
                </span>
                <span style={{ fontSize: 22, fontWeight: 700, color: "#CD844D" }}>
                  {offerPrice}
                </span>
              </>
            ) : (
              <span style={{ fontSize: 22, fontWeight: 700, color: "#333" }}>{price}</span>
            )}
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Precio por mayor</div>
          </div>

          {/* Color picker */}
          <PdpColorPicker
            colors={product.DetalleColor}
            activeColor={activeColor}
            onColorChange={onColorChange}
          />

          <div style={{ marginTop: 16 }}>
            <PdpSizePicker
              colorDetail={colorDetail}
              sizesWithStock={sizesWithStock}
              activeSize={activeSize}
              onSizeChange={setActiveSize}
            />
          </div>

          {product.Descripcion && (
            <div style={{ marginTop: 20, fontSize: 14, color: "#555", lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Descripción</div>
              <p style={{ margin: 0 }}>{product.Descripcion}</p>
            </div>
          )}

          <div style={{ marginTop: 24 }}>
            <AddToCartButton
              variantId={resolvedVariantId}
              productName={product.Articulo}
              color={activeColor}
              size={activeSize}
              priceSnapshot={Number(product.Precio ?? 0)}
              imagen={
                typeof colorDetail?.images?.[0] === "string"
                  ? colorDetail.images[0]
                  : (colorDetail?.images?.[0] as any)?.url ?? undefined
              }
              disabled={!resolvedVariantId || outOfStock}
            />
            {outOfStock && (
              <p style={{
                textAlign: "center", fontSize: 12, color: "#e85d04",
                margin: "8px 0 0", fontWeight: 500,
              }}>
                Sin stock en este talle
              </p>
            )}
          </div>

          {/* Recommended products */}
          <PdpRecommended
            articulo={product.Articulo}
            filtro1={product.Filtro1}
            filtro2={product.Filtro2}
            filtro3={product.Filtro3}
            categoria={product.Categoria}
          />
        </div>
      </div>
    </div>
  );
}
