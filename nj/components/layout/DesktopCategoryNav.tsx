"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { buildNavCategories } from "@/lib/constants/categories";

/** Navegación de categorías del encabezado. Solo se muestra desde 1024px. */
export default function DesktopCategoryNav() {
  const pathname = usePathname();
  const [hasOfertas, setHasOfertas] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/catalog/has-ofertas")
      .then((r) => r.json())
      .then((d: { has?: boolean }) => {
        if (!cancelled) setHasOfertas(!!d.has);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = buildNavCategories(hasOfertas);
  const current = (pathname ?? "/")
    .replace(/^\//, "")
    .split("/")[0]
    ?.toLowerCase() ?? "";

  return (
    <nav className="desktop-cat-nav" aria-label="Categorías">
      <Link
        href="/"
        className={`desktop-cat-nav__link${pathname === "/" ? " is-active" : ""}`}
      >
        Inicio
      </Link>
      {categories.map((cat) => {
        const active = current === cat.slug;
        return (
          <Link
            key={cat.slug}
            href={`/${cat.slug}`}
            className={[
              "desktop-cat-nav__link",
              active ? "is-active" : "",
              cat.slug === "ofertas" ? "desktop-cat-nav__link--ofertas" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {cat.label}
          </Link>
        );
      })}
    </nav>
  );
}
