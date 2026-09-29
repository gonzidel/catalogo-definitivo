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
- URLs hardcodeadas: `CUSTOMER_DASHBOARD_MESSAGE_URL` (nj) y `357_wa_deadline_reached_taxonomy.sql` → `https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart`; admin vanilla `njUrl()` → `https://www.fylmoda.com.ar/nj/admin/{conciliacion-reembolso,orders,retiro}`; `public-sales.js` y otros arman QR con `${window.location.origin}/customer.html?code=…`; `qz-sign` solo permite origen `catalogo-fyl-test.web.app` / `catalogo-fyl.web.app` (no `www`).

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
| `/admin/{orders,retiro,products,search,conciliacion-reembolso…}` | admin nj (login) |
| `/admin/*.{html,js,css,…}`, `/customer.html`, `/scripts/*`, `/config.prod.js`, `/fyl-flags.json`, `/qz-site.crt`, `/certs/*` | 200 vía rewrite a Firebase (admin vanilla y QR) |
| `/admin` | 307 `/admin/index.html` |
| `/catalogo.html`, `/index.html`, `/client/*` | 307 `/` |
| apex | 308 `www` (existente, a nivel dominio) |

### Decisiones del usuario (2026-09-29)

- Proxy del admin vanilla/QR en nj: **sí** (implementado, ver riesgo 1).
- `NEXT_PUBLIC_NJ_INDEXING=1` en el build del cutover: **sí**.
- Link WhatsApp al dashboard (`nj-fyl-testing`): **sin cambios** en Fase 1.
- Site URL de Supabase Auth → `https://www.fylmoda.com.ar` en la ventana del cutover (con aprobación del cambio).
- Clave server-side: **secret key dedicada `sb_secret_`** para nj (se valida en el paso 4).

### Riesgos nuevos

1. **Admin vanilla y QR en `www` (resuelto en código, sin deploy):** los archivos con extensión no pasan por middleware y nj no los tiene → 404. `legacyHostingRewrites()` / `legacyHostingRedirects()` en `nj/lib/rollout/legacy-hosting.ts`, activos solo con `NEXT_PUBLIC_ROLLOUT_ENABLED=1`: rewrites a Firebase para `/customer.html`, `/scripts/:path*`, `/config.prod.js`, `/fyl-flags.json`, `/qz-site.crt`, `/certs/:path*`, `/admin/<archivo con extensión>`; redirects 307 `/admin` → `/admin/index.html`, `/catalogo.html`, `/index.html` y `/client/*` → `/`. Las rutas del admin nj (sin extensión) no se tocan. Tests con el matcher de Next (3), 182/182, `tsc` y `next build` (bandera 1) OK. La impresión QZ sigue funcionando solo desde el host de Firebase (`qz-sign` no permite `www`); no cambia respecto de hoy.
2. **Desindexación** si falta `NEXT_PUBLIC_NJ_INDEXING=1`.
3. **Ventana `/nj`:** `vercel promote` mueve `nj-gonzidel`; mientras `www` siga en catalogo1, `/nj*` queda proxied a un build con rollout (302 a host `nj-gonzidel`). Mitigación: deploy `--skip-domain`, y promote + mover dominio en la misma ventana (minutos).
4. **Clientas sin cuenta con grant:** 1301 clientas con pedidos no tienen grant (520 activas en 30 días). En `www` con `paused`, si inician sesión quedan en catalog y no ven `/dashboard`. Los links de WhatsApp siguen yendo a `nj-fyl-testing` (deploy aparte, sin rollout), así que el flujo actual no cambia en Fase 1. Cambiar el link a `www/nj/dashboard` daría full `tester_link` a quien lo abra; a `www/dashboard`, catalog. Decisión aparte (el cron SQL necesita aprobación).
5. **Deploy de Firebase publica todo el árbol** (landings + admin vanilla + scripts). Debe salir del working tree principal (su contenido es el vivo, con el WIP de `admin/control.html`) agregando solo los 8 HTML de `f066213`.
6. **Auth:** Site URL = `catalogo-fyl-test.web.app`. Un redirect no permitido termina ahí. Recomendado: cambiar Site URL a `https://www.fylmoda.com.ar` (config de producción, aprobación aparte). El login no se puede probar en la URL `--skip-domain` (no está permitida).
7. `main` auto-despliega `catalogo-definitivo` (sin impacto mientras no se pushee; tras el cutover, un deploy de catalogo1 ya no afecta `www`).
8. 308 cacheadas de `www/` → `/catalogo`: con `max-age=0, must-revalidate` el riesgo de loop es bajo; probar en un navegador que ya visitó `www`. Service workers viejos: nj los desregistra.

### Pasos (cada uno con verificación y punto de rollback)

