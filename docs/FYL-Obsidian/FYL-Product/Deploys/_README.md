# Deploys

Bitácora de deploys a producción. Usar [[../_Templates/Template-Deploy]]. **Uno por archivo**, no concatenar.

## Convención

- ID: `DEP-YYYY-MM-DD-vXX` (XX = orden del día si hay más de uno).
- Archivo: `DEP-YYYY-MM-DD-vXX-slug.md`.
- El campo `cache-bust` debe coincidir con `app-version.json` y el `?v=` aplicado en `index.html`.

## Por qué importa

- Sirve para correlacionar cambio ↔ delta en métricas Clarity.
- Sirve para rollback (cada nota tiene plan de reversión).
- Es la entrada al postmortem si el deploy rompe algo ([[../_Templates/Template-Postmortem]]).

## Checklist por deploy

(Detallado en el template). Mínimo no-negociable:
- [ ] `npm run build` ok
- [ ] `app-version.json` y cache-bust HTML actualizados
- [ ] Smoke producción mobile real en 5 minutos
- [ ] Clarity sin spike 30 minutos post-deploy

## Vínculos

- Plantilla: [[../_Templates/Template-Deploy]]
- Runbook operativo legacy: [[../../09-RUNBOOK-OPERATIVO]]
- Release gate / auditoría: [[../../07-RELEASE-GATE-Y-AUDITORIA]]
