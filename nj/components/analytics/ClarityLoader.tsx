"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { clarityProjectForHost } from "@/lib/analytics/clarity";
import { ROLLOUT_UI_ENABLED } from "@/lib/rollout/client";

/** Microsoft Clarity: proyecto de test en NJ_TEST_CLARITY_HOSTS, productivo en www tras el cambio de host. */
export default function ClarityLoader() {
  // El host solo se conoce en el navegador; el primer render debe ser null en
  // servidor y cliente para no romper la hidratación.
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    setProjectId(clarityProjectForHost(window.location.hostname, ROLLOUT_UI_ENABLED));
  }, []);

  if (!projectId) return null;

  return (
    <Script id="nj-clarity-init" strategy="afterInteractive">
      {`
        (function(c,l,a,r,i,t,y){
          if (l.querySelector('script[src*="clarity.ms/tag/'+i+'"]')) return;
          c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
          t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
          y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "${projectId}");
      `}
    </Script>
  );
}
