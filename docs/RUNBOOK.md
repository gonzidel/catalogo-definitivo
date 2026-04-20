# Runbook FYL — Operativa diaria

Checklist mínimo para deploy, post-deploy, diagnóstico rápido y decisión go/no-go.
Ver `docs/STOCK_GOVERNANCE.md` para el detalle conceptual.

---

## 1. Pre-deploy (5 min)

- `git status` limpio, cambios revisados.
- Si hay `.sql` nuevos en `supabase/canonical/`:
  - Numerados consecutivamente.
  - Para cambios de columnas en views existentes: `DROP VIEW IF EXISTS ... CASCADE` antes de `CREATE VIEW`.
  - Probados en SQL editor de Supabase (staging o rama de DB).
- Gate en verde **antes** de tocar nada:
  ```sql
  SELECT go_live_ready, health_score
  FROM public.vw_stock_audit_release_gate;
  ```
  - `go_live_ready = true` → seguir.
  - `go_live_ready = false` → STOP, ir a "Diagnóstico rápido".

---

## 2. Deploy

1. **SQL** (si aplica):
  - Ejecutar cada archivo nuevo de `supabase/canonical/` en orden numérico desde el SQL editor o CLI.
  - Verificar sin errores.
2. **Frontend**: push del repo. Sitio estático servido desde Cloudflare/Netlify/GitHub Pages (según configuración actual).
3. Si hay cambios en `admin/`: avisar al equipo para hard-reload (`Ctrl+F5`).

---

## 3. Post-deploy (5 min)

- Gate sigue en verde:
  ```sql
  SELECT * FROM public.vw_stock_audit_release_gate;
  ```
- Alertas activas vacías o esperadas:
  ```sql
  SELECT * FROM public.vw_stock_audit_alerts_current;
  ```
- Smoke test manual (5 min, mobile y desktop):
  - Home carga y muestra productos con stock correcto.
  - Abrir un PDP con stock → talles correctos.
  - Abrir un PDP sin stock → muestra alternativas con stock real (no inventado).
  - Agregar 1 ítem al carrito → stock disponible se reduce al recargar.
  - Checkout dry-run de un cliente de prueba → RPC `rpc_checkout_cart` responde OK.
  - Admin: abrir `admin/stock-audit.html` → health_score ≥ 95.
  - Admin: abrir `admin/orders.html` → lista sin errores en consola.

---

## 4. Diagnóstico rápido

### Síntoma: gate en no-go

```sql
-- ¿Qué KPI rompió?
SELECT
  go_live_ready,
  variant_warehouse_diffs_count,
  reserved_qty_diffs_count,
  orphan_variants_count,
  health_score
FROM public.vw_stock_audit_release_gate;
```

- `variant_warehouse_diffs_count > 0` → correr reconcile:
  ```sql
  SELECT public.rpc_reconcile_stock(p_fix_reserved_qty := false);  -- dry-run
  SELECT public.rpc_reconcile_stock(p_fix_reserved_qty := true);   -- fix
  ```
- `reserved_qty_diffs_count > 0` → mismo reconcile con `p_fix_reserved_qty := true`.
- `orphan_variants_count > 0` → revisar `vw_stock_audit_orphan_variants`; limpiar variante o reactivar producto.

### Síntoma: UI muestra "sin stock" pero admin muestra unidades

1. Abrir devtools → Network → filtrar `variant_size_warehouse_stock`.
2. Verificar que `warehouse_id` va como **UUID**, no como string (`general`, `venta-publico`).
3. Si va como string → bug como el hotfix de `product-alternatives.js`. Buscar nuevas ocurrencias:
  ```
   rg "warehouse_id.*['\"](general|venta-publico)['\"]" --glob "*.js"
  ```
4. Resolver UUID primero desde `warehouses.code` y pasarlo al filtro.

### Síntoma: checkout falla con `operation_id_conflict`

- Significa que otra llamada previa usó el mismo `operation_id` con payload distinto.
- Causa típica: generación del `operation_id` dentro de un retry loop (bug).
- Solución: regenerar `operation_id` por click de usuario, no por reintento.

### Síntoma: checkout falla con `conflict_in_progress`

- Otra transacción con el mismo `operation_id` está corriendo.
- Esperar 2-3 s y polear estado del pedido antes de reintentar con el mismo id.

### Síntoma: pedido sale doble

- Revisar si la RPC correspondiente tiene `p_operation_id` (ver tabla en `STOCK_GOVERNANCE.md` §6).
- Verificar en `rpc_operations` que hubo dos ids distintos → es un bug del cliente (no reusó id en retry).

### Logs útiles

```sql
-- Últimas operaciones idempotentes
SELECT
  operation_id,
  operation_kind,
  request_json->>'action' AS action,
  request_json->>'source' AS source,
  status,
  result_json->>'error'   AS err,
  started_at
FROM public.rpc_operations
ORDER BY started_at DESC
LIMIT 50;

-- Últimos movimientos de stock
SELECT * FROM public.stock_movements ORDER BY created_at DESC LIMIT 50;

-- Últimos cambios manuales
SELECT * FROM public.stock_history ORDER BY created_at DESC LIMIT 50;
```

---

## 5. Go / No-go (release)

Antes de abrir operación nueva, anunciar feature grande o comunicar cambios a resellers:


| Check               | Fuente                                      | Criterio                                           |
| ------------------- | ------------------------------------------- | -------------------------------------------------- |
| Gate                | `vw_stock_audit_release_gate.go_live_ready` | `true`                                             |
| Health score        | `vw_stock_audit_release_gate.health_score`  | `≥ 95`                                             |
| Alertas             | `vw_stock_audit_alerts_current`             | 0 filas o solo conocidas/aceptadas                 |
| Drift reserved_qty  | `reserved_qty_diffs_count`                  | `0`                                                |
| Drift warehouse     | `variant_warehouse_diffs_count`             | `0`                                                |
| Smoke test UI       | manual, §3                                  | OK                                                 |
| Consola sin errores | devtools                                    | sin errores rojos en home, PDP, carrito, dashboard |


Si **todo** está OK → **go**.
Si falla cualquiera → **no-go**, abrir incidencia y correr diagnóstico.

---

## 6. Rollback rápido

- **Frontend**: revertir commit en el repo y re-deploy.
- **SQL canónico**: cada archivo `XXX_*.sql` debe ser re-ejecutable. Para revertir, crear un `XXX+N_revert_*.sql` que recree la versión anterior. Nunca editar un archivo ya ejecutado en prod.
- **Datos corrompidos**: `rpc_reconcile_stock(p_fix_reserved_qty := true)` resuelve drift de stock. Para corrupción más profunda (filas huérfanas, pedidos en estado raro) → backup PITR de Supabase.

---

## 7. Contactos y accesos

- Supabase project: `dtfznewwvsadkorxwzft`
- Dashboard: [https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft](https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft)
- Pantalla de auditoría: `admin/stock-audit.html`
- Docs relacionadas:
  - `docs/STOCK_GOVERNANCE.md` — gobernanza completa
  - `admin/STOCK_OPERATIVA.md` — operativa admin
  - `docs/STOCK_SYSTEM_AUDIT.md` — auditoría histórica
  - `docs/RPC_CANONICAL_MAP.md` — mapa de RPCs canónicas

