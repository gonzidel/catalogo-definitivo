# DEP-YYYY-MM-DD-vXX — {{título corto}}

- **Fecha:** YYYY-MM-DD HH:MM (UTC-3)
- **Versión / cache-bust:** ej. `m260512`
- **Autor:** quien hace el deploy
- **Tipo:** feature | bugfix | hotfix | performance | rollback
- **Áreas tocadas:** catálogo | PDP | carrito | dashboard | admin | supabase

## Cambios incluidos

| Tipo | Resumen | Archivos | Doc |
|---|---|---|---|
| fix | | | [[BUG-NNN]] |
| perf | | | [[PERF-NNN]] |
| ux | | | [[UXD-NNN]] |

## Migraciones SQL

- ¿Hay migración? sí / no
- Archivo: `supabase/canonical/NNN_...sql`
- Reversible: sí | no | sí con compensación

## Pre-deploy

- [ ] `npm run build` ok
- [ ] Cache-bust actualizado en `app-version.json`
- [ ] Smoke local
- [ ] Sin secrets commiteados
- [ ] Migraciones aplicadas y verificadas

## Post-deploy

- [ ] Smoke producción mobile real
- [ ] Sticky cart visible si hay items
- [ ] PDP abre por deep link
- [ ] Búsqueda responde < 500ms
- [ ] Clarity sin spike de errores tras 30min

## Métricas

- LCP antes / después:
- INP antes / después:
- CLS antes / después:
- Errores JS / 1k sesiones:

## Rollback plan

Cómo revertir si rompe. Comando, commit, restauración.

## Incidentes detectados

- Ninguno | [[BUG-NNN]]

## Cruces

[[../Roadmap/...]] · postmortems si aplica
