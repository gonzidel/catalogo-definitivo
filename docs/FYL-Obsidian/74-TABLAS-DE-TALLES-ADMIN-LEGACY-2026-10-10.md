# 74 - Tablas de talles en el admin legacy (2026-10-10)

Estado: **CERRADA (admin legacy, 2026-10-19)** — 378 aplicada; gestión/asignación publicada en Firebase junto con ARQ-05 Fase 1. Catálogo público / PDP NJ siguen fuera de alcance (deuda de la nota). Runbook/rollbacks: nota 75.

## Qué es (y qué no es)

**NEGOCIO CONFIRMADO** (auditoría 378): una tabla de talles es una **guía de medidas orientativa** reutilizable que se asigna a productos, principalmente calzado.

- No es stock ni talle comercial: no cambia `product_variants`, `variant_sizes`, stock por depósito, reservas, pedidos, checkout ni el catálogo público.
- Un producto tiene como máximo una tabla (`products.size_chart_id`).
- Medida: `largo_plantilla` (largo de plantilla interna) o `largo_pie` (largo del pie recomendado), en cm, entre 5 y 40, con hasta 2 decimales.
- Una tabla es **completa** cuando tiene al menos una fila y todas tienen medida. Las incompletas son borradores.
- Solo se puede **asignar** una tabla completa y no archivada. Una tabla asignada no puede quedar incompleta.
- Archivar conserva las asignaciones existentes. Eliminar solo es posible si ningún producto (incluidos archivados) la usa.

El catálogo público todavía **no muestra** las tablas: queda para una fase posterior.

## Backend (378, sin cambios)

- `supabase/canonical/378_size_charts.sql`, `378_ROLLBACK_size_charts.sql`, `378_size_charts_tests.sql`.
- Tablas `size_charts` / `size_chart_rows` sin grants para `anon` ni `authenticated`: todo pasa por RPC `SECURITY DEFINER` que exige `has_permission(auth.uid(), 'products', view|edit|delete)`.
- RPCs usadas por el admin:
  - `rpc_admin_size_charts_overview()`
  - `rpc_admin_get_size_chart(p_id)`
  - `rpc_admin_save_size_chart(p_id, p_expected_version, p_name, p_measure_type, p_notes, p_rows)`
  - `rpc_admin_set_size_chart_archived(p_id, p_expected_version, p_archived)`
  - `rpc_admin_delete_size_chart(p_id, p_expected_version)`
- Concurrencia optimista por `version`. Errores con prefijo `SIZE_CHART_<CÓDIGO>:`.
- El trigger `fn_products_size_chart_guard` valida la asignación solo cuando `size_chart_id` cambia.

## Admin legacy (rama `feat/tablas-de-talles`)

| Archivo | Rol |
|---|---|
| `admin/size-charts-core.js` | Lógica pura: normalización de talles, parseo de cm (acepta coma o punto), generador de rangos simples/dobles, validación del formulario, estado y mensajes de error. |
| `admin/size-charts-shared.js` | Wrappers de las 5 RPC y el modal editor (`openSizeChartEditor`), compartido por la página de gestión y el formulario de producto. |
| `admin/size-charts.html` + `admin/size-charts.js` | Página de gestión: filtro Activas/Archivadas, nueva, editar, duplicar, archivar/reactivar, eliminar (permiso `delete`, solo sin productos). En pantallas de menos de 640 px la tabla pasa a tarjetas. |
| `admin/product-size-chart.js` | Selector "Tabla de talles" en `admin/products.html`. |
| `admin/index.html` | Tarjeta "Tablas de talles" (`data-module="products"`). |

Comportamiento del editor:

- Generador de rango (ej. 35–40 o 35/36–39/40). Solo agrega los talles que faltan, sin medida.
- Al guardar se avisa cuántas medidas faltan; si quedan vacías, la tabla se guarda como borrador.
- Si la tabla ya está asignada y cambian talles, medidas o tipo, se pide confirmar: **Aplicar al/los N producto(s)**, **Duplicar y editar la copia** o **Cancelar**.
- Si otra persona la modificó (conflicto de `version`), se ofrece **Recargar tabla**.
- Cerrar con cambios sin guardar pide confirmación.

Comportamiento en el formulario de producto:

