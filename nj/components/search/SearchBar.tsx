"use client";

import {
  useCallback, useRef, useState, useEffect, useTransition,
} from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { buildSuggestions, type SearchSuggestion } from "@/lib/utils/search";

const ICON_SEARCH = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink: 0, color: "#aaa" }}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const ICON_CLEAR = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const TYPE_ICONS: Record<string, string> = {
  product:   "🏷️",
  tag:       "🔖",
  categoria: "📂",
};


export default function SearchBar() {
  const router        = useRouter();
  const pathname      = usePathname();
  const searchParams  = useSearchParams();
  const [, startTransition] = useTransition();

  const inputRef    = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = searchParams.get("q") ?? "";

  const [inputValue, setInputValue]       = useState(current);
  const [suggestions, setSuggestions]     = useState<SearchSuggestion[]>([]);
  const [showDropdown, setShowDropdown]   = useState(false);
  const [highlighted, setHighlighted]     = useState(-1);

  // Keep input in sync when URL changes externally
  useEffect(() => { setInputValue(current); }, [current]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function navigate(q: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (q.trim().length >= 2) {
      params.set("q", q.trim());
    } else {
      params.delete("q");
    }
    startTransition(() => {
      router.push(`${pathname}?${params}`, { scroll: false });
    });
  }

  const onInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);
      setHighlighted(-1);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        // Build suggestions from loaded products
        const products = (typeof window !== "undefined" && (window as any).__fylProducts) ?? [];
        if (val.trim().length >= 2 && products.length > 0) {
          setSuggestions(buildSuggestions(products, val, 7));
          setShowDropdown(true);
        } else {
          setSuggestions([]);
          setShowDropdown(false);
        }
        // Navigate
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
    navigate(s.query);
    inputRef.current?.blur();
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
    <div
      ref={containerRef}
      style={{ position: "relative", flex: 1 }}
    >
      {/* Input wrapper */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        background: "#f5f5f5", borderRadius: 22,
        padding: "0 12px",
        border: hasSuggestions ? "1.5px solid #CD844D" : "1.5px solid transparent",
        transition: "border-color 0.15s",
      }}>
        {ICON_SEARCH}
        <input
          ref={inputRef}
          type="search"
          className="search-bar-mobile"
          id="search-bar-mobile"
          placeholder="¿Qué buscás? Ej: Zapatillas..."
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          value={inputValue}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) setShowDropdown(true);
          }}
          style={{
            flex: 1, background: "none", border: "none", outline: "none",
            fontSize: 14, padding: "9px 0", color: "#222",
          }}
        />
        {inputValue && (
          <button
            onClick={clearSearch}
            aria-label="Limpiar búsqueda"
            style={{
              background: "#ddd", border: "none", borderRadius: "50%",
              width: 18, height: 18, cursor: "pointer", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#666",
            }}
          >
            {ICON_CLEAR}
          </button>
        )}
      </div>

      {/* Autocomplete dropdown */}
      {hasSuggestions && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
          background: "#fff", borderRadius: 14, zIndex: 999,
          boxShadow: "0 8px 32px rgba(0,0,0,0.14)",
          border: "1px solid #f0e8df",
          overflow: "hidden",
        }}>
          {suggestions.map((s, idx) => (
            <button
              key={`${s.type}-${s.label}`}
              onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                width: "100%", padding: "11px 14px",
                background: highlighted === idx ? "#FFF5EE" : "transparent",
                border: "none", borderBottom: idx < suggestions.length - 1 ? "1px solid #f5f5f5" : "none",
                cursor: "pointer", textAlign: "left",
              }}
            >
              <span style={{ fontSize: 15, flexShrink: 0 }}>{TYPE_ICONS[s.type]}</span>
              <span style={{ flex: 1, fontSize: 14, color: "#222", fontWeight: 500 }}>
                {highlightMatch(s.label, inputValue)}
              </span>
              <span style={{
                fontSize: 10, color: "#bbb", flexShrink: 0,
                textTransform: "uppercase", letterSpacing: "0.04em",
              }}>
                {s.type === "product" ? "Art." : s.type === "tag" ? "Tag" : "Categoría"}
              </span>
            </button>
          ))}

          {/* "Search all" row */}
          <button
            onMouseDown={(e) => { e.preventDefault(); setShowDropdown(false); navigate(inputValue); }}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              width: "100%", padding: "10px 14px",
              background: "#fafafa", border: "none", cursor: "pointer",
              textAlign: "left",
            }}
          >
            {ICON_SEARCH}
            <span style={{ fontSize: 13, color: "#888" }}>
              Buscar <strong style={{ color: "#CD844D" }}>&ldquo;{inputValue}&rdquo;</strong> en todo el catálogo
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// Highlight matching characters in the suggestion label
function highlightMatch(label: string, term: string): React.ReactNode {
  if (!term || term.length < 2) return label;
  const idx = label.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return label;
  return (
    <>
      {label.slice(0, idx)}
      <mark style={{ background: "#fde68a", borderRadius: 2, padding: "0 1px" }}>
        {label.slice(idx, idx + term.length)}
      </mark>
      {label.slice(idx + term.length)}
    </>
  );
}
