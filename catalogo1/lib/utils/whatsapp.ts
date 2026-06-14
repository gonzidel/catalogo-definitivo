import { BASE_PATH } from "@/lib/constants/app";

export const WHATSAPP_NUMBER = "5493625172874";

export interface WhatsappPayload {
  model?: string;
  sku?: string;
  color?: string;
  size?: string;
  link?: string;
}

function cleanText(value: string | undefined | null): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function buildWhatsappMessage({
  model,
  sku,
  color,
  size,
  link,
}: WhatsappPayload): string {
  const identifier = cleanText(
    [model, sku && sku !== model ? sku : ""].filter(Boolean).join(" / ")
  );
  const lines = [
    `Hola, quiero consultar por este modelo: ${identifier || "producto FYL"}.`,
  ];
  if (link) lines.push(`Link: ${link}`);
  if (color) lines.push(`Color: ${color}`);
  if (size) lines.push(`Talle: ${size}`);
  return lines.join("\n");
}

export function buildWhatsappUrl(payload: WhatsappPayload): string {
  const text = encodeURIComponent(buildWhatsappMessage(payload));
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${text}`;
}

export function buildGeneralWhatsappUrl(): string {
  return `https://wa.me/${WHATSAPP_NUMBER}`;
}

export function buildProductPageUrl(sku: string): string {
  if (typeof window !== "undefined") {
    return window.location.href;
  }
  return `${BASE_PATH}/producto/${encodeURIComponent(sku)}`;
}
