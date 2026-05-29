---
title: "SEO Plan — fylmoda.com.ar"
fecha_auditoria: 2026-05-28
fecha_fase1: 2026-05-28
fecha_fase1_deploy: 2026-05-28
estado: fase_2_en_progreso
tags: [seo, fylmoda, cursor, implementacion]
---

# SEO Plan de Implementación — fylmoda.com.ar

---

## Stack técnico del sitio

| Capa | Tecnología |
|---|---|
| Frontend | HTML estático + Vanilla JavaScript (sin framework) |
| Routing | SPA con hash routing (`#/catalogo`, `#/como-comprar`, `#/quienes-somos`, etc.) |
| Backend / datos | Supabase (`dtfznewwvsadkorxwzft.supabase.co`) |
| Imágenes | Cloudinary (`res.cloudinary.com/dnuedzuzm`) |
| CSS | `styles.css` + `styles-desktop.css` |
| Scripts propios | `/scripts/*.js` (módulos: config, catalogo-publico, analytics, etc.) |
| Analytics | Google Analytics G-2JDYZW1KD6, Microsoft Clarity, Facebook Pixel |
| PWA | `manifest.json`, `icons/icon-192x192.png` |
| Versioning | Query string `?v=m260527` en assets |

**Arquitectura de publicación (confirmada 2026-05-28):**
- `catalogo.html` → sirve `/catalogo` — **versión pública actual**. Sin carrito ni login. Es el entorno donde se corrigen errores antes de liberar la versión completa. **URL indexada por Google.**
- `index.html` → sirve `/` — **versión completa con carrito y login**. Aún NO liberada al público. `firebase.json` tiene un redirect 301 de `/` → `/catalogo` mientras esta versión no esté lista.

> Todo el trabajo SEO se hace sobre `catalogo.html` (y `main-supabase.js` compartido). Cuando se libere `index.html`, ver sección **"Checklist de liberación de index.html"** al final de este documento.

**Archivos SEO de infraestructura:**
- `robots.txt` — ~~NO EXISTÍA~~ → ✅ **Creado en Fase 1**
- `sitemap.xml` — ~~NO EXISTÍA~~ → ✅ **Creado en Fase 1**
- `scripts/catalogo-publico.js` — inyecta botones "Consultar" con MutationObserver. **No renderiza imágenes** — no relevante para CLS/LCP
- `scripts/main-supabase.js` (7947 líneas) — renderiza todas las tarjetas de producto. **Es el archivo clave para Fase 2**. Funciones críticas:
  - `buildProductCardHTML()` ~línea 2056 — template HTML de cada card (incluye `<img class="main-image">` sin width/height)
  - `renderizarGaleria()` ~línea 2843 — miniaturas PDP sin width/height
  - `renderOfferCard()` ~línea 1849 — tarjeta de oferta
  - `fylPreloadLcpImage()` ~línea 1915 — agrega `<link rel="preload">` dinámico (ya implementado)
  - `cloudinaryOptimizedFromPublicId()` ~línea 557 — `f_auto,q_auto,c_scale,w_${width}` (ya optimizado)
  - cardImageWidth: `w_800` desktop / `w_480` mobile (línea 2165) → reducir a `w_600`/`w_400`
  - Primeras 4 cards ya usan `loading="eager"` + `fetchpriority="high"` (línea 2184-2186) ✅

---

## Baseline — Estado ANTES de Fase 1 (28 mayo 2026)

> No modificar esta sección. Es el punto de comparación.

### Lighthouse Mobile (PageSpeed Insights)

| Métrica | Valor | Estado |
|---|---|---|
| Performance | 49 / 100 | ❌ |
| Accesibilidad | 89 / 100 | ✅ |
| Best Practices | 96 / 100 | ✅ |
| SEO Score | 83 / 100 | ⚠️ |

### Core Web Vitals (datos reales — últimos 28 días al 28/05/2026)

| Métrica | Valor | Umbral OK | Estado |
|---|---|---|---|
| LCP | **9.3 s** | < 2.5 s | ❌ |
| INP | **606 ms** | < 200 ms | ❌ |
| CLS | **0.33** | < 0.1 | ❌ |
| FCP | 1.5 s | < 1.8 s | ✅ |
| TTFB | 0.4 s | < 0.8 s | ✅ |

