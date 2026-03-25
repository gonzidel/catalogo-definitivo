# scripts/generate-qz-private-b64.ps1
# Script para extraer la clave privada del .p12 y convertirla a base64

$p12Path = "C:\qz\qz-certificate.p12"
$pemPath = "qz-private-from-p12.pem"
$b64Path = "qz-private-from-p12.b64"

Write-Host "🔐 Extrayendo clave privada desde .p12..."

# Extraer clave privada
& "C:\Program Files\Git\usr\bin\openssl.exe" pkcs12 -in $p12Path -nocerts -nodes -out $pemPath -passin pass:changeit

if (Test-Path $pemPath) {
    Write-Host "✅ Clave privada extraída: $pemPath"
    
    # Leer PEM y convertir a base64
    $pem = Get-Content $pemPath -Raw
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($pem)
    $b64 = [Convert]::ToBase64String($bytes)
    
    # Guardar base64
    $b64 | Out-File -Encoding ASCII $b64Path
    
    Write-Host "✅ Base64 generado: $b64Path"
    Write-Host ""
    Write-Host "📋 Longitud del base64: $($b64.Length) caracteres"
    Write-Host ""
    Write-Host "📝 Para configurar en Supabase:"
    Write-Host "1. Copia el contenido de $b64Path"
    Write-Host "2. Ve a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/settings/functions"
    Write-Host "3. Agrega/actualiza el secret: QZ_PRIVATE_KEY_B64"
    Write-Host "4. Pega el contenido completo del archivo $b64Path"
    Write-Host ""
    Write-Host "🔍 Verificación de módulo:"
    $certModulus = & "C:\Program Files\Git\usr\bin\openssl.exe" x509 -in certs/qz-site.crt -noout -modulus 2>&1 | & "C:\Program Files\Git\usr\bin\openssl.exe" md5 2>&1
    $keyModulus = & "C:\Program Files\Git\usr\bin\openssl.exe" pkey -in $pemPath -noout -modulus 2>&1 | & "C:\Program Files\Git\usr\bin\openssl.exe" md5 2>&1
    
    Write-Host "Certificado MD5: $certModulus"
    Write-Host "Clave privada MD5: $keyModulus"
    
    if ($certModulus -eq $keyModulus) {
        Write-Host "✅ Los módulos COINCIDEN - el par es correcto"
    } else {
        Write-Host "❌ Los módulos NO coinciden - hay un problema"
    }
} else {
    Write-Host "❌ Error: No se pudo extraer la clave privada"
}

