# ARQ-05 — Exposición de costos por la API pública: diagnóstico y plan de corrección

Fecha: 2026-10-09 · Rama: `hotfix/arq-05-exposicion-costos` (desde `origin/nj-main` f004cd2) · Estado: **PLAN, nada aplicado**

Clasificación: **TÉCNICA VERIFICADA** (solo lectura sobre producción `dtfznewwvsadkorxwzft`).
**CONTRADICCIÓN** con `14-AUDITORIA-MODULO-PRODUCTS.md`: la protección de la migración 182 (`enforce_sensitive_product_fields`) no existe en producción.

## 1. Diagnóstico

### Qué está expuesto

| Objeto | Visitante sin sesión (`anon`) | Cliente con sesión (`authenticated` no admin) | Colaborador admin |
|---|---|---|---|
| `products.cost`, `price_percentage`, `logistic_amount`, `cost_is_estimated` | **Lee** (RLS: `active` + `pending_stock` = 2178 productos; 1342 con costo) | **Lee** (mismas filas) | Lee y **escribe** todos (la UI lo limita a super_admin; la base no) |
| `category_pricing_defaults` (porcentaje y logística por categoría) | Tiene GRANT pero la RLS no le da filas (0 filas, verificado) | **Lee** (política `authenticated_select_pricing_defaults` con `true`) | Lee; escribe solo super_admin (RLS) |
| `suppliers` (`id, code, name, description`) | **Lee** las 51 filas | **Lee** | Lee y escribe |

Roles: `authenticated` es el mismo rol para clientes (≈52 cuentas) y admins (10). Los permisos por columna no distinguen entre ellos; solo RLS (por fila) o funciones `SECURITY DEFINER` pueden hacerlo.

### Evidencia de uso (logs de API, últimas 24 h)

767 GET a `/rest/v1/products` pidieron columnas de costo, todos de la propia aplicación:

| Origen | Rol | Consultas |
|---|---|---|
| Búsqueda del catálogo NJ en navegador (`www.fylmoda.com.ar`), `searchProductsIncludingOutOfStock` | anon | 546 (+12 del crawler de Meta) |
| PDP SSR de NJ (`node`), `stubFromProductsTable` | anon | 153 |
| Misma búsqueda, clientes logueados (prod + `nj-fyl-testing`) | authenticated | 56 |

Es decir: **cada búsqueda en el catálogo envía costo, porcentaje y logística al navegador del visitante** (visible en DevTools). No se vio tráfico de terceros en la ventana de 24 h, pero los logs no permiten descartar extracciones anteriores.

### Consumidores en código

Lecturas de costo por roles públicos (deben cambiar antes de revocar):

- `nj/lib/pdp/load-product-base.ts` L82-95 (`stubFromProductsTable`): calcula precio con `calculateRecommendedPrice`.
- `nj/lib/utils/catalog-variant-enrich.ts` L295-334 (`searchProductsIncludingOutOfStock`): idem.

Ambos ya enriquecen con `product_variants.price` (L110-112, L194-210) y la UI usa primero el precio del color (`getColorEffectivePrice`). Productos `active`/`pending_stock` sin ningún precio de variante > 0 pero con costo: **2** (pending_stock). Son los únicos que perderían un precio mostrado.

Lecturas y escrituras de admin (todas con sesión, rol `authenticated`):

| Archivo | Uso | Rompe con REVOKE por columna |
|---|---|---|
| `admin/products.js` L5804-5807 | `select("*")` en `loadProductById` | Sí (todos los admins) |
| `admin/products.js` L1365-1378, L6404-6480 | insert/update con campos de costo (si super_admin) | Sí (escritura) |
| `admin/import-export.js` L692-695, L891-893 | `select("*")` y rollback con fila completa | Sí |
| `admin/public-sales.js` L9175-9177 | `select("*, products(*)")` | Sí |
| `admin/offers.js` L994, 1009, 1030, 1299-1300, 2052-2053 | lee `products.cost` (cualquier admin con acceso a ofertas) | Sí |
| `nj/app/admin/products/[id]/page.tsx` L41-49 | lee costo si super_admin | Sí (super_admin) |
| `nj/lib/products/actions.ts` L115-178 | escribe costo si super_admin | Sí (super_admin) |
| `nj/lib/products/actions.ts` L13-27 | lee `category_pricing_defaults` | No (si la política pasa a admins) |

Sin impacto: catálogo vanilla (`scripts/`, `client/`) usa columnas explícitas sin costo; vistas y snapshot públicos no exponen costo; RPC de estadísticas (`get_dashboard_kpis`, `get_top_*`, `metrics_*`) son `SECURITY DEFINER` y siguen funcionando; `get_meta_feed` solo usa `suppliers.id, code`; `find_similar_products` no usa columnas de costo.

## 2. Plan por fases

Orden obligatorio en cada fase: **código compatible primero, permisos después**. Cada SQL de producción requiere aprobación explícita con el texto exacto (regla FYL-Supabase-Production-Safety).

### Fase 0 — Cortar la exposición pública (urgente)

**0a. NJ (código, deploy controlado):**

