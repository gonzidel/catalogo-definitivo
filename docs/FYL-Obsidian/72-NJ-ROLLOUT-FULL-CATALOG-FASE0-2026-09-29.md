# 72 — Rollout `full` / `catalog` en nj — Fase 0 — 2026-09-29

> **Estado:** Fase 0 terminada en rama `feat/nj-rollout-fase0` (worktree `E:\PROYECTOS\fyl-rollout-fase0`, rebaseada sobre `af349fb` = `fix/customer-link-nj-onboarding` con `origin/main` integrado; commit local, sin push).
> **Producción:** migración 362 **aplicada** el 2026-09-29 (ver §Aplicación en producción), modo `paused`. Dominio sin mover, sin deploy productivo de nj (solo preview), sin indexación, sin 301. Plan de Fase 1 preparado, **no ejecutado** (ver § Fase 1).
> Reemplaza los planes de SEO (§H), redirects (§I) y analytics (§M) de [[58-NJ-PRELAUNCH-CUTOVER-2026-09-04]].

## Qué es

nj pasa a ser el único frontend de `www`. catalogo1 no se forkea: se reproduce como **modo `catalog`** dentro de nj (mismas páginas y componentes, variantes por experiencia). Cada visitante recibe `full` (carrito, pedidos, dashboard) o `catalog` (catálogo + WhatsApp, sin carrito).

**NEGOCIO CONFIRMADO (usuario, 2026-09-29):**

- Cupo diario ≈15 personas nuevas en `full` (Fase 2). El cupo se consume al **conceder**; la asignación `full` es persistente.
- El registro/login nunca se bloquea. Login **no** concede `full` ni saltea el cupo (excepciones: staff/admin verificado y `open_all`).
- El grupo previo al rollout (51 cuentas al 2026-09-29: 1 admin / 9 staff / 41 clientas del test) conserva `full` sin consumir cupo. No es “todo `auth.users` al aplicar”: las altas posteriores al corte no reciben seed.
- **`catalog` es una experiencia normal y completa** (productos, categorías, búsqueda/filtros, PDP, WhatsApp, páginas informativas, guías/FAQ del catálogo). No es espera, demo ni versión incompleta: nunca explica rollout, cupos, pruebas ni funciones `full` ausentes.
- `open_all` = desde ese momento todos reciben `full`. `paused` no concede nuevos `full` y conserva los existentes. `kill` fuerza catalog a clientes, conserva grants y deja el acceso operativo de staff/admin.
- Límite aceptado: incógnito/cookies borradas/dispositivo nuevo sin sesión cuentan como visitante nuevo; lo que se garantiza es el tope global de `daily_quota` por día. Sin fingerprinting.
- `/nj` = puerta de testers: concede `full` (`tester_link`) sin cupo y hace 302 a la misma ruta sin prefijo.
- Modos: `paused`, `quota`, `open_all`, `kill`. `kill` no borra nada.
- `/catalogo*` → 302 (no 301 hasta el 100 %).
- Textos al cliente: sin cupos, rollout, cohortes ni A/B.
- `kill`: `/dashboard` cerrado para clientes aunque tengan grant `full`; los grants se conservan. Staff/admin mantiene acceso para operación/diagnóstico.
- `/quienes-somos`: se mantiene la página nj, sin rewrite a Firebase.
- Aviso a cuenta logueada que sigue en catalog (aprobado 2026-09-29, reemplaza al anterior «Por ahora podés…»): «¡Listo, ya ingresaste! 👋 Podés seguir viendo el catálogo y consultarnos por WhatsApp cuando quieras.» Aparece **solo una vez, tras el login** (cookie `fyl_notice` de 120 s).
- Avatar de una cuenta logueada en catalog: tarjeta “Tu cuenta: {nombre o email}” + **Cerrar sesión** (en catalog no hay otra forma de cerrar sesión: el logout vive en `/dashboard`). Sin dashboard nuevo ni menciones a rollout/FULL/cupos.
- Procedimiento de lanzamiento: `paused` → comprobar producción → `quota` = 15. Al activar `quota`, quien quedó en catalog durante `paused` ese mismo día vuelve a ser candidato.

## Base de datos — `supabase/canonical/362_*`

### Aplicación en producción (TÉCNICA VERIFICADA, 2026-09-29)

- Proyecto `dtfznewwvsadkorxwzft`. `apply_migration` con nombre `362_rollout_experience` y versión `20260929231113`. Se envió el archivo del commit `7b06dd9` sin cambios (SHA256 `A0D42BB6…E95226`).
- Chequeos previos: 51 cuentas (1/9/41), 0 altas posteriores al corte, `service_role` con SELECT en `public.admins`, 0 objetos `rollout_*`.
- `_verify` (solo lectura):
  - 3 tablas con RLS activo y 0 policies. Privilegios solo para `postgres` y `service_role`; `service_role` recibe `ALL` por el default ACL del proyecto, igual que en las demás tablas. anon/authenticated no tienen acceso.
  - 5 funciones: EXECUTE solo para `service_role`, sin SECURITY DEFINER, con `search_path=""`.
  - Configuración: 1 fila, `paused`, `daily_quota` 15.
  - 51 grants, todos `seed:362`: `super_admin` → admin 1, `collaborator` → staff 9, tester 41. Ninguno tiene `visitor_id`, vínculo ni revocación.
  - Ninguna cuenta del grupo previo quedó sin grant. Contador diario vacío y 0 grants de cuota.
- `_tests` **no** se ejecutó en producción. El modo no se cambió y no se hicieron llamadas a las RPC.

| Archivo | Contenido |
|---|---|
| `362_rollout_experience.sql` | `rollout_config` (1 fila, default `paused`, cupo 15), `rollout_grants`, `rollout_daily_counter`; RLS sin policies; REVOKE PUBLIC/anon/authenticated; GRANT solo `service_role`; `rpc_rollout_resolve`, `rpc_rollout_link_user`; seed de cuentas |
| `362_ROLLBACK_rollout_experience.sql` | DROP funciones + tablas (backup opcional comentado). Pierde grants quota/tester_link/open_all |
| `362_rollout_experience_tests.sql` | BEGIN…ROLLBACK: privilegios, seed, escenarios quota/kill/open_all/tester_link/login |
| `362_rollout_experience_verify.sql` | Solo lectura: objetos, grants, clasificación del seed, contador vs grants, cohorte |

**Mecanismo atómico (TÉCNICA VERIFICADA en PG17 local):** `pg_advisory_xact_lock` por usuario y luego por visitante (orden fijo, sin deadlocks) + upsert `INSERT … ON CONFLICT (day) DO UPDATE SET granted = granted + 1 WHERE granted < quota RETURNING`. Si no devuelve fila, el cupo está lleno. Índices únicos parciales: 1 grant activo por visitante y por usuario.

**Clasificación del seed (datos existentes, no supuestos):** `super_admin` en `admins` → `admin`; otro rol en `admins` → `staff`; resto → `tester`. Al 2026-09-29: 1 / 9 / 41. Verificar con `362_rollout_experience_verify.sql` §5 antes de aplicar.

**Seed congelado (decisión del usuario, 2026-09-29):** solo `auth.users.created_at < '2026-09-29 00:00:00-03'` (última alta del grupo: 2026-09-26 21:10 ART). Antes de insertar, la migración cuenta ese grupo y **aborta toda la 362** si no es exactamente 1 / 9 / 41. Descartados: lista de 51 UUIDs (frágil, ilegible) y criterio por actividad (15 de las 41 testers no tienen carrito ni pedido). Cualquier grant previo de la cuenta (también revocado) bloquea el seed: reaplicar no revive revocaciones. Una cuenta del test creada después del corte necesitaría un grant `manual` aparte (UPDATE/INSERT con aprobación).

**Precondición:** la 362 empieza con una guarda que aborta si `service_role` no tiene `SELECT` en `public.admins`.

