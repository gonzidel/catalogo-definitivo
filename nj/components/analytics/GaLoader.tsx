"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { FYL_GA_MEASUREMENT_ID } from "@/lib/analytics/ga";
import { EXPERIENCE_MIRROR_COOKIE, GRANT_SOURCE_BY_CODE } from "@/lib/rollout/constants";
import { ROLLOUT_UI_ENABLED } from "@/lib/rollout/client";

function isMeasuredPath(pathname: string): boolean {
  return !pathname.startsWith("/admin") && !pathname.startsWith("/dashboard");
}

/**
 * Carga gtag en catálogo/cliente. Admin no se mide (igual que scripts/analytics.js).
 * page_view automático solo en www con nj sirviendo la raíz (paridad con catalogo1).
 */
export default function GaLoader() {
  const pathname = usePathname() ?? "/";
  if (!isMeasuredPath(pathname)) return null;

  const enabled = ROLLOUT_UI_ENABLED ? "true" : "false";

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
          var fylRollout = ${enabled};
          var fylHost = location.hostname.toLowerCase();
          var fylProd = fylRollout && (fylHost === 'www.fylmoda.com.ar' || fylHost === 'fylmoda.com.ar');
          var fylX = (document.cookie.match(/(?:^|; )${EXPERIENCE_MIRROR_COOKIE}=([^;]*)/) || [])[1] || '';
          fylX = decodeURIComponent(fylX).split('.');
          var fylExp = !fylRollout ? 'full' : (fylX[0] === 'f' ? 'full' : 'catalog');
          var fylSrc = (fylExp === 'full' && ${JSON.stringify(GRANT_SOURCE_BY_CODE)}[fylX[1]]) || 'none';
          gtag('set', 'user_properties', { experience: fylExp, rollout_source: fylSrc });
          gtag('config', '${FYL_GA_MEASUREMENT_ID}', { send_page_view: fylProd });
        `}
      </Script>
    </>
  );
}
