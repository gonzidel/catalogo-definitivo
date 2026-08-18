@echo off
title FYL - Servidor NJ (puerto 3001)
cd /d "%~dp0nj"

echo.
echo  Iniciando Next.js en http://localhost:3001
echo  (Admin pedidos: http://localhost:3001/nj/admin/orders)
echo  Cerra esta ventana para apagar el servidor.
echo.

npm run dev

if errorlevel 1 (
  echo.
  echo  Error al iniciar. Revisá que Node/npm esten instalados.
  pause
)
