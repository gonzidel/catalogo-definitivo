# ARQ-05 — Exposición de costos por la API pública: diagnóstico y plan de corrección

Fecha: 2026-10-09 · Rama: `hotfix/arq-05-exposicion-costos` (desde `origin/nj-main` f004cd2) · Estado: **Fase 0 preparada en la rama (código + tests + SQL 379). Nada desplegado ni aplicado.**

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

Ambos ya enriquecen con `product_variants.price` (L110-112, L194-210) y la UI usa primero el precio del color (`getColorEffectivePrice`). Productos `active`/`pending_stock` sin ningún precio de variante > 0 pero con costo: **2** (pending_stock, ver §4). No tienen variantes, así que hoy tampoco se muestran: nadie pierde un precio visible.

Otras rutas públicas o de admin que exponían datos sensibles (inventario completo 2026-10-09):

- Server Action `getCategoryPricingDefault` (`nj/lib/products/actions.ts`): sin chequeo de permiso; cualquier sesión podía invocarla. Además `admin/products/new` y `[id]` la llamaban para **todo** admin y serializaban porcentaje/logística en las props de `ProductGeneralForm`, aunque la UI de costo solo se muestra a super_admin.
- Server Action `listSuppliers`: sin chequeo de permiso (nombres de proveedor a cualquier sesión).
- `catalog_public_view` es `security_invoker` y hace `LEFT JOIN suppliers s ON s.id = p.supplier_id`: con anon necesita `products.supplier_id` y `suppliers(id, code)` en todas las filas. Restringir filas de `suppliers` (p. ej. solo `FYL`) vaciaría `SupplierCode` en el catálogo vanilla y en `ActiveOrderTab`.
- La tabla `admins` es legible por cualquier cliente con sesión (10 filas). Hallazgo para Fase 2.
- Sin exposición: `/api/catalog`, `/api/catalog/has-ofertas` (snapshot), vistas `catalog_public_*` y snapshot (sin costo), Edge Functions (no leen `products`/`suppliers`), `get_meta_feed` (solo `suppliers.id, code`), `find_similar_products`/`compute_similarity` (id, name, category, status). Ninguna lectura pública usa `select('*')` ni `products(*)`.

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
| `nj/lib/products/actions.ts` `getCategoryPricingDefault` | lee `category_pricing_defaults` (desde Fase 0a solo super_admin) | No (la política ALL de super_admin cubre la lectura) |

Sin impacto: catálogo vanilla (`scripts/`, `client/`) usa columnas explícitas sin costo; vistas y snapshot públicos no exponen costo; RPC de estadísticas (`get_dashboard_kpis`, `get_top_*`, `metrics_*`) son `SECURITY DEFINER` y siguen funcionando; `get_meta_feed` solo usa `suppliers.id, code`; `find_similar_products` no usa columnas de costo.

## 2. Plan por fases

Orden obligatorio en cada fase: **código compatible primero, permisos después**. Cada SQL de producción requiere aprobación explícita con el texto exacto (regla FYL-Supabase-Production-Safety).

### Fase 0 — Cortar la exposición pública (urgente)

**0a. NJ (código) — IMPLEMENTADO en la rama, sin deploy:**

| Archivo | Cambio |
|---|---|
| `nj/lib/pdp/load-product-base.ts` | `stubFromProductsTable` pide `PUBLIC_PRODUCT_FALLBACK_SELECT` (`name, description, category, status`); `Precio: ""`; sin `calculateRecommendedPrice`. |
| `nj/lib/utils/catalog-variant-enrich.ts` | `searchProductsIncludingOutOfStock` pide `PUBLIC_PRODUCT_SEARCH_SELECT` (`name, description, category`); `Precio: ""`. |
| `nj/lib/products/actions.ts` | `getCategoryPricingDefault` exige super_admin; `listSuppliers` exige permiso `products:view`. |
| `nj/lib/products/pricing.ts` | `HIDDEN_CATEGORY_PRICING_DEFAULT` (0/0) para quien no ve costos. |
| `nj/app/admin/products/new/page.tsx`, `[id]/page.tsx` | Solo super_admin pide defaults de precio; el resto recibe 0/0 (el servidor ya ignoraba campos de costo de no super_admin en `sanitizeSensitiveFields`, así que lo guardado no cambia). |
| `nj/lib/products/public-cost-exposure.test.ts` | 9 tests (ver abajo). |

El precio del producto fuera del snapshot sale solo de `product_variants.price` por color. Nunca de costos.

Tests (`npx tsx --test`):

