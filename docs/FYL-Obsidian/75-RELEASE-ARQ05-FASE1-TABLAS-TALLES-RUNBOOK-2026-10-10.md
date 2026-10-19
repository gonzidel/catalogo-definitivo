# 75 - Publicación integrada: ARQ-05 Fase 1 + tablas de talles (runbook, 2026-10-10)

**Estado:** preparado y ensayado. **Nada aplicado ni publicado.** Cada paso de publicación requiere autorización explícita.
Contexto: nota 73 (ARQ-05, §6 Fase 1) y nota 74 (tablas de talles).

## Candidato

- **Candidato vigente (2026-10-19):** rama local `release/arq05-fase1-tablas-talles-prod`, worktree `E:\PROYECTOS\fyl-release-integrada-prod`, commit `8231529`.
  - Base = producción actual `79fd269` (`www` = `dpl_76DFu3UyXZCVX9eRMByr4BFFPVYr` / `nj-rely8826z`): incluye chips de tags sin productos comprables y priorización de Apartados (`c7f1b5f`).
  - Merge sin conflictos de `e8ca781` (Fase 1 + tablas de talles). SQL 378/380/381 con los mismos SHA-256 ensayados.
- Rama anterior `release/arq05-fase1-tablas-talles` (`e8ca781`, worktree `fyl-release-integrada`): quedó atrás de `www` y **no** debe publicarse.
  - `9f6b629` / `2042776`: Fase 1 costos por RPC.
  - `deccfe4`: tablas de talles; `PRODUCT_ADMIN_COLUMNS` incluye `size_chart_id`; costos solo por `saveProductPricing`.
- **NJ:** respecto de `www` actual (`79fd269`), cambian solo los 4 archivos de la Fase 1: `nj/app/admin/products/[id]/page.tsx`, `ProductGeneralForm.tsx`, `nj/lib/products/actions.ts` y su test. NJ no usa `size_chart_id`.
- **Firebase (admin legacy):** directorio de deploy armado aparte, `E:\PROYECTOS\fyl-firebase-staging-2026-10-10` (manifiesto `….manifest.json`).
  - 760 archivos: 744 idénticos byte a byte a lo publicado, 4 rutas que hoy redirigen (sus archivos salen de `af349fb`, el commit del deploy vivo), `config.prod.js` y `scripts/config.local.js` bajados del sitio vivo, y los 12 archivos del admin integrado, idénticos al candidato.
  - `firebase.json` sin `predeploy`: no se regenera nada.
  - Motivo: `npm run deploy:firebase` publica el árbol completo del repo y pisaría lo que hoy está publicado y no está en la rama: 8 landings y `client/transportes-data.js` publicados con versiones distintas, y `nj/**`, que también se sube.
- **Rollback de Firebase preparado:** `E:\PROYECTOS\fyl-firebase-rollback-2026-10-10`. Son 754 archivos: 750 idénticos byte a byte a lo publicado hoy más las 4 rutas redirigidas, es decir, la copia exacta del sitio vivo.
- El JS del admin se sirve con `Cache-Control: no-cache, no-store` (verificado en vivo): basta recargar para tomar el código nuevo.

## Verificaciones hechas

- Raíz: `node --test test/*.test.mjs` 17/17. `node --check` de todo el JS del admin OK.
- NJ: `npx tsx --test` 215/215, `tsc --noEmit` 0 errores, `next build` OK.
- Firebase: el staging difiere de lo publicado solo en los 12 archivos previstos (verificación repetida antes de cerrar). La copia de rollback no tiene ninguna diferencia.
- **Ensayo en producción (2026-10-10, autorizado, TÉCNICA VERIFICADA).** Una sola sentencia `DO` con `statement_timeout` 180 s y `lock_timeout` 3 s, generada desde los archivos del commit. Secuencia: parte A de 381 (línea base) → cuerpo de 378 → pruebas 378 (bloque A) → cuerpo de 380 → cuerpo de 381 → pruebas 381 (parte B) → chequeo estructural 378 (bloque B) → `381_378_integracion_tests.sql`. Termina con `RAISE EXCEPTION`, así que se revierte todo. Resultados:
  - `378 TEST OK (18 bloques)`;
  - `381 TEST OK (11 bloques)`, con 378 ya aplicada (incluye `size_chart_id` en la lista exacta de columnas);
  - chequeo estructural 378: 14/14 true;
  - `INTEG TEST OK (11 bloques)`.
