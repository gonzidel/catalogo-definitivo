"use client";

import { useEffect, useState } from "react";
import { getVariantSizes, saveVariantSizes, type SizeStockRow } from "@/lib/products/variants";

interface SizesStockEditorProps {
  variantId: string;
  skuBase: string;
}

export default function SizesStockEditor({ variantId, skuBase }: SizesStockEditorProps) {
  const [sizesText, setSizesText] = useState("");
  const [stock, setStock] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    getVariantSizes(variantId).then((rows: SizeStockRow[]) => {
      setSizesText(rows.map((r) => r.size).join(", "));
      const map: Record<string, number> = {};
      for (const r of rows) map[r.size] = r.stock_qty;
      setStock(map);
    });
  }, [variantId]);

  function handleGenerate() {
    const sizes = sizesText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setStock((prev) => {
      const next: Record<string, number> = {};
      for (const s of sizes) next[s] = prev[s] ?? 0;
      return next;
    });
  }

  async function handleSave() {
    const items = Object.entries(stock).map(([size, stock_qty]) => ({ size, stock_qty }));
    if (items.length === 0) {
      setStatus({ text: "Generá los talles primero.", error: true });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await saveVariantSizes(variantId, skuBase, items);
      setStatus({ text: "Stock guardado." });
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error guardando stock", error: true });
    } finally {
      setSaving(false);
    }
  }

  const sizeKeys = Object.keys(stock);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          value={sizesText}
          onChange={(e) => setSizesText(e.target.value)}
          placeholder="35, 36, 37, 38, 39, 40"
          style={{ flex: 1, padding: 6 }}
        />
        <button type="button" onClick={handleGenerate}>
          Generar
        </button>
      </div>

      {sizeKeys.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(70px, 1fr))", gap: 6, marginBottom: 8 }}>
          {sizeKeys.map((size) => (
            <div key={size}>
              <label style={{ fontSize: 10, color: "#666", display: "block" }}>{size}</label>
              <input
                type="number"
                min={0}
                value={stock[size]}
                onChange={(e) =>
                  setStock((prev) => ({ ...prev, [size]: Math.max(0, parseInt(e.target.value, 10) || 0) }))
                }
                style={{ width: "100%", padding: 4 }}
              />
            </div>
          ))}
        </div>
      )}

      <button type="button" onClick={handleSave} disabled={saving}>
        {saving ? "Guardando..." : "Guardar talles y stock"}
      </button>
      {status && (
        <span style={{ marginLeft: 8, fontSize: 11, color: status.error ? "#c00" : "#090" }}>{status.text}</span>
      )}
    </div>
  );
}
