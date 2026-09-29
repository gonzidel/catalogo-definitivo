"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import {
  NJ_TEST_CLARITY_PROJECT_ID,
  isNjTestClarityHost,
} from "@/lib/analytics/clarity";

/** Microsoft Clarity — solo en los hosts de NJ_TEST_CLARITY_HOSTS. */
export default function ClarityLoader() {
  // El host solo se conoce en el navegador; el primer render debe ser null en
  // servidor y cliente para no romper la hidratación.
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(isNjTestClarityHost(window.location.hostname));
  }, []);

  if (!enabled) return null;

  return (
    <Script id="nj-clarity-init" strategy="afterInteractive">
      {`
        (function(c,l,a,r,i,t,y){
          if (l.querySelector('script[src*="clarity.ms/tag/'+i+'"]')) return;
          c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
          t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
          y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "${NJ_TEST_CLARITY_PROJECT_ID}");
      `}
    </Script>
  );
}
