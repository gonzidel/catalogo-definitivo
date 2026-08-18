"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { invokeAutoTags, applyAutoTagsPlainFields, type AutoTagsResult } from "@/lib/products/auto-tags";
import { createTagChecked, listTags1, listTags2, saveProductTags } from "@/lib/products/tags";
import styles from "@/app/admin/products/products-admin.module.css";

interface AutoTagsButtonProps {
  productId: string;
  productName: string;
  category: string;
  description: string;
  /** null hasta que exista al menos una imagen de variante (bloque de variantes). */
  imageUrl: string | null;
}

const SEASON_LABEL: Record<string, string> = {
  verano: "Verano",
  invierno: "Invierno",
  todo_anio: "Todo el año",
};

const AUDIENCE_LABEL: Record<string, string> = {
  mujer: "Mujer",
  hombre: "Hombre",
  ninos: "Niños",
  unisex: "Unisex",
};

export default function AutoTagsButton({
  productId,
  productName,
  category,
  description,
  imageUrl,
}: AutoTagsButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<AutoTagsResult | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);

  async function handleRun() {
    if (!imageUrl) {
      setStatus({
        text: "Subí al menos una imagen de una variante para usar el auto-etiquetado (llega en el bloque de variantes).",
        error: true,
      });
      return;
    }
    setLoading(true);
    setStatus(null);
    try {
      const r = await invokeAutoTags(imageUrl, productName, category, description);
      setResult(r);
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error en auto-etiquetado", error: true });
    } finally {
      setLoading(false);
    }
  }

  async function resolveTagId(name: string, level: 1 | 2, parentId: string | null) {
    const existing = level === 1 ? await listTags1(category) : await listTags2(parentId!);
    const exact = existing.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (exact) return exact.id;

    const created = await createTagChecked(name, level, category, parentId, false);
    if (created.tag) return created.tag.id;
    if (created.suggestion) return created.suggestion.id;
    return null;
  }

  async function handleApply() {
    if (!result) return;
    setApplying(true);
    setStatus(null);
    try {
      const tag1Id = await resolveTagId(result.tag1, 1, null);
      const tag2Id = tag1Id ? await resolveTagId(result.tag2, 2, tag1Id) : null;

      await saveProductTags(productId, {
        tag1Id,
        tag2Id,
        tag3Ids: [],
      });

      await applyAutoTagsPlainFields(productId, {
        season: result.season,
        targetAudience: result.target_audience,
        description: result.description,
      });

      setStatus({ text: "Aplicado. Revisá tags, temporada, público y descripción abajo." });
      setResult(null);
      router.refresh();
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error aplicando sugerencia", error: true });
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className={styles.panelCard} style={{ background: "var(--accent-soft)", borderColor: "var(--accent)" }}>
      <button type="button" className={styles.btnAccent} onClick={handleRun} disabled={loading} style={{ width: "100%" }}>
        {loading ? "Analizando..." : "🤖 Auto-tags con IA"}
      </button>

      {status && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: status.error ? "var(--danger)" : "var(--ink-muted)" }}>
          {status.text}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12, fontSize: 12.5, background: "var(--surface)", padding: 12, borderRadius: 8, border: "1px solid var(--border)" }}>
          <div>
            <strong>Tipo:</strong> {result.tag1} &nbsp; <strong>Atributo:</strong> {result.tag2}
          </div>
          <div>
            <strong>Temporada:</strong> {SEASON_LABEL[result.season]} &nbsp;
            <strong>Público:</strong> {AUDIENCE_LABEL[result.target_audience]}
          </div>
          {result.details.length > 0 && (
            <div>
              <strong>Detalles:</strong> {result.details.join(", ")}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <strong>Descripción sugerida:</strong>
            <div style={{ color: "var(--ink-muted)", marginTop: 2 }}>{result.description}</div>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--ink-faint)", marginTop: 6 }}>
            Confianza: {Math.round(result.confidence * 100)}%
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" className={styles.btnAccent} onClick={handleApply} disabled={applying}>
              {applying ? "Aplicando..." : "Aplicar sugerencia"}
            </button>
            <button type="button" className={styles.ghostBtn} onClick={() => setResult(null)}>
              Descartar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
