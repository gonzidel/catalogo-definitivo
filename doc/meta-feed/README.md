# Meta Catalog Feed — documentación

| Documento | Descripción |
|-----------|-------------|
| [2026-05-23-meta-feed-enriquecimiento-spec.md](./2026-05-23-meta-feed-enriquecimiento-spec.md) | Spec completo: auditoría, 3 fases, mapa Google, CSV, runbook |
| [2026-05-23-fase1-deploy-checklist.md](./2026-05-23-fase1-deploy-checklist.md) | Checklist deploy Fase 1 |
| [ejemplo-csv-fase1.csv](./ejemplo-csv-fase1.csv) | Ejemplo CSV 14 columnas |
| [[../../META_FEED_EJEMPLO_CSV.md]] | Ejemplo CSV (actualizar tras cada fase deploy) |
| [[../../INSTRUCCIONES_DEPLOY_META_FEED.md]] | Deploy Edge Function |
| [[../../DEPLOY_META_FEED.md]] | Deploy / CORS |

**Obsidian:** [[../../docs/FYL-Obsidian/38-META-FEED-ENRICHMENT-2026-05-23]]

**Código:**

- `supabase/functions/meta-feed/index.ts`
- `supabase/canonical/41_meta_feed_rpc.sql`
- `scripts/outputs/meta-feed-csv-validate.mjs`
