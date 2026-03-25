# verify-modulus.ps1
# Verifica que el certificado y la clave privada coincidan

$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"
$certPath = "certs\qz-site.crt"
$p12Path = "C:\qz\qz-certificate.p12"
$privateKeyPath = "qz-private.pem"

Write-Host "🔍 Verificando coincidencia certificado/clave privada..." -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $openssl)) {
    Write-Host "❌ OpenSSL no encontrado en: $openssl" -ForegroundColor Red
    Write-Host "   Instala Git Bash o OpenSSL para Windows" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $certPath)) {
    Write-Host "❌ Certificado no encontrado: $certPath" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $p12Path)) {
    Write-Host "❌ Archivo .p12 no encontrado: $p12Path" -ForegroundColor Red
    exit 1
}

# 1. Modulus del certificado
Write-Host "1️⃣  Modulo del certificado (MD5):" -ForegroundColor Yellow
$certModulus = & $openssl x509 -in $certPath -noout -modulus 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error obteniendo modulus del certificado" -ForegroundColor Red
    exit 1
}
$certMD5 = $certModulus | & $openssl md5 2>&1
Write-Host $certMD5 -ForegroundColor White
Write-Host ""

# 2. Extraer clave privada si no existe
if (-not (Test-Path $privateKeyPath)) {
    Write-Host "📦 Extrayendo clave privada desde .p12..." -ForegroundColor Cyan
    & $openssl pkcs12 -in $p12Path -nocerts -nodes -out $privateKeyPath -passin pass:changeit 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Error extrayendo clave privada" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ Clave privada extraída a: $privateKeyPath" -ForegroundColor Green
    Write-Host ""
}

# 3. Modulus de la clave privada
Write-Host "2️⃣  Modulo de la clave privada (MD5):" -ForegroundColor Yellow
$keyModulus = & $openssl pkey -in $privateKeyPath -noout -modulus 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error obteniendo modulus de la clave privada" -ForegroundColor Red
    exit 1
}
$keyMD5 = $keyModulus | & $openssl md5 2>&1
Write-Host $keyMD5 -ForegroundColor White
Write-Host ""

# 4. Comparar
$certMD5Clean = ($certMD5 -split '\s+')[-1]
$keyMD5Clean = ($keyMD5 -split '\s+')[-1]

if ($certMD5Clean -eq $keyMD5Clean) {
    Write-Host "✅ COINCIDEN - El certificado y la clave privada son pareja" -ForegroundColor Green
    Write-Host ""
    Write-Host "📋 Próximos pasos:" -ForegroundColor Cyan
    Write-Host "   1. Verificar que QZ_PRIVATE_KEY_B64 en Supabase sea de esta clave"
    Write-Host "   2. Si no, actualizar con el base64 generado abajo"
} else {
    Write-Host "❌ NO COINCIDEN - El certificado y la clave privada NO son pareja" -ForegroundColor Red
    Write-Host ""
    Write-Host "⚠️  PROBLEMA: La firma será inválida porque usas una clave privada diferente" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "🔧 SOLUCIÓN:" -ForegroundColor Cyan
    Write-Host "   1. La clave privada extraída es del mismo .p12 que el certificado"
    Write-Host "   2. Actualiza QZ_PRIVATE_KEY_B64 en Supabase con el base64 generado abajo"
    Write-Host "   3. Redeploy la Edge Function"
}

Write-Host ""
Write-Host "📦 Generando Base64 de la clave privada para Supabase..." -ForegroundColor Cyan
Write-Host ""

# Generar base64
$pemContent = Get-Content $privateKeyPath -Raw -Encoding UTF8
$bytes = [System.Text.Encoding]::UTF8.GetBytes($pemContent)
$base64 = [Convert]::ToBase64String($bytes)

Write-Host "Base64 (copia este valor para QZ_PRIVATE_KEY_B64):" -ForegroundColor Yellow
Write-Host $base64 -ForegroundColor White
Write-Host ""
Write-Host "💡 Comando para actualizar en Supabase:" -ForegroundColor Cyan
Write-Host "   supabase secrets set QZ_PRIVATE_KEY_B64=`"$base64`" --project-ref dtfznewwvsadkorxwzft" -ForegroundColor White

