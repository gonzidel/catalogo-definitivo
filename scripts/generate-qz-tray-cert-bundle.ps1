#requires -Version 5.1
<#
.SYNOPSIS
  Genera un bundle QZ Tray completo: RSA 2048, cert PEM con SAN multi-dominio,
  PKCS#12, PKCS#8 DER Base64 (Supabase), qz-site.crt y override.crt para el repo.

.DESCRIPTION
  NO modifica frontend ni JS. Los secretos salen solo bajo -OutDir (por defecto %TEMP%).
  Opcionalmente copia certs publicos a certs/ del repo con -DeployPublicCerts.

.PARAMETER OutDir
  Carpeta segura para key.pem, .p12 y QZ_PRIVATE_KEY_B64.txt (no commitear).

.PARAMETER DeployPublicCerts
  Si se indica, copia certs/qz-site.crt y certs/override.crt desde el PEM generado.

.PARAMETER P12Password
  Password del .p12 (default changeit). Tambien: $env:QZ_P12_PASSWORD
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [switch]$DeployPublicCerts,
  [string]$P12Password = ''
)

$ErrorActionPreference = 'Stop'

function Get-OpenSslPath {
  $cmd = Get-Command openssl -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($p in @(
      'C:\Program Files\Git\usr\bin\openssl.exe',
      'C:\Program Files\OpenSSL-Win64\bin\openssl.exe',
      'C:\OpenSSL-Win64\bin\openssl.exe'
    )) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  throw 'OpenSSL no encontrado (Git for Windows u OpenSSL).'
}

function Invoke-OpenSsl {
  param([string]$Exe, [string[]]$ArgList)
  $o = & $Exe @ArgList 2>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() }
    else { $_.ToString() }
  }
  if ($LASTEXITCODE -ne 0) {
    throw ("OpenSSL error " + $LASTEXITCODE + ": " + ($o -join "`n"))
  }
  return ($o -join "`n")
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$cnfPath = Join-Path $PSScriptRoot 'openssl-qz-tray-san.cnf'
if (-not (Test-Path -LiteralPath $cnfPath)) {
  throw "Falta la plantilla: $cnfPath"
}

if (-not $OutDir) {
  $OutDir = Join-Path $env:TEMP ('qz-tray-cert-' + [Guid]::NewGuid().ToString('N'))
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$pass = $P12Password
if (-not $pass) { $pass = [Environment]::GetEnvironmentVariable('QZ_P12_PASSWORD', 'Process') }
if (-not $pass) { $pass = 'changeit' }

$keyPem = Join-Path $OutDir 'qz-tray-private.pem'
$certPem = Join-Path $OutDir 'qz-tray-cert.pem'
$p12Path = Join-Path $OutDir 'qz-certificate.p12'
$pk8Der = Join-Path $OutDir 'private.pk8.der'
$b64Path = Join-Path $OutDir 'QZ_PRIVATE_KEY_B64.txt'

$openssl = Get-OpenSslPath

try {
  Invoke-OpenSsl $openssl @('genrsa', '-out', $keyPem, '2048')
  Invoke-OpenSsl $openssl @(
    'req', '-new', '-x509',
    '-sha256',
    '-key', $keyPem,
    '-out', $certPem,
    '-days', '825',
    '-config', $cnfPath,
    '-extensions', 'v3_req'
  )
  Invoke-OpenSsl $openssl @(
    'pkcs8', '-topk8', '-nocrypt',
    '-in', $keyPem,
    '-outform', 'DER',
    '-out', $pk8Der
  )
  $derBytes = [System.IO.File]::ReadAllBytes($pk8Der)
  $b64 = [Convert]::ToBase64String($derBytes)
  [System.IO.File]::WriteAllText($b64Path, ($b64 -replace '\s', ''), (New-Object System.Text.UTF8Encoding $false))

  Invoke-OpenSsl $openssl @(
    'pkcs12', '-export',
    '-out', $p12Path,
    '-inkey', $keyPem,
    '-in', $certPem,
    '-passout', "pass:$pass",
    '-name', 'QZ Tray Certificate'
  )

  $repoQzSite = Join-Path $repoRoot 'certs\qz-site.crt'
  $repoOverride = Join-Path $repoRoot 'certs\override.crt'

  if ($DeployPublicCerts) {
    Copy-Item -LiteralPath $certPem -Destination $repoQzSite -Force
    Copy-Item -LiteralPath $certPem -Destination $repoOverride -Force
  }

  $fpRaw = Invoke-OpenSsl $openssl @('x509', '-in', $certPem, '-noout', '-fingerprint', '-sha256')
  $fpLine = ''
  if ($fpRaw) {
    $fpLine = ($fpRaw -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match 'Fingerprint|sha256' } | Select-Object -First 1)
    if (-not $fpLine) { $fpLine = ($fpRaw.Trim()) }
  }
  Write-Host ''
  Write-Host '=== Bundle QZ Tray (SAN multi-dominio) ===' -ForegroundColor Cyan
  Write-Host "OpenSSL: $openssl"
  Write-Host "Salida (SECRETO - no commitear OutDir): $OutDir"
  Write-Host ''
  Write-Host 'Archivos:' -ForegroundColor White
  Write-Host "  Clave PEM:        $keyPem"
  Write-Host "  Cert PEM:         $certPem"
  Write-Host "  PKCS#12:          $p12Path"
  Write-Host "  QZ_PRIVATE_KEY_B64: $b64Path"
  Write-Host ''
  if ($fpLine) { Write-Host $fpLine } else { Write-Host '(Huella: ejecutar openssl x509 -in cert -noout -fingerprint -sha256)' -ForegroundColor DarkYellow }
  Write-Host ''
  Write-Host 'Longitud Base64 (PKCS#8 DER):' $b64.Length
  Write-Host ''
  if ($DeployPublicCerts) {
    Write-Host "Desplegado en repo: $repoQzSite , $repoOverride" -ForegroundColor Green
  } else {
    Write-Host 'Para copiar certificados publicos al repo:' -ForegroundColor Yellow
    Write-Host "  .\scripts\generate-qz-tray-cert-bundle.ps1 -DeployPublicCerts -OutDir `"$OutDir`"" -ForegroundColor Gray
    Write-Host '  (reusa la misma OutDir si ya generaste; o volve a ejecutar con -DeployPublicCerts)' -ForegroundColor DarkGray
  }
  Write-Host ''
  Write-Host 'Siguiente: docs/QZ-CERT-MULTI-SAN-MIGRATION.md (secret Supabase, deploy Firebase, QZ Tray).' -ForegroundColor Cyan
  Write-Host ''
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
