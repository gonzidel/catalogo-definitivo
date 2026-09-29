# 72 — Rollout `full` / `catalog` en nj — Fase 0 — 2026-09-29

> **Estado:** Fase 0 terminada en rama `feat/nj-rollout-fase0` (worktree `E:\PROYECTOS\fyl-rollout-fase0`, rebaseada sobre `af349fb` = `fix/customer-link-nj-onboarding` con `origin/main` integrado; commit local, sin push).
> **Nada aplicado en producción:** migración 362 sin aplicar, dominio sin mover, sin deploy productivo (solo preview), sin indexación, sin 301.
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
- Aviso a cuenta logueada que sigue en catalog (aprobado 2026-09-29, reemplaza al anterior «Por ahora podés…»): «¡Listo, ya ingresaste! 👋 Podés seguir viendo el catálogo y consultarnos por WhatsApp cuando quieras.» Aparece tras el login y al tocar el avatar en catalog.

## Base de datos — `supabase/canonical/362_*` (NO aplicada)

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

**`open_all` inmediato:** en nj, `evaluateSigned(signed, today, mode)` ignora el `catalog` firmado del día cuando el modo es `open_all`, así que la siguiente navegación de documento vuelve a resolver (una RPC por visitante, después queda `full` firmado; RSC/prefetch/bots siguen sin consultar). En SQL, `rpc_rollout_link_user` crea un grant `open_all` para la cuenta sin grant que inicia sesión en ese modo. Demora máxima: cache del modo (≤ 30 s por instancia).

**Revisión previa (2026-09-29, sin aplicar en producción):**
- Producción (solo lectura): 51 cuentas = 1 admin / 9 staff / 41 tester; 0 objetos `rollout_*`; `service_role` con BYPASSRLS y `SELECT` sobre `public.admins`; los default ACL de `public` otorgan todo a anon/authenticated en tablas nuevas (por eso el `REVOKE ALL` explícito).
- Postgres 17.6 local con la misma composición: aplica, reaplica (idempotente, seed 0 filas nuevas), `_tests` → `362 tests OK`, `_verify` según lo esperado, rollback limpio (0 objetos, `auth.users`/`admins` intactos) y reaplicación posterior OK.
- Segunda revisión (ajustes del usuario): guarda sin `SELECT` → aborta con 0 objetos; grupo previo de 52 → aborta con 0 objetos; 2 altas posteriores al corte (una exactamente en el corte) → sin seed; reaplicar con un grant revocado → sigue revocado; `_tests` ampliados (login en `open_all`, alta posterior en `paused`) → OK antes y después de rollback/reaplicación; nj 176/176 tests, tsc y build OK.
- Concurrencia: cupo 15 con 60 visitantes en paralelo → 15 `quota` / 45 `quota_full`; 20 requests simultáneos del mismo visitante → 1 grant (1 `quota` + 19 `existing_grant`); 20 cruces `resolve`/`link_user` de la misma cuenta y dispositivo → 1 grant activo, sin deadlocks. Contador = grants quota.
- **Dependencia:** las RPC son `SECURITY INVOKER`: requieren que `service_role` conserve `SELECT` en `public.admins` (sin eso fallan con `permission denied` y nj cae a catalog sin firmar).
- **Límite conocido:** el cupo es por `visitor_id`/cuenta. Un dispositivo nuevo sin sesión (o cookies borradas) es un visitante nuevo y puede consumir otro cupo en modo `quota`; el total diario nunca supera `daily_quota`.
- **Revocación:** `revoked_at` se refleja cuando nj revalida el full firmado (hasta 7 días) o al rotar `ROLLOUT_COOKIE_SECRET`; `kill` es inmediato (cache de modo ≤ 30 s).

## Código nj

- **Bandera única:** `NEXT_PUBLIC_ROLLOUT_ENABLED=1` (server + boot script; requiere rebuild). Apagada = nj exactamente como antes (todos `full`, sin cookies, `html[data-exp="full"]` en SSR).
- **Middleware** (`nj/middleware.ts`): decide server-side; bots, prefetch/RSC y landings Firebase nunca resuelven. RPC 1 vez por visitante/día (catalog) o cada 7 días (full).
- **Cookies:** `fyl_vid` (httpOnly, UUID), `fyl_exp` (httpOnly, HMAC-SHA256 sobre `v1|vid|exp|src|day`; única que habilita `/dashboard`), `fyl_x` (espejo legible, solo UI), `fyl_notice` (120 s). `catalog` vence a medianoche ART; `full` 400 días.
- **UI sin flash:** script inline en `<head>` fija `html[data-exp]`; variantes por CSS (`exp-full-only` / `exp-catalog-only`); `FullOnly` para componentes con efectos (carrito, onboarding, notificaciones). Sin atributo = catalog.
- **Catalog:** WhatsApp en Header/BottomNav/PDP (número de catalogo1 `5493625172874`, ver contradicción), talles solo lectura, sin carrito ni “Pedido”, FAQ/cómo usar/quiénes somos de catalogo1.
- **Auth callback:** vincula la cuenta (`rpc_rollout_link_user`); sin grant → vuelve a `/` en catalog con aviso (en `open_all` la cuenta recibe grant y entra a `full`).
- **Catalog firmado y `open_all`:** un `catalog` firmado del día no vale en `open_all`; se vuelve a resolver en la siguiente navegación de documento.
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

Hallazgos del preview (sin cambios, fuera de alcance): las landings Firebase conservan canonical apex (`https://fylmoda.com.ar/...`) y afirman “fábrica propia” / “786+ artículos”; se corrigen solo con deploy de Firebase.

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
- **Pendiente Fase 1 — landings Firebase (no modificadas):** afirman “fábrica propia” (y “producción nacional”, “precio de fábrica”), muestran “786+ artículos” y declaran canonical apex `https://fylmoda.com.ar/...` en vez de `www`. Requiere cambio del HTML en el repo + deploy de Firebase, con aprobación.
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

## Fase 1 (no ejecutada) — orden propuesto

1. Integrar ramas; aplicar 362 con modo `paused` (aprobación explícita, SQL exacto).
2. Env prod nj: `SUPABASE_SERVICE_ROLE_KEY`, `ROLLOUT_COOKIE_SECRET` (≥32), `NEXT_PUBLIC_ROLLOUT_ENABLED=1`, `NEXT_PUBLIC_SITE_URL` vacío o `www`; `NEXT_PUBLIC_NJ_INDEXING=1` solo si se decide indexar el día del cambio.
3. Asignar `www` al proyecto nj **en el mismo redeploy** que activa la bandera (con `www` aún en catalogo1, `/nj`→`/` rompe el rewrite actual).
4. Supabase Auth Redirect URLs para el preview/host (cambio de config prod: aprobar aparte).
5. Verificar con `362_rollout_experience_verify.sql`; pasar a `quota` recién en Fase 2.

**Rollback:** modo `kill` (o `ROLLOUT_FORCE_MODE=kill` sin base) → todos catalog sin borrar grants; bandera en 0 + redeploy → nj actual; devolver `www` a catalogo1; `362_ROLLBACK` solo tras `kill` y rotando `ROLLOUT_COOKIE_SECRET`.
