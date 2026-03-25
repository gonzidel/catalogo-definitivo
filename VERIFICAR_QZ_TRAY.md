# Verificar e Iniciar QZ Tray en Windows

## 🔍 Problema Actual

Los errores muestran que **QZ Tray no está corriendo** en tu sistema. Los mensajes de error mejorados están funcionando correctamente y te están indicando el problema real.

## ✅ Verificación Paso a Paso

### 1. Verificar si QZ Tray está instalado

**Opción A: Desde el Menú Inicio**
1. Presioná `Win` (tecla Windows)
2. Escribí "QZ Tray" o "qz"
3. Si aparece "QZ Tray" en los resultados, está instalado

**Opción B: Desde Programas**
1. Abrí "Configuración" → "Aplicaciones" → "Aplicaciones y características"
2. Buscá "QZ Tray" en la lista
3. Si aparece, está instalado

**Opción C: Desde la carpeta de instalación**
- QZ Tray normalmente se instala en: `C:\Program Files\QZ Tray\`
- Verificá si existe esa carpeta

### 2. Iniciar QZ Tray

**Si QZ Tray está instalado:**

1. **Desde el Menú Inicio:**
   - Presioná `Win`
   - Escribí "QZ Tray"
   - Hacé clic en "QZ Tray" para ejecutarlo

2. **Desde la carpeta de instalación:**
   - Navegá a `C:\Program Files\QZ Tray\`
   - Ejecutá `qz-tray.exe`

3. **Verificar que esté corriendo:**
   - Buscá el ícono de QZ Tray en la **bandeja del sistema** (systray)
   - Esquina inferior derecha de la pantalla, junto al reloj
   - El ícono debería ser un pequeño logo de QZ

### 3. Si QZ Tray NO está instalado

**Descargar e instalar:**

1. **Descargar:**
   - Ir a: https://qz.io/download/
   - Descargar la versión para Windows
   - Ejecutar el instalador

2. **Instalar:**
   - Seguir el asistente de instalación
   - Aceptar los términos
   - Instalar en la ubicación predeterminada

3. **Iniciar después de instalar:**
   - QZ Tray debería iniciarse automáticamente
   - Si no, buscarlo en el Menú Inicio y ejecutarlo

## 🔧 Verificación Rápida desde PowerShell

Podés verificar si QZ Tray está corriendo con este comando:

```powershell
Get-Process | Where-Object {$_.ProcessName -like "*qz*"}
```

Si aparece algún proceso, QZ Tray está corriendo.

## 🚨 Problemas Comunes

### QZ Tray no aparece en el Menú Inicio

**Solución:**
- Buscar manualmente en `C:\Program Files\QZ Tray\`
- O reinstalar QZ Tray

### QZ Tray se cierra inmediatamente

**Posibles causas:**
1. **Error de Java:**
   - QZ Tray requiere Java
   - Verificar que Java esté instalado: `java -version` en CMD
   - Si no está, instalar Java desde: https://www.java.com/

2. **Permisos:**
   - Intentar ejecutar QZ Tray como Administrador
   - Clic derecho → "Ejecutar como administrador"

3. **Antivirus/Firewall:**
   - Agregar QZ Tray a las excepciones del antivirus
   - Permitir QZ Tray en el firewall de Windows

### QZ Tray está corriendo pero no se conecta

**Verificar:**
1. Que el ícono aparezca en la bandeja del sistema
2. Hacer clic derecho en el ícono → "About" para ver la versión
3. Verificar que no haya errores en los logs de QZ Tray

**Solución:**
- Reiniciar QZ Tray
- Reiniciar el navegador
- Verificar que el certificado esté correctamente configurado

## 📋 Checklist de Verificación

Antes de intentar imprimir, verificá:

- [ ] QZ Tray está instalado en el sistema
- [ ] QZ Tray está corriendo (ícono en la bandeja del sistema)
- [ ] Java está instalado y actualizado
- [ ] El navegador tiene permisos para acceder a QZ Tray
- [ ] No hay firewall/antivirus bloqueando QZ Tray
- [ ] El certificado está correctamente configurado

## 🔄 Después de Iniciar QZ Tray

1. **Recargar la página:**
   - Presionar `F5` o `Ctrl+R` en `closed-orders.html`

2. **Verificar en la consola:**
   - Abrir la consola del navegador (F12)
   - Deberías ver: `✅ QZ Tray conectado`

3. **Intentar imprimir nuevamente:**
   - Los errores de WebSocket deberían desaparecer
   - La impresión debería funcionar

## 📞 Si el Problema Persiste

Si después de iniciar QZ Tray aún hay errores:

1. **Verificar logs de QZ Tray:**
   - Clic derecho en el ícono de QZ Tray
   - Ver logs o errores

2. **Verificar certificado:**
   - Asegurarse de que el certificado esté correctamente importado
   - Ver documentación: `IMPORTACION_CERTIFICADO_QZ_PASO_A_PASO.md`

3. **Reinstalar QZ Tray:**
   - Desinstalar completamente
   - Reiniciar el sistema
   - Reinstalar QZ Tray

