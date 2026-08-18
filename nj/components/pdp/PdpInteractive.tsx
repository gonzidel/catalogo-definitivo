"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import PdpColorPicker from "./PdpColorPicker";
import PdpSizePicker from "./PdpSizePicker";
import PdpGallery from "./PdpGallery";
import PdpRecommended from "./PdpRecommended";
import { useCartStore } from "@/store/cart";
import { useProfileGate } from "@/components/profile/ProfileGateProvider";
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

function normalizeProductText(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function usesMeasureLabel(product: GroupedProduct) {
  const text = [
    product.Articulo,
    product.Categoria,
    product.Filtro1,
    product.Filtro2,
    product.Filtro3,
    product.Descripcion,
  ]
    .map(normalizeProductText)
    .join(" ");

  if (text.includes("marroquineria")) return true;
  return [
    "cinto",
    "cinturon",
    "cartera",
    "bolso",
    "bandolera",
    "billetera",
    "mochila",
    "panu",
    "panuelo",
    "pañuelo",
    "chalina",
  ].some((term) => text.includes(normalizeProductText(term)));
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
  const qtyListRef = useRef<HTMLDivElement | null>(null);

  const addItem = useCartStore((s) => s.addItem);
  const setPdpOwnBarActive = useCartStore((s) => s.setPdpOwnBarActive);
  const { requireProfileComplete } = useProfileGate();

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

  // Talle puede tocarse para CUALQUIER variante (no solo la del color que
  // está en pantalla) — así la fila "38 Beige" en el resumen sigue siendo
  // editable aunque ahora estemos mirando el negro.
  const handleSizeChange = useCallback((variantId: string, size: string, qty: number) => {
    if (!variantId) return;
    setSelections((prev) => {
      const variant = { ...(prev[variantId] ?? {}) };
      if (qty < 0) {
        // -1 = deselect (quitar del mapa)
        delete variant[size];
      } else {
        variant[size] = qty;
      }
      return { ...prev, [variantId]: variant };
    });
    const activeElement = document.activeElement;
    const cameFromQtyList =
      activeElement instanceof HTMLElement &&
      Boolean(qtyListRef.current?.contains(activeElement));

    if (qty >= 0 && !cameFromQtyList) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          qtyListRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        });
      });
    }
  }, []);

  const onColorChange = useCallback((color: string) => {
    setActiveColor(color);
  }, []);

  // Todas las filas talle+color con selección activa, incluyendo las que
  // todavía están en 0 (recién tocadas) — esto es lo que necesita el
  // selector de talles para mostrar "38 Beige" apenas se toca, sin esperar
  // a que se sume una cantidad.
  const allSelectedRows = useMemo(() => {
    const rows: Array<{ variantId: string; color: string; size: string; qty: number }> = [];
    for (const [varId, sizeMap] of Object.entries(selections)) {
      const vi = variantSizes.find((v) => v.variantId === varId);
      if (!vi) continue;
      for (const [size, qty] of Object.entries(sizeMap)) {
        rows.push({ variantId: varId, color: vi.color, size, qty });
      }
    }
    rows.sort((a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size));
    return rows;
  }, [selections, variantSizes]);

  // Subconjunto con cantidad > 0 — lo que realmente se va a agregar al
  // carrito (para el CTA, el total y el armado del pedido).
  const allSelectedItems = useMemo(() => {
    return allSelectedRows
      .filter((row) => row.qty > 0)
      .map((row) => {
        const dc = visibleColors.find(
          (d) => d.color.toLowerCase() === row.color.toLowerCase()
        );
        const imagen =
          typeof dc?.images?.[0] === "string"
            ? dc.images[0]
            : (dc?.images?.[0] as { url?: string } | undefined)?.url ?? undefined;
        return { ...row, imagen };
      });
  }, [allSelectedRows, visibleColors]);

  const hasOffer = Boolean(product.OfertaActiva && product.PrecioOferta);
  const unitPriceNum = (() => {
    const raw = hasOffer ? product.PrecioOferta : product.Precio;
    if (raw == null || raw === "") return 0;
    const n =
      typeof raw === "string"
        ? parseFloat(raw.replace(/[^\d.]/g, ""))
        : Number(raw);
    return Number.isFinite(n) ? n : 0;
  })();

  const totalSelectedQty = allSelectedItems.reduce((a, i) => a + i.qty, 0);
  const totalSelectedAmount = allSelectedItems.reduce(
    (a, i) => a + i.qty * unitPriceNum,
    0
  );

  // Le avisa a CartFloatingBar (barra global) que esta barra propia del PDP
  // está ocupando el lugar, para que no se superpongan. Cuando no hay
  // selección en curso en este producto, se limpia y la barra global vuelve
  // a mostrarse acá también (si ya hay algo en el carrito).
  useEffect(() => {
    setPdpOwnBarActive(totalSelectedQty > 0 || addedFlash);
    return () => setPdpOwnBarActive(false);
  }, [totalSelectedQty, addedFlash, setPdpOwnBarActive]);

  async function handleAddAllToCart() {
    if (totalSelectedQty === 0) return;
    // Cuenta Google/nueva sin datos: exigir perfil antes de armar carrito.
    const profileOk = await requireProfileComplete();
    if (!profileOk) return;
    for (const item of allSelectedItems) {
      addItem({
        variant_id: item.variantId,
        product_name: product.Articulo,
        color: item.color,
        size: item.size,
        qty: item.qty,
        price_snapshot: unitPriceNum,
        is_offer: hasOffer,
        imagen: item.imagen,
      });
    }
    setSelections({});
    setAddedFlash(true);
    setTimeout(() => setAddedFlash(false), 1400);
  }

  const price = formatARS(product.Precio);
  const offerPrice = hasOffer ? formatARS(product.PrecioOferta) : null;
  const displayPrice = offerPrice ?? price;
  const selectionLabel = usesMeasureLabel(product) ? "medida" : "talle";
  const selectionArticle = selectionLabel === "medida" ? "una" : "un";
  const selectionPlural = selectionLabel === "medida" ? "medidas" : "talles";

  const tags = Array.from(
    new Set(
      [product.Filtro1, product.Filtro2, product.Filtro3]
        .map((tag) => String(tag ?? "").trim())
        .filter(Boolean)
    )
  );
  const stickyVisible = totalSelectedQty > 0 || addedFlash;
  const hasAnySelectionRows = allSelectedRows.length > 0;

  // Controles flotantes sobre la imagen principal. Volver y Cerrar hacían
  // exactamente lo mismo (misma URL) — nos quedamos con un solo botón (X),
  // ahora más grande porque es la acción principal. Descargar + Compartir
  // van separados, abajo del todo en la misma columna — lejos de la X para
  // que no se toquen sin querer uno por otro (evita falsos clics).
  const heroOverlay = (
    <>
      {hasOffer && (
        <span className="pdp-hero-offer-label" aria-label="Oferta">
          Oferta
        </span>
      )}
      <Link
        href={backUrl}
        aria-label="Cerrar"
        className="pdp-icon-btn pdp-hero-round-btn pdp-hero-round-btn--lg pdp-hero-close-btn"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </Link>

      <div className="pdp-hero-controls-bottom">
        <button
          type="button"
          onClick={() => downloadHeroImage(currentHeroSrc, product.Articulo)}
          aria-label="Descargar imagen"
          className="pdp-icon-btn pdp-hero-round-btn pdp-hero-round-btn--sm"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => shareProduct(product.Articulo, displayPrice)}
          aria-label="Compartir"
          className="pdp-icon-btn pdp-hero-round-btn pdp-hero-round-btn--sm"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        </button>
      </div>
    </>
  );

  return (
    <div className="product-modal-body pdp-page">
      <div className="pdp-page__body">
        <PdpGallery
          allColors={visibleColors}
          activeColor={activeColor}
          onColorChange={onColorChange}
          altText={product.Articulo}
          onHeroSrcChange={setCurrentHeroSrc}
          outOfStock={colorDetail?.hasStock === false}
          heroOverlay={heroOverlay}
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

        <div className="pdp-page__content">
          <div className="pdp-identity">
            <div className="pdp-identity__row">
              <div className="pdp-identity__left">
                <div className="pdp-identity__title">
                  Art. {product.Articulo}
                </div>
                <div className="pdp-identity__color">
                  Color seleccionado:{" "}
                  <span className="pdp-identity__color-value">{activeColor}</span>
                </div>
              </div>
              <div className="pdp-identity__price-col">
                {offerPrice ? (
                  <>
                    <div className="pdp-identity__price-old">{price}</div>
                    <div className="pdp-identity__price pdp-identity__price--offer">
                      {offerPrice}
                    </div>
                  </>
                ) : (
                  <div className="pdp-identity__price">{price}</div>
                )}
                <div className="pdp-identity__price-hint">Precio por mayor</div>
              </div>
            </div>
          </div>

          <div className="pdp-colors-block">
            <div className="pdp-colors-block__label">
              Elegí color
              <span className="pdp-colors-block__selected">
                {activeColor}
              </span>
            </div>
            <div className="pdp-colors-block__hint">
              {selectionPlural.charAt(0).toUpperCase() + selectionPlural.slice(1)} de abajo
              corresponden al color seleccionado.
            </div>
            <PdpColorPicker
              colors={visibleColors}
              activeColor={activeColor}
              onColorChange={onColorChange}
              hideLabel
            />
          </div>

          <PdpSizePicker
            colorDetail={colorDetail}
            activeColor={activeColor}
            selectionLabel={selectionLabel}
            sizesWithStock={sizesWithStock}
            activeVariantId={resolvedVariantId}
            variantSizes={variantSizes}
            colors={visibleColors}
            allSelections={allSelectedRows}
            onSelectionChange={handleSizeChange}
            qtyListRef={qtyListRef}
          />

          {/* Hint solo antes del primer talle tocado; al seleccionar, desaparece. */}
          {!hasAnySelectionRows && !addedFlash && (
            <div className="pdp-hint">
              <svg
                className="pdp-hint__icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
              </svg>
              <span className="pdp-hint__text">
                Tocá {selectionArticle} {selectionLabel} y después ajustá la cantidad
              </span>
            </div>
          )}

          {product.Descripcion && (
            <div className="pdp-description">
              <div className="pdp-description__title">Descripción</div>
              <p className="pdp-description__text">{product.Descripcion}</p>
            </div>
          )}

          {/* Tags — al final: son contexto de navegación (categorías relacionadas),
              no información de compra, por eso no compiten arriba y van discretos. */}
          {tags.length > 0 && (
            <div className="pdp-tags">
              {tags.map((tag) => (
                <Link
                  key={tag}
                  href={`/tags/${encodeURIComponent(tag)}`}
                  className="pdp-tag-chip pdp-tag-chip--link"
                >
                  {tag}
                </Link>
              ))}
            </div>
          )}

          <div
            className={[
              "pdp-sticky-spacer",
              totalSelectedQty > 0 ? "is-open" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          />

          <PdpRecommended
            articulo={product.Articulo}
            filtro1={product.Filtro1}
            filtro2={product.Filtro2}
            filtro3={product.Filtro3}
            categoria={product.Categoria}
          />
        </div>
      </div>

      <div
        className={[
          "pdp-sticky-bar",
          stickyVisible ? "is-visible" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="pdp-sticky-bar__inner">
          {addedFlash && totalSelectedQty === 0 ? (
            <div className="pdp-sticky-flash">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="pdp-sticky-flash__text">
                Agregado al carrito
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleAddAllToCart}
              className="pdp-sticky-cta"
            >
              <span className="pdp-sticky-cta__label">
                <span className="pdp-sticky-cta__plus" aria-hidden="true">+</span>
                <span className="pdp-sticky-cta__text">
                  <span className="pdp-sticky-cta__title">Agregar al carrito</span>
                  <span className="pdp-sticky-cta__sub">
                    {totalSelectedQty} producto{totalSelectedQty !== 1 ? "s" : ""}
                  </span>
                </span>
              </span>
              <span className="pdp-sticky-cta__amount">
                {formatARS(totalSelectedAmount)}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
