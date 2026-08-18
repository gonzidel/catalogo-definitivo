"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useCartStore, selectCartCount, selectCartTotal } from "@/store/cart";

const FLASH_DURATION = 1400; // igual al flash local del PDP para evitar huecos al volver a la barra normal

export default function CartFloatingBar() {
  const router = useRouter();
  const pathname = usePathname();
  const totalQty = useCartStore(selectCartCount);
  const totalAmount = useCartStore(selectCartTotal);
  const lastAddedAt = useCartStore((s) => s.lastAddedAt);
  const pdpOwnBarActive = useCartStore((s) => s.pdpOwnBarActive);
  const [flash, setFlash] = useState(false);
  const [visible, setVisible] = useState(false);

  // Cuando se agrega un ítem → flash verde → luego naranja
  useEffect(() => {
    if (!lastAddedAt) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), FLASH_DURATION);
    return () => clearTimeout(t);
  }, [lastAddedAt]);

  // Visibilidad: mostrar si hay ítems en el carrito
  useEffect(() => {
    setVisible(totalQty > 0);
  }, [totalQty]);

  // En PDP, taparse solo mientras ESE producto tiene su propia barra activa
  // (talles elegidos ahí mismo) — si no hay selección en curso, esta barra
  // debe verse igual que en cualquier otra página para poder ir al carrito.
  const isOnPdp = pathname?.startsWith("/producto/") || pathname?.startsWith("/produto/");
  // Este aviso es solo para la experiencia de compra del cliente (home,
  // búsqueda/categorías, PDP). No tiene sentido — y no debe aparecer — en
  // /dashboard (carrito, mi pedido, perfil), /admin (panel interno), /login
  // ni en las páginas institucionales.
  const EXCLUDED_SECTIONS = ["/dashboard", "/admin", "/login", "/como-comprar", "/quienes-somos"];
  const isExcludedSection = EXCLUDED_SECTIONS.some((p) => pathname?.startsWith(p));
  const isFlash = flash;
  if (!visible || (isOnPdp && (pdpOwnBarActive || isFlash)) || isExcludedSection) return null;

  const title = isFlash
    ? "Agregado al carrito"
    : "Tu carrito";
  const subtitle = isFlash
    ? "Entrá al carrito para armar tu pedido"
    : `${totalQty} producto${totalQty !== 1 ? "s" : ""} · ${formatARS(totalAmount)}`;

  return (
    <div
      className={["cfb-bar", isFlash ? "is-flash" : ""].filter(Boolean).join(" ")}
      onClick={() => router.push("/dashboard?tab=cart")}
      role="button"
      aria-label={`${title}. ${subtitle}`}
    >
      <span className="cfb-bar__icon-wrap" aria-hidden="true">
        {!isFlash && <span className="cfb-bar__badge">{totalQty}</span>}
        {isFlash ? (
          <svg className="cfb-bar__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg className="cfb-bar__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.35" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
          </svg>
        )}
      </span>

      <span className="cfb-bar__copy">
        <span className="cfb-bar__title">{title}</span>
        <span className="cfb-bar__subtitle">{subtitle}</span>
      </span>

      {!isFlash && (
        <span className="cfb-bar__action">
          Ver
          <svg className="cfb-bar__chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      )}
    </div>
  );
}

function formatARS(n: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(n);
}
