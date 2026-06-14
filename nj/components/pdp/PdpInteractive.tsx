"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import PdpColorPicker from "./PdpColorPicker";
import PdpSizePicker from "./PdpSizePicker";
import PdpGallery from "./PdpGallery";
import PdpRecommended from "./PdpRecommended";
import { useCartStore } from "@/store/cart";
import { formatARS, colorDetailHasImage } from "@/lib/utils/catalog";
import type { GroupedProduct, ColorDetail } from "@/types/catalog";

/** selections[variantId][size] = qty */
type MultiSelection = Record<string, Record<string, number>>;

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
  const visibleColors = useMemo(
    () => (product.DetalleColor ?? []).filter(colorDetailHasImage),
    [product.DetalleColor]
  );

  const firstColor = visibleColors[0]?.color ?? "";
  const [activeColor, setActiveColor] = useState(() => {
    const requested = (initialColor ?? firstColor).trim();
    const exists = visibleColors.some(
      (dc) => dc.color.toLowerCase() === requested.toLowerCase()
    );
    return exists ? requested : firstColor;
  });
  const [currentHeroSrc, setCurrentHeroSrc] = useState<string | null>(null);

  // Multi-selection: { variantId: { size: qty } }
  const [selections, setSelections] = useState<MultiSelection>({});
  const [addedFlash, setAddedFlash] = useState(false);

  const addItem = useCartStore((s) => s.addItem);

  // Always resolve to a valid color — fallback to first if not found
  const colorDetail: ColorDetail | null =
    visibleColors.find(
      (dc) => dc.color.toLowerCase() === activeColor.toLowerCase()
    ) ?? visibleColors[0] ?? null;

  const variantInfo = variantSizes.find(
    (v) => v.color.toLowerCase() === activeColor.toLowerCase()
  );
  const sizesWithStock = variantInfo?.sizes ?? [];
  const resolvedVariantId = variantInfo?.variantId ?? "";

  // Selections for the current color/variant
  const currentVariantSelections: Record<string, number> =
    resolvedVariantId ? (selections[resolvedVariantId] ?? {}) : {};

  const handleSizeChange = useCallback((size: string, qty: number) => {
    if (!resolvedVariantId) return;
    setSelections((prev) => {
      const variant = { ...(prev[resolvedVariantId] ?? {}) };
      if (qty <= 0) {
        delete variant[size];
      } else {
        variant[size] = qty;
      }
      return { ...prev, [resolvedVariantId]: variant };
    });
  }, [resolvedVariantId]);

  const onColorChange = useCallback((color: string) => {
    setActiveColor(color);
  }, []);

  // Build flat list of all selected items across all variants
  const allSelectedItems = useMemo(() => {
    const items: Array<{ variantId: string; color: string; size: string; qty: number; imagen?: string }> = [];
    for (const [varId, sizeMap] of Object.entries(selections)) {
      const vi = variantSizes.find((v) => v.variantId === varId);
      if (!vi) continue;
      const dc = visibleColors.find(
        (d) => d.color.toLowerCase() === vi.color.toLowerCase()
      );
      const imagen =
        typeof dc?.images?.[0] === "string"
          ? dc.images[0]
          : (dc?.images?.[0] as any)?.url ?? undefined;
      for (const [size, qty] of Object.entries(sizeMap)) {
        if (qty > 0) items.push({ variantId: varId, color: vi.color, size, qty, imagen });
      }
    }
    // Sort by color then size for display
    items.sort((a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size));
    return items;
  }, [selections, variantSizes, visibleColors]);

  const totalSelectedQty = allSelectedItems.reduce((a, i) => a + i.qty, 0);
  const totalSelectedAmount = allSelectedItems.reduce(
    (a, i) => a + i.qty * Number(product.Precio ?? 0), 0
  );

  function handleAddAllToCart() {
    if (totalSelectedQty === 0) return;
    for (const item of allSelectedItems) {
      addItem({
        variant_id: item.variantId,
        product_name: product.Articulo,
        color: item.color,
        size: item.size,
        qty: item.qty,
        price_snapshot: Number(product.Precio ?? 0),
        imagen: item.imagen,
      });
    }
    setSelections({});
    setAddedFlash(true);
    setTimeout(() => setAddedFlash(false), 2500);
  }

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
          allColors={visibleColors}
          activeColor={activeColor}
          onColorChange={onColorChange}
          altText={product.Articulo}
          onHeroSrcChange={setCurrentHeroSrc}
          outOfStock={colorDetail?.hasStock === false}
          onShareImage={async (url) => {
            if (navigator.share) {
              try {
                await navigator.share({
                  title: `Art. ${product.Articulo}`,
                  url,
                });
                return;
              } catch {
                /* cancelado */
              }
            }
            await navigator.clipboard.writeText(url);
          }}
          onDownloadImage={(url) =>
            downloadHeroImage(url, product.Articulo)
          }
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
            colors={visibleColors}
            activeColor={activeColor}
            onColorChange={onColorChange}
          />

          <div style={{ marginTop: 16 }}>
            <PdpSizePicker
              colorDetail={colorDetail}
              sizesWithStock={sizesWithStock}
              selections={currentVariantSelections}
              onSelectionChange={handleSizeChange}
            />
          </div>

          {product.Descripcion && (
            <div style={{ marginTop: 20, fontSize: 14, color: "#555", lineHeight: 1.6 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Descripción</div>
              <p style={{ margin: 0 }}>{product.Descripcion}</p>
            </div>
          )}

          {/* Space for the sticky cart bar */}
          <div style={{ height: totalSelectedQty > 0 ? 96 : 0, transition: "height 0.2s" }} />

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

      {/* ── Sticky cart summary bar — sits above BottomNav ───────────── */}
      <div style={{
        position: "fixed", bottom: 60, left: 0, right: 0,
        zIndex: 60,
        transform: totalSelectedQty > 0 || addedFlash ? "translateY(0)" : "translateY(calc(100% + 60px))",
        transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
      }}>
        <div style={{
          background: "#fff",
          borderTop: "1px solid #f0ebe4",
          padding: "10px 16px 12px",
          boxShadow: "0 -4px 20px rgba(0,0,0,0.1)",
        }}>
          {/* Success flash */}
          {addedFlash && totalSelectedQty === 0 ? (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              padding: "14px", borderRadius: 14,
              background: "#f0fdf4", border: "1.5px solid #86efac",
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span style={{ fontSize: 15, fontWeight: 700, color: "#16a34a" }}>
                ¡Agregado al carrito!
              </span>
            </div>
          ) : (
            <button
              onClick={handleAddAllToCart}
              style={{
                width: "100%", padding: "14px 16px",
                borderRadius: 14, border: "none",
                background: "#CD844D", color: "#fff",
                fontSize: 15, fontWeight: 700, cursor: "pointer",
                boxShadow: "0 4px 14px rgba(205,132,77,0.35)",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                  strokeLinejoin="round">
                  <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
                  <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                </svg>
                Agregar {totalSelectedQty} par{totalSelectedQty !== 1 ? "es" : ""} al carrito
              </span>
              <span style={{ fontWeight: 600, opacity: 0.9 }}>
                {formatARS(totalSelectedAmount)}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
