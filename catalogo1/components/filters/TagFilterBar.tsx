"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface TagFilterBarProps {
  searchTerm: string;
  activeSizes: string[];
  activeTags: string[];
  totalResults: number;
}

export default function TagFilterBar({
  searchTerm,
  activeSizes,
  activeTags,
  totalResults,
}: TagFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const clearAll = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("q");
    params.delete("talle");
    const qs = params.toString();

    if (activeTags.length > 0) {
      router.push(qs ? `/?${qs}` : "/");
      return;
    }
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }, [router, pathname, searchParams, activeTags.length]);

  const removeTag = useCallback(
    (tag: string) => {
      const remaining = activeTags.filter((t) => t !== tag);
      const params = new URLSearchParams(searchParams.toString());
      const qs = params.toString();

      if (remaining.length === 0) {
        router.push(qs ? `/?${qs}` : "/");
        return;
      }
      const tagPath = `/tags/${remaining.map((t) => encodeURIComponent(t)).join("/")}`;
      router.push(qs ? `${tagPath}?${qs}` : tagPath);
    },
    [router, activeTags, searchParams]
  );

  const removeSize = useCallback(
    (size: string) => {
      const remaining = activeSizes.filter((s) => s !== size);
      const params = new URLSearchParams(searchParams.toString());
      if (remaining.length === 0) {
        params.delete("talle");
      } else {
        params.set("talle", remaining.join(","));
      }
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, activeSizes, searchParams]
  );

  const hasSearch = searchTerm.length > 0;
  const hasSizes = activeSizes.length > 0;
  const hasTags = activeTags.length > 0;
  const onlySearch = hasSearch && !hasSizes && !hasTags;
  const countLabel = `${totalResults} producto${totalResults !== 1 ? "s" : ""}`;

  const filterType = hasSearch ? "search" : hasSizes ? "size" : "tag";

  if (onlySearch) {
    return (
      <div className="tag-filter-bar" data-filter-type="search">
        <div className="tag-filter-search-summary">
          <span className="tag-filter-text">
            Buscando{" "}
            <strong className="tag-filter-value">&ldquo;{searchTerm}&rdquo;</strong>
          </span>
          <span className="tag-filter-count">{countLabel}</span>
        </div>

        <button
          type="button"
          className="tag-filter-clear"
          onClick={clearAll}
          aria-label="Quitar búsqueda"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="tag-filter-bar" data-filter-type={filterType}>
      {/* Fila 1: chips — envuelven libremente, cuantos hagan falta.
          Fila 2 (footer): conteo a la izquierda + botón de cerrar SIEMPRE
          pegado a la derecha, de forma explícita — antes dependía de
          cuánto espacio sobraba en la línea de los chips, así que a veces
          el botón quedaba "colgado" en el medio en vez de en un lugar fijo. */}
      <div className="tag-filter-chips-row">
        {hasSearch && (
          <span className="tag-filter-text">
            Buscando:{" "}
            <strong className="tag-filter-value">&ldquo;{searchTerm}&rdquo;</strong>
          </span>
        )}

        {activeSizes.map((size) => (
          <button
            key={`size-${size}`}
            type="button"
            className="tag-filter-chip"
            onClick={() => removeSize(size)}
            aria-label={`Quitar talle ${size}`}
          >
            Talle {size}
            <span className="tag-filter-chip__remove" aria-hidden="true">×</span>
          </button>
        ))}

        {activeTags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="tag-filter-chip"
            onClick={() => removeTag(tag)}
            aria-label={`Quitar tag ${tag}`}
          >
            {tag}
            <span className="tag-filter-chip__remove" aria-hidden="true">×</span>
          </button>
        ))}
      </div>

      <div className="tag-filter-footer">
        <span className="tag-filter-count">{countLabel}</span>

        {(hasSearch || hasSizes || hasTags) && (
          <button
            type="button"
            className="tag-filter-clear"
            onClick={clearAll}
            aria-label="Quitar todos los filtros"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
