"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { GroupedProduct } from "@/types/catalog";
import {
  buildSizeFilterSections,
  extractSizesFromProducts,
  productMatchesSizeCategory,
  type SizeFilterSection,
} from "@/lib/utils/size-filter-catalog";
import {
  buildInitialSizeAvailability,
  fetchSizeAvailabilityForArticulos,
  isPhysicalAlwaysAvailable,
  sizeHasStock,
} from "@/lib/utils/size-filter-stock";
import {
  isRopaSizeSelected,
  ropaSelectionKey,
  ROPA_PAIR_LABELS,
  ROPA_UNIFIED_PAIRS,
  type RopaMainEntry,
} from "@/lib/utils/size-filter-ropa";

type SizeGroup = "calzado" | "ropa" | "lenceria" | "marroquineria" | "otros" | null;

function groupFromCategoria(cat: string): SizeGroup {
  const c = cat.toLowerCase();
  if (c === "calzado") return "calzado";
  if (c === "ropa") return "ropa";
  if (c === "lenceria") return "lenceria";
  if (c === "marroquineria") return "marroquineria";
  if (c === "otros") return "otros";
  return null;
}

const GROUP_LABELS: Record<Exclude<SizeGroup, null>, string> = {
  calzado: "Calzado",
  ropa: "Ropa",
  lenceria: "Lencería",
  marroquineria: "Marroquinería",
  otros: "Otros",
};

interface SizeFilterSheetProps {
  activeSizes: string[];
  categoria: string;
  products: GroupedProduct[];
  onNeedCategory?: () => void;
  highlight?: boolean;
}

function isSizeSelected(
  token: string,
  selected: string[],
  categoria: string
): boolean {
  if (categoria.toLowerCase() === "ropa") {
    return isRopaSizeSelected(token, selected);
  }
  return selected.includes(token);
}

function entryHasStock(
  entry: RopaMainEntry,
  availability: Map<string, { exists: boolean; hasStock: boolean }>,
  categoria: string
): boolean {
  if (isPhysicalAlwaysAvailable(entry.token, categoria)) return true;
  if (entry.kind === "pair") return pairHasStock(entry.token, availability, categoria);
  if (entry.kind === "unico") {
    return (
      sizeHasStock("Único", availability, categoria) ||
      sizeHasStock("Unico", availability, categoria) ||
      sizeHasStock("U", availability, categoria)
    );
  }
  return sizeHasStock(entry.token, availability, categoria);
}

function pairHasStock(
  token: string,
  availability: Map<string, { exists: boolean; hasStock: boolean }>,
  categoria: string
): boolean {
  if (isPhysicalAlwaysAvailable(token, categoria)) return true;
  const pair = ROPA_UNIFIED_PAIRS.find((p) => p.label === token);
  const filterValues = pair
    ? pair.keys.map((k) => k.split(":").pop()!).filter(Boolean)
    : [token];
  return filterValues.some((p) => sizeHasStock(p, availability, categoria));
}

function parsePairDisplay(label: string): { top: string; bottom: string } {
  const parts = label.split("/");
  if (parts.length >= 2) {
    return { top: parts[1].trim(), bottom: parts[0].trim() };
  }
  return { top: label, bottom: "" };
}

function formatSelectionLabel(
  token: string,
  pantSizes: Set<string>
): string {
  if (ROPA_PAIR_LABELS.has(token)) return token;
  if (token === "Único") return "Único";
  if (pantSizes.has(token)) return `Pantalón ${token}`;
  return token;
}

function buildSelectionSummary(
  selected: string[],
  pantSizes: string[]
): string {
  if (selected.length === 0) return "";
  const pantSet = new Set(pantSizes);
  return selected.map((t) => formatSelectionLabel(t, pantSet)).join(" · ");
}

function SectionDivider({ title }: { title: string }) {
  return (
    <div className="size-section-divider" aria-hidden="true">
      <span className="size-section-divider__line" />
      <span className="size-section-divider__label">{title}</span>
      <span className="size-section-divider__line" />
    </div>
  );
}

