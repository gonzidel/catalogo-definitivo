# Restaura el dump schema-only en Postgres local. No toca fyl-core.
# Requiere: docker compose up, dumps/fyl-core-schema-only.sql

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Dump = Join-Path $Root "dumps\fyl-core-schema-only.sql"
if (-not (Test-Path $Dump)) { Write-Error "Falta $Dump. Corré dump-schema.ps1 primero." }

Set-Location $Root
docker compose up -d
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  docker exec fyl334-pg pg_isready -U fyl334 -d fyl334 | Out-Null
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ok) { Write-Error "Postgres local no respondió." }

function Invoke-LocalSql([string]$FileInContainer) {
  docker exec -i fyl334-pg psql -U fyl334 -d fyl334 -v ON_ERROR_STOP=1 -f $FileInContainer
  if ($LASTEXITCODE -ne 0) { Write-Error "Falló $FileInContainer" }
}

Invoke-LocalSql "/staging/00-bootstrap.sql"
Invoke-LocalSql "/staging/dumps/fyl-core-schema-only.sql"

$verify = @"
SELECT
  to_regclass('public.public_sales') IS NOT NULL AS public_sales,
  to_regclass('public.local_orders') IS NOT NULL AS local_orders,
  to_regclass('public.local_order_items') IS NOT NULL AS local_order_items,
  to_regclass('public.variant_size_warehouse_stock') IS NOT NULL AS vss,
  to_regclass('public.variant_warehouse_stock') IS NOT NULL AS vws,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='rpc_create_public_sale') AS create_public_sale,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='rpc_update_local_order') AS update_local_order,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='rpc_create_local_order') AS create_local_order,
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='rpc_void_public_sale') AS void_public_sale,
  EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          WHERE c.relname='public_sales' AND t.tgname='trigger_register_local_sale') AS daily_sales_trigger;
"@
docker exec -i fyl334-pg psql -U fyl334 -d fyl334 -c $verify
Write-Host "Restore + verify listos. 334 todavía no aplicada."
