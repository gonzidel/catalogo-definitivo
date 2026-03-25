# Script para verificar que el certificado y la clave privada coincidan
# Uso: powershell -ExecutionPolicy Bypass -File scripts/verify-cert-key-match.ps1

$openssl = "C:\Program Files\Git\usr\bin\openssl.exe"

if (-not (Test-Path $openssl)) {
    Write-Host "❌ OpenSSL no encontrado en: $openssl"
    exit 1
}

Write-Host "🔍 Verificando coincidencia certificado/clave privada..."
Write-Host ""

# 1. Modulus del certificado
Write-Host "1️⃣ Modulus del certificado (certs/qz-site.crt):"
if (Test-Path "certs/qz-site.crt") {
    $certMod = & $openssl x509 -in certs/qz-site.crt -noout -modulus 2>&1 | & $openssl md5 2>&1
    Write-Host $certMod
    $certModHash = ($certMod -split "=")[1].Trim()
} else {
    Write-Host "❌ certs/qz-site.crt no existe"
    exit 1
}

Write-Host ""

# 2. Modulus de la clave privada desde .p12
Write-Host "2️⃣ Extrayendo clave privada desde .p12..."
if (Test-Path "C:\qz\qz-certificate.p12") {
    & $openssl pkcs12 -in C:\qz\qz-certificate.p12 -nocerts -nodes -out qz-private-from-p12.pem -passin pass:changeit 2>&1 | Out-Null
    
    if (Test-Path "qz-private-from-p12.pem") {
        Write-Host "✅ Clave privada extraida"
        Write-Host ""
        Write-Host "3️⃣ Modulus de la clave privada extraida:"
        $keyMod = & $openssl pkey -in qz-private-from-p12.pem -noout -modulus 2>&1 | & $openssl md5 2>&1
        Write-Host $keyMod
        $keyModHash = ($keyMod -split "=")[1].Trim()
        
        Write-Host ""
        Write-Host "📊 Comparación:"
        Write-Host "Certificado MD5: $certModHash"
        Write-Host "Clave privada MD5: $keyModHash"
        Write-Host ""
        
        if ($certModHash -eq $keyModHash) {
            Write-Host "✅ COINCIDEN - El certificado y la clave privada son pareja"
            Write-Host ""
            Write-Host "📦 Generando Base64 de la clave privada para QZ_PRIVATE_KEY_B64:"
            Write-Host ""
            $pemContent = Get-Content qz-private-from-p12.pem -Raw
            # Convertir PEM a DER primero
            & $openssl pkcs8 -topk8 -nocrypt -in qz-private-from-p12.pem -outform DER -out qz-private-from-p12.der 2>&1 | Out-Null
            if (Test-Path "qz-private-from-p12.der") {
                $derBytes = [System.IO.File]::ReadAllBytes("$PWD\qz-private-from-p12.der")
                $b64 = [Convert]::ToBase64String($derBytes)
                Write-Host $b64
                Write-Host ""
                Write-Host "✅ Copia este Base64 y úsalo como QZ_PRIVATE_KEY_B64 en Supabase Secrets"
            }
        } else {
            Write-Host "❌ NO COINCIDEN - El certificado y la clave privada NO son pareja"
            Write-Host "⚠️ Esto causará firmas inválidas"
        }
    } else {
        Write-Host "❌ Error al extraer clave privada"
        exit 1
    }
} else {
    Write-Host "❌ C:\qz\qz-certificate.p12 no existe"
    exit 1
}
