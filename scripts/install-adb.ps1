# Instala Android platform-tools (ADB) desde Google.
# Preferido: ejecutar PowerShell como Administrador para C:\platform-tools y PATH de máquina.
# Sin admin: instala en %LOCALAPPDATA%\Android\platform-tools y PATH de usuario.

$ErrorActionPreference = 'Stop'

$url     = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
$tempZip = Join-Path $env:TEMP 'platform-tools-latest-windows.zip'

$isAdmin = {
    $wi = [Security.Principal.WindowsIdentity]::GetCurrent()
    $wp = New-Object Security.Principal.WindowsPrincipal($wi)
    return $wp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}.Invoke()

if ($isAdmin) {
    $destDir = 'C:\platform-tools'
    $pathScope = 'Machine'
} else {
    $destDir = Join-Path $env:LOCALAPPDATA 'Android\platform-tools'
    $pathScope = 'User'
    Write-Warning 'Sin permisos de administrador: se instala en usuario y PATH de usuario.'
}

Write-Host 'Descargando platform-tools desde Google...' -ForegroundColor Cyan
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $url -OutFile $tempZip -UseBasicParsing

$parent = Split-Path $destDir -Parent
if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}

Write-Host "Extrayendo en $parent ..." -ForegroundColor Cyan
Expand-Archive -Path $tempZip -DestinationPath $parent -Force
Remove-Item $tempZip -Force -ErrorAction SilentlyContinue

# El ZIP crea carpeta platform-tools bajo el destino
if (-not (Test-Path (Join-Path $destDir 'adb.exe'))) {
    throw "No se encontró adb.exe en $destDir"
}

Write-Host "Agregando al PATH ($pathScope)..." -ForegroundColor Cyan
$envKey = if ($pathScope -eq 'Machine') { 'Machine' } else { 'User' }
$currentPath = [Environment]::GetEnvironmentVariable('Path', $envKey)
$normDest = $destDir.TrimEnd('\')
$parts = $currentPath -split ';' | ForEach-Object { $_.TrimEnd('\') } | Where-Object { $_ }
$already = $parts | Where-Object { $_ -eq $normDest }
if (-not $already) {
    $newPath = if ([string]::IsNullOrEmpty($currentPath)) { $destDir } else { "$currentPath;$destDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, $envKey)
}

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

Write-Host "`nVerificación:" -ForegroundColor Green
& (Join-Path $destDir 'adb.exe') version

Write-Host "`nInstalación en: $destDir" -ForegroundColor Green
Write-Host 'Abre una terminal nueva para que otros programas vean el PATH actualizado.' -ForegroundColor Yellow
