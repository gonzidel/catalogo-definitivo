import type { CategoryIconId } from "@/lib/constants/categories";

interface CategoryIconProps {
  id: CategoryIconId;
  className?: string;
}

const SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Iconos lineales alineados con bottom-nav y botón Talles. */
export default function CategoryIcon({ id, className }: CategoryIconProps) {
  switch (id) {
    case "calzado":
      return (
        <svg {...SVG_PROPS} className={className}>
          <path d="M3 18h16v-6a4 4 0 0 0-4-4h-2l-2-4h-4l-2 4H7a4 4 0 0 0-4 4v6" />
          <path d="M8 13h8" />
        </svg>
      );
    case "ropa":
      return (
        <svg {...SVG_PROPS} className={className}>
          <path d="M12 3l4 4v14H8V7l4-4z" />
          <path d="M8 7h8" />
        </svg>
      );
    case "lenceria":
      return (
        <svg {...SVG_PROPS} className={className}>
          <path d="M12 21s-6-4.35-6-10a4 4 0 0 1 8 0c0 5.65-6 10-6 10z" />
        </svg>
      );
    case "marroquineria":
      return (
        <svg {...SVG_PROPS} className={className}>
          <path d="M8 8V6a4 4 0 0 1 8 0v2" />
          <path d="M6 8h12l-1 13H7L6 8z" />
        </svg>
      );
    case "ofertas":
      return (
        <svg {...SVG_PROPS} className={className}>
          <path d="M12 22c4-3 6-6 6-10 0-3.5-1.5-6-4-8-1.5 2.5-2.5 4.5-2.5 6.5 0 1.2.3 2.2.8 3.2C10.5 12 8 10.5 8 8c0 2 1 4 4 6z" />
        </svg>
      );
    default:
      return null;
  }
}