- El campo es visible en categoría Calzado o cuando el producto ya tiene tabla.
- Opciones: "Sin tabla", las completas, las incompletas deshabilitadas "(incompleta)". La archivada aparece solo si es la actual, deshabilitada "(archivada)": el producto la conserva al guardar.
- Desde el formulario se puede crear, editar o duplicar una tabla sin salir del producto.
- **Si las RPC fallan (por ejemplo, 378 todavía no aplicada)**: el selector queda deshabilitado con "Reintentar" y el payload **no incluye** `size_chart_id`. El guardado del producto sigue funcionando y no toca la asignación.
- "Clonar como borrador" conserva la tabla solo si sigue siendo asignable; si no, lo avisa.
- Los errores del trigger se muestran con el prefijo "Tabla de talles:".

## Verificación (2026-10-10)

- `node --test test/*.test.mjs`: 17/17. Incluye `test/size-charts-core.test.mjs` (lógica pura) y `test/size-charts-admin-integration.test.mjs`. Este último comprueba:
  - que las llamadas usen los nombres de parámetros de la 378;
  - que no haya acceso directo a `size_charts`;
  - que el payload esté condicionado a la carga;
  - el cableado en `products.js` y el HTML.
- Prueba manual en el navegador con un Supabase falso en memoria. El harness es temporal y no está versionado. Se verificó:
  - página de gestión y editor: validaciones, borrador, rango 5–40 y decimales, conflicto de versión con recarga, confirmación de tabla en uso, duplicar la copia, vista en 390 px;
  - formulario de producto: tabla asignada, tabla archivada conservada al guardar, Ropa sin tabla con el campo oculto, cambio de tabla persistido, producto nuevo con tabla, falla de las RPC sin enviar `size_chart_id`.
- Las validaciones del navegador replican las de la 378, pero la autoridad sigue siendo la DB.

## Publicación (requiere autorización)

> **Actualización 2026-10-10:** integrada con ARQ-05 Fase 1 en `release/arq05-fase1-tablas-talles` (`size_chart_id` ya está en `PRODUCT_ADMIN_COLUMNS`). Ensayo combinado 378 + 380 + 381 en producción OK y revertido. Para publicar se usa `75-RELEASE-ARQ05-FASE1-TABLAS-TALLES-RUNBOOK-2026-10-10.md`. El deploy de Firebase sale de un staging (no de `npm run deploy:firebase`) y los pasos de abajo quedan como referencia.

1. Aplicar `378_size_charts.sql` en producción. Ya está ensayada con rollback; se puede repetir el ensayo justo antes.
2. Publicar el admin legacy en Firebase (`npm run deploy:firebase`). Ese deploy sube todo el árbol vanilla, así que antes hay que confirmar que fuera de `admin/` coincide con lo publicado.
3. Smoke: crear una tabla, asignarla a un producto de calzado, archivarla y comprobar que el producto la conserva.

Si el admin se publica antes que la 378, el selector muestra "todavía no están habilitadas" y el producto se guarda igual.

Rollback: volver a publicar el admin anterior y luego, si hace falta, `378_ROLLBACK_size_charts.sql`. El rollback borra las tablas cargadas y `products.size_chart_id`.

## Acople con ARQ-05 Fase 1 (`fix/arq-05-fase1-costos`)

La Fase 1 reemplaza el `select("*")` de productos por `PRODUCT_ADMIN_COLUMNS` (`admin/product-pricing.js`) y restringe los grants de columnas de `products` (381). Al integrar ambas ramas:

- Agregar `size_chart_id` a `PRODUCT_ADMIN_COLUMNS`. Si no, el selector nunca ve la tabla actual del producto.
- La 378 debe aplicarse antes de publicar un admin que pida `size_chart_id` en el select.
- Si la 381 se aplica antes que la 378, la 378 necesita además `GRANT SELECT, INSERT, UPDATE (size_chart_id) ON public.products TO authenticated` (nunca `anon`). Si la 378 ya está aplicada, la 381 lo cubre.

## Deuda / siguiente fase

- Mostrar la tabla en el catálogo público y en la PDP de NJ (requiere decidir el formato y exponerla vía snapshot o RPC pública).
- Pantalla equivalente en el admin NJ.
- Asignación masiva de tablas a varios productos.