**Catalog atado al modo (cambios de modo inmediatos):** las RPC devuelven `mode` (el `rollout_config.mode` leído en esa decisión) y nj lo firma en la cookie (`v2.<f|c>.<source>.<mode>.<día>.<hmac>`). Un `catalog` firmado vale solo el mismo día ART **y con el mismo modo** (`evaluateSigned(signed, today, mode)`):
- `paused → quota`: el catalog decidido en `paused` deja de valer; en la siguiente navegación de documento se resuelve: `full` si queda cupo, si no `catalog` firmado con `quota` (y ya no se consulta más ese día).
- `→ open_all`: ningún catalog vale (open_all nunca decide catalog); se resuelve y queda `full`. En SQL, `rpc_rollout_link_user` también crea grant `open_all` a la cuenta sin grant que inicia sesión.
- `kill`: el catalog firmado se conserva y no se resuelve (evita pedir el usuario en cada request). Al salir de `kill`, vale si coincide con el modo nuevo; si no, se redecide una vez.
- `full` firmado no depende del modo (revalida a los 7 días como antes).
- El modo que devuelve la RPC refresca el cache del isolate (`rememberRolloutMode`), así instancias con cache viejo convergen tras una sola consulta. Demora máxima del cambio: cache del modo (≤ 30 s por instancia) + siguiente carga real de página. RSC/prefetch/bots siguen sin consultar. Con `ROLLOUT_FORCE_MODE` se firma el modo forzado.

**Cambiar `daily_quota` en el mismo día (semántica, sin lógica extra):** el contador del día se compara contra el cupo vigente en cada decisión. Subirlo abre lugares al instante para visitantes nuevos, para quien tenga su catalog invalidado por cambio de modo y para el día siguiente; quien ya fue rechazado hoy con el cupo lleno (catalog firmado en `quota`) **no** reintenta hasta medianoche ART. Bajarlo no revoca a nadie: si `granted ≥ cupo nuevo`, no entra nadie más hoy. `quota` con cupo 0 = nadie nuevo (catalog `quota`). Si se quisiera que subir el cupo reabra a los rechazados del día, habría que firmar también el cupo en la cookie (no implementado).

**Revisión previa (2026-09-29, sin aplicar en producción):**
- Producción (solo lectura): 51 cuentas = 1 admin / 9 staff / 41 tester; 0 objetos `rollout_*`; `service_role` con BYPASSRLS y `SELECT` sobre `public.admins`; los default ACL de `public` otorgan todo a anon/authenticated en tablas nuevas (por eso el `REVOKE ALL` explícito).
- Postgres 17.6 local con la misma composición: aplica, reaplica (idempotente, seed 0 filas nuevas), `_tests` → `362 tests OK`, `_verify` según lo esperado, rollback limpio (0 objetos, `auth.users`/`admins` intactos) y reaplicación posterior OK.
- Segunda revisión (ajustes del usuario): guarda sin `SELECT` → aborta con 0 objetos; grupo previo de 52 → aborta con 0 objetos; 2 altas posteriores al corte (una exactamente en el corte) → sin seed; reaplicar con un grant revocado → sigue revocado; `_tests` ampliados (login en `open_all`, alta posterior en `paused`) → OK antes y después de rollback/reaplicación; nj 176/176 tests, tsc y build OK.
- Tercera revisión (paused → quota y avatar): `fn_rollout_result` devuelve `mode` (firma nueva con `text`, actualizada en GRANT/REVOKE y ROLLBACK); `_tests` verifican `mode` en paused/quota/kill/login → OK antes y después de rollback/reaplicación. Lanzamiento simulado: 60 visitantes en `paused` (60 `paused/paused`) → `quota` 15 → los mismos 60 en paralelo = 15 `quota` / 45 `quota_full`. nj 179/179 tests (cookie v2, cambio de modo, kill, formato viejo), tsc y build OK.
- Concurrencia: cupo 15 con 60 visitantes en paralelo → 15 `quota` / 45 `quota_full`; 20 requests simultáneos del mismo visitante → 1 grant (1 `quota` + 19 `existing_grant`); 20 cruces `resolve`/`link_user` de la misma cuenta y dispositivo → 1 grant activo, sin deadlocks. Contador = grants quota.
- **Dependencia:** las RPC son `SECURITY INVOKER`: requieren que `service_role` conserve `SELECT` en `public.admins` (sin eso fallan con `permission denied` y nj cae a catalog sin firmar).
- **Límite conocido:** el cupo es por `visitor_id`/cuenta. Un dispositivo nuevo sin sesión (o cookies borradas) es un visitante nuevo y puede consumir otro cupo en modo `quota`; el total diario nunca supera `daily_quota`.
- **Revocación:** `revoked_at` se refleja cuando nj revalida el full firmado (hasta 7 días) o al rotar `ROLLOUT_COOKIE_SECRET`; `kill` es inmediato (cache de modo ≤ 30 s).

## Código nj

- **Bandera única:** `NEXT_PUBLIC_ROLLOUT_ENABLED=1` (server + boot script; requiere rebuild). Apagada = nj exactamente como antes (todos `full`, sin cookies, `html[data-exp="full"]` en SSR).
- **Middleware** (`nj/middleware.ts`): decide server-side; bots, prefetch/RSC y landings Firebase nunca resuelven. RPC 1 vez por visitante/día (catalog) o cada 7 días (full).
- **Cookies:** `fyl_vid` (httpOnly, UUID), `fyl_exp` (httpOnly, HMAC-SHA256 sobre `v2|vid|exp|src|mode|day`; única que habilita `/dashboard`; las `v1` se descartan y se redecide), `fyl_x` (espejo legible, solo UI), `fyl_notice` (120 s). `catalog` vence a medianoche ART; `full` 400 días.
- **UI sin flash:** script inline en `<head>` fija `html[data-exp]`; variantes por CSS (`exp-full-only` / `exp-catalog-only`); `FullOnly` para componentes con efectos (carrito, onboarding, notificaciones). Sin atributo = catalog.
- **Catalog:** WhatsApp en Header/BottomNav/PDP (número de catalogo1 `5493625172874`, ver contradicción), talles solo lectura, sin carrito ni “Pedido”, FAQ/cómo usar/quiénes somos de catalogo1.
- **Auth callback:** vincula la cuenta (`rpc_rollout_link_user`); sin grant → vuelve a `/` en catalog con aviso (en `open_all` la cuenta recibe grant y entra a `full`).
- **Catalog firmado y cambio de modo:** un `catalog` firmado vale solo con el modo con que se decidió (ver “Catalog atado al modo”); `CatalogAccountNotice` muestra el aviso post-login y la tarjeta de cuenta del avatar.
- **`kill` y `/dashboard`:** `canEnterFullArea(mode, current, isVerifiedStaff)`. En `kill` solo pasa staff verificado **en vivo** contra `public.admins` (`isStaffUser`, service_role; ante error → no pasa). No se confía en el `source` firmado de la cookie. Middleware (`/dashboard`, `/login`) y callback aplican la misma regla; la clienta con grant vuelve a `/` con el aviso y su `full` firmado se conserva para cuando se salga de `kill`. Con `ROLLOUT_FORCE_MODE=kill` y la base caída, staff tampoco entra (fail-closed).
- **SEO:** `NJ_INDEXING_ENABLED` = `NEXT_PUBLIC_NJ_INDEXING=1` **y** rollout activo (apagado). `robots.ts` host-aware (Disallow fuera de `www`); `X-Robots-Tag: noindex` en hosts no canónicos y en `/nj`; canonical por página; JSON-LD org/website/categoría/FAQ con `www`.
- **Analytics:** Pixel y Clarity productiva solo con rollout activo y host `www`/apex; GA `user_properties` `experience` + `rollout_source` (sin eventos duplicados).
- **Landings Firebase** (`/revendedoras`, `/*-por-mayor`, `/terms`, `/privacy-policy`, `/icons/*`, `/styles.css`): rewrite `beforeFiles` a `catalogo-fyl-test.web.app` solo con rollout activo.

