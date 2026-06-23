import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "@/styles/globals.css";
import Header from "@/components/layout/Header";
import BottomNav from "@/components/layout/BottomNav";
import { BASE_PATH } from "@/lib/constants/app";
import JsonLdScript from "@/lib/seo/JsonLdScript";
import { organizationJsonLd, webSiteJsonLd } from "@/lib/seo/json-ld";

export const metadata: Metadata = {
  title: "FYL Moda | Calzado e Indumentaria Femenina por Mayor",
  description:
    "Mayorista de calzado e indumentaria femenina con fábrica propia. Stock visible, surtido libre de talles desde 4 pares. Envíos a todo el país.",
  metadataBase: new URL("https://fylmoda.com.ar"),
  openGraph: {
    type: "website",
    siteName: "FYL Moda",
    locale: "es_AR",
    images: [{ url: "/icons/icon-192x192.png", width: 192, height: 192 }],
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
          <img src={`${BASE_PATH}/logo.png`} alt="Logo F&L" className="header-logo" />
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
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,400;0,600&display=swap"
        />
        <meta name="theme-color" content="#CD844D" />

        {/* Google Analytics */}
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-2JDYZW1KD6" />
        <script dangerouslySetInnerHTML={{ __html: `
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-2JDYZW1KD6', { send_page_view: true });
        `}} />

        {/* Meta Pixel */}
        <script dangerouslySetInnerHTML={{ __html: `
          !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
          n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
          n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
          t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
          (window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
          fbq('init','988002930324230');
          fbq('track','PageView');
        `}} />

        {/* Microsoft Clarity */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
          t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
          y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
          })(window,document,"clarity","script","w7h6cytm9j");
        `}} />
      </head>
      <body>
        <JsonLdScript data={[organizationJsonLd(), webSiteJsonLd()]} />
        {/* Header needs Suspense because SearchBar uses useSearchParams */}
        <Suspense fallback={<HeaderFallback />}>
          <Header />
        </Suspense>
        <div id="catalog-view">
          {children}
        </div>
        <Suspense fallback={null}>
          <BottomNav />
        </Suspense>
        <Analytics />
        <SpeedInsights />
        {/* Unregister stale Firebase service workers left from previous hosting */}
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(function(regs) {
              regs.forEach(function(r) { r.unregister(); });
            });
          }
        `}} />
      </body>
    </html>
  );
}
