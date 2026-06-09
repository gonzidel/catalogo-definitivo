"use client";

import Link from "next/link";

export const CATEGORIES = [
  { slug: "calzado",       label: "Calzado",       icon: "👟", desc: "Zapatillas, botas y más" },
  { slug: "ropa",          label: "Ropa",           icon: "👗", desc: "Prendas para mujer" },
  { slug: "lenceria",      label: "Lencería",       icon: "✨", desc: "Conjuntos y accesorios íntimos" },
  { slug: "marroquineria", label: "Marroquinería",  icon: "👜", desc: "Carteras y bolsos" },
  { slug: "otros",         label: "Otros",          icon: "🛍️", desc: "Variedad de productos" },
  { slug: "novedades",     label: "Novedades ⭐",   icon: "🆕", desc: "Últimos ingresos" },
  { slug: "ofertas",       label: "Ofertas 🔥",     icon: "🏷️", desc: "Precios especiales" },
];

interface CategoryTabsProps {
  activeCategoria: string;
}

export default function CategoryTabs({ activeCategoria }: CategoryTabsProps) {
  return (
    <>
      {CATEGORIES.map(({ slug, label }) => {
        const isActive = activeCategoria.toLowerCase() === slug;
        return (
          <Link
            key={slug}
            href={`/${slug}`}
            className={`category-chip${isActive ? " category-chip--active" : ""}`}
            style={isActive ? {
              background: "#CD844D",
              color: "#fff",
              fontWeight: 700,
              border: "2px solid #A8612E",
              boxShadow: "0 2px 8px rgba(205,132,77,0.4)",
            } : {
              opacity: 0.72,
            }}
          >
            {label}
          </Link>
        );
      })}
    </>
  );
}
