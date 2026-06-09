// Portado de scripts/utils/size-normalizer.js

export function normalizeSize(size: string | number | null | undefined): string {
  if (size === null || size === undefined) return "";
  let normalized = String(size).trim();
  const numValue = Number(normalized);
  if (!isNaN(numValue) && isFinite(numValue)) {
    normalized = String(Math.floor(numValue));
  }
  return normalized;
}

const APPAREL_SIZE_ORDER = [
  "xxs","xs","s","m","ml","l","xl","xxl","2xl","3xl","4xl","5xl",
  "6xl","7xl","8xl","9xl","10xl","11xl","12xl",
];

const APPAREL_SYNONYMS: Record<string, string> = {
  xxxl: "3xl", xxxxl: "4xl", xxxxxl: "5xl",
  xxxxxxl: "6xl", xxxxxxxl: "7xl", xxxxxxxxl: "8xl",
};

const APPAREL_RANK = Object.fromEntries(
  APPAREL_SIZE_ORDER.map((s, i) => [s, i])
);

function apparelSizeRank(size: string): number | null {
  const raw = String(size ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const key = APPAREL_SYNONYMS[raw] ?? raw;
  return Object.prototype.hasOwnProperty.call(APPAREL_RANK, key)
    ? APPAREL_RANK[key]
    : null;
}

function isNumericSizeString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(String(value ?? "").trim());
}

export function compareCatalogSizes(a: string, b: string): number {
  const aNum = isNumericSizeString(a);
  const bNum = isNumericSizeString(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;
  const ar = apparelSizeRank(a);
  const br = apparelSizeRank(b);
  if (ar !== null && br !== null) return ar - br;
  if (ar !== null && br === null) return -1;
  if (ar === null && br !== null) return 1;
  return String(a).localeCompare(String(b), "es", { sensitivity: "base" });
}
