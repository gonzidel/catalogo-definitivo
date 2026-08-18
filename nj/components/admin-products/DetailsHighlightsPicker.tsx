"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createTagChecked,
  listTags2,
  listTags3ByTag1,
  saveDetailsAndHighlights,
  type SimilarTag,
  type TagRow,
} from "@/lib/products/tags";
import styles from "@/app/admin/products/products-admin.module.css";

interface DetailsHighlightsPickerProps {
  productId: string;
  category: string;
  tag1Id: string;
  initialDetailIds: string[];
  initialHighlightIds: string[];
}

export default function DetailsHighlightsPicker({
  productId,
  category,
  tag1Id,
  initialDetailIds,
  initialHighlightIds,
}: DetailsHighlightsPickerProps) {
  const [available, setAvailable] = useState<TagRow[]>([]);
  const [search, setSearch] = useState("");
  const [selectedDetails, setSelectedDetails] = useState<string[]>(initialDetailIds);
  const [highlights, setHighlights] = useState<string[]>(initialHighlightIds);
  const [newDetail, setNewDetail] = useState("");
  const [pending, setPending] = useState<SimilarTag | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tag1Id) listTags3ByTag1(tag1Id).then(setAvailable);
  }, [tag1Id]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return available;
    return available.filter((t) => t.name.toLowerCase().includes(term));
  }, [available, search]);

  function toggleDetail(id: string) {
    setSelectedDetails((prev) => {
      if (prev.includes(id)) {
        setHighlights((h) => h.filter((x) => x !== id));
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  }

  function toggleHighlight(id: string) {
    setHighlights((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) {
        setStatus({ text: "Máximo 2 destacados.", error: true });
        return prev;
      }
      if (!selectedDetails.includes(id)) {
        setSelectedDetails((d) => [...d, id]);
      }
      return [...prev, id];
    });
  }

  async function handleCreateDetail(force = false) {
    const name = newDetail.trim();
    if (!name) return;
    try {
      const tag2s = await listTags2(tag1Id);
      const parentId = tag2s[0]?.id ?? null;
      if (!parentId) {
        setStatus({ text: "Hace falta al menos un Tags2 en esta categoría para crear un detalle.", error: true });
        return;
      }
      const result = await createTagChecked(name, 3, category, parentId, force);
      if (result.suggestion) {
        setPending(result.suggestion);
        return;
      }
      if (result.tag) {
        setPending(null);
        setNewDetail("");
        setAvailable((prev) => [...prev, result.tag!].sort((a, b) => a.name.localeCompare(b.name)));
        setSelectedDetails((prev) => [...prev, result.tag!.id]);
      }
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error creando detalle", error: true });
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveDetailsAndHighlights(productId, selectedDetails, highlights);
      setStatus({ text: "Detalles y destacados guardados." });
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error guardando", error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.panelCard}>
      <label className={styles.miniLabel} style={{ fontSize: 11 }}>
        Detalles (para similitud) — ilimitados
      </label>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <input
          className={styles.smallInput}
          placeholder="Buscar detalles..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 140 }}
        />
        <input
          className={styles.smallInput}
          placeholder="Crear detalle (ej. Frio)"
          value={newDetail}
          onChange={(e) => setNewDetail(e.target.value)}
          style={{ flex: 1, minWidth: 140 }}
        />
        <button type="button" className={styles.ghostBtn} onClick={() => handleCreateDetail(false)}>
          Crear detalle
        </button>
      </div>

      {pending && (
        <div className={styles.suggestBox}>
          ¿Quisiste decir <strong>{pending.name}</strong> en vez de &ldquo;{newDetail}&rdquo;?
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => {
                setSelectedDetails((prev) => (prev.includes(pending.id) ? prev : [...prev, pending.id]));
                setNewDetail("");
                setPending(null);
              }}
            >
              Usar {pending.name}
            </button>
            <button type="button" className={styles.ghostBtn} onClick={() => handleCreateDetail(true)}>
              Crear &ldquo;{newDetail}&rdquo; de todos modos
            </button>
            <button type="button" className={styles.ghostBtn} onClick={() => setPending(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className={styles.tag3List} style={{ maxHeight: 200 }}>
        {filtered.length === 0 && (
          <div style={{ color: "var(--ink-faint)", fontSize: 11, textAlign: "center", padding: 8 }}>
            Sin resultados.
          </div>
        )}
        {filtered.map((t) => (
          <label key={t.id} className={styles.tag3Item}>
            <input type="checkbox" checked={selectedDetails.includes(t.id)} onChange={() => toggleDetail(t.id)} />
            {t.name}
            {selectedDetails.includes(t.id) && (
              <button
                type="button"
                onClick={() => toggleHighlight(t.id)}
                style={{
                  marginLeft: "auto",
                  fontSize: 10.5,
                  background: highlights.includes(t.id) ? "var(--accent)" : "var(--surface)",
                  color: highlights.includes(t.id) ? "var(--accent-ink)" : "var(--ink-muted)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "2px 6px",
                  cursor: "pointer",
                }}
              >
                {highlights.includes(t.id) ? "★ Destacado" : "Destacar"}
              </button>
            )}
          </label>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <button type="button" className={styles.btnAccent} onClick={handleSave} disabled={saving}>
          {saving ? "Guardando..." : "Guardar Detalles y Destacados"}
        </button>
        {status && (
          <span style={{ marginLeft: 8, fontSize: 11, color: status.error ? "var(--danger)" : "var(--accent)" }}>
            {status.text}
          </span>
        )}
      </div>
    </div>
  );
}
