# 63 — Redirect vanilla `app.fylmoda.com.ar/catalogo` → `www` — 2026-09-08

El catálogo canónico de clientas es Next `catalogo1/` en `https://www.fylmoda.com.ar/catalogo`. `https://app.fylmoda.com.ar/catalogo` seguía sirviendo el HTML vanilla de Firebase (200, ETag del 2026-09-05).

## Qué cambió

| Ruta Firebase | Antes | Ahora |
|---|---|---|
| `/`, `/index.html`, `/catalogo`, `/catalogo.html`, `/catalogo/**` | vanilla `catalogo.html` | 301 `https://www.fylmoda.com.ar/catalogo` |
| `/client/dashboard*` | 302 `/catalogo` (vanilla) | 302 al mismo canónico `www` |
| `app.fylmoda.com.ar/admin/**` | admin vanilla | **sin cambio** |
| Landings SEO (`/calzado-femenino-por-mayor`, etc.) | rewrite a `.html` | **sin cambio** |

Respaldo: `catalogo.html` redirige por JS a `www` salvo `localhost` (caché CDN `max-age=3600` y service workers viejos).

En Vercel (`catalogo1/vercel.json`): `/catalogo.html` 308 → `/catalogo` para no filtrar vanilla por el catch-all hacia Firebase.

## Por qué

`app.fylmoda.com.ar` es el custom domain de Firebase Hosting (`catalogo-fyl`, IP 199.36.158.100). `www` es Vercel. El vanilla ya no es el flujo público ([[56-FRONTENDS-CATALOGO-VS-NJ-2026-09-04]]).

## Riesgo / rollback

- **Riesgo:** bajo. Solo routing. Admin y landings siguen en Firebase.
- **Rollback:** restaurar redirects `/` y `/index.html` → `/catalogo`, rewrites `/catalogo` → `/catalogo.html`, quitar el script de `catalogo.html`, redesplegar hosting.
- **Hops:** `/catalogo` en `catalogo-fyl.web.app` y `app.` van 301 directo a `www`. Admin en `app.` no redirige.

## Estado

**Live 2026-09-08.** Deploy hosting desde worktree HEAD + overlay (`firebase.json` sin `predeploy`, `catalogo.html`), proyectos `catalogo-fyl` y `catalogo-fyl-test`. Working tree sucio no se publicó.

Verificado:

| URL | Resultado |
|---|---|
| `https://app.fylmoda.com.ar/catalogo` | 301 → `https://www.fylmoda.com.ar/catalogo` (Next 200) |
| `https://app.fylmoda.com.ar/` | 301 → mismo destino |
| `https://app.fylmoda.com.ar/catalogo.html` | 301 → mismo destino |
| `https://app.fylmoda.com.ar/admin/index.html` | 200 admin vanilla |

```text
curl -sI https://app.fylmoda.com.ar/catalogo
# Location: https://www.fylmoda.com.ar/catalogo

curl -sI https://app.fylmoda.com.ar/admin/index.html
# 200 admin vanilla
```

## Referencias

- `firebase.json`, `catalogo.html`, `catalogo1/vercel.json`
- [[56-FRONTENDS-CATALOGO-VS-NJ-2026-09-04]]
