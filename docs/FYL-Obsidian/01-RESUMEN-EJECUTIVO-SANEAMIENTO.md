# 01 — Resumen ejecutivo: saneamiento FYL (stock, pedidos, ventas)

## Por qué se hizo

El sistema mezclaba **lecturas y escrituras** sobre capas de stock (canónica vs derivada vs columnas legacy), **flujos sin idempotencia** (doble click / reintentos duplicando impacto) y **inconsistencias** difíciles de auditar (`reserved_qty`, derivados vs suma de filas canónicas). Eso generaba riesgo operativo: stock “fantasma”, reservas mal cerradas, pedidos con estados difíciles de explicar al cliente, y dificultad para atribuir un bug a UI vs base de datos.

## Riesgos originales (síntesis)

| Riesgo | Efecto |
|--------|--------|
| Escritura directa a tablas de stock / derivadas desde el navegador | Drift, bypass de reglas, imposible auditar de forma uniforme |
| Flujos críticos sin `operation_id` / replay | Duplicar descuentos, ventas, movimientos o checkout |
| Catches silenciosos / fallbacks que “inventan” disponibilidad | Usuario o admin creen tener stock real que no existe |
| `product_variants.reserved_qty` desalineado de fuentes reales (órdenes, carrito) | Oversell o bloqueos erróneos |
| Triggers 84/145 y canónica mal entendidos | “Arreglar” en UI lo que debería corregirse en DB |

## Qué quedó resuelto (alineado a repo)

1. **Política de escritura:** el frontend **orquesta**; las mutaciones de stock y operaciones transaccionales viven en **RPCs** `SECURITY DEFINER` (ver [[04-RPCS-CRITICAS]], [[02-MODELO-STOCK-ACTUAL]]).
2. **Idempotencia:** tabla `rpc_operations` + `p_operation_id` + fingerprint/replay en operaciones listadas (ver [[05-IDEMPOTENCIA-RPC-OPERATIONS]]).
3. **Auditoría:** vistas `vw_stock_audit_*`, gate `go_live_ready` con `blocking_reasons` (ver [[07-RELEASE-GATE-Y-AUDITORIA]]).
4. **`reserved_qty`:** comparación y corrección bajo `rpc_reconcile_stock` con `p_fix_reserved_qty` (ver [[06-RESERVED-QTY-Y-RECONCILE]], migraciones `175`, `176`).
5. **UI canónica:** reglas de lectura y eliminación de fallbacks peligrosos (ver [[08-UI-CANONICA-Y-FALLBACKS]] y `docs/STOCK_GOVERNANCE.md` §1 y §5).
6. **Cliente B2B:** checkout solo con `rpc_checkout_cart(p_operation_id, p_request)`; filas de carrito con `variant_id` válido; ajustes de DOM post-checkout (ver `client/dashboard-instant.js`, notas en [[10-BUGS-RESUELTOS]], [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] §11).
7. **Gobernanza y operativa** documentada en repositorio: `docs/STOCK_GOVERNANCE.md`, `docs/RUNBOOK.md` (sincronizados conceptualmente con este vault).

## Estado final del sistema (cómo pensarlo)

- **Una capa canónica** de existencias por talle y depósito: `variant_size_warehouse_stock`.
- **Capas derivadas** mantenidas por triggers **84** y **145** (no editar a mano salvo excepciones operativas deliberadas).
- **Operaciones con efecto contable o en pedido** pasan por RPCs con contrato de idempotencia donde aplica.
- **Monitoreo** antes de deploy: `vw_stock_audit_release_gate` y alertas; **herramienta de corrección** `rpc_reconcile_stock`.

## Referencias

- [[00-INDICE]] · [[11-DECISIONES-TECNICAS]] · [[99-AUDITORIA-FINAL]]
- Fuentes externas al vault: `docs/STOCK_GOVERNANCE.md`, `docs/RUNBOOK.md`
