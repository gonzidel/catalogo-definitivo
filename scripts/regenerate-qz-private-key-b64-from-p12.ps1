#requires -Version 5.1
<#
.SYNOPSIS
  Regenera QZ_PRIVATE_KEY_B64 (PKCS#8 DER en Base64) desde C:\qz\qz-certificate.p12, alineado con certs/qz-site.crt.

.DESCRIPTION
  - No regenera certificados ni modifica qz-site.crt.
  - No imprime la clave privada completa.
  - Escribe un .txt en %TEMP% con una sola linea Base64 lista para Supabase.
  - Borra PEM/DER intermedios; conserva solo el archivo de salida (y esta carpeta vaciable).

.USAGE
  cd "ruta\al\repo"
  .\scripts\regenerate-qz-private-key-b64-from-p12.ps1

  Contrasenia del .p12: por defecto "changeit". Para no pasarla en claro en parametros:
    $env:QZ_P12_PASSWORD = 'changeit'
    .\scripts\regenerate-qz-private-key-b64-from-p12.ps1

.PARAMETER P12Path
  Ruta al PKCS#12 (por defecto C:\qz\qz-certificate.p12).

.PARAMETER CertPath
  Certificado publico del sitio (por defecto certs\qz-site.crt en el repo).

.PARAMETER P12Password
  Contrasenia del .p12 si no usas QZ_P12_PASSWORD.
#>
[CmdletBinding()]
param(
  [string]$P12Path = 'C:\qz\qz-certificate.p12',
  [string]$CertPath = '',
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
  throw 'OpenSSL no encontrado. Instalá Git for Windows u OpenSSL.'
}

function Invoke-OpenSsl {
  param([string]$OpenSslExe, [string[]]$ArgList)
  $combined = & $OpenSslExe @ArgList 2>&1 | ForEach-Object { $_.ToString() }
  if ($LASTEXITCODE -ne 0) {
    $msg = if ($combined) { $combined -join "`n" } else { '(sin salida)' }
    throw "OpenSSL fallo (codigo $LASTEXITCODE):`n$msg"
  }
  return ($combined -join "`n")
}

function Get-ModulusHex {
  param([string]$OpenSslExe, [string[]]$ArgList)
  $text = Invoke-OpenSsl $OpenSslExe $ArgList
  foreach ($line in $text -split "`n") {
    $t = $line.Trim()
    if ($t.StartsWith('Modulus=')) {
      return $t.Substring('Modulus='.Length).Trim().ToUpperInvariant()
    }
  }
  return $null
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $CertPath) {
  $CertPath = Join-Path $repoRoot 'certs\qz-site.crt'
}
$CertPath = (Resolve-Path -LiteralPath $CertPath).Path
if (-not (Test-Path -LiteralPath $P12Path)) {
  throw "No existe el PKCS#12: $P12Path"
}

$pass = $P12Password
if (-not $pass) { $pass = [Environment]::GetEnvironmentVariable('QZ_P12_PASSWORD', 'Process') }
if (-not $pass) { $pass = [Environment]::GetEnvironmentVariable('QZ_P12_PASSWORD', 'User') }
if (-not $pass) { $pass = 'changeit' }

$openssl = Get-OpenSslPath
$workDir = Join-Path $env:TEMP ('qz-b64-regen-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null

$pemExtracted = Join-Path $workDir '_extracted-key.pem'
$derPkcs8 = Join-Path $workDir '_pkcs8.der'
$outB64File = Join-Path $workDir 'QZ_PRIVATE_KEY_B64_para_Supabase.txt'

try {
  $null = Invoke-OpenSsl $openssl @(
    'pkcs12', '-in', $P12Path,
    '-nocerts', '-nodes',
    '-passin', "pass:$pass",
    '-out', $pemExtracted
  )

  $null = Invoke-OpenSsl $openssl @(
    'pkcs8', '-topk8', '-nocrypt',
    '-in', $pemExtracted,
    '-outform', 'DER',
    '-out', $derPkcs8
  )

  # Modulus: x509 y rsa soportan -modulus en OpenSSL/LibreSSL viejos; pkey -modulus no (ej. LibreSSL en Git).
  $certMod = Get-ModulusHex $openssl @('x509', '-in', $CertPath, '-noout', '-modulus')
  $keyMod = $null
  try {
    $keyMod = Get-ModulusHex $openssl @('rsa', '-in', $pemExtracted, '-noout', '-modulus')
  } catch {
    $keyMod = $null
  }
  if (-not $keyMod) {
    $keyPemCheck = Join-Path $workDir '_key-modulus-check.pem'
    try {
      $null = Invoke-OpenSsl $openssl @('pkcs8', '-inform', 'DER', '-nocrypt', '-in', $derPkcs8, '-out', $keyPemCheck)
      $keyMod = Get-ModulusHex $openssl @('rsa', '-in', $keyPemCheck, '-noout', '-modulus')
    } finally {
      if (Test-Path -LiteralPath $keyPemCheck) { Remove-Item -LiteralPath $keyPemCheck -Force -ErrorAction SilentlyContinue }
    }
  }
  if (-not $certMod -or -not $keyMod) {
    throw 'No se pudo calcular modulus del cert o de la clave (rsa -modulus / pkcs8 DER -> PEM).'
  }

  $derBytes = [System.IO.File]::ReadAllBytes($derPkcs8)
  $b64 = [Convert]::ToBase64String($derBytes)
  $b64Clean = ($b64 -replace '\s', '')
  [System.IO.File]::WriteAllText($outB64File, $b64Clean, (New-Object System.Text.UTF8Encoding $false))

  $fpOut = Invoke-OpenSsl $openssl @('x509', '-in', $CertPath, '-noout', '-fingerprint', '-sha256')
  $fpLine = ($fpOut -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 1)

  Remove-Item -LiteralPath $pemExtracted -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $derPkcs8 -Force -ErrorAction SilentlyContinue

  Write-Host ''
  Write-Host '=== Regeneracion QZ_PRIVATE_KEY_B64 (PKCS#8 DER -> Base64) ===' -ForegroundColor Cyan
  Write-Host "PKCS#12:  $P12Path"
  Write-Host "Cert:     $CertPath"
  Write-Host "OpenSSL:  $openssl"
  Write-Host ''
  Write-Host 'Fingerprint cert (SHA-256):' -ForegroundColor White
  Write-Host $fpLine
  Write-Host ''
  Write-Host 'Longitud Base64 (una linea):' -ForegroundColor White
  Write-Host $b64Clean.Length
  Write-Host ''
  Write-Host 'Modulus (cert):' -ForegroundColor White
  Write-Host $certMod
  Write-Host ''
  Write-Host 'Modulus (clave PKCS#8 DER):' -ForegroundColor White
  Write-Host $keyMod
  Write-Host ''

  if ($certMod -ne $keyMod) {
    Write-Host 'Resultado: MISMATCH (no subir este secreto; revisar .p12 vs cert).' -ForegroundColor Red
    Remove-Item -LiteralPath $outB64File -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
  }

  Write-Host 'Resultado: MATCH' -ForegroundColor Green
  Write-Host ''
  Write-Host 'Archivo temporal (solo Base64, sin PEM de clave):' -ForegroundColor Yellow
  Write-Host $outB64File
  Write-Host ''
  Write-Host 'Abri el archivo, copiar TODO a Supabase como QZ_PRIVATE_KEY_B64. Luego borrar el archivo.' -ForegroundColor DarkYellow
  Write-Host ''

  Write-Host '--- INSTRUCCIONES ---' -ForegroundColor Cyan
  Write-Host @'

1) Reemplazar QZ_PRIVATE_KEY_B64 en Supabase
   - Dashboard: Project Settings -> Edge Functions -> Secrets -> QZ_PRIVATE_KEY_B64 -> Edit -> pegar el contenido del .txt (una sola linea).
   - CLI (PowerShell, desde una carpeta con supabase link):
       $v = Get-Content -Raw "RUTA_AL_TXT_GENERADO"
       supabase secrets set "QZ_PRIVATE_KEY_B64=$v" --project-ref TU_PROJECT_REF
     (Sin comillas extra dentro del valor; el archivo ya es una linea.)

2) Redeploy de la Edge Function qz-sign
   - supabase functions deploy qz-sign --project-ref TU_PROJECT_REF
   - Esperar a que el deploy termine; los secretos nuevos aplican en la proxima invocacion.

3) Limpiar cache / trust local QZ Tray (cliente Windows)
   - Cerrar QZ Tray por completo (icono bandeja -> Exit).
   - Opcional: respaldar y vaciar datos de sitios en %APPDATA%\qz si sigue rechazando firma antigua (allowed.dat / prefs segun version).
   - Si usas authcert.override en Program Files, no hace falta tocar certificados del sitio; igual conviene reiniciar QZ tras cambiar la firma en servidor.
   - Volver a abrir QZ Tray.

4) Volver a probar
   - Hard refresh en el navegador (Ctrl+F5) en la URL del admin que imprime.
   - Reintentar impresion; revisar consola [QZ] / Network hacia qz-sign (200 y firma en texto plano).

'@
  Write-Host ''
  exit 0
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  if (Test-Path -LiteralPath $workDir) {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  exit 1
} finally {
  if (Test-Path -LiteralPath $pemExtracted) { Remove-Item -LiteralPath $pemExtracted -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $derPkcs8) { Remove-Item -LiteralPath $derPkcs8 -Force -ErrorAction SilentlyContinue }
}