### Meta tags que existían

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="app-version" content="m260527">
<meta name="theme-color" content="#CD844D">
<!-- title, description, canonical, OG, schema: AUSENTES -->
```

### H1s reales encontrados por Cursor en el código

> ⚠️ Corrección al diagnóstico inicial: el sitio es una SPA con hash routing. Las secciones "Quiénes somos" y "Cómo comprar" son vistas que se muestran/ocultan con CSS (`is-hidden`). Google indexa contenido oculto por CSS, por lo que estos H1 eran visibles para el crawler.

**H1s problemáticos reales (en ambos HTMLs):**
```
❌ <h1 id="howto-title">Cómo comprar por mayor</h1>     ← vista #/como-comprar
❌ <h1 id="about-fyl-title">Quiénes somos</h1>          ← vista #/quienes-somos
❌ <h1 class="collection-title">F&L Originals</h1>      ← vista #/coleccion/fyl-originals
❌ Sin H1 en la vista principal del catálogo             ← ninguno de los dos HTMLs tenía H1 para el grid
```

### Indexación en Google

- **Páginas indexadas:** 1 (solo la homepage)
- **Google Search Console:** no verificado
- No aparecía en ninguna búsqueda de keywords relevantes

---

## FASE 1 — ✅ Completada (28 mayo 2026)

### Qué implementó Cursor

#### `index.html` y `catalogo.html` — `<head>`

Bloque agregado en ambos HTMLs después de `<meta name="app-version">`:

```html
<!-- index.html -->
<title>FYL Moda | Calzado e Indumentaria Femenina por Mayor — Argentina</title>
<meta name="description" content="Mayorista de calzado e indumentaria femenina con fábrica propia. Stock visible, surtido libre de talles desde 4 pares. Envíos a todo el país. ¡Consultá ya!">
<link rel="canonical" href="https://fylmoda.com.ar/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="FYL Moda">
<meta property="og:title" content="FYL Moda | Calzado e Indumentaria Femenina por Mayor">
<meta property="og:description" content="Mayorista de calzado e indumentaria femenina con fábrica propia. Stock visible, surtido libre desde 4 pares. Envíos a todo el país.">
<meta property="og:url" content="https://fylmoda.com.ar/">
<meta property="og:image" content="https://fylmoda.com.ar/icons/icon-192x192.png">
<meta property="og:locale" content="es_AR">
```

```html
<!-- catalogo.html — igual excepto canonical -->
<link rel="canonical" href="https://fylmoda.com.ar/catalogo">
```

> **Nota:** el mínimo de compra es **4 productos** en `index.html` (no 6 pares como decía el plan original). El schema FAQPage se adapta a cada archivo.

#### H1 principal agregado (visually-hidden)

Agregado dentro de `#catalog-view`, antes del `.container`, en ambos HTMLs:

```html
<h1 class="visually-hidden">Calzado e Indumentaria Femenina por Mayor — FYL</h1>
```

> La clase `visually-hidden` oculta visualmente el H1 sin que Google lo ignore (posicionado fuera del viewport pero en el DOM). Verificar que el CSS tenga esta clase definida, o agregarla en `styles.css`:
```css
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

#### H1s de vistas SPA convertidos a H2

En ambos HTMLs:
```html
<!-- ANTES → DESPUÉS -->
<h1 id="howto-title">      → <h2 id="howto-title">
<h1 id="about-fyl-title">  → <h2 id="about-fyl-title">
<h1 class="collection-title"> → <h2 class="collection-title">
```

#### Schema JSON-LD agregado antes de `</body>` en ambos HTMLs

**Organization** (igual en los dos):
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "FYL Moda",
  "alternateName": "F&L Originals",
  "url": "https://fylmoda.com.ar",
  "logo": "https://fylmoda.com.ar/icons/icon-192x192.png",
  "description": "Empresa familiar especializada en venta mayorista de calzado e indumentaria femenina. Fábrica propia de calzado. Envíos a todo el país.",
  "address": { "@type": "PostalAddress", "addressLocality": "Resistencia", "addressRegion": "Chaco", "addressCountry": "AR" },
  "contactPoint": { "@type": "ContactPoint", "contactType": "sales", "availableLanguage": "Spanish" }
}
</script>
```

