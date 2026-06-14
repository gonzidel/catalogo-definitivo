import { compareCatalogSizes, normalizeSize } from "@/lib/utils/size-normalizer";

const ROPA_LETTER_SET = new Set(["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"]);

export const ROPA_UNIFIED_PAIRS = [
  { label: "S/1", keys: ["ROPA:L:S", "ROPA:N:1"] },
  { label: "M/2", keys: ["ROPA:L:M", "ROPA:N:2"] },
  { label: "L/3", keys: ["ROPA:L:L", "ROPA:N:3"] },
  { label: "XL/4", keys: ["ROPA:L:XL", "ROPA:N:4"] },
  { label: "2XL/5", keys: ["ROPA:L:2XL", "ROPA:N:5"] },
  { label: "3XL/6", keys: ["ROPA:L:3XL", "ROPA:N:6"] },
  { label: "4XL/7", keys: ["ROPA:L:4XL", "ROPA:N:7"] },
  { label: "5XL/8", keys: ["ROPA:L:5XL", "ROPA:N:8"] },
] as const;

export const ROPA_PAIR_LABELS = new Set<string>(ROPA_UNIFIED_PAIRS.map((p) => p.label));

function stripTrailingDots(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/\.+$/g, "")
    .trim();
}

function isRopaUnicoToken(s: string): boolean {
  const t = stripTrailingDots(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return t === "unico" || t === "unica" || t === "u";
}

function ropaLetterCanonical(s: string): string | null {
  const raw = String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!raw) return null;
  if (/^(6|7|8|9|1[0-9]|[2-9]\d)xl$/.test(raw)) return null;

  const map: Record<string, string> = {
    s: "S",
    m: "M",
    l: "L",
    xl: "XL",
    xxl: "2XL",
    "2xl": "2XL",
    xxxl: "3XL",
    "3xl": "3XL",
    xxxxl: "4XL",
    "4xl": "4XL",
    xxxxxl: "5XL",
    "5xl": "5XL",
  };
  const c = map[raw] ?? (ROPA_LETTER_SET.has(raw.toUpperCase()) ? raw.toUpperCase() : null);
  return c && ROPA_LETTER_SET.has(c) ? c : null;
}

function parseRopaIntSize(s: string): number | null {
  const t = stripTrailingDots(s);
  if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
  const n = parseInt(normalizeSize(t) || t, 10);
  return Number.isNaN(n) || n < 0 ? null : n;
}

export interface RopaTalleClass {
  key: string;
  filterValue: string;
  section: "U" | "M" | "P";
}

export function classifyRopaTalle(raw: string): RopaTalleClass | null {
  const t = stripTrailingDots(String(raw ?? ""));
  if (!t) return null;

  if (isRopaUnicoToken(t)) {
    return { key: "ROPA:U", filterValue: "Único", section: "U" };
  }

  const letter = ropaLetterCanonical(t);
  if (letter) {
    return {
      key: `ROPA:L:${letter}`,
      filterValue: letter,
      section: "M",
    };
  }

  const n = parseRopaIntSize(t);
  if (n !== null) {
    const fv = String(n);
    if (n >= 34 && n <= 60) {
      return { key: `ROPA:P:${n}`, filterValue: fv, section: "P" };
    }
    if (n >= 1 && n <= 10) {
      return { key: `ROPA:N:${n}`, filterValue: fv, section: "M" };
    }
    return { key: `ROPA:E:${n}`, filterValue: fv, section: "M" };
  }

  const x = t.replace(/\s+/g, " ").trim();
  return {
    key: `ROPA:X:${x.normalize("NFD").toLowerCase()}`,
    filterValue: x,
    section: "M",
  };
}

export function ropaTalleKey(s: string): string {
  return classifyRopaTalle(s)?.key ?? "";
}

export function ropaSelectionKey(sel: string): string {
  const t = String(sel ?? "").trim();
  if (ROPA_PAIR_LABELS.has(t)) return `ROPA:SEL:PAIR:${t}`;
  return ropaTalleKey(t);
}

export function isRopaSizeSelected(value: string, selected: string[]): boolean {
  const kv = ropaSelectionKey(value);
  if (!kv) return false;
  return selected.some((x) => ropaSelectionKey(x) === kv);
}

export type RopaMainEntry =
  | { kind: "pair"; token: string }
  | { kind: "num"; token: string }
  | { kind: "extra"; token: string }
  | { kind: "unico"; token: string };

export function buildRopaUnifiedMainEntries(byKey: Map<string, string>): RopaMainEntry[] {
  const consumed = new Set<string>();
  const out: RopaMainEntry[] = [];

  for (const p of ROPA_UNIFIED_PAIRS) {
    if (p.keys.some((k) => byKey.has(k))) {
      p.keys.forEach((k) => consumed.add(k));
      out.push({ kind: "pair", token: p.label });
    }
  }

  for (const n of [9, 10]) {
    const k = `ROPA:N:${n}`;
    if (byKey.has(k) && !consumed.has(k)) {
      consumed.add(k);
      out.push({ kind: "num", token: String(n) });
    }
  }

  const extras: string[] = [];
  for (const [key, fv] of byKey.entries()) {
    if (consumed.has(key) || key.startsWith("ROPA:P:") || key === "ROPA:U") continue;
    consumed.add(key);
    extras.push(fv);
  }
  extras.sort(compareCatalogSizes);
  for (const fv of extras) out.push({ kind: "extra", token: fv });

  if (byKey.has("ROPA:U")) out.push({ kind: "unico", token: "Único" });

  return out;
}

/** Claves ROPA:* que debe coincidir un producto para la selección actual. */
export function expandRopaSelectionToKeys(selected: string[]): Set<string> {
  const keys = new Set<string>();
  for (const sel of selected) {
    const t = String(sel).trim();
    if (ROPA_PAIR_LABELS.has(t)) {
      const pair = ROPA_UNIFIED_PAIRS.find((p) => p.label === t);
      pair?.keys.forEach((k) => keys.add(k));
      continue;
    }
    const k = ropaTalleKey(t);
    if (k) keys.add(k);
  }
  return keys;
}

export function productTalleMatchesRopaKeys(talle: string, keys: Set<string>): boolean {
  const parts = talle.includes("/")
    ? talle.split("/").map((p) => p.trim()).filter(Boolean)
    : [talle.trim()];

  for (const part of parts) {
    const k = ropaTalleKey(part);
    if (k && keys.has(k)) return true;
  }
  return false;
}
