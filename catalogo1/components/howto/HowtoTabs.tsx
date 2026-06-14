"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BASE_PATH } from "@/lib/constants/app";

export default function HowtoTabs() {
  const pathname = usePathname();

  const isComoComprar =
    pathname === `${BASE_PATH}/como-comprar` || pathname === "/como-comprar";
  const isQuienesSomos =
    pathname === `${BASE_PATH}/quienes-somos` || pathname === "/quienes-somos";

  return (
    <div className="howto-hero__tabs" role="tablist" aria-label="Secciones">
      <Link
        href="/como-comprar"
        className={`howto-tab${isComoComprar ? " is-active" : ""}`}
        role="tab"
        aria-selected={isComoComprar ? "true" : "false"}
      >
        Cómo usar el catálogo
      </Link>
      <Link
        href="/quienes-somos"
        className={`howto-tab${isQuienesSomos ? " is-active" : ""}`}
        role="tab"
        aria-selected={isQuienesSomos ? "true" : "false"}
      >
        Quiénes somos
      </Link>
    </div>
  );
}
