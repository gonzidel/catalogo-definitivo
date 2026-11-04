import type { ReactNode } from "react";
import CategoryTabs from "@/components/filters/CategoryTabs";
import CategoryContextBar from "@/components/filters/CategoryContextBar";
import SkeletonCard from "@/components/catalog/SkeletonCard";
import { findCategory } from "@/lib/constants/categories";

const SIZE_FILTER_CATEGORIES = new Set([
  "calzado",
  "ropa",
  "lenceria",
  "marroquineria",
  "otros",
]);

export type CatalogShellSkeletonProps = {
  /** Categoría de la ruta (all = home/tags). */
  categoria?: string;
  /** Reserva chip Ofertas (misma geometría que tabs finales). */
  hasOfertas?: boolean;
  /** Slot de banners (solo home). */
  bannersSlot?: ReactNode;
  /** Cantidad de skeleton cards en el grid. */
  gridCount?: number;
};

/**
 * Fallback Suspense estructuralmente alineado con CatalogShell:
 * tabs + (talles) + (context) + banners opcionales + grid.
 */
export default function CatalogShellSkeleton({
  categoria = "all",
  hasOfertas = true,
  bannersSlot,
  gridCount = 8,
}: CatalogShellSkeletonProps) {
  const catKey = categoria.toLowerCase();
  const showSizeFilter = SIZE_FILTER_CATEGORIES.has(catKey);
  const contextCat = catKey !== "all" ? findCategory(catKey) : undefined;

  return (
    <>
      <div className="catalog-category-zone" aria-hidden="true">
        <div className="quick-actions-container">
          <div className="category-bar" id="category-bar">
            <div className="quick-actions" id="quick-actions">
              <CategoryTabs
                activeCategoria={categoria}
                initialHasOfertas={hasOfertas}
              />
            </div>
          </div>
          {showSizeFilter && (
            <button
              type="button"
              className="size-filter-chip"
              id="size-filter-btn-skeleton"
              tabIndex={-1}
              disabled
              aria-hidden="true"
            >
              <span className="size-filter-chip__label">Talles</span>
            </button>
          )}
        </div>
        {contextCat && (
          <CategoryContextBar categoria={contextCat.slug} count={0} hideCount />
        )}
      </div>

      {bannersSlot}

      <div id="catalogo" className="catalogo">
        <div id="catalog-container">
          {Array.from({ length: gridCount }).map((_, i) => (
            <SkeletonCard key={`sk-${i}`} />
          ))}
        </div>
      </div>
    </>
  );
}