## Verificación (2026-09-29)

| Prueba | Resultado |
|---|---|
| PGlite: tests SQL, rollback + reaplicar, idempotencia | OK |
| Docker PG17: 60 visitantes paralelos, cupo 15 | 15 full / 45 catalog, contador = grants |
| Docker PG17: 20 requests mismo visitante; 40 resolve+link misma cuenta | 1 fila; sin deadlocks |
| PostgREST: anon → RPC / tablas | `42501 permission denied` |
| Unit tests nj (`npx tsx --test`) | 175/175 (28 de rollout, incl. `kill` + staff en `/dashboard`, + 3 Clarity) |
| `tsc --noEmit`; `next build` rollout off / on | OK. Home/categoría ya eran dinámicas en la base (no se perdió ISR); `robots.txt` pasa a dinámico |
| E2E local (middleware real + PG17 + PostgREST, cupo 3) | 21/22: quota, cookies firmadas, bots, prefetch, forja de cookies, `/nj`, `/catalogo` 302, `/dashboard`, robots, noindex, kill/paused/open_all. El caso restante (proxy a Firebase) falla solo por intercepción TLS local; rewrite verificado en `routes-manifest` y destinos 200 |
| Comparación visual 390 px catalog vs catalogo1 | Ver diferencias abajo |

## Preview Vercel (2026-09-29) — validación final de Fase 0

`https://nj-e11sqau1i-gonzidel.vercel.app` (proyecto `nj`, target preview, commit `650fc5b`). `--build-env/--env NEXT_PUBLIC_ROLLOUT_ENABLED=1`, `ROLLOUT_FORCE_EXPERIENCE=catalog`. Sin dominio, DNS, producción, indexación ni catalogo1 tocados. El proyecto `nj` no está conectado a git (la CLI sugiere `vercel git connect`).

**Límite:** el preview no tiene `SUPABASE_SERVICE_ROLE_KEY` ni `ROLLOUT_COOKIE_SECRET` (no se agregaron secretos) → modo `paused` + catalog forzado; no emite `fyl_exp`. Cupo, grants, `kill`/staff y aviso post-login quedan validados solo en E2E local.

| Verificación (390 px) | Resultado |
|---|---|
| Home | OK: header búsqueda + WhatsApp + Ingresar, chips de categorías, banner catalog (igual catalogo1), barra inferior Inicio/Buscar/WhatsApp, sin carrito ni “Pedido” |
| Categorías (`/calzado`) | OK: 14+ productos; filtro Talles (38 → 132 productos, `?talle=38`) |
| Búsqueda | OK: `/?q=bota` → resultados |
| PDP (`/producto/653`) | OK: talles solo lectura, sin agregar, CTA fijo “Consultar por WhatsApp” con modelo/SKU/color |
| WhatsApp | Solo `wa.me/5493625172874` en todas las páginas |
| `/quienes-somos` | OK: página nj, bullets catalog, 5 recursos (sin autolink), meta description sin “fábrica propia”, canonical `www` |
| Landings Firebase (proxy) | **OK en real**: `/revendedoras`, `/*-por-mayor`, `/terms`, `/privacy-policy` 200 con HTML y estilos; assets `/styles.css`, `/logo.png`, `/icons/*` 200; links internos resuelven (`/catalogo` → 302 `/`) |
| `robots.txt` / `sitemap.xml` | `Disallow: /` / vacío (host no canónico) |
| noindex | `X-Robots-Tag: noindex, nofollow` en HTML (y `noindex` en assets) + `<meta robots noindex>` en páginas nj |
| canonical | `https://www.fylmoda.com.ar/...` en home, categoría, PDP, tags, quiénes somos |
| `/nj`, `/nj/calzado`, `/catalogo`, `/catalogo/calzado`, `/dashboard` | 302 a `/`, `/calzado`, `/`, `/calzado`, `/login?next=…` |
| Parpadeo full/catalog | Sin flash: boot script inline síncrono en `<head>`; sin atributo (estado SSR) el CSS ya equivale a catalog (0 elementos full visibles) |

Hallazgos del preview: las landings Firebase conservaban canonical apex (`https://fylmoda.com.ar/...`) y afirmaban “fábrica propia” / “786+ artículos”. Corregidas en el repo (commit `f066213`), **sin deploy de Firebase** (ver § Fase 1).

## Diferencias catalog vs catalogo1 (a aceptar o corregir)

- PDP con layout nj (galería/colores/talles distinto orden) — rediseño previo de nj.
- Filtro “Talles” solo en categorías (decisión previa de nj); F&L Originals sin subtítulo (nj) vs “Fabricación propia y stock constante” (catalogo1).
- Disponibilidad por `sellable` (nj) vs `stock_qty` (catalogo1).
- Sin `@vercel/analytics` / speed-insights. JSON-LD con `www` (catalogo1 usaba apex).
- Botón “Ingresar” visible en catalog (pedido explícito).

## CONTRADICCIONES / pendientes de decisión

- **WhatsApp catalog — NEGOCIO CONFIRMADO (usuario, 2026-09-29):** `5493625172874` (Ani, canal default de ventas y el del catálogo público). No se cambia a Fati como parte del rollout. Evidencia que motivó la consulta:
  - nj: es el único número (`ActiveOrderTab`, `OrderTransportConfirmModal`, contacto de envíos/local del dashboard), puesto por `fad9f37` en lugar de `5493624118637`. En `origin/main` nj todavía tiene `5493624118637`.
  - Producción `public.wa_channels` (solo lectura): `ani` `+5493625172874` **`is_default=true`**; `fati` `+5493624866768` `is_default=false`.
  - catalogo1, catálogo vanilla, landings Firebase y notas 44/`doc/catalogo1/README.md` usan `5493625172874` como WhatsApp de ventas.
  - `CATALOG_WHATSAPP_NUMBER = "5493625172874"` queda definitivo para catalog.
- Riesgo residual: un usuario autenticado puede llamar RPC de carrito/checkout directo (igual que hoy). Forzarlo en DB toca checkout → fuera de alcance; opción Fase 2 con aprobación. En `kill` aplica igual: el middleware no cubre `/api/*` ni RPC directas.
- `/nj` es público: cualquiera con el link obtiene `full` (diseño pedido). Hay links `/nj/dashboard` en mensajes WhatsApp enviados.
- **`/quienes-somos` (revisado):** hoy `www/quienes-somos` sirve la landing Firebase (`quienes-somos.html`); catalogo1 (`/catalogo/quienes-somos`) es la misma página que nj. Contenido de la landing que no está en nj:
  - Claims **no reutilizables** según `docs/01_EMPRESA.md` / `11_PROBLEMAS_Y_FIXES.md`: “fábrica propia”, “producción nacional”, “precio de fábrica”, “no somos distribuidores”, cifras (786+ artículos, conteos por categoría) desactualizadas.
  - Sin confirmar (EMP-01 / transportes): horario “lunes a viernes”, “Correo Argentino, OCA y transportes”, teléfono de ventas en JSON-LD.
  - Confirmado (CANÓNICA) pero solo implícito en nj: surtido libre y mínimo de 4 productos surtidos (nj full dice “Compra mínima accesible”). No se portó copy; queda a decisión.
  - Se quitó de “Guías y recursos” el link a `/quienes-somos` (en nj apunta a sí misma).
