"use client";

import {
  useCallback, useRef, useState, useEffect, useTransition,
} from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { buildSuggestions, type SearchSuggestion } from "@/lib/utils/search";

const ICON_SEARCH = (
  <svg className="search-bar__icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const ICON_CLEAR = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

function SuggestionIcon({ type }: { type: SearchSuggestion["type"] }) {
  if (type === "product") {
    return (
      <svg className="search-suggest__icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
        <line x1="7" y1="7" x2="7.01" y2="7" />
      </svg>
    );
  }
  if (type === "tag") {
    return (
      <svg className="search-suggest__icon search-suggest__icon--tag" width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true">
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="20" y2="15" />
        <line x1="10" y1="3" x2="8" y2="21" />
        <line x1="16" y1="3" x2="14" y2="21" />
      </svg>
    );
  }
  return (
    <svg className="search-suggest__icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function typeLabel(type: SearchSuggestion["type"]): string {
  switch (type) {
    case "product":
      return "Artículo";
    case "tag":
      return "Etiqueta";
    case "categoria":
      return "Categoría";
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

export default function SearchBar() {
  const router        = useRouter();
  const pathname      = usePathname();
  const searchParams  = useSearchParams();
  const [, startTransition] = useTransition();

  const inputRef     = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = searchParams.get("q") ?? "";

  const [inputValue, setInputValue]     = useState(current);
  const [suggestions, setSuggestions]   = useState<SearchSuggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlighted, setHighlighted]   = useState(-1);

  useEffect(() => { setInputValue(current); }, [current]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // usePathname a veces incluye /nj (basePath); TagFilterBar navega con "/"
  const isCatalogPage =
    pathname === "/" ||
    pathname === "/nj" ||
    pathname === "/nj/";

  function navigate(q: string) {
    const params = new URLSearchParams(isCatalogPage ? searchParams.toString() : "");
    if (q.trim().length >= 2) {
      params.set("q", q.trim());
    } else {
      params.delete("q");
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `/?${qs}` : "/", { scroll: false });
    });
  }

  const onInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);
      setHighlighted(-1);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const products = (typeof window !== "undefined" && (window as any).__fylProducts) ?? [];
        if (val.trim().length >= 2 && products.length > 0) {
          setSuggestions(buildSuggestions(products, val, 7));
          setShowDropdown(true);
        } else {
          setSuggestions([]);
          setShowDropdown(false);
        }
        navigate(val);
      }, 280);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname, searchParams]
  );

  function applySuggestion(s: SearchSuggestion) {
    setInputValue(s.query);
    setSuggestions([]);
    setShowDropdown(false);
    inputRef.current?.blur();
    if (s.href) {
      startTransition(() => {
        router.push(s.href!);
      });
      return;
    }
    navigate(s.query);
  }

  function clearSearch() {
    setInputValue("");
    setSuggestions([]);
    setShowDropdown(false);
    navigate("");
    inputRef.current?.focus();
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (showDropdown) {
        setShowDropdown(false);
      } else {
        clearSearch();
      }
      return;
    }
    if (!showDropdown || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, -1));
    } else if (e.key === "Enter" && highlighted >= 0) {
      e.preventDefault();
      applySuggestion(suggestions[highlighted]);
    }
  };

  const hasSuggestions = showDropdown && suggestions.length > 0;

  return (
    <div ref={containerRef} className="search-bar-inner">
      <div className={`search-bar__field${hasSuggestions ? " is-open" : ""}`}>
        {ICON_SEARCH}
        <input
          ref={inputRef}
          type="text"
          className="search-bar-mobile search-bar__input"
          id="search-bar-mobile"
          placeholder="¿Qué buscás?"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          value={inputValue}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) setShowDropdown(true);
          }}
        />
        {inputValue && (
          <button
            type="button"
            className="search-bar__clear"
            onClick={clearSearch}
            aria-label="Limpiar búsqueda"
          >
            {ICON_CLEAR}
          </button>
        )}
      </div>

      {hasSuggestions && (
        <div className="search-suggest" role="listbox">
          {suggestions.map((s, idx) => (
            <button
              key={`${s.type}-${s.label}`}
              type="button"
              role="option"
              aria-selected={highlighted === idx}
              className={`search-suggest__row${highlighted === idx ? " is-active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
            >
              <SuggestionIcon type={s.type} />
              <span className="search-suggest__label">
                {highlightMatch(s.label, inputValue)}
              </span>
              <span className="search-suggest__type">{typeLabel(s.type)}</span>
            </button>
          ))}

          <button
            type="button"
            className="search-suggest__all"
            onMouseDown={(e) => {
              e.preventDefault();
              setShowDropdown(false);
              navigate(inputValue);
            }}
          >
            {ICON_SEARCH}
            <span>
              Buscar <strong>&ldquo;{inputValue}&rdquo;</strong> en todo el catálogo
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function highlightMatch(label: string, term: string): React.ReactNode {
  if (!term || term.length < 2) return label;
  const idx = label.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return label;
  return (
    <>
      {label.slice(0, idx)}
      <mark className="search-suggest__mark">
        {label.slice(idx, idx + term.length)}
      </mark>
      {label.slice(idx + term.length)}
    </>
  );
}
