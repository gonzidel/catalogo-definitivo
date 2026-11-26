# 15 — Producción NJ: qué está publicado y qué no se puede pisar

**Para qué sirve:** es el registro vivo de lo que corre en `www.fylmoda.com.ar`. Todo agente lo lee **antes** de publicar y lo actualiza **en el mismo turno** en que publica. La regla que lo exige es `.cursor/rules/FYL-NJ-Deploy-No-Pisar.mdc`.
**Por qué existe:** el 2026-11-24 y el 2026-11-26 se publicaron deploys construidos sobre `nj-main` pelado y borraron funcionalidades ya publicadas. Auditoría: `FYL-Obsidian/77-AUDITORIA-DEPLOYS-QUE-SE-PISAN-2026-11-26.md`.
**Clasificación:** TÉCNICA VERIFICADA el 2026-11-26 (git + HTML en vivo). Lo marcado *no verificado* no se comprobó.

## Estado en vivo (2026-11-26, verificado con `curl` y `npm run smoke:prod-nj` contra `www`)

| Dato | Valor |
|---|---|
| Deploy en `www` | `dpl_2mNmEWzqcfuBaYGBeDSkUCVYzNtu` (`nj-pqz9ff60q-gonzidel.vercel.app`), publicado el 2026-11-26 con `--skip-domain` → smoke → `vercel promote`. Rama `release/nj-integrada-2026-11-26`, commit `3a71e8c`. |
| `www` tras `promote` | Cambió solo, sin `alias set` (cierra la duda de ARQ-11: con el dominio en el proyecto `nj` alcanza `promote`). |
| Rollback | Promover `dpl_2vRDc7pmuKsw2rbyyLB3BMLUP7VF` (el que estaba antes en `www`; le faltan mínimo 1, Meta, buscador, etc.). Para volver a lo último completo: `dpl_D5ysbksXF9AY5xtW49c9fG9U3W4e` (2026-11-20). |
| Banner de ofertas | Presente |
| Banner de promo | Presente, etiqueta `PROMO` (ya no dice Cyber Monday) |
| Mínimo 1 producto | Vigente |
| `/catalogo?sku=X` → `/producto/X` | Vigente |
| `nj-gonzidel.vercel.app` | **No se movió**: sigue en `dpl_FpAget3noduG2WFDgtQtufGCMHTg` (2026-11-10). Fijarlo en el deploy actual requiere `vercel alias set` con autorización. |

## Funcionalidades que cualquier deploy debe conservar

`nj-main` (`837cc44`) **no contiene** casi nada de esta tabla: se publicó desde ramas laterales y nunca se mergeó. Partir de `nj-main` y publicar = borrarlas.

| # | Funcionalidad | Commits clave | Rama de origen | Marcador en el smoke |
|---|---|---|---|---|
| 1 | Mínimo 1 + Cyber Monday + recomendados fijos (flags `TEMP_*` en `nj/lib/config/temp-order-min.ts`) | `9ed65a5` | `feat/minimo-temporal-1` | Sí (2 marcadores) |
| 2 | Links de Meta `/catalogo?sku=X` → ficha | `f36e27d` | `feat/banner-ofertas-inicio` | Sí |
| 3 | Banner de ofertas arriba del inicio (+ SQL `383_home_feature_flags`) | `374e725`, `62421d3`, `9f1e50e` | `feat/banner-ofertas-inicio` | Sí |
| 4 | Buscador premium v2, aviso de buscador nuevo, perfiles IA | `b1e4133` … `101d74e` | `feat/nj-buscador-premium` | No |
| 5 | Teléfono sin recortar dígitos ni prefijo visible | `cfdb6c9` | `release/nj-telefono-2026-11-16` | No |
| 6 | Eliminar a los 5 días pedidos sin stock (SQL 411/411b) + aviso en Mi pedido | `16e44f8` | `release/nj-sin-stock-2026-11-20` | No |
| 7 | Aviso de WhatsApp bajo el total del pedido abierto | `996a46a` | `feat/aviso-whatsapp-sobre-prod` | No |
| 8 | Banner curado en una fila en escritorio | `cea31ed` | `feat/banner-curado-sobre-prod` | No |
| 9 | TV local (pantalla + admin; SQL `383_tv_local_settings`) | `803d079` … `89ce501` | `feat/tv-local` | No |
| 10 | Admin de ofertas: imagen de campaña validada (`admin/offers.*`, Firebase) | en `fix/home-banners-especiales` | `fix/home-banners-especiales` | No |

Cada vez que una funcionalidad llega a producción: agregar fila acá **y** su marcador en `test/smoke-prod-nj-markers.mjs`.

## Rama que reúne todo

`release/nj-integrada-2026-11-26` (worktree `E:\PROYECTOS\fyl-release-integrada-2026-11-26`) = `nj-main` + filas 1–10. `tsc` limpio, 259/259 tests (`npx tsx --test`) y `next build` OK con env de prueba. **Publicada (2026-11-26) y mergeada a `nj-main`** con autorización del usuario: desde ahora `nj-main` contiene todo lo de la tabla y es base segura.

## Antes de publicar (resumen; el detalle está en la regla)

```
git fetch origin
git merge-base --is-ancestor <commit_en_produccion> HEAD     # debe dar exit 0
git log --oneline HEAD..<commit_en_produccion>               # debe estar vacío
vercel deploy --prod --skip-domain                           # NO promueve
npm run smoke:prod-nj -- <url del deploy>                    # todos los marcadores OK
vercel promote                                               # solo con autorización
npm run smoke:prod-nj                                        # contra www
```

## Deuda abierta

- **SQL con número repetido:** `383_home_feature_flags.sql` y `383_tv_local_settings.sql` comparten número. Revisar orden/aplicación antes de tocar `supabase/canonical`.
- **Estado en producción de las migraciones 383 (ambas) y 411/411b:** *no verificado*. Ver `docs/12_PENDIENTES.md` ARQ-02.
- **Flags temporales:** el banner dice `PROMO` (sin fecha de fin). Cuando termine la promo hay que poner `TEMP_MIN_ONE_ENABLED`, `TEMP_CYBER_BANNER` y los demás en `false` y actualizar los marcadores del smoke.