- **Claims “fábrica propia” (corregido en metadata, 2026-09-29, pedido del usuario):** `layout.tsx` y `/quienes-somos` ya no lo afirman en `description`; el JSON-LD tampoco. Sin ampliar contenido.
- **Limpieza nj (2026-09-29, pedido del usuario):** se quitó el párrafo visible “Contamos con fábrica propia de calzado…” de `/quienes-somos`; el banner de la home queda “F&L Originals” sin subtítulo y la colección usa “Colección destacada” (antes “Fabricación propia”); la metadata de `[categoria]` y `tags` dice “compra mínima de 4 productos surtidos” (antes “desde 4 pares”). En nj no queda ningún “fábrica/fabricación propia” ni “4 pares”.
- **Landings Firebase (preparado 2026-09-29, commit `f066213`, sin deploy):** se quitaron “fábrica propia”, “producción nacional”, “precio de fábrica”, “no somos distribuidores”, 786+/490+/70+ y conteos por categoría; mínimo expresado como “4 productos surtidos” (CANÓNICA); todas las URLs absolutas pasan a `https://www.fylmoda.com.ar` (canonical, og, JSON-LD, breadcrumb, terms, privacy). Se dejaron sin tocar, **sin confirmar**: precios “desde $X” por categoría, “Correo Argentino, OCA y transportes”, “lunes a viernes”, “envíos a todo el país”. `quienes-somos.html` también se corrigió aunque con nj en `www` se sirve la página nj.
- **Ramas divergentes:** ver § Integración de ramas.

## Integración de ramas (ejecutada solo en local, 2026-09-29)

**Hecho:** `git merge -s ours origin/main` en `fix/customer-link-nj-onboarding` → `af349fb`. Árbol idéntico al previo (`26698bf`, 0 archivos distintos vs `f338f9e`); `origin/main` pasa a ser ancestro. Chequeos antes/después: sin `canCloseOrderFromExpiredColumn` ni botón “Cerrar pedido” en `OrderActions.tsx`, sin regla soft ≤1 día en `classification.ts`, sin chip amarillo en `VencidoLegend.tsx`. WIP sin commitear del repo principal intacto (hash del diff y archivos sin seguimiento iguales; respaldo en `E:\PROYECTOS\fyl-integration-backup-20260929`). Sin push, sin PR, `main` sin tocar. `feat/nj-rollout-fase0` se rebaseó sobre `af349fb`.

### Análisis previo

`fix/customer-link-nj-onboarding` (`f338f9e`, 20 commits sobre el merge-base `b0e3770`; 8 sin pushear) vs `origin/main` (`11976e4`, 6 commits).

- **Main no aporta nada nuevo.** Sus 6 commits son versiones de 6 commits de la rama: `90d3863`≡`09f75b4` (patch idéntico); `a72e53b`/`0f50852`/`07fcbf9`/`de2b505`/`11976e4` ≈ `01ab081`/`7b18007`/`a092f8e`/`07ea1b4`/`e8be2ba` (mismo cambio, contexto adaptado a una base sin `8c6e0b1`/`18378ba`; `git range-diff` solo muestra diferencias de contexto en docs e imports).
- **`git merge-tree origin/main HEAD`:** 4 conflictos, todos del mismo tema — main conserva “≤1 día → columna Vencido (amarillo)” y la rama tiene la decisión posterior `f3b1c42` (“≤1 día → Apartados con marco amarillo; Vencido solo con plazo cumplido”): `classification.ts`, `classification-expired-column.test.ts`, `VencidoLegend.tsx`, nota 65 (add/add; la versión de main está contenida en la de la rama).
- **Conflicto oculto:** sin conflicto textual, el merge reintroduce en `OrderActions.tsx` el botón “Cerrar pedido” de Vencido (lo agregó `de2b505` en main y lo quitó `f3b1c42` en la rama). Hay que descartarlo.
- Resto de archivos compartidos (44): el auto-merge da exactamente el árbol de la rama.
- **Resultado correcto = árbol de la rama sin cambios** → `git merge -s ours origin/main` en la rama (registra main como integrado, no toca archivos), luego PR/fast-forward de `main`. Evita rebase de 20 commits (reescribiría 12 ya pusheados).
- Riesgos: el repo principal tiene WIP sin commitear (confirmación de pedido; toca `nj/styles/globals.css`, igual que el rollout); push a `main` podría disparar deploys si algún proyecto Vercel está conectado a git (verificar); la rama trae migraciones 351–361 y Edge Functions: mergear no las aplica, pero `main` pasaría a documentarlas.
- El rollout (`feat/nj-rollout-fase0`, base `fad9f37`) no se superpone con `f338f9e` (solo `admin/` + test + nota 40): rebase directo sobre la rama integrada.

## Fase 1 — plan de cutover y rollback (preparado 2026-09-29, NO ejecutado)

Objetivo: nj sirve `www` con rollout `paused` (visitantes → catalog; grants del seed y `/nj` → full). `daily_quota` 15 queda inactivo. catalogo1 no se borra. Sin redirects permanentes nuevos.

### Estado de producción (TÉCNICA VERIFICADA, solo lectura, 2026-09-29 20:37 ART)

- `www.fylmoda.com.ar` y apex → proyecto Vercel **`catalogo-definitivo`** (catalogo1; auto-deploy desde `main`, último hace 9 h). Apex → 308 `www` (dominio Vercel). DNS en donweb, sin cambios necesarios.
- catalogo1 `vercel.json`: `/` y `/catalogo.html` → 308 `/catalogo` (`Cache-Control: max-age=0, must-revalidate`); `/nj*` → rewrite a `nj-gonzidel.vercel.app/nj*`; todo lo que no sea `/catalogo*` ni `/nj*` → rewrite a Firebase `catalogo-fyl-test.web.app` (catch-all `**` → `catalogo.html`).
- Por eso hoy en `www`: `/dashboard`, `/login`, `/auth/callback` = 200 de `catalogo.html` (JS → `/catalogo`); `/admin` ↔ `/admin/` loop 301/308; `/admin/*.html`, `/customer.html`, `/scripts/*`, `/config.prod.js`, `/qz-site.crt`, `/sw.js` = 200 desde Firebase; `/nj/dashboard` → 307 `/nj/login`.
- `robots.txt` y `sitemap.xml` en `www` = los de Firebase: `Allow: /`, `Disallow: /admin/ /client/ /auth/…`, `Sitemap: https://fylmoda.com.ar/sitemap.xml`; el sitemap lista URLs **apex** (`/catalogo`, 5 landings, `/quienes-somos`).
- Proyecto `nj`: producción `nj-drab.vercel.app` / `nj-gonzidel.vercel.app` (deploy `dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP`, hace 5 días). Env **Production**: solo `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY` (también en Preview). Faltan todas las del rollout.
- Supabase Auth (`auth.flow_state.referrer` de probes previos): aceptadas `https://www.fylmoda.com.ar/auth/callback?next=…`, `https://www.fylmoda.com.ar/nj/auth/callback?next=…&pfx=nj`, `https://nj-gonzidel.vercel.app/auth/callback?…`. Rechazadas (caen a Site URL `https://catalogo-fyl-test.web.app`): apex, `nj-drab`, URLs de deploy. Los probes dejaron 10 filas efímeras en `auth.flow_state` (se limpian solas).
- URLs hardcodeadas: `CUSTOMER_DASHBOARD_MESSAGE_URL` (nj) y `357_wa_deadline_reached_taxonomy.sql` → `https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart`; admin vanilla `njUrl()` → `https://www.fylmoda.com.ar/nj/admin/{conciliacion-reembolso,orders,retiro}`; `public-sales.js` y otros arman QR con `${window.location.origin}/customer.html?code=…`.
- **`nj-fyl-testing.vercel.app`** = alias manual del proyecto `nj` a un deployment **preview** (`dpl_GtM6FMT1528xyC42oGwWo4PRWgwx`, 2026-09-24). No es dominio de producción: `vercel promote`/`rollback` y el movimiento de `www` no lo tocan. Build sin bandera de rollout (todos full). Supabase acepta su callback (`/nj/auth/callback` y `/auth/callback` aparecen como `referrer` aceptado en `auth.flow_state`): no depende del Site URL.
- **Admin vanilla en Firebase:** se usa desde `catalogo-fyl-test.web.app/admin/` y `app.fylmoda.com.ar/admin/` (dominio custom de Firebase, no está en Vercel). Ninguno de los dos cambia con el cutover.
- **Impresión:** el admin ya no usa QZ Tray ni `qz-sign`. `qz-printing.js` carga `gz-shim.js`, que habla con el agente local `gz-agent` en `http://127.0.0.1:8785` sin certificado ni firma; `gz-agent` responde CORS con el origen que llegue. `qz-sign` (v47, orígenes `catalogo-fyl-test.web.app` / `catalogo-fyl.web.app`) sigue desplegada pero el admin actual no la llama. Corrige lo anotado antes («QZ solo desde Firebase»).

