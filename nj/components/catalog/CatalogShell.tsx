"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { useCatalog } from "@/hooks/useCatalog";
import { useEnrichedCatalog } from "@/hooks/useEnrichedCatalog";
import { productHasAnyStock } from "@/lib/utils/catalog-variant-enrich";
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
  const activeSizes = searchParams
    .get("talle")
    ?.split(",")
    .filter(Boolean) ?? [];

  // Build the current URL to pass as `from` param to PDP
  const currentUrl = searchParams.toString()
    ? `${pathname}?${searchParams}`
    : pathname;

  const [displayCount, setDisplayCount] = useState(INITIAL_DISPLAY);
  const [highlightTalles, setHighlightTalles] = useState(false);

  const prevCategoriaRef = useRef(categoria);
  useEffect(() => {
    if (prevCategoriaRef.current === categoria) return;
    prevCategoriaRef.current = categoria;
    if (categoria && categoria !== "all") {
      setHighlightTalles(true);
      setTimeout(() => setHighlightTalles(false), 2000);
    }
  }, [categoria]);

  // Talles solo con categoría real (Calzado, Ropa, …) — no en home / ofertas / tags.
  const showSizeFilter = [
    "calzado",
    "ropa",
    "lenceria",
    "marroquineria",
    "otros",
  ].includes(categoria.toLowerCase());

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

  const catalogPool = React.useMemo(() => {
    const withImages = enrichedProducts.filter(
      (p) => (p.DetalleColor?.length ?? 0) > 0
    );
    const browsing =
      searchTerm.length < 2 && activeSizes.length === 0 && tags.length === 0;
    // No filtrar por stock mientras el enriquecimiento está en curso para evitar
    // el flash de productos sin stock que luego desaparecen.
    if (fixedProductSet || !browsing || isEnriching) return withImages;
    return withImages.filter(productHasAnyStock);
  }, [enrichedProducts, searchTerm, activeSizes, tags, fixedProductSet, isEnriching]);

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

  // ─── Restaurar scroll + cantidad cargada al volver del PDP ────────────────
  // Sin esto, volver del PDP con el botón atrás arranca siempre desde arriba
  // con solo 14 productos. La clave: esto no dispara ningún fetch — SWR ya
  // tiene los productos en caché (revalidateOnFocus:false), así que subir
  // displayCount es solo un slice() más largo sobre datos ya en memoria, y
  // sessionStorage es síncrono. Cero latencia extra en la vuelta.
  const scrollStorageKey = `fyl-nj-catalog-scroll:${currentUrl}`;
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
      } catch { /* ignore */ }
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
      restoredKeyRef.current = null;
      if (saved.displayCount > INITIAL_DISPLAY) {
        setDisplayCount(saved.displayCount);
      }
    } catch { /* sessionStorage no disponible o dato corrupto — no bloquea nada */ }
    // Solo depende de la identidad de esta vista (filtros/búsqueda actuales).
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
            window.scrollY + anchor.getBoundingClientRect().top - (saved.anchorTop ?? 0);
          window.scrollTo(0, Math.max(0, targetY));
          restoredKeyRef.current = scrollStorageKey;
          return;
        }
      }

      const expectedCount = Math.min(saved.displayCount, filtered.length || saved.displayCount);
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
    // Debounce de 200ms tras dejar de scrollear — no escribimos en
    // sessionStorage en cada frame para no meter jank en el scroll real.
    const handleScroll = () => {
      if (scrollSaveTimeoutRef.current) window.clearTimeout(scrollSaveTimeoutRef.current);
      scrollSaveTimeoutRef.current = window.setTimeout(() => saveCatalogState(), 200);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollSaveTimeoutRef.current) window.clearTimeout(scrollSaveTimeoutRef.current);
    };
  }, [scrollStorageKey, saveCatalogState]);

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

  const showHomeBanners =
    searchTerm.trim().length < 2 &&
    activeSizes.length === 0 &&
    tags.length === 0;

  return (
    <>
      {/* Zona categoría: chips (gris) + head (blanco), sin solapamiento */}
      <div className="catalog-category-zone">
        <div className="quick-actions-container">
          <div
            className="category-bar"
            id="category-bar"
            aria-label="Categorías del catálogo"
          >
            <div className="quick-actions" id="quick-actions">
              <CategoryTabs
              activeCategoria={categoria}
              initialHasOfertas={hasOfertas}
            />
            </div>
          </div>
          {showSizeFilter && (
            <SizeFilterSheet
              activeSizes={activeSizes}
              categoria={categoria}
              products={searched}
              highlight={highlightTalles}
            />
          )}
        </div>

        {contextCategoria && contextCategoria !== "all" && (
          <CategoryContextBar
            categoria={contextCategoria}
            count={filtered.length}
            hideCount={showTagBar}
          />
        )}
      </div>

      <style>{`
        @keyframes fyl-talles-pulse {
          0%, 100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(205,132,77,0.4); }
          50%       { transform: scale(1.08); box-shadow: 0 0 0 6px rgba(205,132,77,0); }
        }
      `}</style>

      {/* Banners above grid: solo navegación normal, no en búsqueda/filtros */}
      {showHomeBanners && aboveGridSlot}

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
                onNavigate={(element) =>
                  saveCatalogState(product.Articulo, element.getBoundingClientRect().top)
                }
              />
            );
            // Insert curated banner slot after the 4th product (index 3)
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
