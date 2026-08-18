"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createTagChecked,
  deleteTag,
  listTags1,
  listTags2,
  listTags3ByTag1,
  saveProductTags,
  type SimilarTag,
  type TagRow,
} from "@/lib/products/tags";
import styles from "@/app/admin/products/products-admin.module.css";

interface TagsHierarchyPickerProps {
  productId: string;
  category: string;
  initial: { tag1Id: string | null; tag2Id: string | null; tag3Ids: string[] };
}

type Level = 1 | 2 | 3;

interface PendingSuggestion {
  level: Level;
  name: string;
  suggestion: SimilarTag;
}

export default function TagsHierarchyPicker({
  productId,
  category,
  initial,
}: TagsHierarchyPickerProps) {
  const router = useRouter();
  const [tags1, setTags1] = useState<TagRow[]>([]);
  const [tags2, setTags2] = useState<TagRow[]>([]);
  const [tags3, setTags3] = useState<TagRow[]>([]);

  const [tag1Id, setTag1Id] = useState(initial.tag1Id ?? "");
  const [tag2Id, setTag2Id] = useState(initial.tag2Id ?? "");
  const [tag3Ids, setTag3Ids] = useState<string[]>(initial.tag3Ids ?? []);

  const [newName, setNewName] = useState({ 1: "", 2: "", 3: "" } as Record<Level, string>);
  const [pending, setPending] = useState<PendingSuggestion | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listTags1(category).then(setTags1);
  }, [category]);

  useEffect(() => {
    if (!tag1Id) {
      setTags2([]);
      setTags3([]);
      return;
    }
    listTags2(tag1Id).then(setTags2);
    listTags3ByTag1(tag1Id).then(setTags3);
  }, [tag1Id]);

  function refreshLevel(level: Level) {
    if (level === 1) listTags1(category).then(setTags1);
    if (level === 2 && tag1Id) listTags2(tag1Id).then(setTags2);
    if (level === 3 && tag1Id) listTags3ByTag1(tag1Id).then(setTags3);
  }

  async function handleCreate(level: Level, force = false) {
    const name = newName[level].trim();
    if (!name) return;
    const parentId = level === 1 ? null : level === 2 ? tag1Id : tag2Id || tag1Id;
    if (level > 1 && !parentId) {
      setStatus({ text: "Elegí primero el nivel anterior.", error: true });
      return;
    }

    try {
      const result = await createTagChecked(name, level, category, parentId || null, force);
      if (result.suggestion) {
        setPending({ level, name, suggestion: result.suggestion });
        return;
      }
      if (result.tag) {
        setPending(null);
        setNewName((prev) => ({ ...prev, [level]: "" }));
        refreshLevel(level);
        if (level === 1) setTag1Id(result.tag.id);
        if (level === 2) setTag2Id(result.tag.id);
        if (level === 3 && tag3Ids.length < 2) setTag3Ids((prev) => [...prev, result.tag!.id]);
        setStatus({ text: `"${result.tag.name}" creado.` });
      }
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error creando tag", error: true });
    }
  }

  function useSuggestion() {
    if (!pending) return;
    if (pending.level === 1) setTag1Id(pending.suggestion.id);
    if (pending.level === 2) setTag2Id(pending.suggestion.id);
    if (pending.level === 3 && tag3Ids.length < 2) {
      setTag3Ids((prev) => [...prev, pending.suggestion.id]);
    }
    setNewName((prev) => ({ ...prev, [pending.level]: "" }));
    setPending(null);
  }

  async function forceCreate() {
    if (!pending) return;
    await handleCreate(pending.level, true);
  }

  async function handleDelete(level: Level, id: string) {
    if (!confirm("¿Eliminar este tag? No se puede deshacer.")) return;
    const result = await deleteTag(id);
    if (!result.deleted) {
      setStatus({ text: result.reason || "No se pudo eliminar.", error: true });
      return;
    }
    if (level === 1 && tag1Id === id) setTag1Id("");
    if (level === 2 && tag2Id === id) setTag2Id("");
    if (level === 3) setTag3Ids((prev) => prev.filter((t) => t !== id));
    refreshLevel(level);
  }

  function toggleTag3(id: string) {
    setTag3Ids((prev) => {
      if (prev.includes(id)) return prev.filter((t) => t !== id);
      if (prev.length >= 2) {
        setStatus({ text: "Solo podés seleccionar hasta 2 Tags3", error: true });
        return prev;
      }
      return [...prev, id];
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveProductTags(productId, { tag1Id: tag1Id || null, tag2Id: tag2Id || null, tag3Ids });
      setStatus({ text: "Tags guardados." });
      router.refresh();
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error guardando tags", error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.panelCard}>
      <div className={styles.tagLevelGrid}>
        <div className={styles.tagLevelCol}>
          <label className={styles.miniLabel}>Tags1 (tipo)</label>
          <select
            className={styles.smallInput}
            value={tag1Id}
            onChange={(e) => {
              setTag1Id(e.target.value);
              setTag2Id("");
              setTag3Ids([]);
            }}
            style={{ width: "100%" }}
          >
            <option value="">-- Seleccionar --</option>
            {tags1.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {tag1Id && (
            <button type="button" className={styles.expandToggle} style={{ marginTop: 4, color: "var(--danger)" }} onClick={() => handleDelete(1, tag1Id)}>
              Eliminar
            </button>
          )}
          {!tag1Id && (
            <div className={styles.tagCreateRow}>
              <input
                className={styles.smallInput}
                value={newName[1]}
                onChange={(e) => setNewName((p) => ({ ...p, 1: e.target.value }))}
                placeholder="O crear nuevo..."
              />
              <button type="button" className={styles.ghostBtn} onClick={() => handleCreate(1)}>
                Crear
              </button>
            </div>
          )}
        </div>

        <div className={styles.tagLevelCol}>
          <label className={styles.miniLabel}>Tags2 (atributo)</label>
          <select
            className={styles.smallInput}
            value={tag2Id}
            onChange={(e) => setTag2Id(e.target.value)}
            disabled={!tag1Id}
            style={{ width: "100%" }}
          >
            <option value="">-- {tag1Id ? "Seleccionar" : "Primero elegí Tags1"} --</option>
            {tags2.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {tag2Id && (
            <button type="button" className={styles.expandToggle} style={{ marginTop: 4, color: "var(--danger)" }} onClick={() => handleDelete(2, tag2Id)}>
              Eliminar
            </button>
          )}
          {tag1Id && !tag2Id && (
            <div className={styles.tagCreateRow}>
              <input
                className={styles.smallInput}
                value={newName[2]}
                onChange={(e) => setNewName((p) => ({ ...p, 2: e.target.value }))}
                placeholder="O crear nuevo..."
              />
              <button type="button" className={styles.ghostBtn} onClick={() => handleCreate(2)}>
                Crear
              </button>
            </div>
          )}
        </div>

        <div className={styles.tagLevelCol}>
          <label className={styles.miniLabel}>Tags3 — máx 2</label>
          <div className={styles.tag3List}>
            {tags3.length === 0 && <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>Sin opciones todavía</span>}
            {tags3.map((t) => (
              <label key={t.id} className={styles.tag3Item}>
                <input type="checkbox" checked={tag3Ids.includes(t.id)} onChange={() => toggleTag3(t.id)} />
                {t.name}
                <button type="button" className={styles.remove} onClick={() => handleDelete(3, t.id)}>
                  ✕
                </button>
              </label>
            ))}
          </div>
          {tag1Id && tag3Ids.length < 2 && (
            <div className={styles.tagCreateRow}>
              <input
                className={styles.smallInput}
                value={newName[3]}
                onChange={(e) => setNewName((p) => ({ ...p, 3: e.target.value }))}
                placeholder="O crear nuevo..."
              />
              <button type="button" className={styles.ghostBtn} onClick={() => handleCreate(3)}>
                Crear
              </button>
            </div>
          )}
        </div>
      </div>

      {pending && (
        <div className={styles.suggestBox}>
          ¿Quisiste decir <strong>{pending.suggestion.name}</strong> en vez de &ldquo;{pending.name}&rdquo;?
          <div className={styles.actions}>
            <button type="button" className={styles.ghostBtn} onClick={useSuggestion}>
              Usar {pending.suggestion.name}
            </button>
            <button type="button" className={styles.ghostBtn} onClick={forceCreate}>
              Crear &ldquo;{pending.name}&rdquo; de todos modos
            </button>
            <button type="button" className={styles.ghostBtn} onClick={() => setPending(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {status && (
        <div style={{ marginTop: 8, fontSize: 12, color: status.error ? "var(--danger)" : "var(--accent)" }}>
          {status.text}
        </div>
      )}

      <button type="button" className={styles.btnAccent} onClick={handleSave} disabled={saving} style={{ marginTop: 14 }}>
        {saving ? "Guardando..." : "Guardar tags"}
      </button>
    </div>
  );
}
