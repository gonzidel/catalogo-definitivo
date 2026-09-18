# Staging local 334 (opción 1)

Postgres Docker. Schema-only de fyl-core. **Sin datos reales. Sin tocar producción.**

## 1. Contraseña

En PowerShell (no la guardes en el repo):

```powershell
$env:FYL_CORE_DB_PASSWORD = "<Database password del Dashboard>"
```

## 2. Dump (lectura)

```powershell
powershell -File supabase/staging-334/dump-schema.ps1
```

Si falla, parar y reportar el error exacto.

## 3. Restore local

Docker Desktop tiene que estar abierto.

```powershell
powershell -File supabase/staging-334/restore-and-verify.ps1
```

## 4. Aplicar 334 solo acá

```powershell
Get-Content "supabase/canonical/334_finalize_local_order_to_public_sale.sql" -Raw |
  docker exec -i fyl334-pg psql -U fyl334 -d fyl334 -v ON_ERROR_STOP=1
```

## 5. Paso B

Después de 334 + fixtures, contra `localhost:55434` db `fyl334`.

No conectar F3/F5.
