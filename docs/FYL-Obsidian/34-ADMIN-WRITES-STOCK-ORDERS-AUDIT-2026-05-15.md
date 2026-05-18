# 34 — Auditoría escrituras admin (stock / pedidos / reservas)

**Fecha:** 2026-05-15  
**Tipo:** diagnóstico (sin cambios de código aplicados)

## Fuente de verdad (repo)

Documento técnico consolidado (mapa de escrituras, clasificación A/B/C, plan por etapas, riesgos):

- **`doc/admin-writes-audit-stock-orders-2026-05-15.md`**

## Resumen en una frase

Los caminos **más críticos** (cancelación, void venta pública, batches de stock, reconciliación `reserved_qty`) ya están **dominantemente en RPC**; el riesgo residual está en **secuencias multi-request** desde el navegador (creación de pedido admin + rollback manual, import masivo precio+stock) y en **updates directos** a `orders` por operativa (notas, caducidad, método de pago).

## Enlaces útiles en el vault

- Reservas y reconciliación: [[06-RESERVED-QTY-Y-RECONCILE]]
- Hardening previo Supabase: [[21-CONTEXTO-AGENTE-HARDENING-2026-04]] (contexto); registro mayo 2026 en `doc/hardening-supabase-2026-05-13.md`
- Fase A grants PostgREST: [[33-FASE-A-GRANTS-COMPRAS-PUBLICACION-2026-05-15]]

## Próximo paso sugerido

**Elegido:** primera RPC transaccional = alta pedido admin (`createNewOrder`). Diseño en borrador (sin código aún): [[35-RFC-RPC-CREATE-ADMIN-ORDER-ATOMIC-2026-05-15]].
