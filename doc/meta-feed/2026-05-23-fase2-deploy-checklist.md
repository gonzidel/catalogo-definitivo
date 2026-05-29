# Meta Feed — Fase 2 deploy checklist

## Deploy ejecutado (2026-05-23)

| Paso | Estado |
|------|--------|
| SQL `meta_feed_phase2_commercial_sources` | OK |
| Edge `meta-feed` Fase 2 | OK |
| `verify_jwt: false` (requerido para Meta fetch) | Verificar tras `--no-verify-jwt` |

## Headers CSV (22)

```text
id,item_group_id,title,description,availability,condition,price,link,image_link,brand,color,size,gender,product_type,google_product_category,custom_label_0,custom_label_1,custom_label_2,custom_label_3,custom_label_4,internal_label
```

## Conjuntos recomendados en Commerce Manager

| Objetivo | Regla sugerida |
|----------|----------------|
| Solo ropa | `custom_label_1` = `ropa` **o** `product_type` empieza con `Ropa` |
| Solo calzado | `custom_label_1` = `calzado` |
| Botas invierno | `internal_label` contiene `bota` y `invierno` |
| FYL Originals | `internal_label` contiene `fyl_originals` |
| Ofertas | `custom_label_2` = `oferta` o `internal_label` contiene `oferta` |

**Priorizar `internal_label` para Advantage+** (actualiza más rápido que custom labels).

## Post-deploy

1. Reimport feed en Commerce Manager
2. Esperar reindex **24–48 h**
3. Recrear conjuntos que antes mezclaban categorías (no reusar reglas viejas por título)

## Rollback

- Edge: deploy commit anterior + `--no-verify-jwt`
- SQL: restaurar `226_meta_feed_phase1_category_filtro1.sql`
