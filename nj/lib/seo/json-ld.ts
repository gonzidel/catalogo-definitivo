import { CANONICAL_SITE_URL } from "@/lib/site-url";

/** Portado de catalogo1 con la URL canónica final: www y catálogo en la raíz. */
const SITE_URL = CANONICAL_SITE_URL;
const SITE_NAME = "FYL Moda";
/** Sin "fábrica propia" ni "desde 4 pares": claims en revisión comercial (docs/01_EMPRESA.md, 11_PROBLEMAS_Y_FIXES.md). */
const SITE_DESCRIPTION =
  "Mayorista de calzado e indumentaria femenina para revendedoras. Surtido libre de modelos y talles. Envíos a todo el país.";
const SITE_LOGO = `${SITE_URL}/icons/icon-192x192.png`;

export function absoluteUrl(path: string): string {
  return path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path}`;
}

export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    logo: SITE_LOGO,
    description: SITE_DESCRIPTION,
    address: {
      "@type": "PostalAddress",
      streetAddress: "Av. Alberdi 1099",
      addressLocality: "Resistencia",
      addressRegion: "Chaco",
      addressCountry: "AR",
    },
    sameAs: ["https://www.instagram.com/fylmodaok/", "https://www.facebook.com/FyLcalzados1"],
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "sales",
      availableLanguage: "es",
    },
  };
}

export function webSiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    publisher: { "@id": `${SITE_URL}/#organization` },
    inLanguage: "es",
  };
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function faqJsonLd(items: { question: string; answer: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

export function catalogCategoryJsonLd(opts: { name: string; description: string; path: string }) {
  const url = absoluteUrl(opts.path);
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": url,
    name: opts.name,
    description: opts.description,
    url,
    isPartOf: { "@id": `${SITE_URL}/#website` },
    breadcrumb: breadcrumbJsonLd([
      { name: "Inicio", url: absoluteUrl("/") },
      { name: opts.name, url },
    ]),
    provider: { "@id": `${SITE_URL}/#organization` },
  };
}
