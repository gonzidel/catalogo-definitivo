# 77 — Auditoría: deploys de NJ que se pisan entre sí — 2026-11-26

**Clasificación:** TÉCNICA VERIFICADA (git + HTML de `www` en vivo el 2026-11-26). No se aplicó SQL ni se publicó nada.
**Relacionado:** [[64-TEMP-MINIMO-1-CYBER-MONDAY-2026-11-03]] (en `feat/minimo-temporal-1`), [[76-BANNER-OFERTAS-INICIO-2026-11-10]], [[76-TV-LOCAL-PANTALLA-2026-11-20]], `docs/15_PRODUCCION_NJ_ACTUAL.md`, regla `.cursor/rules/FYL-NJ-Deploy-No-Pisar.mdc`.

## Síntoma

1. El banner de ofertas desapareció del inicio.
2. La compra mínima volvió de 1 a 4 productos (y desapareció el banner Cyber Monday).
3. Los links de Meta `/catalogo?sku=X` dejaron de ir a la ficha (`/producto/X`).

## Causa raíz

`vercel deploy` sube el árbol completo de la rama y **reemplaza** el build. No suma a lo publicado. Y la base común no tiene lo publicado:

- `origin/nj-main` = `837cc44`. **No contiene** `temp-order-min.ts`, `OfertasBanner.tsx` ni el icono Cyber Monday. Lo publicado entre el 2026-11-03 y el 2026-11-20 vive en `release/nj-sin-stock-2026-11-20` (31 commits sobre `nj-main`), nunca mergeado.
- La regla del repo manda partir de `origin/nj-main`. Quien la cumple al pie de la letra construye sobre una base sin esas funcionalidades.
- Hay ~50 worktrees y decenas de ramas `feat/*`, `release/*`, `*-sobre-prod`; cada agente publica desde la suya.

### Línea de tiempo de deploys de producción (Vercel `nj`)

| Fecha | Deploy | Origen probable | Efecto |
|---|---|---|---|
| 2026-11-20 16:38 | `dpl_D5ysbksX…` | `release/nj-sin-stock-2026-11-20` (todo lo publicado, sin 996a46a ni cea31ed) | Última base casi completa |
| 2026-11-24 13:20–14:07 (5 deploys) | `dpl_45xWEF87…` … `dpl_9C5EzWaL…` | `feat/tv-local` (`nj-main` + TV) | **Borra** mínimo 1, Cyber, ofertas, Meta, buscador v2, teléfono, auto-eliminar sin stock |
| 2026-11-25 21:50 | `dpl_8gXYuLWc…` | `fix/home-banners-especiales` (`2e06866`) | Vuelve a copiar el banner de ofertas; el commit lo dice: "un deploy posterior de nj-main publicó el home sin el carrusel". El resto sigue perdido |
| 2026-11-26 08:47–09:17 (4 deploys) | `dpl_E1s16MxT…` … `dpl_2vRDc7pm…` (hoy en `www`) | mismo worktree, **con cambios sin commitear** | Se publica código que no está en ningún commit |

Los deploys por CLI no guardan commit en Vercel (`meta` vacío): el origen sale de la topología git y de los horarios. Los 5 deploys del 11-24 coinciden minuto a minuto con los 5 commits de TV local (13:20, 13:26, 13:35, 13:55, 14:07) y el del 11-20 16:38 con el commit `16e44f8` (16:35). **Hipótesis fuerte, no prueba.**

El mismo patrón ya ocurrió el 2026-11-18/19: `996a46a` (aviso WhatsApp) y `cea31ed` (banner curado en escritorio) se publicaron desde ramas `*-sobre-prod`, y los deploys siguientes (`release/nj-telefono`, `release/nj-sin-stock`) no los contenían.

### Estado en vivo comprobado

- Inicio de `www`: banner de ofertas **presente**; texto "CYBER MONDAY" **ausente**.
- `/como-comprar`: "Mínimo 4 productos combinables" (debería decir "Podés comprar desde 1 producto").
- `/catalogo?sku=B6180`: `302 → /?sku=B6180` (debería ir a `/producto/B6180`).

## Otro factor: la regla de ramas no llega a los demás agentes

