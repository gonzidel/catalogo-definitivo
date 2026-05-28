# Meta Feed — Fase 1 deploy checklist

## Headers exportados (14)

```text
id,item_group_id,title,description,availability,condition,price,link,image_link,brand,color,size,gender,product_type
```

Verificar post-deploy:

```bash
curl -s "https://<PROJECT>.supabase.co/functions/v1/meta-feed?token=<TOKEN>&limit=1" | head -n 1
```

JSON admin:

```bash
curl -s "https://<PROJECT>.supabase.co/functions/v1/meta-feed?format=json&limit=1&token=<TOKEN>" | jq '.debug.csv_headers, .debug.feed_phase'
```

## SQL (requiere aprobación prod)

```bash
# Aplicar en Supabase SQL Editor:
# supabase/canonical/226_meta_feed_phase1_category_filtro1.sql
```

## Edge

```bash
supabase functions deploy meta-feed
```

## Commerce Manager

1. Data sources → catálogo FYL → Fetch now / reupload URL feed
2. Items → abrir 2 SKUs con mismo `item_group_id` → deben agruparse como variantes
3. Filtros: probar color, size, gender, product type (puede tardar **24–48 h**)
4. **No avanzar Fase 2** hasta validar agrupación

## Rollback

- Edge: redeploy commit anterior de `index.ts` (9 columnas)
- SQL: restaurar `41_meta_feed_rpc.sql` / `225` sin `category`/`filtro1` (DROP + CREATE previo)

## Ejemplo CSV

`doc/meta-feed/ejemplo-csv-fase1.csv`