**FAQPage — `index.html`** (mínimo 4 productos):
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "¿Cuál es la compra mínima?",
      "acceptedAnswer": { "@type": "Answer", "text": "El pedido mínimo es de 4 productos. Podés surtir modelos y talles libremente." }
    },
    {
      "@type": "Question",
      "name": "¿Hacen envíos a todo el país?",
      "acceptedAnswer": { "@type": "Answer", "text": "Sí, realizamos envíos a todo el país. El costo y tiempo varía según la zona." }
    },
    {
      "@type": "Question",
      "name": "¿Puedo ver el stock antes de comprar?",
      "acceptedAnswer": { "@type": "Answer", "text": "Sí, el catálogo muestra el stock en tiempo real. Lo que ves es lo que hay." }
    },
    {
      "@type": "Question",
      "name": "¿Tienen fábrica propia?",
      "acceptedAnswer": { "@type": "Answer", "text": "Sí, contamos con fábrica propia de calzado, lo que nos permite ofrecer stock constante y respuesta rápida." }
    }
  ]
}
</script>
```

**FAQPage — `catalogo.html`** (mínimo 6 pares, según corresponda al catálogo público):
```html
<!-- Mismo schema pero ajustar la respuesta del mínimo según la política del catálogo público -->
```

#### `robots.txt` — nuevo archivo en raíz

```
User-agent: *
Allow: /

Sitemap: https://fylmoda.com.ar/sitemap.xml
```

#### `sitemap.xml` — nuevo archivo en raíz

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://fylmoda.com.ar/</loc>
    <lastmod>2026-05-28</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://fylmoda.com.ar/catalogo</loc>
    <lastmod>2026-05-28</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
</urlset>
```

### Scope excluido de Fase 1

- Core Web Vitals (Fase 2): requieren modificar `scripts/main-supabase.js` (no `catalogo-publico.js`)
- Nuevas páginas (Fase 3): archivos HTML nuevos
- Google Search Console (Task 16): acción manual externa, no requiere código

---

## FASE 2 — Core Web Vitals (pendiente)

> **Contexto clave** (confirmado leyendo el código real):
> - Las imágenes de productos las renderiza `scripts/main-supabase.js`, NO `catalogo-publico.js`
> - `catalogo-publico.js` solo inyecta botones "Consultar" con MutationObserver — no renderiza imágenes
> - `buildProductCardHTML()` en `main-supabase.js` construye cada tarjeta de producto
> - `fetchpriority="high"` y `loading="eager"` ya están implementados para las 4 primeras cards (línea 2184-2186)
> - `fylPreloadLcpImage()` agrega un `<link rel="preload">` dinámicamente después del render — mejora LCP pero llega tarde
> - Imágenes de cards: `w_800` en desktop, `w_480` en mobile (línea 2165)

---

### TASK 10 — Fix CLS: agregar width/height a imágenes

**CLS actual: 0.33 → objetivo < 0.1**

#### 10A — Card de producto principal

**Archivo:** `scripts/main-supabase.js`  
**Función:** `buildProductCardHTML()` — línea ~2065  
**Problema:** `<img class="main-image">` no tiene `width` ni `height` → el browser no puede reservar espacio → layout shift al cargar la imagen

```javascript
// ANTES (línea ~2065)
<img class="main-image" loading="${imageLoading}" decoding="async"${imageFetchPriority}
     src="${mainSrc}" 
     alt="${producto.Articulo}"
     data-sku="${skuDefecto || ""}"
     ${fallbackUrlsAttr ? `data-fallback-urls="${fallbackUrlsAttr}" onerror="window.mainImageFallback&&window.mainImageFallback(this)"` : ""}/>

// DESPUÉS
<img class="main-image" loading="${imageLoading}" decoding="async"${imageFetchPriority}
     src="${mainSrc}" 
     alt="${producto.Articulo}"
     width="${cardImageWidth}" height="${cardImageWidth}"
     data-sku="${skuDefecto || ""}"
     ${fallbackUrlsAttr ? `data-fallback-urls="${fallbackUrlsAttr}" onerror="window.mainImageFallback&&window.mainImageFallback(this)"` : ""}/>
```

> `cardImageWidth` ya está disponible en el scope de `buildProductCardHTML` via `meta.cardImageWidth` (línea 2035). Las imágenes de producto son cuadradas (1:1), así que `width` = `height` = `cardImageWidth` es correcto.

#### 10B — Miniaturas en PDP (galería de colores)

**Archivo:** `scripts/main-supabase.js`  
**Función:** `renderizarGaleria()` — línea ~2851