- **Huella antes y después del ensayo, idéntica:**
  - `products`: 2355 filas, md5 de costo/updated_at/nombre `69df9c58…`;
  - `orders`: 7592, md5 `349858b2…`; `order_items`: 76293;
  - stock `eab3e173…`, ofertas `cbdea44e…`;
  - sin `size_charts`, sin columna `size_chart_id` y sin RPC de costos;
  - ACL de `products` igual y 92 privilegios de columna de `authenticated`;
  - 0 productos de prueba.
- **Lo que cubre la integración** (colaborador con `products:edit`, super_admin, cliente y anon; los pedidos solo se leen):
  - I1: el colaborador lee las 20 columnas de `PRODUCT_ADMIN_COLUMNS`, incluida `size_chart_id`;
  - I2: crear una tabla completa, crear un borrador y duplicar (copia con las filas leídas);
  - I3: asignar la tabla a un producto existente y crear un producto con tabla, con el payload del admin y sin costos;
  - I4: un borrador no se puede asignar;
  - I5: una tabla en uso no puede quedar incompleta, pero sí se puede editar completa (la versión avanza);
  - I6: al archivar, la asignación se conserva y se bloquean asignaciones nuevas;
  - I7: el listado informa el uso; se borra una copia sin uso y no se puede borrar una tabla en uso;
  - I8: el cliente no accede a las RPC ni a las tablas de talles;
  - I9: super_admin da de alta sin costo y luego guarda el costo por RPC;
  - I10: el colaborador no lee costos por RPC;
  - I11: con 378, 380 y 381 aplicadas, anon y cliente siguen leyendo la versión del catálogo, `catalog_public_view`, stock vendible, precio efectivo y reservas; el cliente lee sus pedidos y el colaborador lee pedidos con ítems, stock, ofertas activas y variantes con producto.
- Lecturas previas en producción: ninguna vista ni función `SECURITY INVOKER` lee columnas de costo de `products` ni filas completas (`%ROWTYPE`, `SELECT *`, `to_jsonb(p)`). La 381 no rompe esas rutas.

## Orden de publicación

Dependencias:
- **378 antes del admin:** el admin nuevo pide `size_chart_id` y sin 378 no carga productos.
- **380 antes de NJ y del admin:** los dos llaman a las RPC de costos.
- **381 solo después de los dos deploys y del smoke:** el código viejo hace `select("*")` y escribe costos directo.

Con 378 y 380 aplicadas y sin 381, tanto el código viejo como el nuevo funcionan.

0. **Chequeos previos** (solo lectura):
   - repetir la huella del ensayo;
   - `git -C E:\PROYECTOS\fyl-release-integrada status` limpio. SHA-256 de los archivos ensayados: 378 `C36D194234B9…`, 380 `8D143FAF123D…`, 381 `26B0567C75E3…`;
   - repetir la verificación staging contra el sitio vivo (`verify-staging.mjs`), que debe dar solo los 12 archivos previstos;
   - registrar a qué deploy apunta `www` (2026-10-19: `dpl_76DFu3UyXZCVX9eRMByr4BFFPVYr` / `nj-rely8826z`) y a cuál `nj-gonzidel` (`dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP`).
1. **Aplicar 378** (`378_size_charts.sql` tal cual). Toma un lock breve de `products` por el `ADD COLUMN`.
   - Verificar: bloque B de `378_size_charts_tests.sql` todo true. El admin publicado sigue funcionando: su `select("*")` recibe una columna más y la ignora.
   - Rollback: `378_ROLLBACK_size_charts.sql`. **Solo mientras ningún admin publicado pida `size_chart_id`.** Borra las tablas cargadas.
