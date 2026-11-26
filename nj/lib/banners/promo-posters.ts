import type { SupabaseClient } from "@supabase/supabase-js";

/** Afiche de una promo 2x que tiene imagen cargada. */
export type PromoPoster = {
  id: string;
  imageUrl: string;
  title: string;
  recencyMs: number;
};

export function promoPosterTitle(
  promoType: string | null,
  fixedAmount: number | string | null
): string {
  if (promoType === "2x1") return "2x1";
  if (promoType === "2xMonto" && fixedAmount != null && String(fixedAmount).trim() !== "") {
    const amount = Number(fixedAmount);
    if (Number.isFinite(amount)) {
      const formatted = new Intl.NumberFormat("es-AR", {
        maximumFractionDigits: 0,
      }).format(amount);
      return `2x $${formatted}`;
    }
  }
  return "Promoción";
}

/** Promos vigentes con imagen. La vigencia la filtra la policy de lectura pública. */
export async function fetchActivePromoPosters(
  supabase: SupabaseClient
): Promise<PromoPoster[]> {
  const { data, error } = await supabase
    .from("promotions")
    .select("id, promo_type, fixed_amount, promo_image_url, updated_at")
    .not("promo_image_url", "is", null)
    .order("updated_at", { ascending: false });
  if (error || !data) return [];

  const posters: PromoPoster[] = [];
  for (const row of data) {
    const imageUrl = String(row.promo_image_url ?? "").trim();
    const id = String(row.id ?? "").trim();
    if (!imageUrl || !id) continue;
    const updated = Date.parse(String(row.updated_at ?? ""));
    posters.push({
      id,
      imageUrl,
      title: promoPosterTitle(row.promo_type, row.fixed_amount),
      recencyMs: Number.isFinite(updated) ? updated : 0,
    });
  }
  return posters;
}
