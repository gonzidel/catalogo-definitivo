"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { shouldUseProductionAnalytics } from "@/lib/analytics/hosts";
import { ROLLOUT_UI_ENABLED } from "@/lib/rollout/client";

const META_PIXEL_ID = "988002930324230";

/** Meta Pixel de catalogo1: PageView una vez por carga, solo en www con nj sirviendo la raíz. */
export default function MetaPixelLoader() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(shouldUseProductionAnalytics(window.location.hostname, ROLLOUT_UI_ENABLED));
  }, []);

  if (!enabled) return null;

  return (
    <Script id="fyl-meta-pixel" strategy="afterInteractive">
      {`
        !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
        n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
        (window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
        fbq('init','${META_PIXEL_ID}');
        fbq('track','PageView');
      `}
    </Script>
  );
}
