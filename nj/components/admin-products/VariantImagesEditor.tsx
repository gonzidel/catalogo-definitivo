"use client";

import { useEffect, useState } from "react";
import {
  deleteVariantImage,
  listVariantImages,
  loadImagesFromUrls,
  reorderVariantImages,
  uploadVariantImage,
  type VariantImageRow,
} from "@/lib/products/variants";

interface VariantImagesEditorProps {
  variantId: string;
  category: string;
  skuBase: string;
  color: string;
  onFirstImageUrl?: (url: string) => void;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function VariantImagesEditor({
  variantId,
  category,
  skuBase,
  color,
  onFirstImageUrl,
}: VariantImagesEditorProps) {
  const [images, setImages] = useState<VariantImageRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [urlsText, setUrlsText] = useState("");
  const [showUrlBox, setShowUrlBox] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    listVariantImages(variantId).then((rows) => {
      setImages(rows);
      if (rows[0]) onFirstImageUrl?.(rows[0].secure_url || rows[0].url);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantId]);

  async function refresh() {
    const rows = await listVariantImages(variantId);
    setImages(rows);
    if (rows[0]) onFirstImageUrl?.(rows[0].secure_url || rows[0].url);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!skuBase || !color) {
      setStatus({ text: "Completá SKU y color antes de subir imágenes.", error: true });
      return;
    }
    setUploading(true);
    setStatus(null);
    let position = images.length + 1;
    let ok = 0;
    let fail = 0;
    for (const file of Array.from(files).slice(0, 10)) {
      if (!file.type.match(/^image\/(jpeg|jpg|png|webp)$/)) {
        fail++;
        continue;
      }
      try {
        const base64 = await fileToBase64(file);
        await uploadVariantImage(variantId, base64, category, skuBase, color, position);
        position++;
        ok++;
      } catch {
        fail++;
      }
    }
    setUploading(false);
    setStatus({ text: `${ok} imagen(es) subida(s)${fail ? `, ${fail} con error` : ""}.`, error: fail > 0 && ok === 0 });
    await refresh();
  }

  async function handleLoadUrls() {
    const urls = urlsText.split("\n").map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) return;
    try {
      await loadImagesFromUrls(variantId, urls);
      setUrlsText("");
      setShowUrlBox(false);
      await refresh();
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error cargando URLs", error: true });
    }
  }

  async function handleDelete(imageId: string) {
    if (!confirm("¿Eliminar esta imagen?")) return;
    try {
      await deleteVariantImage(imageId);
      await refresh();
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error eliminando imagen", error: true });
    }
  }

  async function move(index: number, dir: -1 | 1) {
    const next = [...images];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setImages(next);
    try {
      await reorderVariantImages(variantId, next.map((i) => i.id));
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : "Error reordenando", error: true });
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <label style={{ padding: "6px 10px", border: "1px solid #ddd", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>
          {uploading ? "Subiendo..." : "Subir imágenes"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={uploading}
            onChange={(e) => handleFiles(e.target.files)}
            style={{ display: "none" }}
          />
        </label>
        <button type="button" onClick={() => setShowUrlBox((v) => !v)}>
          Cargar por URL
        </button>
      </div>

      {showUrlBox && (
        <div style={{ marginBottom: 8 }}>
          <textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            placeholder="Una URL de Cloudinary por línea"
            rows={3}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }}
          />
          <button type="button" onClick={handleLoadUrls}>
            Cargar URLs
          </button>
        </div>
      )}

      {status && <div style={{ fontSize: 11, color: status.error ? "#c00" : "#090", marginBottom: 8 }}>{status.text}</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {images.map((img, i) => (
          <div key={img.id} style={{ textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.secure_url || img.url}
              alt=""
              width={70}
              height={70}
              style={{ objectFit: "cover", borderRadius: 4, border: img.is_main ? "2px solid #3a6df0" : "1px solid #ddd" }}
            />
            <div style={{ display: "flex", gap: 2, justifyContent: "center", marginTop: 2 }}>
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} style={{ fontSize: 10 }}>
                ←
              </button>
              <button type="button" onClick={() => handleDelete(img.id)} style={{ fontSize: 10 }}>
                ✕
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === images.length - 1} style={{ fontSize: 10 }}>
                →
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
