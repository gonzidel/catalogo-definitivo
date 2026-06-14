export const CURATED_TAG = "__curated__";
export const CURATED_SPECIAL_TAG = "__curated_special__";
export const CURATED_PUBLIC_TAGS = [CURATED_TAG, CURATED_SPECIAL_TAG] as const;

export type SpecialBannerMeta = {
  overline: string;
  ctaLabel: string;
};

const DEFAULT_SPECIAL_META: SpecialBannerMeta = {
  overline: "OCASIÓN ESPECIAL",
  ctaLabel: "Ver selección",
};

export function parseSpecialBannerMeta(
  description: string | null | undefined
): SpecialBannerMeta {
  if (!description?.trim()) return { ...DEFAULT_SPECIAL_META };

  try {
    const parsed = JSON.parse(description) as Partial<SpecialBannerMeta>;
    return {
      overline: String(parsed.overline ?? DEFAULT_SPECIAL_META.overline).trim(),
      ctaLabel: String(parsed.ctaLabel ?? DEFAULT_SPECIAL_META.ctaLabel).trim(),
    };
  } catch {
    return {
      overline: description.trim(),
      ctaLabel: DEFAULT_SPECIAL_META.ctaLabel,
    };
  }
}

export function serializeSpecialBannerMeta(meta: SpecialBannerMeta): string {
  return JSON.stringify({
    overline: meta.overline.trim() || DEFAULT_SPECIAL_META.overline,
    ctaLabel: meta.ctaLabel.trim() || DEFAULT_SPECIAL_META.ctaLabel,
  });
}
