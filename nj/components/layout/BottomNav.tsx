"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useCartStore, selectCartCount } from "@/store/cart";

export default function BottomNav() {
  const pathname = usePathname();
  const cartCount = useCartStore(selectCartCount);

  const isHome =
    pathname === "/" ||
    pathname === "/nj" ||
    pathname === "/nj/" ||
    (!pathname.startsWith("/nj/producto") && !pathname.startsWith("/nj/tags"));

  return (
    <nav className="bottom-nav bottom-nav--three" id="bottom-nav">
      <Link href="/" className={`bottom-nav-item${isHome ? " active" : ""}`}>
        <div className="icon">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>
        <span className="label">Inicio</span>
      </Link>

      <button
        className="bottom-nav-item"
        id="nav-buscar"
        onClick={() => {
          const searchInput = document.getElementById(
            "search-bar-mobile"
          ) as HTMLInputElement | null;
          searchInput?.focus();
        }}
      >
        <div className="icon">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>
        <span className="label">Buscar</span>
      </button>

      <Link
        href={cartCount > 0 ? "/dashboard?tab=cart" : "/dashboard?tab=active-order"}
        className={`bottom-nav-item${pathname?.startsWith("/dashboard") ? " active" : ""}`}
        id="nav-pedidos"
        style={{ position: "relative" }}
      >
        <div className="icon" style={{ position: "relative" }}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="9" cy="21" r="1" />
            <circle cx="20" cy="21" r="1" />
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
          </svg>
          {cartCount > 0 && (
            <span style={{
              position: "absolute", top: -6, right: -6,
              background: "#CD844D", color: "#fff",
              borderRadius: "50%", width: 16, height: 16,
              fontSize: 10, fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center",
              lineHeight: 1,
            }}>
              {cartCount > 9 ? "9+" : cartCount}
            </span>
          )}
        </div>
        <span className="label">Pedido</span>
      </Link>

      <Link
        href="/dashboard"
        className={`bottom-nav-item${pathname?.startsWith("/dashboard") ? " active" : ""}`}
        id="nav-perfil"
      >
        <div className="icon">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="8" r="4" />
          </svg>
        </div>
        <span className="label">Perfil</span>
      </Link>
    </nav>
  );
}
