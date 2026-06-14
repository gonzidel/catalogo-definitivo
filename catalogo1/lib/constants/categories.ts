export type CategoryIconId =
  | "calzado"
  | "ropa"
  | "lenceria"
  | "marroquineria"
  | "ofertas";

export interface CategoryDefinition {
  slug: string;
  label: string;
  desc: string;
  icon: CategoryIconId;
}

/** Siempre visibles en la barra de categorías (sin Otros ni Novedades). */
const NAV_CATEGORIES_BEFORE_OFERTAS: CategoryDefinition[] = [
  {
    slug: "calzado",
    label: "Calzado",
    desc: "Zapatillas, botas y más",
    icon: "calzado",
  },
  {
    slug: "ropa",
    label: "Ropa",
    desc: "Prendas para mujer",
    icon: "ropa",
  },
];

const NAV_CATEGORIES_AFTER_OFERTAS: CategoryDefinition[] = [
  {
    slug: "lenceria",
    label: "Lencería",
    desc: "Conjuntos y accesorios íntimos",
    icon: "lenceria",
  },
  {
    slug: "marroquineria",
    label: "Marroquinería",
    desc: "Carteras y bolsos",
    icon: "marroquineria",
  },
];

export const OFERTAS_CATEGORY: CategoryDefinition = {
  slug: "ofertas",
  label: "Ofertas",
  desc: "Precios especiales",
  icon: "ofertas",
};

/** Todas las categorías con página propia (p. ej. head de /ofertas). */
export const ALL_CATEGORIES: CategoryDefinition[] = [
  ...NAV_CATEGORIES_BEFORE_OFERTAS,
  OFERTAS_CATEGORY,
  ...NAV_CATEGORIES_AFTER_OFERTAS,
];

/** Chips de navegación: Ofertas en 3.er lugar solo si hay stock en oferta. */
export function buildNavCategories(hasOfertas: boolean): CategoryDefinition[] {
  const list = [...NAV_CATEGORIES_BEFORE_OFERTAS];
  if (hasOfertas) list.push(OFERTAS_CATEGORY);
  list.push(...NAV_CATEGORIES_AFTER_OFERTAS);
  return list;
}

export function findCategory(categoria: string): CategoryDefinition | undefined {
  const key = categoria.trim().toLowerCase();
  return (
    ALL_CATEGORIES.find((c) => c.slug === key) ??
    ALL_CATEGORIES.find((c) => c.label.toLowerCase() === key)
  );
}