function CalzadoSizeButton({
  size,
  selected,
  hasStock,
  onToggle,
}: {
  size: string;
  selected: boolean;
  hasStock: boolean;
  onToggle: (size: string) => void;
}) {
  const disabled = !hasStock;
  return (
    <button
      type="button"
      className={[
        "size-option",
        "size-option--calzado",
        selected ? "is-selected" : "",
        disabled ? "size-option--no-stock" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled}
      onClick={() => !disabled && onToggle(size)}
    >
      {size}
    </button>
  );
}

function RopaUnicoButton({
  selected,
  hasStock,
  onToggle,
}: {
  selected: boolean;
  hasStock: boolean;
  onToggle: () => void;
}) {
  const disabled = !hasStock;
  return (
    <button
      type="button"
      className={[
        "size-option",
        "size-option--unico-wide",
        selected ? "is-selected" : "",
        disabled ? "size-option--no-stock" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled}
      onClick={() => !disabled && onToggle()}
    >
      {selected && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      Único
    </button>
  );
}

function RopaDualButton({
  entry,
  selected,
  hasStock,
  onToggle,
}: {
  entry: RopaMainEntry;
  selected: boolean;
  hasStock: boolean;
  onToggle: () => void;
}) {
  const disabled = !hasStock;
  const { top, bottom } =
    entry.kind === "pair"
      ? parsePairDisplay(entry.token)
      : { top: entry.token, bottom: "" };

  return (
    <button
      type="button"
      className={[
        "size-option",
        "size-option--dual",
        selected ? "is-selected" : "",
        disabled ? "size-option--no-stock" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled}
      onClick={() => !disabled && onToggle()}
    >
      <span className="size-option__top">{top}</span>
      {bottom ? <span className="size-option__bottom">{bottom}</span> : null}
    </button>
  );
}

function SizeSectionBlock({
  section,
  categoria,
  selected,
  availability,
  onToggle,
}: {
  section: SizeFilterSection;
  categoria: string;
  selected: string[];
  availability: Map<string, { exists: boolean; hasStock: boolean }>;
  onToggle: (token: string) => void;
}) {
  const cols = section.gridColumns ?? 5;
  const gridStyle = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };

  if (section.ropaGeneralLayout && section.ropaEntries?.length) {
    const unico = section.ropaEntries.find((e) => e.kind === "unico");
    const gridEntries = section.ropaEntries.filter((e) => e.kind !== "unico");

    return (
      <section className="size-section size-section--ropa" data-key={section.key}>
        <SectionDivider title={section.title} />
        <div className="size-section__body">
          {unico && (
            <RopaUnicoButton
              selected={isSizeSelected(unico.token, selected, categoria)}
              hasStock={entryHasStock(unico, availability, categoria)}
              onToggle={() => onToggle(unico.token)}
            />
          )}
          {gridEntries.length > 0 && (
            <div className="size-options-grid size-options-grid--ropa" style={gridStyle}>
              {gridEntries.map((entry) => (
                <RopaDualButton
                  key={entry.token}
                  entry={entry}
                  selected={isSizeSelected(entry.token, selected, categoria)}
                  hasStock={entryHasStock(entry, availability, categoria)}
                  onToggle={() => onToggle(entry.token)}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  const gridClass = section.measureLayout
    ? "size-options-grid size-options-grid--measures"
    : "size-options-grid";

  return (
    <section className="size-section" data-key={section.key}>
      <SectionDivider title={section.title} />
      <div className="size-section__body">
        <div
          className={gridClass}
          style={section.measureLayout ? undefined : gridStyle}
        >
          {(section.sizes ?? []).map((size) => (
            <CalzadoSizeButton
              key={size}
              size={size}
              selected={isSizeSelected(size, selected, categoria)}
              hasStock={sizeHasStock(size, availability, categoria)}
              onToggle={onToggle}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export default function SizeFilterSheet({
  activeSizes,
  categoria,
  products,
  onNeedCategory,
  highlight,
}: SizeFilterSheetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(activeSizes);
  const [mounted, setMounted] = useState(false);
  const [availability, setAvailability] = useState<
    Map<string, { exists: boolean; hasStock: boolean }>
  >(new Map());

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    document.body.classList.add("size-filter-open");
    return () => document.body.classList.remove("size-filter-open");
  }, [isOpen]);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const group = groupFromCategoria(categoria);
  const needsCat = group === null;
  const hasActive = activeSizes.length > 0;
  const groupLabel = group ? GROUP_LABELS[group] : "";

  const categoryProducts = useMemo(
    () => products.filter((p) => productMatchesSizeCategory(p, categoria)),
    [products, categoria]
  );

  const catalogSizes = useMemo(
    () => extractSizesFromProducts(products, categoria),
    [products, categoria]
  );

  const sections = useMemo(
    () => buildSizeFilterSections(catalogSizes, categoria),
    [catalogSizes, categoria]
  );

  const pantSizes = useMemo(
    () => sections.find((s) => s.key === "pants")?.sizes ?? [],
    [sections]
  );

  const selectionSummary = useMemo(
    () => buildSelectionSummary(selected, pantSizes),
    [selected, pantSizes]
  );

  // Talles al instante + stock real en background (solo no-físicos).
  useEffect(() => {
    if (!isOpen) return;

    if (catalogSizes.length === 0) {
      setAvailability(new Map());
      return;
    }

    setAvailability(buildInitialSizeAvailability(catalogSizes, categoria));

    let cancelled = false;
    const articulos = categoryProducts.map((p) => p.Articulo).filter(Boolean);

    (async () => {
      try {
        if (articulos.length === 0) return;
        const supabase = getSupabaseBrowserClient();
        const map = await fetchSizeAvailabilityForArticulos(
          supabase,
          articulos,
          catalogSizes,
          categoria
        );
        if (!cancelled) setAvailability(map);
      } catch (e) {
        console.warn("[SizeFilterSheet] stock:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, catalogSizes, categoria, categoryProducts]);

  const open = useCallback(() => {
    if (needsCat) {
      onNeedCategory?.();
      return;
    }
    setSelected(activeSizes);
    setIsOpen(true);
  }, [needsCat, activeSizes, onNeedCategory]);

  const close = useCallback(() => setIsOpen(false), []);

  const toggleSize = (size: string) => {
    if (categoria.toLowerCase() === "ropa") {
      setSelected((prev) => {
        const k = ropaSelectionKey(size);
        const idx = prev.findIndex((s) => ropaSelectionKey(s) === k);
        if (idx > -1) return prev.filter((_, i) => i !== idx);
        return [...prev, size];
      });
      return;
    }
    setSelected((prev) =>
      prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size]
    );
  };

  const clearSelection = () => setSelected([]);

  const apply = () => {
    const params = new URLSearchParams(searchParams.toString());
    if (selected.length > 0) params.set("talle", selected.join(","));
    else params.delete("talle");
    router.push(`${pathname}?${params}`);
    close();
  };

  return (
    <>
      <button
        type="button"
        className={`size-filter-chip${hasActive ? " size-filter-chip--active is-active" : ""}`}
        id="size-filter-btn"
        aria-label="Filtrar por talle"
        onClick={open}
        style={
          highlight
            ? {
                animation: "fyl-talles-pulse 0.5s ease 3",
                background: "#CD844D",
                color: "#fff",
                borderColor: "#B8703E",
              }
            : undefined
        }
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

      {mounted &&
        createPortal(
          <div
            className={`size-filter-modal size-filter-modal--refined${isOpen ? " active" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={`Talles · ${groupLabel}`}
            aria-hidden={!isOpen}
          >
            <div className="size-filter-overlay" onClick={close} aria-hidden="true" />
            <div className="size-filter-panel">
              <div className="size-filter-panel__handle" aria-hidden="true" />

              <div className="size-filter-header">
                <h2>Talles · {groupLabel}</h2>
                <button
                  type="button"
                  className="size-filter-header-clear"
                  onClick={clearSelection}
                  disabled={selected.length === 0}
                >
                  Limpiar
                </button>
              </div>

              <div className="size-filter-body">
                {sections.length === 0 ? (
                  <div className="size-filter-empty">
                    No hay talles disponibles para esta categoría
                  </div>
                ) : (
                  <div className="size-filter-sections">
                    {sections.map((sec) => (
                      <SizeSectionBlock
                        key={sec.key}
                        section={sec}
                        categoria={categoria}
                        selected={selected}
                        availability={availability}
                        onToggle={toggleSize}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="size-filter-footer size-filter-footer--refined">
                {selectionSummary ? (
                  <p className="size-filter-summary">
                    Seleccionados: {selectionSummary}
                  </p>
                ) : null}
                <button
                  type="button"
                  className={`size-filter-apply-btn${selected.length > 0 ? " is-ready" : ""}`}
                  onClick={apply}
                >
                  Ver productos
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
