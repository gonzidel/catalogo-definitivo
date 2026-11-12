"use client";

import {
  useCallback, useRef, useState, useEffect, useId, useTransition,
} from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { buildSuggestions, type SearchSuggestion } from "@/lib/utils/search";
import { useSearchDictionary } from "@/hooks/useSearchDictionary";
import { getCatalogProductsFromWindow } from "@/lib/search/search-index";
import {
  noteUiSearchCommit,
  trackAutocompleteProductSelected,
  trackSuggestionSelected,
} from "@/lib/search/search-analytics";
import {
  loadRecentSearches,
  pushRecentSearch,
  clearRecentSearches,
  type RecentSearch,
} from "@/lib/search/recent-searches";
import { isSearchHintDismissed, dismissSearchHint } from "@/lib/search/search-hint";
import { formatARS } from "@/lib/utils/catalog";

const SUGGEST_DEBOUNCE_MS = 280;
const RECENT_KEY_HINT = "recent";

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

function isHomeCatalogPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/nj" || pathname === "/nj/";
}

const ICON_CURLY_ARROW = (
  <svg className="search-hint-float__arrow" viewBox="0 0 40 36" fill="none"
    xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M5 26c-2-10 4-19 13-19 5 0 8 3 7 7-1 3-5 4-6 1-1-2 1-4 3-3"
      stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" fill="none"
    />
    <path
      d="M21 7l1 7-7-1"
      stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none"
    />
  </svg>
);

function SuggestionIcon({ type }: { type: SearchSuggestion["type"] | "tag" }) {
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
      return s.count != null ? `${s.count}` : "Buscar";
    case "categoria":
      return s.href ? "Categoría" : "Buscar";
    case "combo":
      return s.count != null ? `${s.count}` : "Buscar";
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
  const [recents, setRecents]           = useState<RecentSearch[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlighted, setHighlighted]   = useState(-1);
  const [showHint, setShowHint]         = useState(false);

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
    if (!isSearchHintDismissed()) setShowHint(true);
  }, []);

  const closeHint = useCallback(() => {
    dismissSearchHint();
    setShowHint(false);
  }, []);

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
      pushRecentSearch(q);
      setRecents(loadRecentSearches());
      params.set("q", q);
      dismissSearchHint();
      setShowHint(false);
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
      const products = getCatalogProductsFromWindow();
      if (val.trim().length >= 2 && products.length > 0) {
        setSuggestions(buildSuggestions(products, val, 7, dictionary));
        setShowDropdown(true);
      } else {
        setSuggestions([]);
        setShowDropdown(val.trim().length === 0 && loadRecentSearches().length > 0);
        if (val.trim().length === 0) setRecents(loadRecentSearches());
      }
    }, SUGGEST_DEBOUNCE_MS);
  }, [cancelSuggestTimer, dictionary]);

  const applySuggestion = useCallback((s: SearchSuggestion, index: number) => {
    setInputValue(s.query);
    dismissSearchHint();
    setShowHint(false);
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

  const showRecents = showDropdown && !inputValue.trim() && recents.length > 0;
  const hasSuggestions = showDropdown && suggestions.length > 0;
  const hintActive = showHint && !inputValue.trim() && !hasSuggestions && !showRecents;
  const activeOptionId =
    hasSuggestions && highlighted >= 0
      ? `${listboxId}-opt-${highlighted}`
      : undefined;

  return (
    <div ref={containerRef} className="search-bar-inner">
      <div className={`search-bar__field${hasSuggestions ? " is-open" : ""}${hintActive ? " search-bar__field--hint" : ""}`}>
        {ICON_SEARCH}
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          className="search-bar-mobile search-bar__input"
          id="search-bar-mobile"
          placeholder="¿Qué buscás?"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={hasSuggestions || (showDropdown && recents.length > 0 && !inputValue)}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          value={inputValue}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) {
              setShowDropdown(true);
              return;
            }
            const r = loadRecentSearches();
            setRecents(r);
            if (r.length > 0 && !inputValue.trim()) setShowDropdown(true);
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

      {hintActive && (
        <div className="search-hint-float">
          {ICON_CURLY_ARROW}
          <button
            type="button"
            className="search-hint-float__close"
            onClick={closeHint}
            aria-label="Cerrar aviso"
          >
            {ICON_CLEAR}
          </button>
          <p className="search-hint-float__title">Mejoramos el buscador, probalo</p>
          <p className="search-hint-float__example">
            Ej: <strong>zapatilla deportiva</strong>
          </p>
        </div>
      )}

      {(hasSuggestions || showRecents) && (
        <div className="search-suggest">
          {showRecents && (
            <div className="search-suggest__list" role="listbox" aria-label="Búsquedas recientes">
              <div className="search-suggest__section-label">
                Recientes
                <button
                  type="button"
                  className="search-suggest__clear-recents"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    clearRecentSearches();
                    setRecents([]);
                    setShowDropdown(false);
                  }}
                >
                  Borrar
                </button>
              </div>
              {recents.map((r) => (
                <button
                  key={`${RECENT_KEY_HINT}-${r.q}`}
                  type="button"
                  role="option"
                  className="search-suggest__row search-suggest__row--search"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitSearch(r.q);
                  }}
                >
                  {ICON_SEARCH}
                  <span className="search-suggest__label">{r.q}</span>
                  <span className="search-suggest__type">Reciente</span>
                </button>
              ))}
            </div>
          )}

          {hasSuggestions && (
            <>
              <button
                type="button"
                className="search-suggest__all search-suggest__all--top"
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitSearch(inputValue);
                }}
              >
                {ICON_SEARCH}
                <span>
                  Ver todos los resultados de <strong>&ldquo;{inputValue}&rdquo;</strong>
                </span>
              </button>

              <div id={listboxId} className="search-suggest__list" role="listbox">
                {suggestions.map((s, idx) => (
                  <button
                    key={`${s.type}-${s.label}-${s.query}`}
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
                    {s.type === "product" && s.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={s.thumb}
                        alt=""
                        className="search-suggest__thumb"
                        width={40}
                        height={40}
                      />
                    ) : (
                      <SuggestionIcon type={s.type === "combo" ? "tag" : s.type} />
                    )}
                    <span className="search-suggest__label">
                      <span className="search-suggest__label-text">
                        {highlightMatch(s.label, inputValue)}
                      </span>
                      {s.subtitle && (
                        <span className="search-suggest__subtitle">{s.subtitle}</span>
                      )}
                    </span>
                    <span className="search-suggest__meta">
                      {s.type === "product" && s.price != null && s.price !== "" && (
                        <span className="search-suggest__price">{formatARS(s.price)}</span>
                      )}
                      <span className="search-suggest__type">{typeLabel(s)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
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
