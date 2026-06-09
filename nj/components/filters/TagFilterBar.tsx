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

  const clearSearch = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("q");
    router.push(`${pathname}?${params}`);
  }, [router, pathname, searchParams]);

  const clearSizes = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("talle");
    router.push(`${pathname}?${params}`);
  }, [router, pathname, searchParams]);

  return (
    <div
      className="tag-filter-bar"
      style={{ gridColumn: "1 / -1" }}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {searchTerm && (
          <span className="talle tag-chip">
            Búsqueda: &ldquo;{searchTerm}&rdquo;
            <button
              onClick={clearSearch}
              aria-label="Limpiar búsqueda"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                marginLeft: 4,
                padding: "0 2px",
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </span>
        )}
        {activeSizes.map((size) => (
          <span key={size} className="talle tag-chip">
            Talle: {size}
            <button
              onClick={clearSizes}
              aria-label={`Quitar talle ${size}`}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                marginLeft: 4,
                padding: "0 2px",
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </span>
        ))}
        {activeTags.map((tag) => (
          <span key={tag} className="talle tag-chip">
            {tag}
          </span>
        ))}
      </div>
      <span style={{ fontSize: 13, color: "#666", whiteSpace: "nowrap" }}>
        {totalResults} producto{totalResults !== 1 ? "s" : ""}
      </span>
    </div>
  );
}
