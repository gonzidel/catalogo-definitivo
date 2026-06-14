"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import WhatsAppButton from "@/components/contact/WhatsAppButton";
import { BASE_PATH } from "@/lib/constants/app";

export default function BottomNav() {
  const pathname = usePathname();

  const isHome =
    pathname === "/" ||
    pathname === BASE_PATH ||
    pathname === `${BASE_PATH}/` ||
    (!pathname.startsWith(`${BASE_PATH}/producto`) &&
      !pathname.startsWith("/producto") &&
      !pathname.startsWith(`${BASE_PATH}/tags`) &&
      !pathname.startsWith("/tags"));

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

      <WhatsAppButton
        variant="nav"
        className="bottom-nav-item"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flex: "1 1 0",
          textDecoration: "none",
          color: "inherit",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <div className="icon">
          <svg viewBox="0 0 24 24" fill="#25D366" aria-hidden="true">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
          </svg>
        </div>
        <span className="label">WhatsApp</span>
      </WhatsAppButton>
    </nav>
  );
}
