# FYL /nj — Banners y contenido dinámico

> Última actualización: 2026-06-08

## Banners implementados

| Componente | Tipo | Fuente de datos | Posición |
|------------|------|-----------------|----------|
| `PromoBanner` | Client, SWR | `banners` table (tipo "promotional") | Arriba del grid |
| `FylOriginalsBanner` | Client, SWR | `banners` table (tipo "fyl_originals") | Arriba del grid |
| `InfoBanner` | Client, SWR | `banners` table (tipo "info") | Arriba del grid |
| `CuratedBanner` | Client, SWR | `banners` table (tipo "curated") | Sección especial |

## Rendimiento

- Todos son `"use client"` con `useSWR` para evitar bloquear SSR
- La falla de un banner no rompe el catálogo (manejo de error silencioso)
- Imágenes via Cloudinary loader custom con `next/image`

## Posición en CatalogShell

Los banners se pasan como props a `CatalogShell` vía slots:
- `aboveGridSlot`: `FylOriginalsBanner` + `InfoBanner`
- `curatedSlot`: `CuratedBanner`

Cada componente tiene `key` prop explícita para evitar warnings de React en contextos de lista.