0. **Pre-chequeo (solo lectura):** `362_rollout_experience_verify.sql` (paused, 15, 51 seed, contador vacío); anotar deploy productivo actual de nj (`dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP`) y de `catalogo-definitivo`; release actual de Firebase.
1. **Deploy Firebase de landings** (independiente, sirve igual con catalogo1): en el repo principal `git checkout f066213 -- <8 html>` → `firebase deploy --only hosting --project catalogo-fyl-test`. Verificar por `www/<landing>`: sin claims, canonical `www`, 200. Rollback: Firebase Console → Hosting → release anterior → Rollback. Riesgo: bajo-medio (publica todo el árbol).
2. **Código:** proxy admin/QR ya commiteado en la rama (riesgo 1). Rollback: revert.
3. **Env de Production en nj** (tabla de arriba). No afecta el deploy vivo hasta un nuevo deploy. Rollback: `vercel env rm`.
4. **`vercel deploy --prod --skip-domain`** desde el worktree. Sobre la URL del deploy: home catalog, `fyl_vid` + `fyl_exp` firmado con `paused` (prueba service key + secreto + RPC), `noindex`, landings/proxies 200, `/catalogo` 302, logs sin `[rollout]`. No visitar `/nj` anónimo. Rollback: no se promueve.
5. **Ventana de cutover** (hora de poco tráfico): (a) `vercel promote <deploy>` en nj; (b) quitar `www` y apex del proyecto `catalogo-definitivo` (Settings → Domains → Remove; **nunca** `vercel domains rm`); (c) agregarlos en `nj` (`www` principal, apex → 308 `www`); (d) Site URL de Supabase Auth → `https://www.fylmoda.com.ar` (dashboard; volver a `https://catalogo-fyl-test.web.app` si se revierte); (e) chequeo rápido: `/`, `/catalogo`, `/revendedoras`, `/admin/index.html`, `/customer.html?code=…`, `/nj` logueada con cuenta seed, login Google. Rollback: ver abajo.
6. **Checklist post-cutover** completo + `_verify` (contador 0, 0 grants quota; `tester_link` solo por usos de `/nj`).
7. Search Console: sitemap `www`; observar 24–48 h (errores Vercel, Supabase logs, GA/Pixel/Clarity).

### Rollback de Fase 1

- **Nivel 1 (problema de experiencia, nj se queda):** `update public.rollout_config set mode = 'kill', updated_at = now(), updated_by = 'fase1-rollback' where id = 1;` (aprobación; efecto ≤ 30 s por instancia; conserva grants). Volver: mismo UPDATE con `mode = 'paused'`.
- **Nivel 2 (volver a catalogo1):** 1) quitar `www` y apex de `nj`; 2) agregarlos a `catalogo-definitivo` (`www` principal, apex 308) — su deploy productivo sigue intacto; 3) `vercel rollback`/`promote` de nj a `dpl_BHA4AYjEo56jbz9B7xstLjrXYZpP` (restaura `www/nj` vía rewrite); 4) quitar `NEXT_PUBLIC_ROLLOUT_ENABLED` de Production para que un deploy futuro no salga con bandera; 5) Site URL de Auth: puede quedar en `www` (catalogo1 no tiene login) o volver a `catalogo-fyl-test.web.app`. Firebase no se toca (landings `www` valen con catalogo1).
- **Impacto:** 362 y grants intactos (sin SQL). Cookies `fyl_*` y `sb-*` quedan en `www`; catalogo1 las ignora; si se reintenta el cutover con el mismo secreto siguen válidas. Indexación: URLs nj rastreadas (`/calzado`…) caen al catch-all de Firebase (200 → `/catalogo`) hasta reenviar sitemap; menor.
- **Verificación:** `www/` → 308 `/catalogo`; `/catalogo` 200; `/nj` 200 (build viejo); `/revendedoras` y `/admin/index.html` 200; `nj-gonzidel` = `dpl_BHA4…`.
- **362_ROLLBACK** no forma parte del rollback de frontend.

### Checklist post-cutover

Home, categorías, búsqueda, filtros, PDP, WhatsApp (`5493625172874`), 360–430 px, login Google/email desde `www` (termina en `www`, nunca en `/nj` ni host de testing), tester existente → full, cuenta sin grant → catalog + aviso, avatar + cerrar sesión, `/dashboard` (full y sin grant), `/nj` (logueada con cuenta seed), landings Firebase, admin nj y vanilla (según decisión 1), `robots.txt`, `sitemap.xml`, canonical, GA `page_view` + `experience`, Pixel, Clarity `w7h6cytm9j`, logs Vercel/Supabase sin errores, `rollout_daily_counter` vacío, 0 grants `quota`. Sin checkout real en producción sin aprobación.
