# 50 — Auditoría consumo Cloudinary — 2026-08-15

## Resumen

El cloud `dnuedzuzm` tiene **6007 originales** en `variant_images` (todos con `public_id` y URL original, sin transformaciones embebidas). El salto de consumo en ~15 días encaja con el catálogo Next (`/nj`, `/catalogo1`) pidiendo **14 anchos por imagen** vía `next/image` + loader Cloudinary, frente a **2–3 anchos** del catálogo vanilla.

Plugin autenticado 2026-08-15. Usage real: plan **Small PAYG**, **224 créditos / 60** (374%). Bandwidth 165 cr, transformaciones 35, storage 24. Requests diarios saltaron el **8 ago** de ~83k a ~154k. Derived 197.491 sobre 12.416 originales (~16×).

## Evidencia

| Fuente | Dato |
|--------|------|
| `variant_images` | 6007 filas; 0 URLs con `f_auto`/`w_` ya aplicados; 0 `image/fetch` |
| `products` | 1853 total, 593 active |
| Vanilla | `cloudinaryOptimized(..., 200\|800\|1200)` en `scripts/main-supabase.js` |
| Next | `deviceSizes: [400, 800, 1200]` + `imageSizes: [64, 200, 384]` (aplicado 2026-08-15) |
| PDP Next | blur `w_64`, probe `w_800`, lightbox `w_1200` |
| Upload | Edge Function `upload-image`: signed, `overwrite=true`, `invalidate=true` |

## Por qué duplica (o más)

1. **Transformaciones**: cada URL única (`f_auto,q_auto,c_scale,w_N/...`) genera un derived la primera vez. Next emite 14 N por card; `f_auto` puede materializar AVIF y WebP. Estimación de techo: ~84k–168k derived vs ~18k vanilla.
2. **AVIF >2MP**: `w_1920` (y los 2048/3840 que Next trae por default, ya recortados en ago 2026) cobra extra (1 tx + 1 tx/2MP).
3. **Bandwidth**: Firebase vanilla + Vercel Next sirven las mismas fotos.
4. **Re-upload**: `overwrite` + `invalidate` borra derived de esa foto; el siguiente tráfico los regenera (cuenta otra vez).

## Lo que ya está bien

- Uploads firmados (no unsigned preset en frontend).
- DB guarda originales, no URLs pre-transformadas (no hay double-stack desde snapshot).
- `f_auto,q_auto` en entrega (bien para peso; caro si hay demasiados anchos).
- Tope 2048/3840 ya documentado en `next.config.ts` (ago 2026).
- **2026-08-15:** recorte aplicado en `nj/` y `catalogo1/`: `deviceSizes [400,800,1200]`, `imageSizes [64,200,384]`, probe 800, lightbox 1200, placeholder 64.
- **2026-08-15 (2):** named transformations en Cloudinary `t_fyl_mini|thumb|sm|card|pdp|hero|blur` (`allowed_for_strict`). Loader Next usa `t_fyl_*/f_auto/q_auto` y hace snap al ancho canónico.
- **2026-08-15 (3):** purge post-deploy. `f_auto,q_auto,c_scale,w_3840` eliminada (~4017 derived). Variantes `w_1920` (auto/webp/eco/jxl) eliminadas. Storage ~24,96 GB → ~21,56 GB; derived 196.026 → 192.266. Originales intactos (12.416). Insights históricos de `w_3840` no bajan al instante.

## Deuda restante

1. Valorar Strict Transformations (rompe vanilla si sigue pidiendo `w_` unnamed).
2. `invalidate` solo si el binario cambió.
3. Purge opcional de leftover `w_640` / `w_2048` si reaparecen en Insights.

## Verificación post-fix

- En Network, una card Next debe pedir **1** URL Cloudinary, no 14 en srcset innecesario para crawlers.
- Usage Cloudinary: transformaciones nuevas por día deberían caer tras el recorte (los derived viejos siguen en storage hasta purge).
- Rollback: revertir `next.config.ts` + loader extras.

## Relacionado

- [[41-MIGRACION-NEXTJS-NJ-2026-06-08]]
- [[44-CATALOGO1-LANZAMIENTO-2026-06-13]]
