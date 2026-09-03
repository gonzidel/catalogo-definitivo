"use client";

import { useEffect, useId, useRef, useState } from "react";

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
};

/**
 * Barra + desplegable custom (mobile-first).
 * Reemplaza <select> nativo para que el menú no se salga del viewport.
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
}: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const listboxId = id ? `${id}-listbox` : `${autoId}-listbox`;

  const selected = options.find((o) => o.value === value) ?? null;
  const display = selected?.label || placeholder;

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
      if (event.key === "Escape") setOpen(false);
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

  return (
    <div
      ref={rootRef}
      id={id}
      className={[
        "fyl-dropdown",
        open ? "is-open" : "",
        disabled ? "is-disabled" : "",
        !selected ? "is-placeholder" : "",
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
        <ul
          id={listboxId}
          className="fyl-dropdown__menu"
          role="listbox"
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : ariaLabel}
        >
          {options.map((option) => {
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
          })}
        </ul>
      ) : null}
    </div>
  );
}
