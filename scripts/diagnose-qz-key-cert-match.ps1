#requires -Version 5.1
<#
.SYNOPSIS
  Diagnóstico LOCAL: verifica si QZ_PRIVATE_KEY_B64 (Supabase) forma par RSA con certs/qz-site.crt.

.DESCRIPTION
  Compara módulo RSA del certificado público con el de la clave privada decodificada.
  No modifica Supabase ni certificados. No guarda secretos en el repo.
  No imprime la clave privada PEM completa (solo módulo y huella del cert).

.USAGE — Opción A (variable de entorno, solo esta ventana de PowerShell)
  $env:QZ_PRIVATE_KEY_B64 = '<pegar Base64 del secreto Supabase>'
  .\scripts\diagnose-qz-key-cert-match.ps1

.USAGE — Opción B (archivo temporal fuera del repo; recomendado si el valor es muy largo)
  notepad $env:TEMP\qz-private-b64.txt
  # Pegar SOLO el Base64 (una línea o varias), guardar y cerrar.
  .\scripts\diagnose-qz-key-cert-match.ps1 -B64File "$env:TEMP\qz-private-b64.txt"
  Remove-Item "$env:TEMP\qz-private-b64.txt" -ErrorAction SilentlyContinue

.PARAMETER CertPath
  Ruta al PEM del certificado (por defecto: certs\qz-site.crt junto al repo).

.PARAMETER B64File
  Archivo de texto con el Base64 de la clave (alternativa a la variable de entorno).
#>
[CmdletBinding()]
param(
  [string]$CertPath = '',
  [string]$B64File = ''
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
  throw 'OpenSSL no encontrado. Instalá Git for Windows (incluye openssl) u OpenSSL y/o agregá openssl al PATH.'
}

function Invoke-OpenSsl {
  param([string]$OpenSslExe, [string[]]$ArgList)
  $combined = & $OpenSslExe @ArgList 2>&1 | ForEach-Object { $_.ToString() }
  if ($LASTEXITCODE -ne 0) {
    $msg = if ($combined) { $combined -join ' ' } else { '(sin salida)' }
    throw "OpenSSL falló (código $LASTEXITCODE): $msg"
  }
  return ($combined -join "`n")
}

function Get-ModulusFromOpenSslOutput {
  param([string]$Text)
  foreach ($line in $Text -split "`n") {
    $t = $line.Trim()
    if ($t.StartsWith('Modulus=')) {
      return ($t.Substring('Modulus='.Length).Trim().ToUpperInvariant())
    }
  }
  return $null
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $CertPath) {
  $CertPath = Join-Path $repoRoot 'certs\qz-site.crt'
}
$CertPath = (Resolve-Path -LiteralPath $CertPath).Path

$b64Raw = $null
if ($B64File) {
  if (-not (Test-Path -LiteralPath $B64File)) { throw "No existe B64File: $B64File" }
  $b64Raw = Get-Content -LiteralPath $B64File -Raw
} else {
  $b64Raw = [Environment]::GetEnvironmentVariable('QZ_PRIVATE_KEY_B64', 'Process')
  if (-not $b64Raw) {
    $b64Raw = [Environment]::GetEnvironmentVariable('QZ_PRIVATE_KEY_B64', 'User')
  }
  if (-not $b64Raw) {
    $b64Raw = [Environment]::GetEnvironmentVariable('QZ_PRIVATE_KEY_B64', 'Machine')
  }
}

if ([string]::IsNullOrWhiteSpace($b64Raw)) {
  Write-Host ''
  Write-Host 'Falta el valor Base64 de la clave.' -ForegroundColor Yellow
  Write-Host '  Opción A:  $env:QZ_PRIVATE_KEY_B64 = ''...''  ; luego ejecutá de nuevo este script.' -ForegroundColor Gray
  Write-Host "  Opción B:  .\diagnose-qz-key-cert-match.ps1 -B64File `"$env:TEMP\qz-private-b64.txt`"" -ForegroundColor Gray
  Write-Host ''
  exit 2
}

$b64OneLine = ($b64Raw -replace '\s', '').Trim()
try {
  $keyBytes = [Convert]::FromBase64String($b64OneLine)
} catch {
  if ($b64Raw -match '-----BEGIN') {
    $enc = New-Object System.Text.UTF8Encoding $false
    $keyBytes = $enc.GetBytes($b64Raw.Trim())
  } else {
    throw 'QZ_PRIVATE_KEY_B64 no es Base64 valido. Si pegaste PEM plano, debe incluir -----BEGIN ...-----END.'
  }
}

$workDir = Join-Path $env:TEMP ("qz-key-cert-diag-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null
$keyPemPath = Join-Path $workDir 'private-import.pem'

try {
  [System.IO.File]::WriteAllBytes($keyPemPath, $keyBytes)

  $openssl = Get-OpenSslPath

  $certModOut = Invoke-OpenSsl $openssl @('x509', '-in', $CertPath, '-noout', '-modulus')
  $certFpOut = Invoke-OpenSsl $openssl @('x509', '-in', $CertPath, '-noout', '-fingerprint', '-sha256')
  $certMod = Get-ModulusFromOpenSslOutput $certModOut
  if (-not $certMod) { throw 'No se pudo leer Modulus del certificado.' }

  $keyMod = $null
  $keyErr = ''
  foreach ($tryArgs in @(
      @('pkey', '-in', $keyPemPath, '-noout', '-modulus'),
      @('rsa', '-in', $keyPemPath, '-noout', '-modulus'),
      @('pkey', '-inform', 'DER', '-in', $keyPemPath, '-noout', '-modulus'),
      @('rsa', '-inform', 'DER', '-in', $keyPemPath, '-noout', '-modulus')
    )) {
    try {
      $keyModOut = Invoke-OpenSsl $openssl @($tryArgs)
      $keyMod = Get-ModulusFromOpenSslOutput $keyModOut
      if ($keyMod) { break }
    } catch {
      $keyErr = $_.Exception.Message
    }
  }
  if (-not $keyMod) {
    throw "No se pudo leer Modulus de la clave privada (PEM PKCS#8/RSA tradicional o DER RSA). Ultimo error: $keyErr"
  }

  Write-Host ''
  Write-Host '--- QZ diagnóstico clave ↔ cert (local) ---' -ForegroundColor Cyan
  Write-Host "Cert:     $CertPath"
  Write-Host "OpenSSL:  $openssl"
  Write-Host ''
  Write-Host 'Fingerprint cert (SHA-256):' -ForegroundColor White
  Write-Host ($certFpOut.Trim())
  Write-Host ''
  Write-Host 'Modulus (cert):' -ForegroundColor White
  Write-Host $certMod
  Write-Host ''
  Write-Host 'Modulus (key):' -ForegroundColor White
  Write-Host $keyMod
  Write-Host ''

  if ($certMod -eq $keyMod) {
    Write-Host 'Resultado: MATCH' -ForegroundColor Green
    Write-Host '(El módulo RSA del certificado y de la clave privada coinciden.)' -ForegroundColor DarkGreen
    $exit = 0
  } else {
    Write-Host 'Resultado: MISMATCH' -ForegroundColor Red
    Write-Host '(El módulo RSA no coincide: revisá el secreto en Supabase o el cert desplegado.)' -ForegroundColor DarkYellow
    $exit = 1
  }
  Write-Host ''
} finally {
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}

exit $exit
