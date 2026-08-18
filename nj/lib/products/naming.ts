export function slugify(str: string): string {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Categoría distinta de Ropa: si el nombre arranca con "R" + dígito, se lo saca. */
export function stripRopaPrefixIfNotRopa(name: string, category: string): string {
  if (category === "Ropa") return name;
  return /^R\d/.test(name) ? name.replace(/^R\d+/, "").trim() : name;
}

/** Ropa: si el nombre no arranca con "R" + dígito, se le antepone "R" (sin numero). */
export function applyRopaPrefixOnBlur(name: string, category: string): string {
  const trimmed = name.trim();
  if (category !== "Ropa" || !trimmed) return trimmed;
  return /^R\d/.test(trimmed) ? trimmed : `R${trimmed}`;
}
