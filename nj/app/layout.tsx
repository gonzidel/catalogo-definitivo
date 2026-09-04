import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import Link from "next/link";
import "@/styles/globals.css";
import Header from "@/components/layout/Header";
import BottomNav from "@/components/layout/BottomNav";
import CartFloatingBar from "@/components/cart/CartFloatingBar";
import ProfileGateProvider from "@/components/profile/ProfileGateProvider";
import GaLoader from "@/components/analytics/GaLoader";

export const metadata: Metadata = {
  title: "FYL Moda | Calzado e Indumentaria Femenina por Mayor",
  description:
    "Mayorista de calzado e indumentaria femenina con fábrica propia. Stock visible, surtido libre de talles desde 4 pares. Envíos a todo el país.",
  openGraph: {
    type: "website",
    siteName: "FYL Moda",
    locale: "es_AR",
  },
  other: {
    "format-detection": "telephone=no",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#CD844D",
};

function HeaderFallback() {
  return (
    <header>
      <div className="header-left">
        <Link href="/" className="header-logo-btn" aria-label="Inicio">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/nj/logo.png" alt="Logo F&L" className="header-logo" />
        </Link>
      </div>
      <div className="search-bar-wrapper" />
      <div className="header-right" />
    </header>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://res.cloudinary.com" crossOrigin="anonymous" />
        <link rel="icon" href="/nj/favicon.ico" sizes="any" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,400;0,600&display=swap"
        />
        <meta name="theme-color" content="#CD844D" />
      </head>
      <body>
        <GaLoader />
        <ProfileGateProvider>
          {/* Header needs Suspense because SearchBar uses useSearchParams */}
          <Suspense fallback={<HeaderFallback />}>
            <Header />
          </Suspense>
          <div id="catalog-view">
            {children}
          </div>
          <CartFloatingBar />
          <Suspense fallback={null}>
            <BottomNav />
          </Suspense>
        </ProfileGateProvider>
      </body>
    </html>
  );
}