- Nuevos: 9/9 OK. Contra el código anterior fallan 7 (exposición) y pasan 2 (equivalencia de precio, válidos en ambos).
- Suite NJ completa: 198/198.
- `tsc --noEmit`: OK.
- `next build`: OK.
- Bundle de navegador (`.next/static`): sin `cost, price_percentage` ni `category_pricing_defaults`.
- ESLint no está instalado en `nj` (script `next lint` sin config local).

Qué cubren los tests:

- selects públicos sin columnas de costo;
- stub/búsqueda/PDP con fila que trae costos → `Precio ""` y precio de variante;
- variante sin precio no muestra el derivado del costo;
- equivalencia de precio visible (card y PDP) con precio de variante válido;
- escaneo de fuentes NJ fuera del admin de productos;
- guardas de las Server Actions.

**Compatibilidad de precios (producción, solo lectura, 2026-10-09):** alcance del fallback = 1666 productos (154 activos en búsqueda). 3603 colores visibles:

- 3597 con precio de variante válido: precio idéntico (el color manda).
- 6 con precio 0: sus productos no tienen costo, el fallback ya era `""`. Idéntico.
- 0 con precio NULL.

**Diferencias: 0.**

**0b–0d. SQL — PREPARADO, no aplicado:** `supabase/canonical/379_arq05_fase0_public_cost_exposure.sql` + `379_ROLLBACK_...` + `379_..._tests.sql` (parte A línea base como anon/cliente, parte B 14 bloques; siempre termina en `RAISE EXCEPTION` para rollback). Sintaxis SQL y PL/pgSQL validada con el parser de Postgres (`libpg-query`); la validación semántica requiere el ensayo.

- 0b `products`: anon pasa a `SELECT` por columna, sin `cost`, `cost_is_estimated`, `price_percentage`, `logistic_amount`. **Conserva `supplier_id`** (lo exige `catalog_public_view`; no agrega información porque `SupplierCode` ya es público).
- 0c `category_pricing_defaults`: `REVOKE ALL` a anon; se elimina `authenticated_select_pricing_defaults`. Lectura solo por `super_admin_write_pricing_defaults` (ALL, super_admin). Decisión: costos solo super_admin.
- 0d `suppliers`: anon `REVOKE ALL` + `GRANT SELECT (id, code)` en todas las filas; oculta `name`, `description`, `created_at`, `updated_at`. Riesgo residual aceptado: 10 de 51 codes son subcadenas del nombre del proveedor; no se puede quitar sin cambiar el formato de SKU.
- ACL previo (para rollback exacto): `products` anon=`rxtm`; `suppliers` y `category_pricing_defaults` anon=`arwdDxtm`.
- Clientes con sesión siguen leyendo costos y nombres de proveedor hasta la Fase 1 (rol compartido con admins; `catalog_public_view` invoker necesita `suppliers.code` para ellos).

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
   - `offers.js`: costo por RPC, solo super_admin (decisión 2026-10-09: no existe un permiso de costos; tener acceso a ofertas no habilita ver ni modificar costos).
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
- La tabla `admins` es legible por cualquier cliente con sesión.
- `get_meta_feed` (invoker) es ejecutable por `anon`; hoy solo la llama `service_role`.
- Permisos del rol `authenticated` sobre tablas operativas.

## 3. Decisiones (2026-10-09)

1. **Costos:** solo super_admin. No existe una clave de permiso de costos (claves actuales: closed-orders, customers, daily-sales, export, fyl-products, import, labels, move-stock, orders, products, public-sales, publications, quick-actions, search, statistics, stock). **NEGOCIO CONFIRMADO.**
2. **Proveedores:** el público no ve nombres, descripciones ni datos comerciales internos; solo `id` y `code` (necesarios para `SupplierCode`/banner FyL Originals). Los codes ya eran públicos por SKU. **NEGOCIO CONFIRMADO.**
3. **Sin fallback de costos:** nunca se usa el costo para mostrar un precio público ni se inventan precios. **NEGOCIO CONFIRMADO.**

## 4. Productos sin precio de variante

| Producto | id | Estado | Categoría | Alta |
|---|---|---|---|---|
| ASD | `ab5c4fba-a883-41b2-9fd9-91f38e5851af` | pending_stock | Calzado | 2026-01-06 |
| BELEN(GUMMI) | `acd650fc-8b7f-4cc6-8e02-4346b42c9cea` | pending_stock | Calzado | 2026-02-20 |

Causa: no tienen ninguna variante (0 filas en `product_variants`), por eso no hay precio de venta; tampoco están en el snapshot. Con o sin el cambio, el PDP devuelve `null` (sin colores) y la búsqueda ampliada solo cubre `active`. Hoy no se muestran en ningún lado.

