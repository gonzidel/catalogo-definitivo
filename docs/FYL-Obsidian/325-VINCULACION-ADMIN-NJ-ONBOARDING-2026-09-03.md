# 325 - Vinculación admin ↔ cuenta NJ (onboarding)

Fecha: 2026-09-03

## Deploy

- **Aplicado en prod** (`fyl-core` / `dtfznewwvsadkorxwzft`) el 2026-09-03 vía migraciones MCP:
  - `improve_customer_link_onboarding` (helpers teléfono)
  - `improve_customer_link_rpc_link_or_create`
  - `improve_customer_link_public_sales_rpc`
  - `fix_customer_link_normalize_geo` + `fix_customer_link_fk_display_name_rpc` (**326**: FK `order_notifications`, nombre del perfil manda, geo sin acentos)
- Verificado: merge real de caso luis (`2841KOVMJ` → cuenta auth) con `action=linked`.

## Hotfix 2026-09-03 (por qué falló el test)

1. El merge abortaba por FK `order_notifications` (`NO ACTION`) al borrar el UUID admin.
2. El onboarding tragaba el error (`console.warn`) y seguía con `rpc_upsert_customer` → duplicado.
3. El front NJ con la llamada a link aún no estaba en el deploy público (cambio local).

## Qué cambió

Al completar el onboarding en NJ (`ProfileOnboardingModal`), el cliente autenticado se **unifica** con un cliente creado por admin cuando coinciden:

1. **Teléfono** (dígitos normalizados, últimos 7 — mismo criterio que admin/PAU)
2. **Provincia y/o localidad** (si el caller las envía; case-insensitive)

Fallbacks: email exacto, luego DNI exacto.

## Por qué fallaba antes

- NJ solo llamaba `rpc_link_public_sales_customer` (lookup) y luego `rpc_upsert_customer`.
- Eso copiaba a veces `customer_number` pero **no migraba** el UUID admin → `auth.uid()`, dejando duplicados.
- El merge real (`rpc_link_or_create_customer`) solo se disparaba desde el carrito vanilla (`scripts/cart-persistent.js`).
- El matching de teléfono en SQL era `trim` exacto (frágil frente a formatos `+54 9 …`).

## Contrato actual

| Pieza | Rol |
|---|---|
| `325_improve_customer_link_onboarding.sql` | Helpers `normalize_phone_digits_for_match` / `phones_match_by_suffix`; RPCs mejoradas |
| `rpc_link_or_create_customer(user, email, phone, name, dni, province?, city?)` | Merge: migra orders/carts/notifications/aliases, borra temporal admin, escribe `customer_auth_links` |
| `rpc_link_public_sales_customer` | Lookup public-sales / admin (teléfono normalizado; sin fallback “solo teléfono” si hubo geo) |
| `rpc_upsert_customer` | Completa dirección y campos de perfil sobre `id = auth.uid()` |
| NJ onboarding | Llama link → public-sales → upsert en ese orden |

## Reglas de match

- Si el caller envía provincia/localidad y el teléfono coincide pero la geo **no**, **no** se auto-mergea por teléfono.
- Si el caller **no** envía geo (p. ej. carrito legacy), el match por teléfono normalizado sigue permitido.
- Se prioriza candidato `created_by_admin = true`.

## Fuera de alcance (2026-09-03)

- No hay backfill/merge de duplicados ya existentes.
- No hay UI admin de unificación manual.
- El carrito NJ sigue usando `user.id` como `customerId` (no reintroduce link en cada sync).

## Verificación sugerida

1. Admin crea cliente con teléfono X + ciudad/provincia.
2. Misma persona completa onboarding NJ con mismo teléfono y misma geo → 1 fila, mismo `#`, pedidos migrados, fila en `customer_auth_links`.
3. Mismo teléfono, geo distinta → no merge; cuenta nueva.
4. Public-sales (QR) sigue asociando `qr_code` / `public_sales_customer_id`.

## Rollback

Restaurar firmas/cuerpos previos de `rpc_link_or_create_customer` (5 args) y `rpc_link_public_sales_customer` desde `26_*` / `30_*`, y quitar la llamada extra en `ProfileOnboardingModal.tsx`.

## Enlaces

- [[03-MAPA-DE-RPCS]]
- [[06-FLUJO-CATALOGO]]
- [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]