### Variables de entorno nj (Production)

| Variable | Tipo | Estado | Valor |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | pública | existe (Prod + Preview) | sin cambios |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only, Sensitive, **solo Production** | falta | recomendado: secret key dedicada `sb_secret_…` (la ruta `sb_secret` solo está probada en unit tests); alternativa: JWT service_role legacy |
| `ROLLOUT_COOKIE_SECRET` | server-only, Sensitive, **solo Production** | falta | ≥ 32 caracteres aleatorios (p. ej. `openssl rand -base64 48`) |
| `NEXT_PUBLIC_ROLLOUT_ENABLED` | pública, build-time | falta | `1` |
| `NEXT_PUBLIC_NJ_INDEXING` | pública, build-time | falta | `1` recomendado (decisión) |
| `NEXT_PUBLIC_SITE_URL` | pública | falta | no hace falta (default `www`) |
| `NEXT_PUBLIC_CUSTOMER_DASHBOARD_URL` | pública | falta | sin definir en Fase 1 = link WA sigue en `nj-fyl-testing` (decisión) |
| `ROLLOUT_FORCE_MODE` / `ROLLOUT_FORCE_EXPERIENCE` | server-only | falta | **no** definir (emergencia; `FORCE_EXPERIENCE` se ignora en producción) |

Preview no recibe secretos. Con bandera 1 y secretos ausentes o inválidos, nj fuerza `paused` + catalog sin firmar (fail-safe).

### Indexación

- Hoy `www` indexa catalogo1 (`/catalogo`) y landings (sitemap apex). Si el cutover sale con `NEXT_PUBLIC_NJ_INDEXING` ausente, nj publica `Disallow: /` + `noindex` en todo `www` → **desindexa** catálogo y landings. Recomendado: `NEXT_PUBLIC_NJ_INDEXING=1` en el build del cutover.
- Con 1 y host `www`: `robots` Allow + Disallow `/admin /dashboard /login /api/ /auth/ /client/`; sitemap nj (home, 5 categorías, cómo comprar, quiénes somos, 7 landings) con `www`; canonical `www` por página. Cualquier otro host (deploy URLs, `nj-drab`, `nj-gonzidel`) → `X-Robots-Tag: noindex` + `Disallow: /`. `/nj` siempre `noindex`.
- Después del cutover: Search Console → enviar `https://www.fylmoda.com.ar/sitemap.xml`; el viejo sitemap apex deja de servirse.

### Redirects durante Fase 1 (todos temporales)

| Ruta | Respuesta |
|---|---|
| `/` | 200 nj (catalog; full si hay `fyl_exp` full válido) |
| `/catalogo`, `/catalogo/` | 302 `/` |
| `/catalogo/<ruta>` | 302 `/<ruta>` (1:1) |
| `/nj` | 302 `/` + grant `tester_link` (noindex) |
| `/nj/<ruta>` | 302 `/<ruta>` + grant `tester_link` |
| `/nj/admin/<ruta>` | 302 `/admin/<ruta>` sin grant |
| `/nj/auth/callback` | callback (logins en curso) → termina en `/nj/…` → 302 sin prefijo |
| `/dashboard` | sin sesión 302 `/login?next=/dashboard`; con full 200; sin grant 302 `/` + aviso |
| `/login` | sin sesión 200; con full 302 `/dashboard`; sin grant 302 `/` + aviso |
| landings (`/revendedoras`, `/*-por-mayor`, `/terms`, `/privacy-policy`) | 200 vía rewrite a Firebase (URL no cambia) |
| `/quienes-somos` | 200 página nj |
| `/icons/*`, `/styles.css` | 200 vía rewrite a Firebase (assets de las landings) |
| `/admin/{orders,retiro,products,search,conciliacion-reembolso…}` | admin nj (login); destino de los links `njUrl()` del admin vanilla vía `/nj/admin/*` |
| `/admin/*.html`, `/customer.html`, `/scripts/*`, `/config.prod.js`, `/fyl-flags.json`, `/qz-site.crt`, `/certs/*` | 404 (sin proxy: el sistema interno no se usa desde `www`) |
| `/catalogo.html`, `/index.html`, `/client`, `/client/*` | 307 `/` (temporal, `redirects()` en `next.config.ts`, solo con bandera) |
| apex | 308 `www` (existente, a nivel dominio) |

### Decisiones del usuario (2026-09-29)

- Proxy del admin vanilla/QR en nj: ~~sí~~ → **no** (revisado 2026-09-29: el staff nunca usa `www/admin` ni imprime QR desde `www`). Se revirtió lo agregado en `49aec61`; quedan solo los rewrites de las 7 landings + `/icons/*` + `/styles.css`.
- **Arquitectura (NEGOCIO CONFIRMADO, 2026-09-29):** `www.fylmoda.com.ar` = experiencia pública/clientas (nj); `app.fylmoda.com.ar` (y `catalogo-fyl-test.web.app`) = sistema interno/staff en Firebase. Migrar el sistema interno a nj es un proyecto aparte, fuera de Fase 1.
- ~~Los 4 commits nj no publicados salen primero como release interno de nj~~ → **abandonado definitivamente (2026-09-30)**: imposible sin tocar catalogo1 o crear una variante con `basePath: "/nj"`, y ninguna de las dos se hace. Esos commits salen directamente con el cutover.
- `NEXT_PUBLIC_NJ_INDEXING=1` en el build del cutover: **sí**.
- Link WhatsApp al dashboard (`nj-fyl-testing`): **sin cambios** en Fase 1.
- ~~Site URL de Supabase Auth → `www` en la ventana~~ → **sin cambios** en el cutover: los callbacks de `www` ya están permitidos (riesgo 6).
- Clave server-side: **secret key dedicada `sb_secret_`** para nj (se valida en el paso 4).

### Riesgos nuevos

