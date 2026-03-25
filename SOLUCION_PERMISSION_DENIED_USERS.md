# Error "permission denied for table users" al editar perfil

Cuando un usuario intenta guardar sus datos en **Mi Perfil**, puede aparecer:

```text
Error: permission denied for table users
```

## Causa

En la base de datos hay un **trigger** `set_customer_auth_provider_trigger` en la tabla `customers` que se ejecuta en cada INSERT/UPDATE. Ese trigger lee la tabla `auth.users` de Supabase para rellenar la columna `auth_provider`. Los permisos de RLS impiden que el usuario autenticado acceda a `auth.users`, por eso falla.

## Solución

Hay que **quitar el trigger** en Supabase para que al guardar el perfil no se intente leer `auth.users`.

### Pasos

1. Entrá al **Dashboard de Supabase** del proyecto.
2. Abrí **SQL Editor**.
3. Copiá y ejecutá el contenido del archivo:
   - **`supabase/canonical/43_fix_permission_denied_users.sql`**
4. Ejecutá el script (Run).

Ese script:

- Elimina el trigger `set_customer_auth_provider_trigger` de la tabla `customers`, así que al guardar el perfil ya no se accede a `auth.users` y el error desaparece.
- Redefine la función del trigger para que, si en el futuro se vuelve a crear el trigger, no vuelva a bloquear la operación.

Después de ejecutarlo, los usuarios deberían poder editar y guardar su perfil sin ver "permission denied for table users".
