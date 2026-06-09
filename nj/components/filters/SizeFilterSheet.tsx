"use client";

import { useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { compareCatalogSizes } from "@/lib/utils/size-normalizer";

// ─── Size sets ────────────────────────────────────────────────────────────────

const CALZADO_SIZES = [
  "18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33",
  "34","35","36","37","38","39","40","41","42",
];

const ROPA_SIZES = [
  // Niños/niñas
  "1","2","3","4","6","8","10","12","14",
  // Talle genérico
  "XS","S","M","L","XL","2XL","3XL","4XL",
  // Pantalones numéricos
  "40","42","44","46",
  // Único
  "U",
];

const OTROS_SIZES = ["U", "XS", "S", "M", "L", "XL", "2XL"];

type SizeGroup = "calzado" | "ropa" | "otros" | null;

function groupFromCategoria(cat: string): SizeGroup {
  const c = cat.toLowerCase();
  if (c === "calzado") return "calzado";
  if (c === "ropa" || c === "lenceria" || c === "marroquineria" || c === "accesorios") return "ropa";
  if (c === "otros") return "otros";
  return null; // "all" → needs selection
}

function sizesForGroup(group: SizeGroup): string[] {
  if (group === "calzado") return CALZADO_SIZES;
  if (group === "ropa")    return ROPA_SIZES;
  if (group === "otros")   return OTROS_SIZES;
  return [];
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface SizeFilterSheetProps {
  activeSizes: string[];
  categoria: string;
  /** Called when user taps Talles without a category selected */
  onNeedCategory?: () => void;
  /** Pulse the button to invite the user to filter by size */
  highlight?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SizeFilterSheet({
  activeSizes,
  categoria,
  onNeedCategory,
  highlight,
}: SizeFilterSheetProps) {
  const [isOpen, setIsOpen]     = useState(false);
  const [selected, setSelected] = useState<string[]>(activeSizes);
  const [mounted, setMounted]   = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const router       = useRouter();
  const pathname     = usePathname();
  const searchParams = useSearchParams();

  const group    = groupFromCategoria(categoria);
  const needsCat = group === null;
  const sizes    = sizesForGroup(group).sort(compareCatalogSizes);
  const hasActive = activeSizes.length > 0;

  const open = useCallback(() => {
    if (needsCat) {
      onNeedCategory?.();
      return;
    }
    setSelected(activeSizes);
    setIsOpen(true);
  }, [needsCat, activeSizes, onNeedCategory]);

  const close = useCallback(() => setIsOpen(false), []);

  const toggleSize = (size: string) =>
    setSelected((prev) =>
      prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size]
    );

  const apply = () => {
    const params = new URLSearchParams(searchParams.toString());
    if (selected.length > 0) params.set("talle", selected.join(","));
    else params.delete("talle");
    router.push(`${pathname}?${params}`);
    close();
  };

  const clear = () => {
    setSelected([]);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("talle");
    router.push(`${pathname}?${params}`);
    close();
  };

  const groupLabel = group === "calzado" ? "Calzado" : group === "otros" ? "Otros" : "Ropa";

  return (
    <>
      {/* Trigger */}
      <button
        type="button"
        className={`size-filter-chip${hasActive ? " size-filter-chip--active" : ""}`}
        id="size-filter-btn"
        aria-label="Filtrar por talle"
        onClick={open}
        style={highlight ? {
          animation: "fyl-talles-pulse 0.5s ease 3",
          background: "#CD844D",
          color: "#fff",
          borderColor: "#B8703E",
        } : undefined}
      >
        <span className="size-filter-chip__icon filter-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </span>
        <span className="size-filter-chip__label">
          {hasActive ? `Talles (${activeSizes.length})` : "Talles"}
        </span>
      </button>

      {/* Modal — portal so position:fixed escapes any sticky/transform ancestor */}
      {mounted && createPortal(
        <div
          className={`size-filter-modal${isOpen ? " active" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={`Talles — ${groupLabel}`}
          aria-hidden={!isOpen}
        >
          <div className="size-filter-overlay" onClick={close} aria-hidden="true" />
          <div className="size-filter-panel">
            <div className="size-filter-header">
              <h2>Talles — {groupLabel}</h2>
              <button className="size-filter-close" onClick={close} aria-label="Cerrar">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="size-filter-body">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "8px 0" }}>
                {sizes.map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => toggleSize(size)}
                    className={`talle${selected.includes(size) ? " talle--selected" : ""}`}
                    style={{
                      minWidth: 44, height: 44, padding: "0 12px",
                      borderRadius: 8,
                      border: selected.includes(size) ? "2px solid #CD844D" : "1px solid #ddd",
                      background: selected.includes(size) ? "#FFF5EE" : "#fff",
                      cursor: "pointer", fontFamily: "inherit", fontSize: 14,
                      fontWeight: selected.includes(size) ? 600 : 400,
                      color: selected.includes(size) ? "#CD844D" : "#333",
                    }}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>

            <div className="size-filter-footer">
              <div className="size-filter-footer__actions">
                <button
                  type="button"
                  className="size-filter-clear-btn"
                  onClick={clear}
                  style={{ display: selected.length > 0 ? "block" : "none" }}
                >
                  Limpiar
                </button>
                <button type="button" className="size-filter-apply-btn" onClick={apply}>
                  Ver productos{selected.length > 0 ? ` (${selected.length})` : ""}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