1. **Rutas del hosting viejo en `www` (decidido: sin proxy):** tras el cutover, `/admin/*.html`, `/customer.html`, `/scripts/*`, `/config.prod.js`, `/fyl-flags.json`, `/qz-site.crt` y `/certs/*` dan 404 en `www`. Por decisión del usuario (no convertir URLs que hoy funcionan en 404) se repusieron solo los 307 temporales `/catalogo.html`, `/index.html` y `/client/*` → `/` (build con bandera: `routes-manifest` con exactamente esos 3 redirects; `next start` local: 307 en los tres, `/customer.html` y `/admin/index.html` 404). El proxy de `49aec61` se revirtió (`next.config.ts` y `legacy-hosting.ts` vuelven al estado previo; `legacy-hosting.test.ts` eliminado; `tsc` 0, 179/179, `next build` con bandera 1 OK; `routes-manifest` sin redirects custom y `beforeFiles` = 7 landings + `/icons/*` + `/styles.css`). El sistema interno sigue en `app.fylmoda.com.ar` / `catalogo-fyl-test.web.app`; los QR se arman con `window.location.origin` del admin (host Firebase) y la impresión es GZ local: nada de eso depende de `www`.2. **Desindexación** si falta `NEXT_PUBLIC_NJ_INDEXING=1`.
3. **Ventana `/nj`:** `vercel promote` **y también `vercel deploy --prod --skip-domain`** mueven `nj-gonzidel` (verificado 2026-09-29); mientras `www` siga en catalogo1, `/nj*` queda proxied a un build sin `basePath` → sin CSS/JS (ver release interno). Mitigación: deploy + promote + mover dominio en la misma ventana (minutos), o re-apuntar `nj-gonzidel` a `dpl_BHA4…` inmediatamente después del deploy.
4. **1301 clientas con pedidos sin cuenta (TÉCNICA VERIFICADA 2026-09-29):** no tienen ningún usuario Auth, ni directo (`customers.id`) ni por `customer_auth_links`. Toda clienta con pedidos que sí tiene cuenta (24) tiene grant; 0 cuentas sin grant. De las 1301: 520 con pedido en 30 días; 272 con pedido no final (187 `active`/`closing_soon`, 93 `closed`, 25 `expired`; 111 con retiro local diferido); 211 con stock reservado (1009 unidades); 48 con desarme en < 48 h; 0 ítems `reserved`/`waiting`/`missing`. Los 354 pedidos abiertos tienen `source = admin`. Acceso hoy: por WhatsApp con el staff; los mensajes que el staff copia desde el admin nj llevan el link a `nj-fyl-testing`, donde tendrían que crear cuenta y vincularse (`rpc_link_or_create_customer`). `wa_outbox` vacía y WA en `whitelist`: el cron 357 no les envió mensajes. El cutover no cambia nada de esto.
5. **Deploy de Firebase publica todo el árbol** (landings + admin vanilla + scripts). **Fuera del cutover mínimo:** las landings vivas (con claims y URLs viejas) siguen sirviéndose igual vía proxy. Si más adelante se publican los 8 HTML de `f066213`, debe salir del working tree principal (su contenido es el vivo, con el WIP de `admin/control.html`) agregando solo esos 8 archivos, como cambio separado.
6. **Auth:** Site URL = `catalogo-fyl-test.web.app`. Un redirect no permitido termina ahí. Los callbacks de `www` ya están permitidos, así que el cutover mínimo **no** cambia el Site URL; queda como ajuste opcional y separado (aprobación aparte). El login no se puede probar en la URL `--skip-domain` (no está permitida).
7. `main` auto-despliega `catalogo-definitivo` (sin impacto mientras no se pushee; tras el cutover, un deploy de catalogo1 ya no afecta `www`).
8. 308 cacheadas de `www/` → `/catalogo`: con `max-age=0, must-revalidate` el riesgo de loop es bajo; probar en un navegador que ya visitó `www`. Service workers viejos: nj los desregistra.

### Release interno de nj previo al cutover (HISTÓRICA — abandonado 2026-09-30)

> Se conserva como registro. `www/nj` queda en `dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP` hasta la ventana de cutover; `dpl_8yoD…` queda sin promover (no se borra por ahora).

Objetivo: dejar la producción de nj con el mismo código base que irá a `www` (`af349fb`, sin rollout). Frente a `nj-fyl-testing` son los 4 commits pendientes (`f3b1c42` Kanban Vencido/Apartados, `e8be2ba` alineación de días, `fad9f37` WhatsApp `5493624866768` en dashboard/modal de transporte, `6fc90b5` Clarity solo en `nj-fyl-testing`); frente a la producción nj actual son 81 archivos (ver «Qué está publicado hoy»). Sin tocar `www`, catalogo1, Firebase, Supabase, `nj-fyl-testing` ni la cuota.

- **Fuente:** worktree limpio `E:\PROYECTOS\fyl-nj-release` en `af349fb` (detached). Contiene los 4 commits y `07ea1b4` (opción reponer stock al quitar ítem). No contiene código de rollout ni el WIP sin commitear del repo principal (confirmación de pedido). Verificado en local: `tsc` 0, 144/144 tests, `next build` OK.
- **Compatibilidad (TÉCNICA VERIFICADA, solo lectura):** las 71 RPC que llama nj en `af349fb` existen en producción (incluida `rpc_remove_order_item_restore_stock(uuid, boolean)`). `next.config` y middleware soportan el prefijo `/nj` del rewrite de catalogo1.
- **Env:** la de Production actual (solo URL + anon key). No agregar variables del rollout antes de este release (`NEXT_PUBLIC_*` se hornean en el build).
- **Pasos:**
  1. Anotar el deploy productivo actual: `dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP`.
  2. Copiar `nj/.vercel/project.json` (proyecto `nj`) al worktree; sin `.env.local` ni `.next`.
  3. `vercel deploy --prod --skip-domain` desde `E:\PROYECTOS\fyl-nj-release\nj` → URL del deploy, sin aliases.
  4. Sobre la URL del deploy: `/nj` 200 con catálogo, PDP, `/nj/admin/orders` → login. (El login Google no funciona en la URL del deploy: no está permitida en Auth.)
  5. `vercel promote <url> --yes` → mueve `nj-gonzidel` / `nj-drab`: lo sirven `www/nj/*` (rewrite de catalogo1) y los links `njUrl()` del admin vanilla. `www` fuera de `/nj`, catalogo1, Firebase, `nj-fyl-testing` y la base no cambian.
  6. Validación del staff desde `app.fylmoda.com.ar` → links a `www/nj/admin/*`: Kanban (Vencido solo vencidos; ≤ 1 día en Apartados con marco amarillo; sin «Cerrar pedido» en Vencido), Retiro, Conciliación, edición de producto, quitar ítem con/sin reponer stock (en pedido de prueba), días del dashboard, número de WhatsApp. Además, por la línea 18–24/09 que hoy no está en producción nj: `www/nj` home, categorías, PDP, Mi pedido y columna Vencido con leyenda (comparar con `nj-fyl-testing`, que ya corre ese código).
  7. Observar 24–48 h antes del cutover.
- **Rollback:** `vercel promote dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP --yes` (o `vercel rollback`). Sin SQL ni cambios de datos.
- **Qué está publicado hoy (TÉCNICA VERIFICADA, 2026-09-29, API de Vercel `v6/deployments/{id}/files` + blobs git, solo lectura):**
  - Producción nj `dpl_BHA4…` (`nj-gonzidel`/`nj-drab`, sirve `www/nj/*` y los links `njUrl()` del staff) = **commit `de2b505`** exacto (329/329 archivos de `nj/` idénticos). `de2b505` tiene el mismo mensaje que `07ea1b4` pero es otra línea de historia.
  - Preview `dpl_GtM6…` (alias `nj-fyl-testing`, link WA a clientas) = **commit `07ea1b4`** exacto (350/350).
  - Diferencia `af349fb` vs `nj-fyl-testing`: 13 archivos + 2 tests = los 4 commits.
  - Diferencia `af349fb` vs producción nj: **81 archivos (+2942/−761)**: además de los 4 commits, la línea 18–24/09 que solo estaba en `nj-fyl-testing` (`8c6e0b1` base URL/SEO/robots/sitemap, revalidación por snapshot y disponibilidad de stock; `01ab081` Vencido con leyenda; `18378ba` CLS y cache del PDP; `7b18007`; `a092f8e`). El código del cutover (`feat/nj-rollout-fase0`) contiene todo eso igual.
