"use client";

import {
  useCallback, useRef, useState, useEffect, useId, useTransition,
} from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { buildSuggestions, type SearchSuggestion } from "@/lib/utils/search";
import { useSearchDictionary } from "@/hooks/useSearchDictionary";
import {
  noteUiSearchCommit,
  trackAutocompleteProductSelected,
  trackSuggestionSelected,
} from "@/lib/search/search-analytics";
import type { GroupedProduct } from "@/types/catalog";

const SUGGEST_DEBOUNCE_MS = 280;

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

function getCatalogProducts(): GroupedProduct[] {
  if (typeof window === "undefined") return [];
  const bag = window as Window & { __fylProducts?: GroupedProduct[] };
  return bag.__fylProducts ?? [];
}

function isHomeCatalogPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/nj" || pathname === "/nj/";
}

function SuggestionIcon({ type }: { type: SearchSuggestion["type"] }) {
  if (type === "product") {
    return (
      <svg className="search-suggest__icon search-suggest__icon--product" width="16" height="16" viewBox="0 0 24 24" fill="none"
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

function typeLabel(s: SearchSuggestion): string {
  switch (s.type) {
    case "product":
      return "Abrir producto";
    case "tag":
      return "Buscar";
    case "categoria":
      return s.href ? "Categoría" : "Buscar";
    default: {
      const _exhaustive: never = s.type;
      return _exhaustive;
    }
  }
}

export default function SearchBar() {
  const router        = useRouter();
  const pathname      = usePathname();
  const searchParams  = useSearchParams();
  const [, startTransition] = useTransition();
  const dictionary = useSearchDictionary();
  const listboxId = useId();

  const inputRef     = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathnameRef  = useRef(pathname);
  const searchParamsRef = useRef(searchParams);
  pathnameRef.current = pathname;
  searchParamsRef.current = searchParams;

  const current = searchParams.get("q") ?? "";

  const [inputValue, setInputValue]     = useState(current);
  const [suggestions, setSuggestions]   = useState<SearchSuggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlighted, setHighlighted]   = useState(-1);

  useEffect(() => {
    if (current) {
      setInputValue(current);
      return;
    }
    if (isHomeCatalogPath(pathname)) {
      setInputValue("");
    }
  }, [current, pathname]);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setHighlighted(-1);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const cancelSuggestTimer = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const closeSuggestions = useCallback(() => {
    setSuggestions([]);
    setShowDropdown(false);
    setHighlighted(-1);
  }, []);

  const commitSearch = useCallback((raw: string) => {
    cancelSuggestTimer();
    const q = raw.trim();
    setInputValue(q);
    closeSuggestions();

    const onHome = isHomeCatalogPath(pathnameRef.current);
    const params = new URLSearchParams(onHome ? searchParamsRef.current.toString() : "");
    if (q.length >= 2) {
      noteUiSearchCommit(q, dictionary);
      params.set("q", q);
    } else {
      params.delete("q");
    }
    const qs = params.toString();
    const href = qs ? `/?${qs}` : "/";
    inputRef.current?.blur();
    startTransition(() => {
      router.push(href, { scroll: false });
    });
  }, [cancelSuggestTimer, closeSuggestions, dictionary, router, startTransition]);

  const goToHref = useCallback((href: string) => {
    cancelSuggestTimer();
    closeSuggestions();
    inputRef.current?.blur();
    startTransition(() => {
      router.push(href);
    });
  }, [cancelSuggestTimer, closeSuggestions, router, startTransition]);

  const onInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputValue(val);
    setHighlighted(-1);

    cancelSuggestTimer();
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      const products = getCatalogProducts();
      if (val.trim().length >= 2 && products.length > 0) {
        setSuggestions(buildSuggestions(products, val, 7, dictionary));
        setShowDropdown(true);
      } else {
        setSuggestions([]);
        setShowDropdown(false);
      }
    }, SUGGEST_DEBOUNCE_MS);
  }, [cancelSuggestTimer, dictionary]);

  const applySuggestion = useCallback((s: SearchSuggestion, index: number) => {
    setInputValue(s.query);
    if (s.type === "product" && s.href) {
      trackAutocompleteProductSelected(inputValue, s.query, index + 1);
      goToHref(s.href);
      return;
    }
    trackSuggestionSelected(inputValue, s, dictionary);
    if (s.type === "categoria" && s.href) {
      goToHref(s.href);
      return;
    }
    commitSearch(s.query);
  }, [commitSearch, dictionary, goToHref, inputValue]);

  const clearSearch = useCallback(() => {
    commitSearch("");
    inputRef.current?.focus();
  }, [commitSearch]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (showDropdown) {
        setShowDropdown(false);
        setHighlighted(-1);
      } else {
        clearSearch();
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (showDropdown && highlighted >= 0 && suggestions[highlighted]) {
        applySuggestion(suggestions[highlighted], highlighted);
      } else {
        commitSearch(inputValue);
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
    }
  };

  const hasSuggestions = showDropdown && suggestions.length > 0;
  const activeOptionId =
    hasSuggestions && highlighted >= 0
      ? `${listboxId}-opt-${highlighted}`
      : undefined;

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
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={hasSuggestions}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
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
        <div className="search-suggest">
          <div id={listboxId} className="search-suggest__list" role="listbox">
            {suggestions.map((s, idx) => (
              <button
                key={`${s.type}-${s.label}`}
                id={`${listboxId}-opt-${idx}`}
                type="button"
                role="option"
                aria-selected={highlighted === idx}
                className={[
                  "search-suggest__row",
                  highlighted === idx ? "is-active" : "",
                  s.type === "product" ? "search-suggest__row--product" : "search-suggest__row--search",
                ].filter(Boolean).join(" ")}
                onMouseDown={(e) => { e.preventDefault(); applySuggestion(s, idx); }}
              >
                <SuggestionIcon type={s.type} />
                <span className="search-suggest__label">
                  {highlightMatch(s.label, inputValue)}
                </span>
                <span className="search-suggest__type">{typeLabel(s)}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            className="search-suggest__all"
            onMouseDown={(e) => {
              e.preventDefault();
              commitSearch(inputValue);
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
