# Script de deploy para Windows PowerShell
# Este script configura las variables de entorno y ejecuta el deploy

Write-Host "Iniciando despliegue del Catalogo FYL a Firebase Hosting" -ForegroundColor Cyan
Write-Host ""

# Verificar si existe un archivo de configuracion local
$configFile = ".env.local"
if (Test-Path $configFile) {
    Write-Host "Leyendo configuracion desde .env.local..." -ForegroundColor Yellow
    Get-Content $configFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line.Split("=", 2)
            if ($parts.Length -eq 2) {
                $key = $parts[0].Trim()
                $value = $parts[1].Trim()
                # Limpiar comillas del valor
                $value = $value -replace '^["'']|["'']$', ''
                Set-Item -Path "env:$key" -Value $value
                Write-Host "  Configurado: $key" -ForegroundColor Green
            }
        }
    }
    Write-Host ""
} else {
    Write-Host "ADVERTENCIA: No se encontro .env.local, usando variables del sistema" -ForegroundColor Yellow
    Write-Host "Para evitar configurar las variables cada vez, crea un archivo .env.local" -ForegroundColor Yellow
    Write-Host ""
}

# Función para limpiar comillas de las variables de entorno
function Clean-EnvValue {
    param([string]$value)
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $value
    }
    # Remover comillas dobles o simples del inicio y final
    $cleaned = $value.Trim()
    $cleaned = $cleaned -replace '^["'']|["'']$', ''
    return $cleaned
}

# Verificar que las variables esten configuradas y limpiarlas
$url = Clean-EnvValue $env:SUPABASE_URL
$anon = Clean-EnvValue $env:SUPABASE_ANON_KEY

if (-not $url -or -not $anon) {
    Write-Host "ERROR: Variables de entorno no configuradas" -ForegroundColor Red
    Write-Host ""
    Write-Host "Configura las siguientes variables antes de desplegar:" -ForegroundColor Yellow
    Write-Host "  - SUPABASE_URL" -ForegroundColor Yellow
    Write-Host "  - SUPABASE_ANON_KEY" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "O crea un archivo .env.local en la raiz del proyecto con:" -ForegroundColor Yellow
    Write-Host "  SUPABASE_URL=https://dtfznewwvsadkorxwzft.supabase.co" -ForegroundColor Gray
    Write-Host "  SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0ZnpuZXd3dnNhZGtvcnh3emZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA1MTIyNzUsImV4cCI6MjA3NjA4ODI3NX0.vJguBGhezUKtJbRA6GUkBxH8IltfdbMiPKWX9vHTlOo" -ForegroundColor Gray
    Write-Host ""
    exit 1
}

Write-Host "Variables de entorno configuradas correctamente" -ForegroundColor Green
Write-Host ""

# Ejecutar el deploy pasando las variables de entorno explícitamente (ya limpiadas)
Write-Host "Ejecutando deploy a Firebase Hosting..." -ForegroundColor Cyan
Write-Host ""
# Asegurar que las variables estén limpias antes de pasarlas
$env:SUPABASE_URL = $url
$env:SUPABASE_ANON_KEY = $anon
npm run deploy

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Despliegue completado exitosamente!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Tu catalogo esta disponible en:" -ForegroundColor Cyan
    Write-Host "  https://catalogo-fyl-test.web.app" -ForegroundColor White
    Write-Host "  https://catalogo-fyl-test.firebaseapp.com" -ForegroundColor White
} else {
    Write-Host ""
    Write-Host "ERROR: El despliegue fallo" -ForegroundColor Red
    exit 1
}
