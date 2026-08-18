"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import styles from "@/app/admin/products/products-admin.module.css";

interface ProductRow {
  id: string;
  name: string;
  handle: string;
  category: "Calzado" | "Ropa" | "Otros";
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Activo",
  draft: "Borrador",
  pending_stock: "Completar stock",
  missing_tags: "Completar tags",
  archived: "Archivado",
};

const STATUS_CLASS: Record<string, string> = {
  active: "statusActive",
  draft: "statusDraft",
  pending_stock: "statusPendingStock",
  missing_tags: "statusMissingTags",
  archived: "statusArchived",
};

const CATEGORY_DOT: Record<string, string> = {
  Calzado: "var(--cat-calzado)",
  Ropa: "var(--cat-ropa)",
  Otros: "var(--cat-otros)",
};

export default function ProductSearchPanel({ canEdit }: { canEdit: boolean }) {
  const [term, setTerm] = useState("");
  const [recent, setRecent] = useState<ProductRow[]>([]);
  const [results, setResults] = useState<ProductRow[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    supabase
      .from("products")
      .select("id, name, handle, category, status")
      .order("updated_at", { ascending: false })
      .limit(5)
      .then(({ data }: { data: ProductRow[] | null }) => setRecent(data ?? []));
  }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    const escaped = q.trim().replace(/[%_]/g, (c) => `\\${c}`);
    const { data } = await supabase
      .from("products")
      .select("id, name, handle, category, status")
      .or(`name.ilike.%${escaped}%,handle.ilike.%${escaped}%`)
      .order("name", { ascending: true })
      .limit(30);
    setResults((data as ProductRow[]) ?? []);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(term), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [term, runSearch]);

  function Row({ p }: { p: ProductRow }) {
    return (
      <Link href={`/admin/products/${p.id}`} className={styles.resultRow}>
        <span className={styles.resultDot} style={{ background: CATEGORY_DOT[p.category] }} />
        <span className={styles.resultName}>{p.name || "(sin nombre)"}</span>
        <span className={styles.resultMeta}>{p.handle}</span>
        <span className={`${styles.statusChip} ${styles[STATUS_CLASS[p.status] ?? "statusDraft"]}`}>
          {STATUS_LABEL[p.status] ?? p.status}
        </span>
      </Link>
    );
  }

  return (
    <div>
      <div className={styles.heroActions}>
        <input
          className={styles.heroSearch}
          placeholder="Buscar producto por nombre o handle..."
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          autoComplete="off"
          autoFocus
        />
        {canEdit && (
          <Link href="/admin/products/new" className={styles.primaryCta}>
            + Crear producto
          </Link>
        )}
      </div>

      {results !== null ? (
        <>
          <div className={styles.sectionLabel}>
            {results.length} resultado{results.length !== 1 ? "s" : ""}
          </div>
          {results.length === 0 ? (
            <div className={styles.emptyState}>No se encontró nada con &ldquo;{term}&rdquo;.</div>
          ) : (
            <div className={styles.resultsList}>
              {results.map((p) => (
                <Row key={p.id} p={p} />
              ))}
            </div>
          )}
        </>
      ) : (
        recent.length > 0 && (
          <>
            <div className={styles.sectionLabel}>Editados recientemente</div>
            <div className={styles.resultsList}>
              {recent.map((p) => (
                <Row key={p.id} p={p} />
              ))}
            </div>
          </>
        )
      )}
    </div>
  );
}
