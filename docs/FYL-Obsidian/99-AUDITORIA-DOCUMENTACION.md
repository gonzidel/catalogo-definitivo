# 99 - Auditoria de la documentacion

Fecha base: abril 2026.

Objetivo: contrastar la boveda `docs/FYL-Obsidian/` con codigo, HTML y SQL del repo, y luego alinear los mapas generales con las auditorias modulares.

## Actualizacion 2026-04-24

Se realizaron auditorias modulares y se vincularon con el resto de Obsidian:


| Modulo                 | Nota                                    |
| ---------------------- | --------------------------------------- |
| Products               | [[14-AUDITORIA-MODULO-PRODUCTS]]        |
| Stock                  | [[16-AUDITORIA-MODULO-STOCK]]           |
| Orders                 | [[17-AUDITORIA-MODULO-ORDERS]]          |
| Public Sales           | [[18-AUDITORIA-MODULO-PUBLIC-SALES]]    |
| Cliente/Carrito        | [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] |
| Observaciones cruzadas | [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]] |


El usuario aclaro que los SQL analizados ya estan cargados y activos en Supabase. Por eso, desde esta actualizacion, los riesgos de "versionado" se interpretan como riesgos de trazabilidad/mantenimiento, no como afirmacion de que la base desplegada este desactualizada.

## Correcciones aplicadas a la boveda


| Archivo                                 | Correccion                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| [[00-INICIO]]                           | Agregado indice de auditorias modulares 14-19.                                               |
| [[03-MAPA-DE-RPCS]]                     | Corregido flujo real de carrito y agregada seccion Public Sales.                             |
| [[05-FLUJO-PEDIDOS]]                    | Alineado con checkout real `rpc_checkout_cart(uuid,jsonb)` y ruta legacy `client/cart.html`. |
| [[06-FLUJO-CATALOGO]]                   | Alineado con `scripts/cart-persistent.js` como flujo vivo y rutas alternativas de carrito.   |
| [[09-TABLAS-COLUMNAS-DUDOSAS-O-LEGACY]] | Reclasificados scripts/RPCs legacy de carrito.                                               |
| [[12-CHECKLIST-CAMBIOS-FUTUROS]]        | Agregada checklist por modulo auditado.                                                      |
| [[13-RPCS-DEPLOY-STATE]]                | Ajustado a "activo segun aclaracion" + verificacion tecnica pendiente.                       |


## Riesgos documentales que quedan


| Riesgo                                                 | Estado                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Multiples definiciones SQL historicas de RPCs criticas | Documentado; requiere mantener [[13-RPCS-DEPLOY-STATE]].                                                    |
| Grants reales de funciones `SECURITY DEFINER`          | Pendiente de consulta en Supabase.                                                                          |
| RLS/policies reales por tabla                          | Pendiente de consulta en Supabase para cierre total.                                                        |
| `price_snapshot` en carrito                            | Observado como riesgo en [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] y [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]. |
| `client/cart.html` divergente                          | Observado como ruta a revisar.                                                                              |
| Public Sales con RPCs auxiliares y local orders        | Observado en [[18-AUDITORIA-MODULO-PUBLIC-SALES]].                                                          |


## Confianza por area


| Area             | Confianza documental                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| Products         | Alta respecto al repo; revisar DB para RLS/triggers/grants exactos.      |
| Stock            | Alta respecto al repo; alta criticidad operativa.                        |
| Orders           | Alta respecto al repo; algunos bordes de negocio requieren pruebas.      |
| Public Sales     | Media/Alta respecto al repo; revisar grants/RLS por exposicion de datos. |
| Cliente/Carrito  | Alta respecto al repo; riesgo abierto en precio/ruta legacy.             |
| RPC deploy state | Media: activo segun aclaracion del usuario, pero falta dump tecnico.     |


## Regla final

Cuando se modifique codigo o SQL:

1. Actualizar la auditoria modular afectada.
2. Actualizar [[03-MAPA-DE-RPCS]] si cambia una llamada o firma.
3. Actualizar [[13-RPCS-DEPLOY-STATE]] si cambia SQL desplegado.
4. Registrar observaciones cruzadas en [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]].

## Enlaces

- [[00-INICIO]]
- [[12-CHECKLIST-CAMBIOS-FUTUROS]]
- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]