Propuesta, sin tocar estado ni visibilidad: revisión manual en el admin. Se les cargan variantes con precio cuando haya mercadería, o se archivan si son altas de prueba ("ASD" lo parece). Cualquier cambio lo decide y ejecuta el negocio.

## 5. Despliegue y rollback de la Fase 0 (requiere autorización en cada paso)

1. **Revisión** del diff de la rama `hotfix/arq-05-exposicion-costos` (sin push hasta autorizar).
2. **NJ** por el procedimiento controlado:
   - registrar el deployment de producción actual (para rollback);
   - `vercel deploy --prod --skip-domain` → smoke sobre la URL del deploy:
     - búsqueda con término de producto fuera del snapshot;
     - PDP fuera del snapshot (pending_stock con variantes);
     - card y PDP de productos con oferta;
     - `/admin/products/new` y `/admin/products/[id]` como super_admin (ve y guarda costo) y como admin no super_admin (sin costo, guarda sin error);
   - `vercel promote` → `vercel alias set <deploy> www.fylmoda.com.ar` → volver a fijar `nj-gonzidel`.
   - Merge a `nj-main` solo con autorización.
3. **Verificación 0a:** logs de API durante ~1 h sin `cost`/`price_percentage` en `/rest/v1/products` desde `www.fylmoda.com.ar` ni desde el SSR de NJ. Excepción esperada: el admin legacy autenticado.
4. **Ensayo 379** en una transacción con `ROLLBACK` forzado: parte A → cuerpo 379 → parte B; `lock_timeout`/`statement_timeout`; verificar que nada quedó.
5. **Aplicar 379** (autorización aparte). Verificación:
   - sondas anon (`select=cost` → error 42501/401; `select=id,name` → mismos conteos);
   - `has_column_privilege`;
   - smoke del catálogo vanilla (`catalog_public_view`, banner FyL Originals) y del NJ.
6. **Rollback:**
   - código: `vercel promote`/`alias set` al deployment registrado en el paso 2;
   - SQL: `379_ROLLBACK_arq05_fase0_public_cost_exposure.sql`, que restaura los ACL y la política exactos. Reabre la exposición, así que se usa solo si se rompe el catálogo.
   - Los dos rollbacks son independientes: el código nuevo funciona con o sin 379.

### Ensayo 379 (2026-10-09 ~21:55 ART, autorizado, TÉCNICA VERIFICADA)

- Una sola sentencia `DO` con `statement_timeout` 120 s y `lock_timeout` 5 s, generada desde los archivos del commit: parte A → 6 sentencias de 379 (sin `BEGIN`/`COMMIT`/`NOTIFY`) → bloque de compatibilidad → parte B.
- El bloque de compatibilidad repite, como anon, cliente, admin no super_admin y super_admin, las columnas exactas que piden NJ y vanilla.
- Resultado: `379 TEST OK (14 bloques)`, con rollback forzado.
- Huella de ACL y políticas antes/después idéntica (`daef16f1…`). `statement_timeout` de vuelta en 2 min y sin GUC residuales.
- Primer intento abortado (también revertido): `find_similar_products` y `compute_similarity` fallan **antes** de 379. Su `proconfig` tiene `search_path="pg_catalog, public"` citado como un único esquema, así que da `undefined_table`. El vanilla (`product-alternatives.js`) ya usa el fallback. T12 ahora solo cuenta errores de permiso. Falla previa, fuera de alcance.

### Candidato de deploy

- `www` corre `dpl_E9RU991aMhJ5bLFReej7X9aXFcgU` (`nj-8lw98awgc-gonzidel.vercel.app`, rama `release/nj-2026-10-09-promos`), con código que **no** está en `nj-main` (Espera, confirmación manual, promos 2x en Retiro).
- Deployar el hotfix solo (base `f004cd2`) revertiría esas funciones.
- Candidato: rama local `release/nj-2026-10-09-arq05` (worktree `E:\PROYECTOS\fyl-release-arq05`) = `release/nj-2026-10-09-promos` + merge del hotfix.
- `nj/` difiere de lo publicado solo en los 7 archivos del hotfix.
- tsc OK, 213/213 tests, `next build` OK. Los avisos de autoprefixer en `conciliacion.module.css` ya existían.

Orden obligatorio: el paso 5 nunca antes del 2. Con el NJ viejo, la búsqueda y el PDP piden `cost`, y con 379 aplicada recibirían error de permiso.
