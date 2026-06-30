"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams, usePathname } from "next/navigation";
import { useCatalog } from "@/hooks/useCatalog";
import { useEnrichedCatalog } from "@/hooks/useEnrichedCatalog";
import { searchProducts, filterBySizes } from "@/lib/utils/search";
import {
  inferCategoryFromProducts,
  filterProductsByTags,
} from "@/lib/utils/infer-catalog-category";
import ProductCard from "./ProductCard";
import SkeletonCard from "./SkeletonCard";
import CategoryTabs from "@/components/filters/CategoryTabs";
import CategoryContextBar from "@/components/filters/CategoryContextBar";
import SizeFilterSheet from "@/components/filters/SizeFilterSheet";
import TagFilterBar from "@/components/filters/TagFilterBar";
import type { GroupedProduct } from "@/types/catalog";

const INITIAL_DISPLAY = 14;
const DISPLAY_INCREMENT = 14;

interface CatalogShellProps {
  initialProducts: GroupedProduct[];
  categoria: string;
  tags: string[];
  /** Muestra chip Ofertas (3.er lugar) si hay productos en oferta. undefined = consulta en cliente. */
  hasOfertas?: boolean;
  /** Solo muestra initialProducts; no reemplaza con el feed global (p. ej. /banner/[slug]). */
  fixedProductSet?: boolean;
  /** Content rendered between category filters and the catalog grid (home only) */
  aboveGridSlot?: React.ReactNode;
  /** Content inserted after the 4th product in the grid (home only) */
  curatedSlot?: React.ReactNode;
}

