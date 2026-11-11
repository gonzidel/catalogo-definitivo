/**
 * Chips editables de intención detectada (tipo / color / talle).
 * Quitar un chip reescribe la query sin ese token.
 */
import { normalizeText, tokenizeNormalized } from "@/lib/search/normalize";
import { extractSizeIntent } from "@/lib/search/size-intent";
import { allColorFamilies, colorToFamilies } from "@/lib/search/color-families";
import { stemEsToken } from "@/lib/search/stem-es";

export type IntentChipKind = "size" | "color" | "term";

export interface IntentChip {
  id: string;
  kind: IntentChipKind;
  label: string;
  /** Token(s) normalizados que este chip representa en la query. */
  tokens: string[];
}

const COLOR_SET = new Set(allColorFamilies().map((c) => normalizeText(c)));

export function buildIntentChips(rawQuery: string): IntentChip[] {
  const raw = String(rawQuery ?? "").trim();
  if (raw.length < 2) return [];

  const sizeIntent = extractSizeIntent(raw);
  const chips: IntentChip[] = [];

  for (const size of sizeIntent.sizes) {
    chips.push({
      id: `size:${size}`,
      kind: "size",
      label: `Talle ${size}`,
      tokens: [normalizeText(size)],
    });
  }

  const content = sizeIntent.contentTokens;
  for (const token of content) {
    const stem = stemEsToken(token);
    const families = colorToFamilies(token);
    const isColor =
      COLOR_SET.has(stem) ||
      COLOR_SET.has(token) ||
      (families.length === 1 && COLOR_SET.has(families[0]));
    if (isColor) {
      const fam = families[0] ?? stem;
      chips.push({
        id: `color:${fam}`,
        kind: "color",
        label: fam.charAt(0).toUpperCase() + fam.slice(1),
        tokens: [token],
      });
    } else {
      chips.push({
        id: `term:${token}`,
        kind: "term",
        label: token.charAt(0).toUpperCase() + token.slice(1),
        tokens: [token],
      });
    }
  }

  return chips;
}

/** Reconstruye la query sin los tokens del chip indicado. */
export function removeIntentChip(rawQuery: string, chip: IntentChip): string {
  const sizeIntent = extractSizeIntent(rawQuery);
  const drop = new Set(chip.tokens.map((t) => normalizeText(t)));

  if (chip.kind === "size") {
    const keepSizes = sizeIntent.sizes.filter((s) => !drop.has(normalizeText(s)));
    const parts = [...sizeIntent.contentTokens];
    for (const s of keepSizes) parts.push(s);
    return parts.join(" ").trim();
  }

  const nextContent = sizeIntent.contentTokens.filter((t) => !drop.has(normalizeText(t)));
  const parts = [...nextContent, ...sizeIntent.sizes];
  return parts.join(" ").trim();
}

export function intentChipKey(chips: IntentChip[]): string {
  return chips.map((c) => c.id).join("|");
}

/** Helpers usados por tests. */
export function tokenizeIntentQuery(raw: string): string[] {
  return tokenizeNormalized(normalizeText(raw));
}
