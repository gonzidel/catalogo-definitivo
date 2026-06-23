# 45 — GEO: Optimización para recomendación por IA (2026-06-23)

Auditoría y primera fase de implementación de **Generative Engine Optimization (GEO)** para que FYL Moda sea citado/recomendado por ChatGPT, Perplexity, Google AI Overview y similares.

---

## Puntuación GEO

| Momento | Score |
|---------|-------|
| Antes (23/06) | **25 / 100** |
| Después de fase 1 | **~55 / 100** |
| Objetivo con fase 2 | **~80 / 100** |

---

## Fase 1 — Implementado (2026-06-23)

### 1. JSON-LD estructurado global

**Archivos creados:**
- `catalogo1/lib/constants/seo.ts` — constantes SITE_URL, SITE_NAME, etc.
- `catalogo1/lib/seo/json-ld.ts` — generadores: `organizationJsonLd()`, `webSiteJsonLd()`, `breadcrumbJsonLd()`, `faqJsonLd()`, `catalogCategoryJsonLd()`
- `catalogo1/lib/seo/JsonLdScript.tsx` — componente `<script type="application/ld+json">`

**Inyección:**
- `layout.tsx` → Organization + WebSite (todas las páginas)
- `[categoria]/page.tsx` → CollectionPage + BreadcrumbList por categoría
- `como-comprar/page.tsx` → FAQPage schema

### 2. Sitemap.xml automático

- `catalogo1/app/sitemap.ts` → genera `/catalogo/sitemap.xml`
- Incluye: home, 5 categorías, como-comprar, quienes-somos, 5 landing pages SEO

### 3. robots.txt

- `catalogo1/app/robots.ts` → genera `/catalogo/robots.txt`
- Allow all, apunta al sitemap

### 4. llms.txt

- `catalogo1/public/llms.txt` → servido en `/catalogo/llms.txt`
- Describe qué es FYL, a quién vende, categorías, cómo comprar, ubicación, contacto
- Formato que Perplexity y otros LLMs buscan activamente

### 5. Metadata mejorada

- `metadataBase` configurado en layout (resuelve URLs relativas de OG)
- `og:image` global añadido

### 6. FAQ datos compartidos

- `catalogo1/lib/constants/faq.ts` — datos extraídos de FaqSection para uso server+client
- `FaqSection.tsx` ahora importa de `lib/constants/faq`

---

## Fase 2 — Pendiente

### Prioridad ALTA

| # | Tarea | Impacto GEO | Detalle |
|---|-------|-------------|---------|
| 1 | **PDP con SSR + Product schema** | +10 pts | Hoy `revalidate=0` y título "Art. XXX". Necesita: fetch SSR del producto, `generateMetadata` con nombre/precio/imagen, JSON-LD `Product` con offers/availability/image |
| 2 | **Landing pages SEO de categoría** | +8 pts | Crear las 5 páginas referenciadas en quienes-somos: `/revendedoras`, `/calzado-femenino-por-mayor`, `/ropa-femenina-por-mayor`, `/accesorios-por-mayor`, `/lenceria-por-mayor`. Contenido largo, optimizado para queries que la gente le hace a la IA |
| 3 | **Sitemap dinámico con productos** | +5 pts | Actual es estático. Agregar URLs de `/catalogo/producto/[sku]` desde Supabase |

### Prioridad MEDIA

| # | Tarea | Impacto GEO | Detalle |
|---|-------|-------------|---------|
| 4 | **OG images dinámicas** | +3 pts | `app/catalogo/producto/[sku]/opengraph-image.tsx` con `ImageResponse` de Next.js |
| 5 | **Canonical URLs** | +2 pts | Agregar `alternates.canonical` en metadata de cada página |
| 6 | **Breadcrumbs visibles** | +2 pts | Componente visual `<nav aria-label="breadcrumb">` en PDP y categorías (ya tenemos el schema, falta el UI) |
| 7 | **Más FAQs temáticas** | +2 pts | FAQ específicas por categoría: "¿Cuál es el mínimo para calzado?", etc. |

### Prioridad BAJA

| # | Tarea | Impacto GEO | Detalle |
|---|-------|-------------|---------|
| 8 | **Blog / guías para revendedoras** | +5 pts (largo plazo) | Contenido tipo "Cómo empezar a revender calzado", "Tendencias calzado 2026". Los LLMs citan contenido de autoridad |
| 9 | **llms-full.txt** | +1 pt | Versión extendida de llms.txt con catálogo de productos |
| 10 | **LocalBusiness schema** | +1 pt | Además de Organization, agregar LocalBusiness con horarios, geo coords |

---

## Cómo verificar

```bash
# JSON-LD en home
curl -s https://fylmoda.com.ar/catalogo | grep -o 'application/ld+json' | wc -l
# Debería dar 2 (Organization + WebSite)

# Sitemap
curl -s https://fylmoda.com.ar/catalogo/sitemap.xml | head -20

# robots.txt
curl -s https://fylmoda.com.ar/catalogo/robots.txt

# llms.txt
curl -s https://fylmoda.com.ar/catalogo/llms.txt

# FAQ schema en como-comprar
curl -s https://fylmoda.com.ar/catalogo/como-comprar | grep -o 'FAQPage'
```

---

## Herramientas de validación externa

- [Google Rich Results Test](https://search.google.com/test/rich-results) — verificar FAQ, Product, Breadcrumb
- [Schema.org Validator](https://validator.schema.org/) — validar JSON-LD
- View Source en Perplexity/ChatGPT — buscar "calzado femenino por mayor resistencia" y ver si aparece FYL

---

## Relacionado

- [[44-CATALOGO1-LANZAMIENTO-2026-06-13]] — lanzamiento del catálogo Next.js
- [[06-FLUJO-CATALOGO]] — arquitectura del catálogo
