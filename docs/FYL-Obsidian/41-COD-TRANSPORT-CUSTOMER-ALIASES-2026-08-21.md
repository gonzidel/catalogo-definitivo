# COD — Alias de cliente por transporte (2026-08-21)

**Estado:** migraciones **281–283 APLICADAS en producción** (`fyl-core`). Código UI listo. Aliases reales **pendientes de creación manual por UI**.

## Qué es

`transport_id + normalized_alias → customer_id`

Cómo un transporte escribe al cliente. **No** es `additional_names`.

## Migraciones

- `281_cod_transport_customer_aliases_schema.sql` — **aplicada**
- `282_cod_transport_customer_aliases_rls.sql` — **aplicada**
- `283_rpc_cod_transport_customer_aliases.sql` — **aplicada** (remember + set_active + reassign)

## Matching

Orden auto: **A** `strong_identity` → **C** `transport_alias` → **B** `unique_financial_logistics`

Vía C exige: alias activo + customer + 1 pedido con monto/fecha/transporte exactos (Etapa A).

## Normalización

TS `normalizeCodAliasName` ≡ SQL `_cod_normalize_match_name`. **Ñ → n**.

## UX

«Aprobar y recordar nombre» = assign (279) luego remember (nueva RPC). Si remember falla, assign permanece.

## Admin

`/admin/conciliacion-reembolso/aliases` — listado + desactivar.

## No hecho / pendiente humano

- Crear aliases MIÑO/HETER por UI (no por SQL)
- Reanalizar rendición `1dcb352a-…` (aún no autorizado)
- Fase 6 / tocar 279–280
