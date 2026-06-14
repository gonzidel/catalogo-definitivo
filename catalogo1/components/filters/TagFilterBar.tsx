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

  const hasSearch = searchTerm.length > 0;
  const hasSizes = activeSizes.length > 0;
  const hasTags = activeTags.length > 0;
  const countLabel = `${totalResults} producto${totalResults !== 1 ? "s" : ""}`;
  const showCountAfterText = !hasTags;

  const filterType = hasSearch ? "search" : hasSizes ? "size" : "tag";

  return (
    <div className="tag-filter-bar" data-filter-type={filterType}>
      <div className="tag-filter-body">
        {hasSearch && (
          <span className="tag-filter-text">
            Buscando:{" "}
            <strong className="tag-filter-value">&ldquo;{searchTerm}&rdquo;</strong>
            {hasSizes && (
              <>
                {" "}
                <span className="tag-filter-sep">•</span> Talles:{" "}
                <strong className="tag-filter-size-value">
                  {activeSizes.join(", ")}
                </strong>
              </>
            )}
            {showCountAfterText && (
              <>
                {" "}
                <span className="tag-filter-sep">•</span>{" "}
                <span className="tag-filter-count">{countLabel}</span>
              </>
            )}
          </span>
        )}

        {!hasSearch && hasSizes && (
          <span className="tag-filter-text">
            Talles:{" "}
            <strong className="tag-filter-size-value">
              {activeSizes.join(", ")}
            </strong>
            {showCountAfterText && (
              <>
                {" "}
                <span className="tag-filter-sep">•</span>{" "}
                <span className="tag-filter-count">{countLabel}</span>
              </>
            )}
          </span>
        )}

        {hasTags && (
          <div className="tag-filter-chips-wrap">
            <span className="tag-filter-chips-label">Tags:</span>
            <div className="tag-filter-chips">
              {activeTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="tag-filter-chip"
                  onClick={() => removeTag(tag)}
                  aria-label={`Quitar tag ${tag}`}
                >
                  {tag}
                  <span className="tag-filter-chip__remove" aria-hidden="true">
                    ×
                  </span>
                </button>
              ))}
            </div>
            <span className="tag-filter-count">{countLabel}</span>
          </div>
        )}
      </div>

      <button
        type="button"
        className="tag-filter-clear"
        onClick={clearAll}
        aria-label="Quitar todos los filtros"
      >
        ✕
      </button>
    </div>
  );
}
