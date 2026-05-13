# Decisiones

Decisiones que conviene fijar para no re-discutirlas. Dos sub-tipos en la **misma carpeta**:

- **DEC-NNN** — decisiones **técnicas** ([[../_Templates/Template-Decision-Tecnica]]).
- **UXD-NNN** — decisiones **UX** ([[../_Templates/Template-Decision-UX]]).

## Convención

- ID estable, numeración secuencial dentro de cada prefijo.
- Archivo: `DEC-NNN-slug.md` o `UXD-NNN-slug.md`.
- Si una decisión queda revertida, **no se borra**: se cambia el estado a `revertida` y se referencia la nueva.

## Pendientes de redactar (derivados de la auditoría)

Cuando se decidan los fixes, capturar al menos:

- **DEC-001** — Política sobre `setInterval` y polling global en frontend (ver [[../Performance/PERF-004-SetInterval-Imagenes-Lazy]]).
- **DEC-002** — Reglas de carga de CSS: cuándo usar `media`, cuándo critical inline, cuándo lazy (ver [[../Performance/PERF-006-Styles-Desktop-Render-Blocking]]).
- **DEC-003** — `MutationObserver` vs API explícita: criterio (ver [[../Performance/PERF-002-MutationObserver-Filtros]]).
- **UXD-001** — Política de touch target mínimo en cards y header (ver [[../UX/UX-004-Color-Swatches-Touch-Target]]).
- **UXD-002** — Política de modales auto-abierto (ver [[../UX/UX-003-Onboarding-Roba-Tap]]).

## Vínculos

- Decisiones técnicas legacy: [[../../11-DECISIONES-TECNICAS]] (no duplicar — referenciar y, si hace falta, "supersedida por DEC-NNN").
