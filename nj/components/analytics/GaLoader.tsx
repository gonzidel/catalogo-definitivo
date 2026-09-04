"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { FYL_GA_MEASUREMENT_ID } from "@/lib/analytics/ga";

function isMeasuredPath(pathname: string): boolean {
  return !pathname.startsWith("/admin") && !pathname.startsWith("/dashboard");
}

/** Carga gtag en catálogo/cliente. Admin no se mide (igual que scripts/analytics.js). */
export default function GaLoader() {
  const pathname = usePathname() ?? "/";
  if (!isMeasuredPath(pathname)) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${FYL_GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="fyl-ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = window.gtag || gtag;
          gtag('js', new Date());
          gtag('config', '${FYL_GA_MEASUREMENT_ID}', { send_page_view: false });
        `}
      </Script>
    </>
  );
}
