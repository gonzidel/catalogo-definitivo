# Meta Feed — Fase 3 deploy checklist

## Deploy ejecutado (2026-05-23)

| Paso | Estado |
|------|--------|
| SQL `meta_feed_phase3_offers_images_marketing` (`228`) | OK |
| Edge `meta-feed` Fase 3 (`--no-verify-jwt`) | OK |
| `verify_jwt: false` (`config.toml`) | OK |
| Feed live HTTP 200 | OK |

## Headers CSV (24)

```text
id,item_group_id,title,description,availability,condition,price,sale_price,link,image_link,additional_image_link,brand,color,size,gender,product_type,google_product_category,custom_label_0,custom_label_1,custom_label_2,custom_label_3,custom_label_4,internal_label
```

## Verificación prod (2026-05-23)

| Check | Resultado |
|-------|-----------|
| Filas exportadas | ~3913 |
| `additional_image_link` poblado | Sí (URLs secundarias Cloudinary normalizadas) |
| `custom_label_4` marketing | `top_seller` / `new_arrival` según reglas |
| `internal_label` incluye marketing key | Sí (ej. `…\|top_seller`) |
| Filas con `sale_price` | 0 al deploy (sin ofertas activas en `color_price_offers` que cumplan stock + catálogo) |

Cuando haya ofertas activas: `price` = lista, `sale_price` = oferta (solo si `offer_price < list_price`).

## Conjuntos recomendados (nuevos / actualizar)

| Objetivo | Regla sugerida |
|----------|----------------|
| Top sellers | `custom_label_4` = `top_seller` **o** `internal_label` contiene `top_seller` |
| Novedades | `custom_label_4` = `new_arrival` **o** `internal_label` contiene `new_arrival` |
| Con galería extra | `additional_image_link` no vacío |
| Ofertas tachadas | `sale_price` no vacío (cuando existan ofertas en BD) |

## Post-deploy

1. Reimport feed en Commerce Manager (misma URL).
2. Esperar reindex **24–48 h**.
3. Validar en CM: columnas `sale_price` y `additional_image_link` mapeadas.
4. Probar conjunto Advantage+ con `top_seller` / `new_arrival` tras reindex.

## Rollback

- Edge: deploy commit anterior + `--no-verify-jwt`
- SQL: restaurar `227_meta_feed_phase2_commercial_sources.sql`