- **`07ea1b4` (quitar ítem con opción «¿vuelve al stock físico?»):** ya publicado en producción nj (vía `de2b505`) y en `nj-fyl-testing`. Migración 361 aplicada (`rpc_remove_order_item_restore_stock(uuid, boolean)`, comentario `canonical:361`). Uso real desde 2026-09-24: 24 registros en `stock_history` «Admin quitó ítem y eligió NO reingresar». No se puede excluir: ya está vivo (excluirlo sería quitarle la opción al staff y volver a reingresar siempre) y `f3b1c42` borra código que `07ea1b4` agregó (botón «Cerrar pedido» en Vencido, test `classification-expired-column`), así que un revert choca.
- **Intento 2026-09-29 22:38 ART — BLOQUEADO, no promovido (TÉCNICA VERIFICADA):**
  - `vercel deploy --prod --skip-domain` desde `af349fb` → `dpl_8yoDQRpoYTaxEAX7GpDmdnezPqzt` (`nj-l97606rsm-gonzidel.vercel.app`), build OK.
  - **`--skip-domain` igual movió `nj-gonzidel.vercel.app`** (alias automático del proyecto) al deploy nuevo; `nj-drab` y el target de producción quedaron en `dpl_BHA4…`. Se devolvió con `vercel alias set nj-mbdzu2ahz-gonzidel.vercel.app nj-gonzidel.vercel.app` a los ~2 min (01:38:36 → ~01:40:30 UTC).
  - En el deploy aislado: `/nj`, `/`, login, cómo comprar, quiénes somos 200; dashboard y `/nj/admin/*` → 307 login; `X-Robots-Tag: noindex`.
  - **Bloqueo:** `de2b505` (producción) usa `basePath: "/nj"` (links, `/nj/_next/*`, `/nj/api/*`). `af349fb` quitó `basePath` y reescribe `/nj/*` → `/*`: el HTML sale con `/_next/static/*`, `/calzado`, `/producto/…`, `/login`. Bajo `www/nj` (catalogo1 solo reenvía `/nj*`), esos pedidos van a Firebase: `www/_next/static/*.css|js` = 200 `text/html` (catch-all `catalogo.html`) y `/calzado`, `/login`, `/api/…` = catálogo vanilla. Resultado: `www/nj` sin CSS/JS y navegación a catalogo1; rompe también los links `njUrl()` del staff. Funciona solo en hosts directos (`nj-fyl-testing`, deploy URL) o con nj en la raíz de `www` (cutover). Corrige lo anotado antes («`af349fb` compatible con el rewrite `/nj` de catalogo1»): lo es para páginas, no para assets ni links.
  - Durante los ~2 min expuestos, `www/nj` pudo verse roto. Estado verificado después: `www/nj` sirve `dpl_BHA4…`, assets `/nj/_next/*` con `text/css`/`application/javascript`.
  - **Impacto en el cutover:** su paso 4 (`deploy --prod --skip-domain` antes de la ventana) también movería `nj-gonzidel` y rompería `www/nj` mientras `www` siga en catalogo1. Hay que hacerlo dentro de la ventana o re-apuntar `nj-gonzidel` a `dpl_BHA4…` enseguida.
- **Validación no destructiva en el deploy aislado (2026-09-30 10:00–10:06 ART, sin promover):**
  - Auth: **no hizo falta** agregar Redirect URL; la lista ya tiene `https://*-gonzidel.vercel.app/**` (42 entradas; Site URL sin cambios). Probe: `nj-l97606rsm-gonzidel…/auth/callback` aceptado como `referrer`; host ajeno → Site URL. Corrige «URLs de deploy rechazadas» anotado antes. El comodín es amplio (cualquier deploy del scope `gonzidel`): revisar aparte.
  - Login Google (cuenta admin) vuelve al mismo host.
  - Público vs `www/nj`: home, 5 categorías, ofertas, nuevos ingresos, 3 PDP, cómo comprar: mismos productos y precios.
  - `/admin/orders`: Vencido 33, todos `vencido-red`, plazo ≤ ahora (20 `expired`), sin «Cerrar pedido» (acciones: Mensaje, Enviar, +24hs, Ya enviado, Archivar, Desarmar). Apartados: 38 con marco amarillo (`vencido-yellow`, plazo 30/09 17:00–01/10 17:00, con «Cerrar pedido»). 0 pedidos de Apartados/Activos con plazo vencido; 0 vencidos con ítems operativos fuera de Vencido.
  - Retiro: Apartados 57 = 57 `active` con retiro local diferido. Conciliación carga (370 pendientes, 3.545 conciliados, 12 irregularidades, 162 sin identificar). Ficha de producto (309) carga completa, sin guardar.
  - Dashboard: A57551 «Vence 6 oct.» = `dismantle_at` 06/10 17:00 = «6 días» en Kanban. WhatsApp: el link solo se muestra con ≤ 2 días o vencido; el chunk del dashboard publicado contiene `5493624866768` y ningún JS cargado contiene `5493624118637`. Clarity no carga en este host.
  - Sin quitar ítems ni tocar stock. Durante la prueba, A57340 recibió +24hs a las 10:02:53 desde otra sesión del staff (en nj el +24hs exige confirmar un modal; no se abrió ninguno).
- **`nj-fyl-testing.vercel.app`:** no se toca en el release interno (decisión 2026-09-29) ni en el cutover; sigue en `dpl_GtM6…` hasta que se decida migrar esos links.

### Runbook de la ventana (aprobado conceptualmente 2026-09-30; ventana y env de Production NO autorizadas todavía)

**Decisiones del usuario (2026-09-30, NEGOCIO CONFIRMADO):**

- Preview previo con secretos temporales exclusivos de Preview (ver «Preview final previo»).
- Solo se mueve `www.fylmoda.com.ar`. El apex `fylmoda.com.ar` queda en `catalogo-definitivo` con su 308 → `www` a nivel dominio (verificado: preserva ruta y query), que tras el cutover apunta a nj.
- Rollback de dominio **preaprobado** para la ventana, solo ante un criterio objetivo: devolver `www` a `catalogo-definitivo` y promover `dpl_BHA4…`, primero restaurar y después informar.
- `kill` por SQL **no** preaprobado: ante un problema solo en FULL, frenar y consultar antes de tocar `rollout_config`.
- El rollback urgente **no** borra variables de Production; esa limpieza se hace después.

**Build:** commit `d5fcd1df139c4f04485be98a7f0f72ebf5c62efd` (código idéntico a `7419ea2`; contiene `af349fb` y `07ea1b4`), desde worktree limpio `E:\PROYECTOS\fyl-cutover` con `.vercel/project.json` (proyecto `nj`, `rootDirectory: nj`) y `.vercelignore`; sin `.env*`.

**Antes:** congelar push a `main` (auto-deploy de catalogo1), deploys de Firebase/Vercel, Supabase Auth y `rollout_config`. Verificar: producción nj `dpl_BHA4…`; `nj-gonzidel`/`nj-drab` → `dpl_BHA4…`; `nj-fyl-testing` → `dpl_GtM6…`; producción catalogo1 `dpl_J5dwrDkZToajwDay4mUpwtjgzwQA` (`11976e4`) con `www` + apex; 362 `paused`/15/contador vacío/51 seed/0 `quota`. Cargar las 4 variables de Production (la usuaria/el usuario carga los secretos; el agente solo verifica nombres).

**Ventana** (`nj-gonzidel` queda fijo en `dpl_BHA4…` toda la ventana: `www/nj` solo se rompe 5–20 s tras V1 y tras V3):

- V0: re-verificar lo anterior; si difiere, abortar.
- V1: `vercel deploy --prod --skip-domain --yes` encadenado con `vercel alias set nj-mbdzu2ahz-gonzidel.vercel.app nj-gonzidel.vercel.app`. Si el alias falla dos veces: `vercel promote dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP --yes`.
- V2: smoke sobre la URL del deploy (cookies `fyl_vid`/`fyl_exp` firmadas `paused`, `/catalogo` 302, 307 legacy, landings, assets, login admin y tester, logs, 362 sin cambios; sin `/nj`). Si falla: no se promueve, fin sin rollback.
- V3: `vercel promote <deploy> --yes` encadenado con el mismo `alias set`.
- V4: `vercel domains add www.fylmoda.com.ar nj --force` (**nunca** `vercel domains remove`: quita el dominio de la cuenta). Plan B: dashboard de `nj` → Domains → Add, o `vercel alias set <deploy> www.fylmoda.com.ar`.
- V5: chequeo crítico en 2 min (`www/` 200 con assets, login Google, `/admin/orders` desde el admin vanilla, apex 308) y luego el checklist completo.