```javascript
// ANTES
return `<img loading="lazy" src="${thumb}" data-full="${full}" alt="Miniatura de producto" class="miniatura${isActive ? ' active' : ''}">`;

// DESPUÉS
return `<img loading="lazy" src="${thumb}" data-full="${full}" alt="Miniatura de producto" width="200" height="200" class="miniatura${isActive ? ' active' : ''}">`;
```

> `getImgUrl(img, 200)` → 200px. Las miniaturas son cuadradas.

#### 10C — Offer card (tarjeta de campaña de oferta)

**Archivo:** `scripts/main-supabase.js`  
**Función:** `renderOfferCard()` — línea ~1856  
**Nota:** el container ya usa `padding-top: 100%` + `position: absolute` para reservar el espacio visual. Aun así, agregar width/height evita jank en navegadores que no honren ese patrón con imágenes dinámicas.

```javascript
// ANTES
<img src="${offer.imageUrl}" alt="${title}" 
     style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;"
     onerror="...">

// DESPUÉS — agregar width/height explícitos (el objeto ya tiene tamaño por CSS, pero ayuda al parser)
<img src="${offer.imageUrl}" alt="${title}"
     width="400" height="400"
     style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;"
     onerror="...">
```

---

### TASK 11 — Fix LCP: reducir tamaño de imágenes above-the-fold

**LCP actual: 9.3 s → objetivo < 2.5 s**

**Diagnóstico confirmado:**
- TTFB: 0.4 s ✅ — el servidor es rápido
- FCP: 1.5 s ✅ — el HTML/CSS carga bien
- LCP: 9.3 s ❌ — la imagen del primer producto carga tarde porque requiere: Supabase query → JS procesa datos → JS inyecta `<img>` → browser descarga imagen
- `fetchpriority="high"` y `loading="eager"` ya están en las primeras 4 cards ✅
- `fylPreloadLcpImage()` ya existe y funciona — pero se ejecuta DESPUÉS del render, que es tarde

**Lo que se puede mejorar sin cambiar la arquitectura:**

#### 11A — Reducir peso de imágenes above-the-fold

**Archivo:** `scripts/main-supabase.js` — línea 2164-2165

```javascript
// ANTES
const cardImageWidth =
  typeof window !== "undefined" && window.innerWidth <= 430 ? 480 : 800;

// DESPUÉS — imágenes más pequeñas reducen tiempo de descarga
const cardImageWidth =
  typeof window !== "undefined" && window.innerWidth <= 430 ? 400 : 600;
```

> 800px → 600px en desktop = ~44% menos datos (cuadrático en Cloudinary `c_scale`).  
> 480px → 400px en mobile = ~31% menos datos.  
> Las cards en el grid nunca superan 400px en mobile ni 600px en desktop — estas dimensiones son suficientes.

#### 11B — Mejorar la transformación Cloudinary para imágenes above-the-fold

**Función:** `cloudinaryOptimizedFromPublicId()` — línea ~557  
Actualmente: `f_auto,q_auto,c_scale,w_${width}`  
Esto ya es óptimo. Cloudinary auto-selecciona formato (WebP/AVIF) y calidad.  
**No requiere cambio** — ya usa `f_auto,q_auto`.

#### 11C — Verificar que `fylPreloadLcpImage` use el mismo width reducido

Después de aplicar 11A, verificar que el link preload que genera `fylPreloadLcpImage()` use la nueva URL con `w_400` / `w_600`. La función toma la URL de `firstLcpSrc` que ya se construye con `cardImageWidth` (línea 2180) — así que si 11A se aplica correctamente, el preload también se actualizará automáticamente. ✅

---

### TASK 12 — Fix INP: reducir long tasks en el render inicial

**INP actual: 606 ms → objetivo < 200 ms**

**Diagnóstico confirmado (leyendo el código):**

Los click handlers de `main-supabase.js` ya están bien optimizados:
- Click en card → Path 1: usa `skuIndex` (in-memory, ~0ms)
- Click en card → Path 2: usa `window.productosActualesMap.get(articulo)` (in-memory Map, ~0ms)
- Click en card → Path 3: solo si el producto no está en página → skeleton inmediato + fetch async en background
- Las queries Supabase (líneas 3546-3557) solo se ejecutan en deep links directos a PDP, no en clicks de cards del grid

**La fuente real del INP 606ms:** long tasks durante la carga inicial. Cuando el browser ejecuta el JS del catálogo (query Supabase → procesar datos → renderizar N cards → inicializar event listeners), esa tarea puede bloquear la interacción hasta que termine.