export default function CatalogShell({
  initialProducts,
  categoria,
  tags,
  hasOfertas,
  fixedProductSet = false,
  aboveGridSlot,
  curatedSlot,
}: CatalogShellProps) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const searchTerm = searchParams.get("q") ?? "";
  const activeSizes = searchParams
    .get("talle")
    ?.split(",")
    .filter(Boolean) ?? [];

  // Build the current URL to pass as `from` param to PDP
  const currentUrl = searchParams.toString()
    ? `${pathname}?${searchParams}`
    : pathname;

  const [displayCount, setDisplayCount] = useState(INITIAL_DISPLAY);
  const [highlightCats, setHighlightCats] = useState(false);
  const [highlightTalles, setHighlightTalles] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const prevCategoriaRef = useRef(categoria);
  useEffect(() => {
    if (prevCategoriaRef.current === categoria) return;
    prevCategoriaRef.current = categoria;
    if (categoria && categoria !== "all") {
      setHighlightTalles(true);
      setTimeout(() => setHighlightTalles(false), 2000);
    }
  }, [categoria]);

  const handleNeedCategory = useCallback(() => {
    setHighlightCats(true);
    setTimeout(() => setHighlightCats(false), 2200);
  }, []);

  const { allProducts, hasMore, isLoadingMore, loadMore } = useCatalog({
    categoria,
    tags,
    enabled: !fixedProductSet,
  });

  const baseProducts = fixedProductSet
    ? initialProducts
    : allProducts.length > 0
      ? allProducts
      : initialProducts;

  const { products: enrichedProducts } = useEnrichedCatalog(
    baseProducts,
    searchTerm
  );

  const canLoadMore = !fixedProductSet && hasMore;

  const catalogPool = React.useMemo(
    () =>
      enrichedProducts.filter((p) => (p.DetalleColor?.length ?? 0) > 0),
    [enrichedProducts]
  );

  const tagFiltered = React.useMemo(
    () => filterProductsByTags(catalogPool, tags),
    [catalogPool, tags]
  );

  const searched = React.useMemo(
    () =>
      searchTerm.length >= 2
        ? searchProducts(tagFiltered, searchTerm)
        : tagFiltered,
    [tagFiltered, searchTerm]
  );

  const effectiveCategoria = React.useMemo(() => {
    if (categoria && categoria !== "all") return categoria;
    if (searchTerm.length < 2 && tags.length === 0) return "all";
    return inferCategoryFromProducts(searched) ?? "all";
  }, [categoria, searchTerm, tags.length, searched]);

  const filtered =
    activeSizes.length > 0
      ? filterBySizes(searched, activeSizes, effectiveCategoria)
      : searched;

  const contextCategoria =
    categoria !== "all" ? categoria : effectiveCategoria;

  // Expose loaded products globally so SearchBar autocomplete can use them
  useEffect(() => {
    if (catalogPool.length > 0) {
      (window as any).__fylProducts = catalogPool;
    }
  }, [catalogPool]);

  // Reset display count when filters change
  useEffect(() => {
    setDisplayCount(INITIAL_DISPLAY);
  }, [searchTerm, activeSizes.join(","), categoria, tags.join(",")]);

  const displayProducts = filtered.slice(0, displayCount);

  // Always-up-to-date refs for the observer callback (avoids stale closures)
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const hasMoreRef = useRef(canLoadMore);
  hasMoreRef.current = canLoadMore;
  const displayCountRef = useRef(displayCount);
  displayCountRef.current = displayCount;

  // Sentinel is always in the DOM — never conditionally removed.
  // The observer callback decides whether to act, so the element stays mounted
  // and the observer never loses its target.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        const currentFiltered = filteredRef.current;
        const currentDisplayCount = displayCountRef.current;
        const currentHasMore = hasMoreRef.current;

        // Nothing to do if we're already showing everything and no more to load
        if (currentDisplayCount >= currentFiltered.length && !currentHasMore) return;

        setDisplayCount((c) => c + DISPLAY_INCREMENT);

        // Fetch next SWR page when display has caught up with loaded products
        if (currentDisplayCount + DISPLAY_INCREMENT >= currentFiltered.length) {
          loadMoreRef.current();
        }
      },
      { rootMargin: "600px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const showTagBar =
    searchTerm.length > 0 || activeSizes.length > 0 || tags.length > 0;

  return (
    <>
      {/* Zona categoría: chips (gris) + head (blanco), sin solapamiento */}
      <div className="catalog-category-zone">
        <div className="quick-actions-container">
          <div
            className="category-bar"
            id="category-bar"
            aria-label="Categorías del catálogo"
            style={highlightCats ? {
              animation: "fyl-blink 0.4s ease 3",
              outline: "2px solid #CD844D",
              outlineOffset: 2,
              borderRadius: 8,
            } : undefined}
          >
            <div className="quick-actions" id="quick-actions">
              <CategoryTabs
              activeCategoria={categoria}
              initialHasOfertas={hasOfertas}
            />
            </div>
          </div>
          <SizeFilterSheet
            activeSizes={activeSizes}
            categoria={effectiveCategoria}
            products={searched}
            onNeedCategory={handleNeedCategory}
            highlight={highlightTalles}
          />
        </div>

        {contextCategoria && contextCategoria !== "all" && (
          <CategoryContextBar
            categoria={contextCategoria}
            count={filtered.length}
            hideCount={showTagBar}
          />
        )}
      </div>

      {/* Tooltip: renderizado debajo del contenedor sticky, fuera de él */}
      {highlightCats && mounted && createPortal(
        <div style={{
          position: "fixed",
          top: 108,   /* header (~56px) + sticky bar (~44px) + gap */
          left: "50%",
          transform: "translateX(-50%)",
          background: "#222",
          color: "#fff",
          fontSize: 12,
          fontWeight: 500,
          padding: "7px 14px",
          borderRadius: 20,
          whiteSpace: "nowrap",
          pointerEvents: "none",
          zIndex: 999,
          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
          animation: "fyl-tooltip-in 0.15s ease",
        }}>
          Seleccioná una categoría primero
        </div>,
        document.body
      )}

      {/* Keyframes para el blink, tooltip y pulse */}
      <style>{`
        @keyframes fyl-blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
        @keyframes fyl-tooltip-in {
          from { opacity: 0; transform: translateX(-50%) translateY(-4px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes fyl-talles-pulse {
          0%, 100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(205,132,77,0.4); }
          50%       { transform: scale(1.08); box-shadow: 0 0 0 6px rgba(205,132,77,0); }
        }
      `}</style>

      {/* Banners above grid: hidden when there's an active search */}
      {!searchTerm && aboveGridSlot}

      {/* Active filter bar */}
      {showTagBar && (
        <TagFilterBar
          searchTerm={searchTerm}
          activeSizes={activeSizes}
          activeTags={tags}
          totalResults={filtered.length}
        />
      )}

      {/* Catalog grid */}
      <div id="catalogo" className="catalogo">
        <div id="catalog-container">
          {displayProducts.map((product, i) => {
            const card = (
              <ProductCard
                key={product.Articulo}
                product={product}
                href={`/producto/${encodeURIComponent(product.Articulo)}?from=${encodeURIComponent(currentUrl)}`}
                priority={i < 4}
                activeSizes={activeSizes}
                categoria={effectiveCategoria}
              />
            );
            // Insert curated banner slot after the 4th product (index 3)
            if (i === 3 && curatedSlot) {
              return (
                <React.Fragment key={product.Articulo}>
                  {card}
                  {curatedSlot}
                </React.Fragment>
              );
            }
            return card;
          })}
          {/* Loading skeletons */}
          {isLoadingMore &&
            allProducts.length === 0 &&
            Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={`sk-${i}`} />
            ))}
        </div>
      </div>

      {/* Sentinel — always in DOM so the observer never loses its target */}
      <div
        ref={sentinelRef}
        style={{ height: 1, visibility: "hidden" }}
        aria-hidden="true"
      />

      {/* Loading indicator */}
      {isLoadingMore && !fixedProductSet && allProducts.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "16px",
          }}
          aria-live="polite"
        >
          <div className="spinner" aria-label="Cargando más productos" />
        </div>
      )}

      {/* End of results */}
      {!canLoadMore && !isLoadingMore && filtered.length === 0 && searchTerm && (
        <div
          style={{ textAlign: "center", padding: "32px 16px", color: "#666" }}
        >
          No se encontraron productos para &ldquo;{searchTerm}&rdquo;
        </div>
      )}
    </>
  );
}