**Criterios de rollback de dominio:** `www/` caído, 404/5xx o sin estilos > 60 s tras V4; assets `/_next/static` con error; loop `/` ↔ `/catalogo`; login Google de cuenta existente falla o termina fuera de `www`; staff sin acceso a `/admin/orders`, Retiro o Conciliación tras recargar; 5xx sostenidos; landings 404/500; `robots.txt` con `Disallow: /` o `[rollout]` mal configurado sin corrección en 10 min. No son criterio: diferencias visuales menores, demora de GA/Clarity.

**Staff durante la ventana:** sigue normal en `app.fylmoda.com.ar` / `catalogo-fyl-test.web.app`; no usar `www/nj/admin/*` (sobre todo acciones que escriben) hasta el «OK»; no mandar a clientas links a `www/nj` (dan `tester_link`); F5 en pestañas viejas.

**Después:** Search Console (sitemap `www`), observar 24–48 h, verificar 0 grants `quota` a 15 min / 1 h / 24 h; decidir más adelante `nj-gonzidel`, apex en catalogo1, `nj-fyl-testing` y el comodín de Auth.

### Preview final previo (TÉCNICA VERIFICADA, 2026-09-30 10:55–11:30 ART)

- **Deploy:** `dpl_2GUg58h7NwTxcx1bj27Niop68MN3` (`https://nj-gdicplqte-gonzidel.vercel.app`), target preview, commit `d5fcd1d` desde `E:\PROYECTOS\fyl-cutover`; `--build-env`/`--env` `NEXT_PUBLIC_ROLLOUT_ENABLED=1` y `NEXT_PUBLIC_NJ_INDEXING=1`. Build OK (38 s).
- **Secretos temporales (scope Preview, Sensitive):** `SUPABASE_SERVICE_ROLE_KEY` = secret key `nj_preview_temp` (exclusiva del preview) y `ROLLOUT_COOKIE_SECRET` distinto del de Production. Primero se cargaron por error en **Production**; se detectó con `vercel env ls` antes de desplegar y se pasaron a Preview (sin deploy de producción en el medio, sin impacto).
- **Producción sin cambios** (antes y después): producción nj `dpl_BHA4…`; `nj-gonzidel`/`nj-drab` → `dpl_BHA4…`; `nj-fyl-testing` → `dpl_GtM6…`; catalogo1 `dpl_J5dw…` con `www` + apex; `www/nj` con `/nj/_next/*`. Ni siquiera se movió `nj-gonzidel-8021-gonzidel.vercel.app`.
- **Sin sesión (sin visitar `/nj`):** `/` 200 catalog (sin carrito, WhatsApp `5493625172874`); cookies `fyl_vid`, `fyl_exp` firmada `v2.c.-.p.<día>.<firma>` (HttpOnly, Secure, vence a medianoche ART) y `fyl_x=c` → secret key `sb_secret_` + secreto + RPC OK en Vercel (antes solo probado en unit tests); 2da visita mismo visitante; bot sin cookies. Categorías (calzado, ropa, ofertas, lencería, marroquinería) y 3 PDP 200 con canonical `www`. `/catalogo` 302 `/`; `/catalogo/` 308 `/catalogo` → 302 `/` (normalización de barra de Next); `/catalogo/calzado` 302 `/calzado`; `/catalogo.html`, `/index.html`, `/client/*` 307 `/`; `/dashboard` y `/admin/orders` → 302 login. 7 landings, `/styles.css`, `/icons/*`, CSS/JS `/_next/static` 200 con content-type correcto. `noindex` + robots `Disallow: /` (host no canónico); sitemap 13 URLs `www`. GA cargado sin `page_view`; Clarity y Pixel no cargan fuera de `www`. 390 px: 2 columnas, sin overflow.
- **Con sesión (cuenta admin):** Google vuelve al mismo host; `fyl_x=f.a` (full, source admin); PDP con talles y «Agregar al carrito» (no se agregó nada); dashboard (A57551 «Vence 6 oct.»); `/admin/orders` Kanban carga; Retiro: Apartados 55 = 55 `active` con `local_deferred_pickup`; Conciliación carga (377 pendientes, 3.545 conciliados, 12 irregularidades, 162 sin identificar); ficha de producto carga (sin guardar).
- **Base:** `paused`/15, contador vacío, 51 grants seed; **0 grants creados o vinculados** durante el preview.
- **Logs:** 0 respuestas 5xx; 0 `resolve failed`. **5 × `[rollout] mode fetch failed` (TimeoutError)** en ráfagas (11:00:10 y 11:00:42) sobre ~1000 requests: la lectura de `rollout_config` tiene timeout de 800 ms y el middleware corre en el edge (`gru1`) contra Supabase en `us-east-2`. El fallback es seguro (último modo conocido o `paused`; nunca concede full), pero suma hasta 0,8 s en esas requests con cache frío. No bloquea el cutover; mejora posible aparte (p. ej. timeout mayor o no leer el modo en prefetch/RSC). Las 160 `OPTIONS /` → 400 y los `HEAD` → 204 vienen del navegador de prueba.
- **Deuda previa, no regresión:** en ~762 px (tablet) la grilla `.catalogo` de la home genera cientos de columnas de 1 px y queda aplastada; `www/catalogo` (catalogo1 en producción) tiene exactamente lo mismo. Mobile 360–430 y desktop OK.
- **Limpieza (decisión del usuario 2026-09-30):** las 2 variables de Preview, la key `nj_preview_temp` y el deploy del preview se **mantienen hasta la ventana** por si hace falta repetir pruebas; se limpian después del cutover.
- **Timeout de modo (decisión del usuario 2026-09-30):** se acepta para el cutover; la mejora queda como cambio aparte posterior.

### Rollback de Fase 1

- **Rollback de dominio (preaprobado solo ante criterio objetivo):**
  1. `vercel domains add www.fylmoda.com.ar catalogo-definitivo --force` → `www` vuelve a la producción de catalogo1; `www/nj` funciona enseguida porque `nj-gonzidel` sigue en `dpl_BHA4…`. Plan B: `vercel alias set catalogo-definitivo-3u4jv520w-gonzidel.vercel.app www.fylmoda.com.ar` o el dashboard.
  2. `vercel promote dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP --yes` en `nj` (instantáneo).
  3. Verificar: `www/` → 308 `/catalogo`; `/catalogo` 200; `www/nj` 200 con `/nj/_next/…`; `/nj/admin/orders` → 307 `/nj/login`; apex 308; `nj-gonzidel` → `dpl_BHA4…`. Ahí termina la maniobra urgente.
  4. Informar. La limpieza de variables/secrets de rollout de Production se decide después, fuera de la maniobra.
- **`kill` (nj se queda):** `update public.rollout_config set mode = 'kill', updated_at = now(), updated_by = 'fase1-rollback' where id = 1;` — **requiere aprobación explícita en el momento** (no preaprobado). Efecto ≤ 30 s; conserva grants; staff sigue entrando al admin.
- **Impacto:** 362 y grants intactos (sin SQL). Cookies `fyl_*` y `sb-*` quedan en `www`; catalogo1 las ignora. URLs nj rastreadas caen al catch-all de Firebase hasta reenviar sitemap; menor. Site URL y Firebase no se tocan.
- **362_ROLLBACK** no forma parte del rollback de frontend.

### Checklist post-cutover

Home, categorías, búsqueda, filtros, PDP, WhatsApp (`5493625172874`), 360–430 px, login Google/email desde `www` (termina en `www`, nunca en `/nj` ni host de testing), tester existente → full, cuenta sin grant → catalog + aviso, avatar + cerrar sesión, `/dashboard` (full y sin grant), `/nj` (logueada con cuenta seed), landings Firebase, admin nj vía links del admin vanilla (`app.fylmoda.com.ar` → `www/nj/admin/*`), `robots.txt`, `sitemap.xml`, canonical, GA `page_view` + `experience`, Pixel, Clarity `w7h6cytm9j`, logs Vercel/Supabase sin errores, `rollout_daily_counter` vacío, 0 grants `quota`. Sin checkout real en producción sin aprobación.
