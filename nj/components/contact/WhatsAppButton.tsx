"use client";

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { buildGeneralWhatsappUrl, buildWhatsappUrl } from "@/lib/utils/whatsapp";
import { gaEvent } from "@/lib/analytics/ga";

interface WhatsAppButtonProps {
  articulo?: string;
  sku?: string;
  color?: string;
  size?: string;
  variant?: "pdp" | "nav" | "header" | "notice";
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** CTA de consulta del modo catalog (portado de catalogo1). */
export default function WhatsAppButton({
  articulo,
  sku,
  color,
  size,
  variant = "pdp",
  className,
  style,
  children,
}: WhatsAppButtonProps) {
  const isProduct = Boolean(articulo || sku);
  const generalHref = isProduct ? undefined : buildGeneralWhatsappUrl();

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    // El link del producto se arma al tocar: window.location solo existe en el cliente.
    if (isProduct) {
      event.currentTarget.href = buildWhatsappUrl({
        model: articulo,
        sku,
        color,
        size,
        link: window.location.href,
      });
    }
    gaEvent("whatsapp_click", { surface: variant, experience: "catalog" });
  }

  const defaultLabel = variant === "pdp" ? "Consultar por WhatsApp" : "WhatsApp";
  const classes = [variant === "pdp" ? "pdp-whatsapp-cta" : "", className].filter(Boolean).join(" ");

  return (
    <a
      href={generalHref ?? buildWhatsappUrl({ model: articulo, sku, color, size })}
      target="_blank"
      rel="noopener noreferrer"
      className={classes || undefined}
      style={style}
      onClick={handleClick}
      aria-label={typeof children === "string" ? children : defaultLabel}
    >
      {children ?? defaultLabel}
    </a>
  );
}
