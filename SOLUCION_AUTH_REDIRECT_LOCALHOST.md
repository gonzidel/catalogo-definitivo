# Redirección a producción al loguearte en localhost

## Qué pasa

Si abrís `http://localhost:5500/index2.html` o `http://localhost:5500/client/dashboard.html` y tras Google / magic link terminás en `https://catalogo-fyl-test.web.app/#`, **Supabase está ignorando el `redirectTo` del código** porque esa URL **no está permitida** en el proyecto. El front ya envía `http://localhost:PUERTO/...`; el bloqueo es **solo** en el panel de Supabase.

## Qué hacer en Supabase (obligatorio)

1. **Supabase Dashboard** → tu proyecto → **Authentication** → **URL configuration**.
2. En **Redirect URLs**, agregá **al menos una** de estas opciones:

### Opción A – Wildcard (la más cómoda en dev)

- `http://localhost:5500/**`  
  (cambia `5500` si tu Live Server usa otro puerto)

Si a veces abrís el sitio con **127.0.0.1**, agregá también:

- `http://127.0.0.1:5500/**`

### Opción B – URLs exactas

- `http://localhost:5500/index2.html`
- `http://localhost:5500/client/dashboard.html`
- `http://localhost:5500/client/login.html` (por si entrás al login directo)
- Repetí las mismas rutas con `http://127.0.0.1:5500/...` si usás esa IP

3. Pulsá **Save** y probá de nuevo en una ventana de incógnito (evita caché vieja).

## Cómo ver la URL que envía el front

En localhost, al cargar `index2` la consola muestra **`[FYL Dev]`** con la lista sugerida. Al iniciar OAuth o magic link aparece **`[FYL Auth]`** con la URL exacta de `redirectTo` / `emailRedirectTo`.

## Después del login: volver a `index2.html#/`

El código guarda el hash (`#/`) antes del OAuth y lo restaura al volver; solo funciona si Supabase te devuelve a **localhost**, no a producción.

## Más detalle

Ver también **DEPLOY.md** → sección *Auth: URLs de redirección*.
