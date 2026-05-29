/** Fase 3: sale_price, additional_image_link, marketing labels. */

const NEW_ARRIVAL_DAYS = 120;

function formatPriceAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const isInteger = Number.isInteger(amount);
  const value = isInteger ? String(amount) : amount.toFixed(2);
  return `${value} ARS`;
}

function parseNumeric(value: unknown): number {
  if (value == null) return Number.NaN;
  if (typeof value === "number") return value;
  const n = Number.parseFloat(String(value).replace(/\s+ARS$/i, "").trim());
  return Number.isFinite(n) ? n : Number.NaN;
}

function isOfertaActiva(value: unknown): boolean {
  return value === true || value === "true" || value === "t";
}

export function applySalePriceFields(row: Record<string, unknown>): {
  price: string;
  sale_price: string;
} {
  const listPrice = parseNumeric(row.list_price);
  const offerPrice = parseNumeric(row.offer_price);
  const listFormatted = formatPriceAmount(listPrice) ||
    (typeof row.price === "string" ? row.price : "");

  if (
    isOfertaActiva(row.oferta_activa) &&
    Number.isFinite(offerPrice) &&
    offerPrice > 0 &&
    Number.isFinite(listPrice) &&
    listPrice > 0 &&
    offerPrice < listPrice
  ) {
    return {
      price: formatPriceAmount(listPrice),
      sale_price: formatPriceAmount(offerPrice),
    };
  }

  return {
    price: listFormatted,
    sale_price: "",
  };
}

export function normalizeAdditionalImageLink(
  raw: string,
  normalizeUrl: (url: string) => string,
): string {
  if (!raw || typeof raw !== "string") return "";
  const urls = raw
    .split(",")
    .map((u) => normalizeUrl(u.trim()))
    .filter((u) => u && !u.toLowerCase().includes("placeholder"));
  return urls.join(",");
}

function parseFechaMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** top_seller > new_arrival (custom_label_4 único). */
export function detectMarketingLabel(row: Record<string, unknown>): string {
  const units = parseNumeric(row.units_sold_90d);
  if (Number.isFinite(units) && units >= 3) return "top_seller";

  const pubMs = parseFechaMs(row.fecha_publicacion);
  if (pubMs != null) {
    const ageDays = (Date.now() - pubMs) / (1000 * 60 * 60 * 24);
    if (ageDays >= 0 && ageDays <= NEW_ARRIVAL_DAYS) return "new_arrival";
  }

  return "";
}

export function appendToInternalLabel(
  existing: string,
  extraKeys: string[],
  max = 14,
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(existing ?? "").split("|")) {
    const k = part.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  for (const key of extraKeys) {
    const k = String(key ?? "").trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.slice(0, max).join("|");
}

export function applyPhase3Enrichment(
  row: Record<string, unknown>,
  normalizeCloudinaryURL: (url: string) => string,
): Record<string, unknown> {
  const { price, sale_price } = applySalePriceFields(row);
  const additional_image_link = normalizeAdditionalImageLink(
    String(row.additional_image_link ?? ""),
    normalizeCloudinaryURL,
  );
  const marketing = detectMarketingLabel(row);
  const internal_label = appendToInternalLabel(
    String(row.internal_label ?? ""),
    marketing ? [marketing] : [],
  );

  return {
    ...row,
    price,
    sale_price,
    additional_image_link,
    custom_label_4: marketing,
    internal_label,
  };
}
