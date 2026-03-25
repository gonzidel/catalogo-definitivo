# Error: `permission denied for table users` al guardar el perfil

## Qué es

Al tocar **Guardar y continuar** en el modal de datos (o en Completar perfil), Postgres devuelve ese error. Suele venir del trigger **`validate_customer_user_trigger`** en `public.customers`: comprueba si tu `id` existe en **`auth.users`**, pero la función corría **sin** `SECURITY DEFINER`, así que se ejecutaba con el rol **`authenticated`**, que **no puede leer** `auth.users`.

## Qué hacer (Supabase)

1. Abrí **Supabase Dashboard** → tu proyecto → **SQL Editor**.
2. Ejecutá el script **`supabase/canonical/132_fix_validate_customer_user_security_definer.sql`** (todo el archivo).
3. Probá de nuevo guardar el perfil.

La función `validate_customer_user()` queda como **`SECURITY DEFINER`** con `search_path = public, auth, pg_catalog`, de modo que la validación pueda leer `auth.users` de forma segura.

### Error: `El cliente debe tener un usuario en auth.users o ser creado por admin`

Eso lo lanza el mismo trigger cuando la comprobación contra `auth.users` falla o da “sin filas”. Ejecutá además:

**`supabase/canonical/133_validate_customer_trust_self_uid.sql`**

Así, si `customers.id` coincide con `auth.uid()` (flujo normal del catálogo), **no** hace falta leer `auth.users` y el guardado del perfil debería funcionar.

## Si aún falla

- Revisá si tenés **otro** trigger en `customers` que lea `auth.*` (por ejemplo uno viejo de `auth_provider`). En el repo están documentados fixes en `43_fix_permission_denied_users.sql` y `45_eliminate_auth_dependencies.sql`.
- En **Table Editor** → `customers` → ver triggers activos.
