"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { EXP_CATALOG_ONLY, EXP_FULL_ONLY } from "@/lib/rollout/client";

export default function HowtoTabs() {
  const pathname = usePathname();

  return (
    <div className="howto-hero__tabs" role="tablist" aria-label="Secciones">
      <Link
        href="/como-comprar"
        className={`howto-tab${pathname === "/nj/como-comprar" || pathname === "/como-comprar" ? " is-active" : ""}`}
        role="tab"
        aria-selected={pathname?.includes("como-comprar") ? "true" : "false"}
      >
        <span className={EXP_FULL_ONLY}>Cómo comprar</span>
        <span className={EXP_CATALOG_ONLY}>Cómo usar el catálogo</span>
      </Link>
      <Link
        href="/quienes-somos"
        className={`howto-tab${pathname === "/nj/quienes-somos" || pathname === "/quienes-somos" ? " is-active" : ""}`}
        role="tab"
        aria-selected={pathname?.includes("quienes-somos") ? "true" : "false"}
      >
        Quiénes somos
      </Link>
    </div>
  );
}
