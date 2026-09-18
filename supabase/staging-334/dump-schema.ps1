# Dump schema-only de fyl-core. Lectura. No aplica 334.
#   $env:FYL_CORE_DB_PASSWORD = "<password dashboard>"
#   powershell -File supabase/staging-334/dump-schema.ps1

$ErrorActionPreference = "Stop"
$OutDir = Join-Path $PSScriptRoot "dumps"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutFile = Join-Path $OutDir "fyl-core-schema-only.sql"

if (-not $env:FYL_CORE_DB_PASSWORD) {
  throw "Seteá FYL_CORE_DB_PASSWORD (Dashboard → Database). No la pegues en un archivo del repo."
}

$image = "postgres:17.6"

function Invoke-PgDump([string]$HostName, [string]$Port, [string]$User) {
  $tmp = Join-Path $OutDir ("tmp-" + [guid]::NewGuid().ToString() + ".sql")
  $arg = @(
    "run", "--rm",
    "-e", "PGPASSWORD=$($env:FYL_CORE_DB_PASSWORD)",
    "-e", "PGSSLMODE=require",
    $image,
    "pg_dump",
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "-h", $HostName,
    "-p", $Port,
    "-U", $User,
    "-d", "postgres",
    "-n", "public",
    "-n", "fyl_private"
  )
  Write-Host "pg_dump $HostName:$Port as $User"
  & docker @arg | Set-Content -Path $tmp -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
    throw "pg_dump exit $LASTEXITCODE contra ${HostName}:${Port}"
  }
  if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -lt 1000) {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
    throw "Dump vacío o demasiado chico contra ${HostName}:${Port}"
  }
  Move-Item -Force $tmp $OutFile
}

try {
  Invoke-PgDump "db.dtfznewwvsadkorxwzft.supabase.co" "5432" "postgres"
} catch {
  Write-Host "Dump directo falló: $($_.Exception.Message)"
  Write-Host "Reintento session pooler us-east-2..."
  Invoke-PgDump "aws-0-us-east-2.pooler.supabase.com" "5432" "postgres.dtfznewwvsadkorxwzft"
}

Write-Host "OK dump: $OutFile ($((Get-Item $OutFile).Length) bytes)"