2. **Aplicar 380** (`380_arq05_fase1_admin_pricing_rpcs.sql`). Es aditiva.
   - Verificar: las dos funciones existen; `has_function_privilege` da anon false y authenticated true.
   - Rollback: `380_ROLLBACK_…`, solo con 381 revertida y el código viejo publicado.
3. **Publicar NJ** desde `E:\PROYECTOS\fyl-release-integrada`, que ya tiene `.vercel` vinculado al proyecto `nj`:
   - `vercel deploy --prod --skip-domain`;
   - volver a fijar `nj-gonzidel` en `dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP`, porque el deploy de producción lo mueve;
   - smoke sobre la URL del deploy: catálogo, búsqueda, PDP, ofertas; `/admin/products/[id]` como super_admin (ve y guarda costo) y como colaborador (sin costo, guarda);
   - `vercel promote <url>` → `vercel alias set <url> www.fylmoda.com.ar` → volver a fijar `nj-gonzidel`.
   - Rollback: `vercel alias set nj-rely8826z-gonzidel.vercel.app www.fylmoda.com.ar` + `vercel promote dpl_76DFu3UyXZCVX9eRMByr4BFFPVYr` + volver a fijar `nj-gonzidel`. Exige 381 revertida o todavía no aplicada.
4. **Publicar el admin legacy:** `cd E:\PROYECTOS\fyl-firebase-staging-2026-10-10` y `firebase deploy --only hosting` (proyecto `catalogo-fyl-test`).
   - Smoke:
     - productos: abrir, editar y guardar como colaborador; editar el costo como super_admin;
     - tablas de talles: crear, asignar, archivar y comprobar que el producto la conserva;
     - además: ofertas, importación, ventas al público.
   - Pedir a los admins que recarguen las pestañas abiertas.
   - Rollback: en la consola de Firebase, Hosting → historial de versiones → "Rollback" a la versión anterior. Alternativa: `firebase deploy --only hosting` desde `E:\PROYECTOS\fyl-firebase-rollback-2026-10-10`. Exige 381 revertida o todavía no aplicada.
5. **Aplicar 381** (`381_arq05_fase1_products_column_grants.sql`).
   - Verificar:
     - `has_column_privilege('authenticated','public.products',<costo>,'SELECT'|'INSERT'|'UPDATE')` da false;
     - `size_chart_id` y las 19 columnas públicas dan true;
     - `381_378_integracion_tests.sql` debe dar `INTEG TEST OK`; se revierte solo y se puede correr después de aplicar;
     - smoke del admin (legacy y NJ) y del catálogo;
     - logs de API sin 401/403 nuevos de admins.
   - Rollback: `381_ROLLBACK_…` (`GRANT SELECT, INSERT, UPDATE ON products TO authenticated`). Es inmediato y el código nuevo sigue funcionando.

**Orden de reversión:** 381 → código (NJ y/o Firebase) → 380 → 378. 378 solo se revierte con el admin viejo ya publicado.

## Riesgos pendientes

- Las pestañas del admin abiertas antes del deploy de Firebase y no recargadas fallan al cargar o guardar productos una vez aplicada 381. Se resuelve recargando.
- Quedan fuera de esta publicación: las 8 landings, `client/transportes-data.js` (fix `8ebb768`) y los cambios de `admin/control.html` sin commitear en el worktree principal. Siguen como están publicados.
- Firebase sigue publicando las fuentes `nj/**`. Ya pasaba antes; no lo cambia este deploy.
- Fuera del alcance de la Fase 1 (decisión pendiente, nota 73):
  - los clientes con sesión leen `suppliers.name`;
  - las RPC de estadísticas devuelven métricas derivadas del costo a cualquier admin;
  - `admins` es legible por clientes.
- El push a `nj-main` del 2026-10-10 pudo generar un Preview de `catalogo-definitivo`. No afecta producción.
