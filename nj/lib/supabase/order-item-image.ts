import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export async function fetchOrderItemImageUrl(
  item: { imagen?: string | null; variant_id?: string | null }
): Promise<string | null> {
  const cached = String(item.imagen || "").trim();
  if (cached) return cached;

  const variantId = String(item.variant_id || "").trim();
  if (!variantId) return null;

  const supabase = getSupabaseBrowserClient();
  const { data: primary } = await supabase
    .from("variant_images")
    .select("url")
    .eq("variant_id", variantId)
    .eq("position", 1)
    .maybeSingle();

  if (primary?.url) return primary.url;

  const { data: fallback } = await supabase
    .from("variant_images")
    .select("url")
    .eq("variant_id", variantId)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();

  return fallback?.url ?? null;
}
