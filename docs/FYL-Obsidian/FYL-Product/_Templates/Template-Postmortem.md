# POSTMORTEM — BUG-NNN — {{título corto}}

- **Cerrado:** YYYY-MM-DD
- **Duración del incidente:** ej. 3 días en producción
- **Detectado:** Clarity | usuaria | dev | QA
- **Severidad final:** crítico | alto | medio | bajo

## Resumen ejecutivo

3–5 líneas: qué pasó, a quién afectó, cómo se resolvió.

## Línea de tiempo

| Fecha / hora | Evento |
|---|---|
| YYYY-MM-DD HH:MM | Primer reporte |
| YYYY-MM-DD HH:MM | Diagnóstico confirmado |
| YYYY-MM-DD HH:MM | Fix deployado |
| YYYY-MM-DD HH:MM | Verificado en producción |

## Causa raíz

Por qué pasó. No "qué hicimos mal" — qué condición técnica lo permitió.

## Por qué no lo detectamos antes

Qué hueco de tests / observabilidad / review lo dejó pasar.

## Fix aplicado

- Archivos: `...`
- Commit / deploy: [[DEP-...]]
- Resumen del cambio:

## Prevención

Acciones concretas:
- [ ] Test que cubre el caso
- [ ] Alerta / métrica
- [ ] Nota en [[../11-DECISIONES-TECNICAS]] si aplica
- [ ] Cambio en checklist de deploys

## Lecciones

Qué patrón evitar a futuro. Sin culpas.

## Cruces

[[BUG-NNN]] · [[DEC-NNN]] · [[CLAR-...]]
