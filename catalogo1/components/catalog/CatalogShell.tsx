"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams, usePathname } from "next/navigation";
import { useCatalog } from "@/hooks/useCatalog";
import { useEnrichedCatalog } from "@/hooks/useEnrichedCatalog";
import { productHasAnyStock } from "@/lib/utils/catalog-variant-enrich";
import { searchProducts, filterBySizes } from "@/lib/utils/search";
import { useSearchDictionary } from "@/hooks/useSearchDictionary";
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
import {
  reconcileDisplayProducts,
  resolvePreviousForFilter,
  type PaintedGridState,
} from "@/lib/catalog/reconcile-display-products";
import type { GroupedProduct } from "@/types/catalog";

const INITIAL_DISPLAY = 14;
const DISPLAY_INCREMENT = 14;

type CatalogScrollState = {
  displayCount: number;
  scrollY: number;
  anchorArticulo?: string;
  anchorTop?: number;
  savedAt?: number;
};

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
  const searchDictionary = useSearchDictionary();
  const activeSizes = searchParams
    .get("talle")
    ?.split(",")
    .filter(Boolean) ?? [];

  const currentUrl = searchParams.toString()
    ? `${pathname}?${searchParams}`
    : pathname;

  const [displayCount, setDisplayCount] = useState(INITIAL_DISPLAY);
  const [highlightCats, setHighlightCats] = useState(false);
  const [highlightTalles, setHighlightTalles] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

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

  const { products: enrichedProducts, isEnriching } = useEnrichedCatalog(
    baseProducts,
    searchTerm
  );

  const canLoadMore = !fixedProductSet && hasMore;

  const browsing = searchTerm.length < 2;
  const useStableGrid = browsing && !fixedProductSet;

  const catalogPool = React.useMemo(() => {
    const withImages = enrichedProducts.filter(
      (p) => (p.DetalleColor?.length ?? 0) > 0
    );
    if (fixedProductSet || !browsing) return withImages;
    if (isEnriching) return withImages;
    return withImages.filter(productHasAnyStock);
  }, [enrichedProducts, browsing, fixedProductSet, isEnriching]);

  const tagFiltered = React.useMemo(
    () => filterProductsByTags(catalogPool, tags),
    [catalogPool, tags]
  );

  const searched = React.useMemo(
    () =>
      searchTerm.length >= 2
        ? searchProducts(tagFiltered, searchTerm, searchDictionary)
        : tagFiltered,
    [tagFiltered, searchTerm, searchDictionary]
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

  useEffect(() => {
    if (catalogPool.length > 0) {
      (window as Window & { __fylProducts?: GroupedProduct[] }).__fylProducts =
        catalogPool;
    }
  }, [catalogPool]);

  const filterKey = `${categoria}|${tags.join(",")}|${searchTerm}|${activeSizes.join(",")}`;
  const paintedStateRef = useRef<PaintedGridState>({
    filterKey: "",
    products: [],
  });

  useEffect(() => {
    setDisplayCount(INITIAL_DISPLAY);
  }, [filterKey]);

  const previousForReconcile = resolvePreviousForFilter(
    paintedStateRef.current,
    filterKey
  );

  const displayProducts = React.useMemo(() => {
    if (!useStableGrid) {
      return filtered.slice(0, displayCount);
    }
    return reconcileDisplayProducts({
      previous: previousForReconcile,
      nextPool: filtered,
      slotCount: displayCount,
      isEnriching,
    });
  }, [
    filtered,
    displayCount,
    isEnriching,
    useStableGrid,
    filterKey,
    previousForReconcile,
  ]);

  paintedStateRef.current = { filterKey, products: displayProducts };

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const hasMoreRef = useRef(canLoadMore);
  hasMoreRef.current = canLoadMore;
  const displayCountRef = useRef(displayCount);
  displayCountRef.current = displayCount;

  const scrollStorageKey = `fyl-catalogo-scroll:${currentUrl}`;
  const scrollSaveTimeoutRef = useRef<number | null>(null);
  const restoreStateRef = useRef<CatalogScrollState | null>(null);
  const restoredKeyRef = useRef<string | null>(null);

  const saveCatalogState = React.useCallback(
    (anchorArticulo?: string, anchorTop?: number) => {
      try {
        sessionStorage.setItem(
          scrollStorageKey,
          JSON.stringify({
            displayCount: displayCountRef.current,
            scrollY: window.scrollY,
            anchorArticulo,
            anchorTop,
            savedAt: Date.now(),
          } satisfies CatalogScrollState)
        );
      } catch {
        /* ignore */
      }
    },
    [scrollStorageKey]
  );

  useEffect(() => {
    try {
      restoreStateRef.current = null;
      restoredKeyRef.current = null;
      const raw = sessionStorage.getItem(scrollStorageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as CatalogScrollState;
      restoreStateRef.current = saved;
      if (saved.displayCount > INITIAL_DISPLAY) {
        setDisplayCount(saved.displayCount);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollStorageKey]);

  useEffect(() => {
    const saved = restoreStateRef.current;
    if (!saved || restoredKeyRef.current === scrollStorageKey) return;

    let cancelled = false;
    const restore = () => {
      if (cancelled) return;

      if (saved.anchorArticulo) {
        const anchor = Array.from(
          document.querySelectorAll<HTMLElement>("[data-articulo]")
        ).find((el) => el.dataset.articulo === saved.anchorArticulo);

        if (anchor) {
          const targetY =
            window.scrollY +
            anchor.getBoundingClientRect().top -
            (saved.anchorTop ?? 0);
          window.scrollTo(0, Math.max(0, targetY));
          restoredKeyRef.current = scrollStorageKey;
          return;
        }
      }

      const expectedCount = Math.min(
        saved.displayCount,
        filtered.length || saved.displayCount
      );
      if (displayProducts.length >= expectedCount || !isEnriching) {
        window.scrollTo(0, saved.scrollY);
        restoredKeyRef.current = scrollStorageKey;
      }
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(restore);
    });

    return () => {
      cancelled = true;
    };
  }, [displayProducts.length, filtered.length, isEnriching, scrollStorageKey]);

  useEffect(() => {
    const handleScroll = () => {
      if (scrollSaveTimeoutRef.current)
        window.clearTimeout(scrollSaveTimeoutRef.current);
      scrollSaveTimeoutRef.current = window.setTimeout(
        () => saveCatalogState(),
        200
      );
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollSaveTimeoutRef.current)
        window.clearTimeout(scrollSaveTimeoutRef.current);
    };
  }, [scrollStorageKey, saveCatalogState]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        const currentFiltered = filteredRef.current;
        const currentDisplayCount = displayCountRef.current;
        const currentHasMore = hasMoreRef.current;

        if (currentDisplayCount >= currentFiltered.length && !currentHasMore)
          return;

        setDisplayCount((c) => c + DISPLAY_INCREMENT);

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

  const showHomeBanners =
    searchTerm.trim().length < 2 &&
    activeSizes.length === 0 &&
    tags.length === 0;

  return (
    <>
      <div className="catalog-category-zone">
        <div className="quick-actions-container">
          <div
            className="category-bar"
            id="category-bar"
            aria-label="Categorías del catálogo"
            style={
              highlightCats
                ? {
                    animation: "fyl-blink 0.4s ease 3",
                    outline: "2px solid #CD844D",
                    outlineOffset: 2,
                    borderRadius: 8,
                  }
                : undefined
            }
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

      {highlightCats &&
        mounted &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: 108,
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
            }}
          >
            Seleccioná una categoría primero
          </div>,
          document.body
        )}

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

      {showHomeBanners && aboveGridSlot}

      {showTagBar && (
        <TagFilterBar
          searchTerm={searchTerm}
          activeSizes={activeSizes}
          activeTags={tags}
          totalResults={filtered.length}
        />
      )}

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
                onNavigate={(element) => {
                  saveCatalogState(
                    product.Articulo,
                    element.getBoundingClientRect().top
                  );
                }}
              />
            );
            if (i === 3 && showHomeBanners && curatedSlot) {
              return (
                <React.Fragment key={product.Articulo}>
                  {card}
                  {curatedSlot}
                </React.Fragment>
              );
            }
            return card;
          })}
          {isLoadingMore &&
            allProducts.length === 0 &&
            Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={`sk-${i}`} />
            ))}
        </div>
      </div>

      <div
        ref={sentinelRef}
        style={{ height: 1, visibility: "hidden" }}
        aria-hidden="true"
      />

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
