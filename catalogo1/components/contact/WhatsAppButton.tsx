"use client";

import { buildGeneralWhatsappUrl, buildWhatsappUrl } from "@/lib/utils/whatsapp";

interface WhatsAppButtonProps {
  articulo?: string;
  sku?: string;
  color?: string;
  size?: string;
  link?: string;
  variant?: "pdp" | "nav" | "header";
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

export default function WhatsAppButton({
  articulo,
  sku,
  color,
  size,
  link,
  variant = "pdp",
  className,
  style,
  children,
}: WhatsAppButtonProps) {
  const href =
    articulo || sku
      ? buildWhatsappUrl({
          model: articulo,
          sku,
          color,
          size,
          link: link ?? (typeof window !== "undefined" ? window.location.href : undefined),
        })
      : buildGeneralWhatsappUrl();

  const defaultLabel =
    variant === "pdp"
      ? "Consultar por WhatsApp"
      : variant === "nav"
        ? "WhatsApp"
        : "WhatsApp";

  const classes = [
    variant === "pdp" ? "pdp-whatsapp-cta" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={classes || undefined}
      style={style}
      aria-label={typeof children === "string" ? children : defaultLabel}
    >
      {children ?? defaultLabel}
    </a>
  );
}
