# 76 — Pantalla TV del local (Full HD)

Fecha: 2026-11-20  
Estado: implementado en rama `feat/tv-local` (pendiente deploy y migración Storage 252)

## Qué es

Página pública de pantalla completa para el Smart TV del local (1920×1080 horizontal).  
URL: `https://www.fylmoda.com.ar/tv-fyl-7k3q` (también `/nj/tv-fyl-7k3q` en hosts con prefijo).

Slug poco adivinable a propósito. Sin login. `noindex`.

## Diseño (vitrina)

- **Grilla multi-producto** (4×2 = 8 por página; 3×2 si hay ≤6). No un producto a pantalla completa.
- Páginas rotan ~14 s; colores de cada card rotan ~3,5 s.
- Tipografía: nombre en serif (`Instrument Serif`), precio en sans bold con color distinto.
- Temas: cálido / oscuro / claro. Botón “Fondo” o tecla `T`. Persistido en `localStorage`.
- Imágenes con `t_fyl_card` (~400 px) para no estirar de más en TV.

## Archivos

- `nj/public/tv-fyl-7k3q/index.html`
- `nj/public/tv-fyl-7k3q/tv.css`
- `nj/public/tv-fyl-7k3q/tv.js`
- Rewrite en `nj/next.config.ts` → `/tv-fyl-7k3q` → `index.html`
- Disallow en `nj/app/robots.ts`

## Datos

- Lee `catalog_public_available_view` con anon key (REST).
- **Lote del día:** filas con `FechaPublicacion` del último día calendario (horario Argentina). Si hoy no hubo publicaciones, sigue el último lote.
- **Ofertas:** `OfertaActiva = true` intercaladas siempre.
- **Banners:** `OfferImageUrl` no vacío, dedupe por `OfferCampaignId`. Layout 1 / 2 / 3 columnas; 4+ en tandas.
- Refresh cada 5 min sin perder el slide. Reload de página ~03:15 local.

## Música

- Playlist en Supabase `tv_local_settings` (migración `383_tv_local_settings.sql`).
- Se configura en **Admin → TV Local** (`admin/tv.html`) con login de admin. La TV solo lee.
- Override de prueba: `?pl=PLAYLIST_ID` (sin localStorage).
- Smart TV requiere gesto: overlay “Presioná OK”.
- OK / Enter / Space: play-pause. Flechas: cambiar página.
- Mixes/radios `RD…` de YouTube Music suelen fallar; usar playlist propia `PL…`.

## Admin ofertas / banners

Causa raíz de “no sube imagen”: faltaba migración `252_offer_promo_images_storage.sql` en producción (buckets `offer-images` y `promo-images`).  
Fixes de UX en `admin/offers.js` + ayuda de medidas en `admin/offers.html`.

## Uso en el local

1. Abrir la URL en el navegador del Smart TV.
2. Favoritos / inicio.
3. Una vez: OK para música (si hay `?pl=`).
4. Publicar/actualizar en `/admin/publications` → aparece en la TV en minutos.

## Riesgos / límites

- Navegadores Tizen/webOS: JS conservador (sin `?.` / `??`).
- Banners de promo 2x (`promo_image_url`) no se muestran en TV (solo se arregla el bucket).
- Sin panel de curación manual de slides.
