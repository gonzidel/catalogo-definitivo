# 38 — Meta Catalog Feed: enriquecimiento (2026-05-23)

> **Estado:** Fases 1–3 **desplegadas en prod** (2026-05-23): SQL `meta_feed_phase3_offers_images_marketing` + Edge Fase 3 (24 cols). **Acción CM:** reimport feed + reindex 24–48 h. Checklist: `doc/meta-feed/2026-05-23-fase3-deploy-checklist.md`.  
> **ID estable:** META-FEED-2026-05-23  
> **Fuente canónica (repo):** `doc/meta-feed/2026-05-23-meta-feed-enriquecimiento-spec.md`

---

## Enlaces rápidos

| Recurso | Ruta |
|---------|------|
| Spec completo | `doc/meta-feed/2026-05-23-meta-feed-enriquecimiento-spec.md` |
| Índice meta-feed | `doc/meta-feed/README.md` |
| Edge Function | `supabase/functions/meta-feed/index.ts` |
| RPC | `get_meta_feed()` — `supabase/canonical/41_meta_feed_rpc.sql` |
| Admin | `admin/meta-feed.html` |
| Validación CSV | `scripts/outputs/meta-feed-csv-validate.mjs` |
| Deploy | [[INSTRUCCIONES_DEPLOY_META_FEED]] (repo root) |

**Relacionado:** [[29-ALLOWLIST-ANON-PUBLIC-SURFACE]] (`get_meta_feed` público), [[06-FLUJO-CATALOGO]], [[27-MODULO-COMPORTAMIENTO-PRODUCTOS]] (`vw_stock_fast_sellers` para Fase 3).

---

## Problema

Meta Commerce Manager no muestra categorías, subcategorías ni labels porque el **CSV exportado tiene 9 columnas** aunque el RPC ya devuelve `item_group_id`, `color` y `size`.

```typescript
// index.ts — headers actuales
["id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand"]
```

---

## Solución: 3 PRs (no mezclar)

| Fase | PR | Columnas nuevas | Total cols |
|------|-----|-----------------|------------|
| 1 | `feat/meta-feed-phase1-variants-product-type` | `item_group_id`, `color`, `size`, `gender`, `product_type` | 14 |
| 2 | `feat/meta-feed-phase2-labels-google` | `google_product_category`, `custom_label_0–4`, `internal_label` | 22 |
| 3 | `feat/meta-feed-phase3-sale-price-images-marketing` | `sale_price`, `additional_image_link`, marketing | 24 |

### Headers finales

`id,item_group_id,title,description,availability,condition,price,sale_price,link,image_link,additional_image_link,brand,color,size,gender,product_type,google_product_category,custom_label_0,custom_label_1,custom_label_2,custom_label_3,custom_label_4,internal_label`

---

## Reglas no negociables

1. **Normalización única** — port `scripts/tag-normalize.js` → Edge `tag-normalize.ts`. Nunca mapear desde strings crudos (`BOTAS` / `texanas` / `bota` → misma key).
2. **`internal_label`** — fuente principal de segmentación (`a|b|c`, lowercase, dedupe). Prioridad sobre `custom_label` para Advantage+.
3. **`detectGender()`** — calzado/ropa → `female`; otros → `unisex`. No hardcode global sin categoría.
4. **`sale_price` (Fase 3)** — si hay oferta: `price` = lista, `sale_price` = oferta. Sin oferta: `sale_price` vacío.
5. **100% additive** — no tocar stock, elegibilidad, IDs, links, PDP, carrito.

---

## Migraciones SQL planificadas

| Archivo | Fase |
|---------|------|
| `226_meta_feed_phase1_category_filtro1.sql` | 1 — `category`, `filtro1` |
| `227_meta_feed_phase2_commercial_sources.sql` | 2 — filtro2/3, detalles, supplier, oferta flag |
| `228_meta_feed_phase3_offers_images_marketing.sql` | 3 — list/offer price, imágenes secundarias, fast sellers (desplegado) |

---

## Runbook Meta (cache agresivo)

Tras **cada** fase: deploy Edge → curl feed → **reimport Commerce Manager** → esperar **24–48 h** reindex → validar antes de la siguiente fase.

---

## Ver también

- Spec detallado: `doc/meta-feed/2026-05-23-meta-feed-enriquecimiento-spec.md` (mapa Google completo, diffs, ejemplo CSV, riesgos)
- `doc/arquitectura-general.md` — tabla documentación relacionada
