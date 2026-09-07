"use client";

import Script from "next/script";
import { NJ_TEST_CLARITY_PROJECT_ID } from "@/lib/analytics/clarity";

/** Microsoft Clarity — solo en el deploy de test de NJ (ver layout.tsx). */
export default function ClarityLoader() {
  return (
    <Script id="nj-clarity-init" strategy="afterInteractive">
      {`
        (function(c,l,a,r,i,t,y){
          c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
          t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
          y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "${NJ_TEST_CLARITY_PROJECT_ID}");
      `}
    </Script>
  );
}
