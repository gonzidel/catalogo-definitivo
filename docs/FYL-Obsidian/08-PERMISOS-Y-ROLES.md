# 08 - Permisos y roles

## Modelo

| Tabla/RPC | Uso |
|---|---|
| `admins` | Vincula usuario Supabase con admin/colaborador |
| `admin_permissions` | Permisos por modulo/accion |
| `is_super_admin` | RPC/helper para distinguir super admin |

## Frontend vs DB

El helper de frontend controla visibilidad y acceso UI, pero no reemplaza RLS, triggers ni validaciones dentro de RPCs.

Riesgos detectados en auditorias:

| Riesgo | Nota |
|---|---|
| Costos protegidos en UI, validar proteccion DB | [[14-AUDITORIA-MODULO-PRODUCTS]] |
| RPCs de stock validan admin general, revisar permiso granular | [[16-AUDITORIA-MODULO-STOCK]] |
| Public Sales exige sesion pero no se detecto permiso frontend granular en `public-sales.js` | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| Funciones/RPCs `SECURITY DEFINER` pueden saltar RLS si grants son amplios | [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]] |

## Permiso `search` (buscador `/nj`, 2026-09-04)

`admin_permissions.permission_key = 'search'`. Super admin pasa. Collaborator necesita `can_view` / `can_edit`.

- UI: `nj/lib/auth/admin.ts` (`SEARCH_ADMIN_PERMISSION_KEY`)
- DB: `is_admin()` en writes de `search_keywords` / `search_aliases` / `search_ignored_terms` y en RPCs `search_admin_*`
- Anon: lee diccionario **activo** (`search_dictionary_public`); no lee analytics; no escribe vocabulario

No duplicar autorización. Detalle: [[59-NJ-BUSCADOR-SMART-SEARCH]], [[41-SEARCH-ADMIN-FASE5-2026-09-03]].

## Regla para cambios

Si una accion modifica stock, costos, pedidos, ventas, creditos o customers, la DB debe validar permisos reales. El frontend sirve para UX, no como barrera de seguridad.

## Enlaces

- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
- [[13-RPCS-DEPLOY-STATE]]
- [[12-CHECKLIST-CAMBIOS-FUTUROS]]
- [[59-NJ-BUSCADOR-SMART-SEARCH]]
