"use client";

import { useState } from "react";
import { createVariant, listVariants, type ColorRow, type VariantRow as VariantRowType } from "@/lib/products/variants";
import VariantRow from "./VariantRow";
import styles from "@/app/admin/products/products-admin.module.css";

interface VariantsPanelProps {
  productId: string;
  category: string;
  handle: string;
  supplierId: string | null;
  initialVariants: VariantRowType[];
  colors: ColorRow[];
}

export default function VariantsPanel({
  productId,
  category,
  handle,
  supplierId,
  initialVariants,
  colors,
}: VariantsPanelProps) {
  const [variants, setVariants] = useState(initialVariants);
  const [newColor, setNewColor] = useState("");
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);

  async function refresh() {
    setVariants(await listVariants(productId));
  }

  async function handleAddVariant() {
    if (!newColor.trim()) return;
    setAdding(true);
    setStatus(null);
    try {
      const created = await createVariant(productId, newColor.trim(), handle, supplierId);
      setNewColor("");
      setLastAddedId(created.id);
      await refresh();
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error creando variante", error: true });
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <div className={styles.variantAddRow}>
        <input
          list="colors-datalist"
          className={styles.smallInput}
          placeholder="Color (ej. Negro)"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAddVariant()}
        />
        <datalist id="colors-datalist">
          {colors.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
        <button type="button" className={styles.btnAccent} onClick={handleAddVariant} disabled={adding}>
          {adding ? "Agregando..." : "+ Agregar variante"}
        </button>
      </div>

      {status && (
        <div style={{ fontSize: 12, color: status.error ? "var(--danger)" : "var(--accent)", marginBottom: 10 }}>
          {status.text}
        </div>
      )}

      {variants.length === 0 && (
        <div className={styles.emptyVariants}>Todavía no hay variantes. Agregá un color para empezar.</div>
      )}

      {variants.map((v) => (
        <VariantRow
          key={v.id}
          variant={v}
          productId={productId}
          category={category}
          onChanged={refresh}
          startExpanded={v.id === lastAddedId}
        />
      ))}
    </div>
  );
}