- `stubFromProductsTable` y `searchProductsIncludingOutOfStock`: quitar `cost, price_percentage, logistic_amount` del select y dejar de llamar a `calculateRecommendedPrice`. `Precio` del producto = menor `product_variants.price > 0` (ya disponible en el enriquecido) o vacío.
- Test unitario: ninguno de los dos selects contiene columnas de costo; el precio sale de variantes.
- Deploy NJ por el procedimiento controlado (`vercel deploy --prod --skip-domain` → smoke → `promote` → alias), con autorización.
- Verificación: logs de API sin `cost` en `/rest/v1/products` durante 1 h de tráfico normal.

**0b. SQL `anon` (después de 0a en producción):**

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
REVOKE SELECT ON public.products FROM anon;
GRANT SELECT (id, handle, name, description, status, category, created_at, updated_at,
              last_published_at, publication_status, supplier_id, pack_size,
              nuevos_ingresos_highlight_at, season, target_audience,
              width_cm, height_cm, length_cm, weight_kg)
  ON public.products TO anon;
REVOKE ALL ON public.category_pricing_defaults FROM anon;
COMMIT;
```

- Riesgo: bajo. Cualquier consulta `anon` con `select=*` o que pida/filtre por costo pasa a 401/42501. Ninguna encontrada en código; confirmar en logs antes de aplicar.
- Verificación: sondas HEAD con la clave pública (`select=cost` → error; `select=id,name` → 206 con los mismos conteos), `has_column_privilege('anon', ...)`, smoke de catálogo, búsqueda y PDP.
- Rollback: `GRANT SELECT ON public.products TO anon;` y `GRANT SELECT ON public.category_pricing_defaults TO anon;`.

**0c. `category_pricing_defaults` para clientes (independiente de 0a):**

```sql
DROP POLICY authenticated_select_pricing_defaults ON public.category_pricing_defaults;
CREATE POLICY admin_select_pricing_defaults ON public.category_pricing_defaults
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
```

Solo la usa el admin de NJ. Rollback: recrear la política anterior con `USING (true)`.

**0d. `suppliers` (requiere decisión de negocio):** si el nombre o la descripción de proveedores es confidencial, limitar `anon` a `GRANT SELECT (id, code)`. El banner público y `get_meta_feed` solo usan `id, code`.

### Fase 1 — Clientes con sesión y escritura de colaboradores

Como `authenticated` es compartido, se recomienda **permisos por columna + RPC `SECURITY DEFINER` para el acceso de admins al costo**:

1. **SQL aditivo (sin riesgo):**
   - `rpc_admin_get_product_pricing(p_product_ids uuid[])`
   - `rpc_admin_set_product_pricing(p_product_id, p_cost, p_cost_is_estimated, p_price_percentage, p_logistic_amount)`

   Ambas con `search_path = ''`, `auth.uid()` + chequeo de rol, EXECUTE solo `authenticated`, y sin acceso `anon`/`PUBLIC`.
2. **Código (compatible con los permisos actuales):**
   - legacy `products.js`: `select("*")` → columnas explícitas; el costo se carga y guarda por RPC (alta rápida L1365 incluida).
   - `import-export.js`: snapshot y rollback con columnas explícitas.
   - `public-sales.js`: `products(*)` → columnas explícitas.
   - `offers.js`: costo por RPC.
   - NJ admin: `[id]/page.tsx` y `actions.ts`, costo por RPC.
   - Revisar también `.insert().select()` / `.update().select()` sobre `products` sin columnas explícitas.
3. **SQL de permisos (después del deploy del código):** `REVOKE SELECT, INSERT, UPDATE ON public.products FROM authenticated` y `GRANT SELECT/INSERT/UPDATE (columnas sin costo)` a `authenticated`. Así, la escritura de costo solo es posible por RPC, lo que **reemplaza a la protección 182 en la base**.

   Rollback: `GRANT SELECT, INSERT, UPDATE ON public.products TO authenticated`.

Alternativa evaluada: mover los costos a una tabla privada (`product_pricing_private`, solo admin). Es más limpia a largo plazo, pero exige migrar datos y tocar las RPC de estadísticas; no conviene para la urgencia.

**Acoplamiento con tablas de talles (378):** con permisos por columna, una columna nueva no queda accesible para nadie. Si 378 se aplica antes de la Fase 1, el `GRANT` de la Fase 1 debe incluir `size_chart_id` para `authenticated` (SELECT, INSERT, UPDATE). Si se aplica después, 378 debe agregar ese `GRANT` por columna. `anon` no debe recibirla.

### Fase 2 — Auditoría de seguridad dedicada

- Todas las tablas con `GRANT` a `anon` y políticas `USING (true)`.
- Funciones invocables por `anon`.
- `has_permission` es consultable por cualquier usuario con sesión con un uid arbitrario (enumeración de permisos).
- Permisos del rol `authenticated` sobre tablas operativas.

## 3. Decisiones pendientes

1. ¿Quién puede ver costos además del super_admin? Hoy `offers.js` los muestra a cualquier admin con acceso a ofertas.
2. ¿Nombre y descripción de proveedores son confidenciales para el público?
3. Los 2 productos `pending_stock` sin precio de variante: ¿se muestran sin precio o se les carga precio?
4. Ventana para el deploy de NJ de la Fase 0a.
