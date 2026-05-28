import {
  canonicalTagKey,
  normalizeTagBasic,
  normalizeTagDisplay,
} from "./tag-normalize.ts";

/** Raíz FYL (Calzado/Ropa/Otros): no usar singularización de canonicalTagKey en "Otros". */
function normalizeRootCategoryKey(categoryRaw: string): string {
  const basic = normalizeTagBasic(categoryRaw);
  if (basic === "calzado" || basic === "calzados") return "calzado";
  if (basic === "ropa") return "ropa";
  if (basic === "otros" || basic === "otro") return "otros";
  return canonicalTagKey(categoryRaw);
}

/** product_type FYL: "Calzado > Botas" (display; keys vía canonicalTagKey). */
export function buildProductType(categoryRaw: string, filtro1Raw: string): string {
  const rootDisplay = normalizeTagDisplay(categoryRaw);
  if (!rootDisplay) return "";
  const filtroKey = canonicalTagKey(filtro1Raw);
  if (!filtroKey) return rootDisplay;
  const filtroDisplay = normalizeTagDisplay(filtro1Raw);
  if (!filtroDisplay) return rootDisplay;
  return `${rootDisplay} > ${filtroDisplay}`;
}

export function detectGender(categoryRaw: string): "female" | "male" | "unisex" {
  const root = normalizeRootCategoryKey(categoryRaw);
  if (root === "otros") return "unisex";
  if (root === "calzado" || root === "ropa") return "female";
  return "female";
}

export function applyPhase1Enrichment(row: Record<string, unknown>): Record<string, unknown> {
  const category = String(row.category ?? "");
  const filtro1 = String(row.filtro1 ?? "");

  return {
    ...row,
    item_group_id: row.item_group_id ? String(row.item_group_id).trim() : "",
    color: normalizeTagDisplay(String(row.color ?? "")),
    size: String(row.size ?? "").trim(),
    gender: detectGender(category),
    product_type: buildProductType(category, filtro1),
  };
}
