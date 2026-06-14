"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buildNavCategories } from "@/lib/constants/categories";
import { BASE_PATH } from "@/lib/constants/app";

function OfertasFlameIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.5 1-3 1-5 2 0 4 2.5 4 6a4 4 0 1 1-8 0c0-1.5.5-2.5 1.5-3.5z" />
      <path d="M12 22c3-2 5-5 5-9 0-4-2-7-5-9-3 2-5 5-5 9 0 4 2 7 5 9z" opacity="0.35" />
    </svg>
  );
}

interface CategoryTabsProps {
  activeCategoria: string;
  /** Si viene del servidor, no se vuelve a consultar. */
  initialHasOfertas?: boolean;
}

export default function CategoryTabs({
  activeCategoria,
  initialHasOfertas,
}: CategoryTabsProps) {
  const [hasOfertas, setHasOfertas] = useState(initialHasOfertas ?? false);

  useEffect(() => {
    if (initialHasOfertas !== undefined) return;
    let cancelled = false;
    fetch(`${BASE_PATH}/api/catalog/has-ofertas`)
      .then((r) => r.json())
      .then((d: { has?: boolean }) => {
        if (!cancelled) setHasOfertas(!!d.has);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialHasOfertas]);

  const categories = buildNavCategories(hasOfertas);

  return (
    <>
      {categories.map(({ slug, label }) => {
        const isActive = activeCategoria.toLowerCase() === slug;
        const isOfertas = slug === "ofertas";

        if (isOfertas) {
          return (
            <Link
              key={slug}
              href={`/${slug}`}
              className={[
                "category-chip",
                "category-chip--ofertas",
                isActive ? "category-chip--active is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span className="category-chip__flame" aria-hidden="true">
                <OfertasFlameIcon />
              </span>
              <span className="category-chip__label">{label}</span>
            </Link>
          );
        }

        return (
          <Link
            key={slug}
            href={`/${slug}`}
            className={`category-chip${isActive ? " category-chip--active" : ""}`}
            style={
              isActive
                ? {
                    background: "#CD844D",
                    color: "#fff",
                    fontWeight: 700,
                    border: "2px solid #A8612E",
                    boxShadow: "0 2px 8px rgba(205,132,77,0.4)",
                  }
                : { opacity: 0.72 }
            }
          >
            {label}
          </Link>
        );
      })}
    </>
  );
}