`.cursor/rules/FYL-NJ-Git-Workflow.mdc` estaba **sin trackear** (`??` en git), solo en la carpeta principal. Los worktrees de los otros agentes (`fyl-banners-especiales`, `fyl-tv-local`, `fyl-release-*`) no la tienen, así que esos agentes no veían "deploy requiere autorización" ni "revisar ramas antes de desplegar". Ahora está commiteada en `release/nj-integrada-2026-11-26`, junto con la regla nueva. Hasta que esa rama se mergee, un worktree que no la tenga necesita que se le copie el archivo.

## Qué se hizo

1. Rama `release/nj-integrada-2026-11-26` (worktree `E:\PROYECTOS\fyl-release-integrada-2026-11-26`), desde `origin/nj-main`:
   - merge de `release/nj-sin-stock-2026-11-20` (mínimo 1/Cyber, Meta, ofertas, buscador, teléfono, auto-eliminar sin stock);
   - merge de `fix/home-banners-especiales` (TV local + admin de ofertas con imagen validada). Conflictos solo en comentarios de `page.tsx` y `globals.css` (el banner de ofertas estaba duplicado): se conservó el lado de la cadena publicada;
   - merge de `origin/feat/banner-curado-sobre-prod` (aviso WhatsApp + banner curado en escritorio).
   - **No** se incluyó el trabajo sin commitear de `fyl-banners-especiales` (`nj/app/ofertas`, `offer-campaign.ts`, etc.): es de otro agente y no está en ningún commit.
2. Verificación local: `tsc --noEmit` limpio; `npx tsx --test` 259/259; `next build` OK con env de prueba.
3. `test/smoke-prod-nj-markers.mjs` (`npm run smoke:prod-nj`): contra `www` actual detecta exactamente las 3 pérdidas (Cyber, mínimo 1, redirect Meta) y confirma que ofertas está.
4. Documentación: `docs/15_PRODUCCION_NJ_ACTUAL.md` (registro vivo), regla `FYL-NJ-Deploy-No-Pisar.mdc`, puntero en `AGENTS.md`.

## Resultado (2026-11-26, con autorización del usuario)

1. Etiqueta del banner: `CYBER MONDAY` → `PROMO` (la promo sigue, ya no es Cyber Monday). Mínimo 1 se mantiene. Commit `3a71e8c`.
2. Publicado `dpl_2mNmEWzqcfuBaYGBeDSkUCVYzNtu` con `vercel deploy --prod --skip-domain`; smoke de marcadores 4/4 y rutas clave 200 sobre la URL del deploy; `vercel promote`; `www` cambió solo (sin `alias set`); smoke 4/4 contra `www`.
3. Merge fast-forward de la rama integrada a `nj-main`.

### Pendiente

- `nj-gonzidel.vercel.app` sigue en `dpl_FpAget…` (2026-11-10). Moverlo requiere `vercel alias set` con autorización.
- Agente de `fyl-banners-especiales` (rama `fix/home-banners-especiales`): tiene cambios sin commitear ya publicados antes por deploy desde worktree sucio. Debe commitear y mergear `nj-main` antes de publicar; si publica sin hacerlo, pisa la promo y el resto. Se le dejó la regla y un aviso en su worktree.
- Cuando termine la promo: flags `TEMP_*` en `false` y actualizar el smoke.
- No verificado: `fylcalzados.com.ar` y `www.fylcalzados.com.ar` (el DNS no resolvió desde esta PC).

## Rollback

- Código: promover de nuevo `dpl_2vRDc7pmuKsw2rbyyLB3BMLUP7VF` (el actual en `www`) si la integrada falla en producción.
- La integrada no incluye migraciones nuevas que no estuvieran ya en las ramas publicadas, pero las SQL 383 (dos archivos con el mismo número) y 411/411b **no se verificaron en producción**. Mientras no se confirme, no asumir que están aplicadas (ver ARQ-02).

## Deuda restante

- Dos migraciones `383_*` con el mismo número.
- ~50 worktrees y ramas viejas: limpiar las ya integradas (decisión del usuario).
- Evaluar conectar el proyecto Vercel `nj` a Git con ramas de producción protegidas, o un script único de publicación que ejecute la verificación de ancestro. Hoy el control es solo por regla + smoke.
