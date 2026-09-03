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
  /** Escribís en el mismo campo y se filtra la lista (como admin). */
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
 * Con `searchable`, el trigger es un input: escribís ahí y se filtra.
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
  searchPlaceholder,
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoId = useId();
  const listboxId = id ? `${id}-listbox` : `${autoId}-listbox`;

  const selected = options.find((o) => o.value === value) ?? null;
  const inputPlaceholder = searchPlaceholder || placeholder;

  const filteredOptions = useMemo(() => {
    if (!searchable || !open) return options;
    const q = normalizeForSearch(query);
    if (!q) return options;
    return options.filter((option) => {
      const label = normalizeForSearch(option.label);
      const val = normalizeForSearch(option.value);
      return label.includes(q) || val.includes(q);
    });
  }, [options, query, searchable, open]);

  // Si cambia el value externo y no estamos editando, sincronizar texto
  useEffect(() => {
    if (!open) {
      setQuery(selected?.label || "");
    }
  }, [selected?.label, open]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target;
      if (target instanceof Node && !root.contains(target)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function pickOption(option: DropdownOption) {
    setOpen(false);
    setQuery(option.label);
    if (option.value !== value) onChange(option.value);
  }

  function openAndEdit() {
    if (disabled) return;
    setQuery(selected?.label || "");
    setOpen(true);
  }

  return (
    <div
      ref={rootRef}
      id={id}
      className={[
        "fyl-dropdown",
        open ? "is-open" : "",
        disabled ? "is-disabled" : "",
        !selected && !query ? "is-placeholder" : "",
        searchable ? "is-searchable" : "",
        className || "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {searchable ? (
        <div className="fyl-dropdown__combobox">
          <input
            ref={inputRef}
            type="text"
            className="fyl-dropdown__input"
            value={open ? query : selected?.label || query || ""}
            placeholder={inputPlaceholder}
            disabled={disabled}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : ariaLabel}
            onFocus={openAndEdit}
            onClick={openAndEdit}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const first = filteredOptions[0];
                if (first) pickOption(first);
              }
            }}
          />
          <span className="fyl-dropdown__chevron" aria-hidden="true">
            ▾
          </span>
        </div>
      ) : (
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
          <span className="fyl-dropdown__value">
            {selected?.label || placeholder}
          </span>
          <span className="fyl-dropdown__chevron" aria-hidden="true">
            ▾
          </span>
        </button>
      )}

      {open ? (
        <div className="fyl-dropdown__panel">
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
                      onClick={() => pickOption(option)}
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