**Ya implementado en el código:**
- `fylScheduleIdle` (importado de `./fyl-scheduler.js`) — usado para `enrichProductsWithStock` (línea 2213)
- `requestIdleCallback` presente (línea 1648-1649)
- Scroll infinito: cards se renderizan en chunks, no todas juntas ✅

**Qué falta implementar:**

#### 12A — Yield entre chunks del render inicial

**Archivo:** `scripts/main-supabase.js` — función que itera sobre `allItems` y llama `buildProductCardHTML()` (~línea 2170)

Actualmente el loop procesa todos los items del primer chunk sincrónicamente. Si el primer chunk tiene 20+ productos, es un long task.

```javascript
// PATRÓN ACTUAL (simplificado) — todo en un loop síncrono
allItems.forEach((item) => {
  htmlParts.push(buildProductCardHTML(item.data, ...));
});
// Luego inserta todo de una vez
tpl.innerHTML = htmlParts.join('');
container.appendChild(tpl.content);

// MEJORA — yield al browser cada N cards usando scheduler.yield si disponible
async function renderChunkWithYield(items, container, ...) {
  const BATCH = 8; // renderizar 8 cards, luego yield
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const html = batch.map(item => buildProductCardHTML(...)).join('');
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    container.appendChild(tpl.content);
    
    if (i + BATCH < items.length) {
      // yield al browser para que procese eventos de usuario
      if (typeof scheduler !== 'undefined' && scheduler.yield) {
        await scheduler.yield(); // Chrome 115+
      } else {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }
}
```

> **Nota:** Evaluar si el impacto vale la complejidad. Si `fylScheduleIdle` ya divide bien el trabajo, el INP puede mejorar solo con las correcciones de CLS/LCP (menos trabajo de layout = tareas más cortas). Medir primero.

#### 12B — Verificar que `enrichProductsWithStock` no bloquea el hilo principal

En línea 2213 ya está deferrido con `fylScheduleIdle(..., 2200)` — 2.2s de delay. Confirmar que esta función no tiene bucles síncronos que bloqueen >50ms cuando se ejecuta. Si los tiene, dividirlos en batches similares al patrón de 12A.

---

## FASE 3 — Nuevas páginas (pendiente)

| Página | URL | H1 | Keywords objetivo | Prioridad |
|---|---|---|---|---|
| Revendedoras | `/revendedoras` | Vendé calzado sin local — Ser revendedora FYL | comprar calzado para revender, mayorista emprendedoras | Alta |
| Calzado por mayor | `/calzado-femenino-por-mayor` | Calzado Femenino por Mayor — FYL | calzado femenino por mayor | Alta |
| Ropa por mayor | `/ropa-femenina-por-mayor` | Ropa Femenina por Mayor — FYL | ropa femenina mayorista | Alta |
| Lencería por mayor | `/lenceria-por-mayor` | Lencería por Mayor — FYL | lencería mayorista argentina | Media |
| Accesorios | `/accesorios-por-mayor` | Accesorios por Mayor — FYL | accesorios mayorista femenino | Media |
| Quiénes somos | `/quienes-somos` | FYL Moda — Empresa Familiar Mayorista | fábrica calzado argentina | Media |

> Cada nueva página: agregar en `sitemap.xml` + schema `CollectionPage` o `AboutPage`.

---

## FASE 4 — Google Search Console (pendiente — acción manual)

