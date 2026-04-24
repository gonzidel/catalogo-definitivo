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

## Regla para cambios

Si una accion modifica stock, costos, pedidos, ventas, creditos o customers, la DB debe validar permisos reales. El frontend sirve para UX, no como barrera de seguridad.

## Enlaces

- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
- [[13-RPCS-DEPLOY-STATE]]
- [[12-CHECKLIST-CAMBIOS-FUTUROS]]
