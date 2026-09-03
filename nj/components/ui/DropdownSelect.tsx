"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export type DropdownOption = {
  value: string;
  label: string;
};

type DropdownSelectProps = {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  labelledBy?: string;
  ariaLabel?: string;
  className?: string;
  /** Muestra input para filtrar opciones (como admin provincia/ciudad). */
  searchable?: boolean;
  searchPlaceholder?: string;
};

function normalizeForSearch(text: string) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Barra + desplegable custom (mobile-first).
 * Reemplaza <select> nativo para que el menú no se salga del viewport.
 * Con `searchable` permite escribir para filtrar (provincia/localidad).
 */
export default function DropdownSelect({
  value,
  options,
  onChange,
  placeholder = "Seleccioná…",
  disabled = false,
  id,
  labelledBy,
  ariaLabel,
  className,
  searchable = false,
  searchPlaceholder = "Escribí para buscar…",
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const autoId = useId();
  const listboxId = id ? `${id}-listbox` : `${autoId}-listbox`;
  const searchId = id ? `${id}-search` : `${autoId}-search`;

  const selected = options.find((o) => o.value === value) ?? null;
  const display = selected?.label || placeholder;

  const filteredOptions = useMemo(() => {
    if (!searchable) return options;
    const q = normalizeForSearch(query);
    if (!q) return options;
    return options.filter((option) => {
      const label = normalizeForSearch(option.label);
      const val = normalizeForSearch(option.value);
      return label.includes(q) || val.includes(q);
    });
  }, [options, query, searchable]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    function onPointerDown(event: MouseEvent | TouchEvent) {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target;
      if (target instanceof Node && !root.contains(target)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);

    if (searchable) {
      // Enfocar el buscador al abrir (móvil: teclado listo para filtrar)
      const t = window.setTimeout(() => searchRef.current?.focus(), 10);
      return () => {
        window.clearTimeout(t);
        document.removeEventListener("mousedown", onPointerDown);
        document.removeEventListener("touchstart", onPointerDown);
        document.removeEventListener("keydown", onKeyDown);
      };
    }

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, searchable]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      ref={rootRef}
      id={id}
      className={[
        "fyl-dropdown",
        open ? "is-open" : "",
        disabled ? "is-disabled" : "",
        !selected ? "is-placeholder" : "",
        searchable ? "is-searchable" : "",
        className || "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className="fyl-dropdown__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
      >
        <span className="fyl-dropdown__value">{display}</span>
        <span className="fyl-dropdown__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="fyl-dropdown__panel">
          {searchable ? (
            <div className="fyl-dropdown__search">
              <input
                ref={searchRef}
                id={searchId}
                type="search"
                className="fyl-dropdown__search-input"
                value={query}
                placeholder={searchPlaceholder}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="search"
                aria-label={searchPlaceholder}
                aria-controls={listboxId}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const first = filteredOptions[0];
                    if (first) {
                      setOpen(false);
                      if (first.value !== value) onChange(first.value);
                    }
                  }
                }}
              />
            </div>
          ) : null}

          <ul
            id={listboxId}
            className="fyl-dropdown__menu"
            role="listbox"
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : ariaLabel}
          >
            {filteredOptions.length === 0 ? (
              <li className="fyl-dropdown__empty" role="presentation">
                Sin coincidencias
              </li>
            ) : (
              filteredOptions.map((option) => {
                const checked = option.value === value;
                return (
                  <li key={option.value} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={checked}
                      className={`fyl-dropdown__option${checked ? " is-selected" : ""}`}
                      disabled={disabled}
                      onClick={() => {
                        setOpen(false);
                        if (option.value !== value) onChange(option.value);
                      }}
                    >
                      {option.label}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