1. Ir a [search.google.com/search-console](https://search.google.com/search-console)
2. Agregar propiedad tipo "Dominio" → `fylmoda.com.ar`
3. Verificar por DNS (registro TXT en el panel del dominio)
4. Enviar sitemap: `https://fylmoda.com.ar/sitemap.xml`
5. Pedir indexación manual de `/` y `/catalogo`
6. Esperar 3-7 días para primeros datos

---

## Checklist de progreso

### Fase 1 — Quick Wins
- [x] TASK 1 — Title tag con keywords (`index.html` + `catalogo.html`)
- [x] TASK 2 — Meta description (4 pares en index, 6 pares en catalogo)
- [x] TASK 3 — Canonical tag (diferente por archivo)
- [x] TASK 4 — Open Graph tags
- [x] TASK 5 — H1 visually-hidden + H1s de vistas SPA → H2
- [x] TASK 6 — Crear `robots.txt`
- [x] TASK 7 — Crear `sitemap.xml` (incluye `/` y `/catalogo`)
- [x] TASK 8 — Schema Organization (ambos HTMLs)
- [x] TASK 9 — Schema FAQPage (adaptado por archivo)
- [ ] TASK 16 — Alta Google Search Console ← **pendiente — acción manual tuya**

### Fase 2 — Core Web Vitals
- [ ] TASK 10 — Fix CLS (dimensiones en imágenes)
- [ ] TASK 11 — Fix LCP (preload + Cloudinary optimization)
- [ ] TASK 12 — Fix INP (event handlers)

### Fase 3 — Nuevas páginas
- [ ] TASK 13 — Landing `/revendedoras`
- [ ] TASK 14a — Landing `/calzado-femenino-por-mayor`
- [ ] TASK 14b — Landing `/ropa-femenina-por-mayor`
- [ ] TASK 14c — Landing `/lenceria-por-mayor`
- [ ] TASK 14d — Landing `/accesorios-por-mayor`
- [ ] TASK 15 — Página `/quienes-somos`

---

## Métricas — Objetivos

Medir de nuevo 30 y 90 días después de completar Fase 1+2.

| Métrica | Baseline | Meta 30 días | Meta 90 días |
|---|---|---|---|
| Performance Lighthouse | 49 | > 70 | > 85 |
| LCP | 9.3 s | < 4 s | < 2.5 s |
| CLS | 0.33 | < 0.15 | < 0.1 |
| INP | 606 ms | < 400 ms | < 200 ms |
| SEO Score Lighthouse | 83 | > 95 | > 98 |
| Páginas indexadas Google | 1 | > 5 | > 10 |
| Impresiones orgánicas (GSC) | 0 | > 100/semana | > 500/semana |

---

## Checklist de liberación de index.html

> Ejecutar este checklist ANTES de hacer deploy de `index.html` como versión pública en `/`.

### En `firebase.json`
- [ ] Eliminar el redirect `"source": "/"` → `"destination": "/catalogo"` (type 301)
- [ ] Eliminar el redirect `"source": "/index.html"` → `"destination": "/catalogo"` (type 301)
- [ ] Agregar rewrite para `/` → `index.html` si es necesario, o confirmar que Firebase lo sirve por defecto
- [ ] Decidir si `/catalogo` sigue existiendo (versión pública sin carrito) o se reemplaza por `/`

### En `sitemap.xml`
- [ ] Agregar `https://fylmoda.com.ar/` con `priority 1.0`
- [ ] Mantener `https://fylmoda.com.ar/catalogo` si sigue siendo una URL válida, o eliminarla si redirige a `/`
- [ ] Re-enviar el sitemap en Google Search Console

### En `index.html`
- [ ] Verificar que el canonical sea `https://fylmoda.com.ar/` ← ya está correcto ✅
- [ ] Verificar que el title, meta description y schemas sean los correctos para la versión completa ← ya están ✅
- [ ] Confirmar que el Schema FAQPage refleja el mínimo real de compra de index (4 productos) ← ya corregido ✅

### En Google Search Console
- [ ] Solicitar indexación de `https://fylmoda.com.ar/` una vez que el redirect esté eliminado
- [ ] Verificar con "Inspección de URLs" que `/` ya no muestra "Página con redirección"

### Post-deploy
- [ ] Correr PageSpeed Insights en `https://fylmoda.com.ar/` (la versión con carrito tiene más JS — puede tener peor Performance inicial)
- [ ] Aplicar Fases 2 y 3 a `index.html` si no están ya sincronizadas con `catalogo.html`

---

## Contexto de negocio

- **Producto:** calzado e indumentaria femenina al por mayor
- **Cliente:** revendedoras, emprendedoras, pequeños negocios, locales
- **Diferencial:** fábrica propia + surtido libre de talles con mínimo bajo (4 productos en index, 6 pares en catálogo público)
- **Modelo:** catálogo online con stock en tiempo real, pedidos vía WhatsApp
- **Cobertura:** todo Argentina
- **Tono:** directo, cercano, orientado a mujeres emprendedoras

---

*Auditoría inicial: Claude (Cowork) — 28 mayo 2026*  
*Fase 1 implementada y deployada: Cursor — 28 mayo 2026*  
*Validar post-deploy: [Rich Results Test](https://search.google.com/test/rich-results) + Lighthouse SEO*
