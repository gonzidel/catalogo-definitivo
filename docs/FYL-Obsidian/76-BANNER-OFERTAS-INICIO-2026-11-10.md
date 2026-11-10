# 76 — Banner de Ofertas en el inicio (NJ) — 2026-11-10

**Estado:** implementado en rama `feat/banner-ofertas-inicio`. Esa rama incluye el commit de producción de Cyber Monday (`feat/minimo-temporal-1`, `9ed65a5`) para que publicar este banner no lo saque. **Migración 383 NO aplicada en producción** (requiere aprobación). Nada publicado.
**Clasificación:** TÉCNICA VERIFICADA (código y tests locales); la regla comercial ("qué cuenta como oferta destacada") es **NEGOCIO CONFIRMADO** por el responsable en esta sesión.
**Relacionado:** [[42-HOME-BANNERS-FEED-NJ-2026-06-09]], [[64-TEMP-MINIMO-1-CYBER-MONDAY-2026-11-03]]. El banner de Ofertas queda arriba del Cyber Monday. En un checkout de `nj-main` pelado ese lugar muestra "compra mínima", porque el Cyber Monday no está en `nj-main`.

## Qué es

Banner nuevo, **arriba de todo** en el home de NJ (sobre `InfoBanner`, hoy el Cyber Monday), con los productos que tienen una oferta de precio vigente. Misma estructura de carrusel que "Nuevos ingresos", pero solo **foto principal + código del artículo + precio de oferta** (sin círculos de colores ni "Precio por Mayor"). Look propio (degradé rojo, llama animada) para distinguirlo del resto.

Se muestra **solo** si el check está activo en `https://app.fylmoda.com.ar/admin/offers.html` **y** hay al menos una oferta vigente con stock e imagen.

## Reglas (confirmadas en la sesión)

| Regla | Implementación |
|---|---|
| Productos = los marcados como oferta | `OfertaActiva = true` del snapshot (`color_price_offers` con `status='active'` y fecha vigente, vista 330) |
| Primeros 5 = más recientes publicados o actualizados | Recencia del **color en oferta**: `max(FechaPublicacion, FechaIngreso)` de su fila. Cuenta solo republicaciones (fecha de publicación del color); crear/editar una oferta en `offers.html` **no** mueve el orden |
| Resto | Mezcla round-robin Calzado/Ropa/Otros (determinística), cada categoría de más nuevo a más viejo. Tope total 24 |
| Tarjeta | Foto del color en oferta + código (badge) + precio de oferta. Link `/producto/{Articulo}?color={color en oferta}` |
| Check apagado / error / tabla inexistente | **Falla cerrado**: no se muestra |

## Piezas

| Capa | Archivo |
|---|---|
| SQL | `supabase/canonical/383_home_feature_flags.sql` (+ `383_ROLLBACK_…`, `383_…_verify.sql`) — tabla `home_feature_flags`, flag `home_offers_banner` (nace apagado). Lectura `anon`/`authenticated`; escritura solo admins (RLS); sin DELETE; grants explícitos |
| Admin | `admin/offers.html` + `admin/offers.js` — sección "Banner de Ofertas en el inicio" con toggle (upsert) y conteo aproximado de ofertas vigentes |
| Datos | `nj/lib/banners/ofertas-destacadas.ts` (selección, orden, fetch), `home-feature-flags.ts` |
| Presencia SSR | `nj/lib/banners/home-banner-presence.ts` — campo `ofertas` (`interpretOfertasPresence`) |
| UI | `nj/components/banners/OfertasBanner.tsx`, `OfertaCarouselCard.tsx`; `nj/app/page.tsx` (primer lugar, más esqueleto) |
| Medición | `GA_BANNER_SLOTS.ofertas = "ofertas_destacadas"` |
| CSS | `nj/styles/globals.css` (NJ-only; reutiliza `.fyl-originals-*`). No se tocó `styles.css` para no mezclarlo con el catálogo vanilla servido por Firebase |
| Tests | `ofertas-destacadas.test.ts`, `home-banner-presence.test.ts` (22 casos) |

## Decisiones técnicas a recordar

- **No se usa `pickDisplayColorDetail`** en este banner: elige el primer color comprable aunque no esté en oferta y mostraría precio normal. `pickOfferColor` exige oferta vigente + imagen + stock/precio vendible.
- La recencia sale de las **filas crudas por color** (no de `GroupedProduct.FechaPublicacion`, que es el máximo de todos los colores): republicar un color sin oferta no adelanta al artículo.
- Tabla de flags **dedicada** en vez de reutilizar `custom_product_banners`: esa tabla tiene ~14 lectores (NJ, catalogo1, vanilla, admin) y un tag nuevo obligaba a tocarlos a todos.
- **Latencia del check:** la presencia SSR usa `unstable_cache` de 300 s y el home es ISR de 300 s: encender/apagar tarda hasta ~5 min en verse.
- `catalogo1/` queda fuera de alcance.

## Orden de publicación (con autorización explícita en cada paso)

1. SQL de producción: mostrar el SQL exacto, aprobar, aplicar `383`, correr `383_…_verify.sql`.
2. Admin (Firebase): `admin/offers.html` + `offers.js`.
3. NJ: `vercel deploy --prod --skip-domain` → smoke → `vercel promote`.

Como el flag nace apagado y el frontend falla cerrado, el orden entre 2 y 3 no rompe nada. Probar con el check **antes** de encender: sin la migración el admin muestra "falta aplicar la migración 383".

## Rollback

- Inmediato: apagar el check en `offers.html` (hasta ~5 min en reflejarse).
- Código: revertir el deploy / commits de la rama.
- SQL: `383_ROLLBACK_home_feature_flags.sql` (el frontend vuelve a ocultar el banner por falla cerrada).

## Verificación realizada

- `tsc --noEmit` limpio; `next build` OK (con env de prueba); 22/22 tests (`tsx --test`).
- Vista previa local con datos reales de producción (lectura anónima, flag simulado): 24 tarjetas, primeras 5 = las 5 publicaciones más recientes (B6180, B6184, B6185, BA4, J25), sin círculos de color ni leyenda, altura real = altura reservada (178 px en móvil, sin CLS), "Ver todo" de 26 px y la llama a 13 px para que la franja de arriba no tape el carrusel. Con el check ausente el banner no aparece.
- Sin probar aún: Preview de Vercel, escritura del toggle con sesión de admin real (depende de aplicar 383), medición GA en vivo.

## Deuda / observaciones

- **NEGOCIO CONFIRMADO (2026-11-10):** `J25` a $ 1.000 es una liquidación real. El banner no filtra precios bajos.
- Para ver el banner en un deploy de revisión sin haber aplicado la migración 383: `NEXT_PUBLIC_OFFERS_BANNER_PREVIEW=1` (solo en ese build). En producción no se define y manda únicamente el check.
- El proyecto no tiene ESLint configurado (`next lint` pide configuración interactiva): no se pudo correr lint.
- Los tests de `nj/` se ejecutan con `npx tsx --test <archivo>` (no hay script `test` en `nj/package.json`).
- Si se quiere que crear/editar una oferta también cuente como "actualizado", hay que exponer `color_price_offers.created_at/updated_at` en el snapshot (cambio de vista; no hecho).
