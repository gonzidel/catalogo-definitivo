# GZ — agente de impresión propio, reemplazo de QZ Tray (2026-08-25)

## Problema

El admin usaba **QZ Tray** para imprimir tickets ESC/POS y rótulos ZPL/TSPL desde el navegador (WebSocket local `qz-tray.js` + firma digital con certificado propio + Edge Function `qz-sign`). Nunca se logró estabilizar del todo: el diálogo de "confiar en este sitio" volvía a aparecer, la firma con certificado era frágil (SHA-1 vs SHA-512, certificado servido mal, `QZ_PRIVATE_KEY_B64` desalineado), y cada instalación en una PC de venta/depósito requería instalar QZ Tray + importar certificado + configurar `authcert.override`. Documentado en detalle en `docs/QZ-TRAY-LOCAL-TRUST-WINDOWS.md`, `ANALISIS_DOCUMENTO_QZ_TRAY.md`, `IMPORTACION_CERTIFICADO_QZ_PASO_A_PASO.md` (quedan como referencia histórica, ya no aplican).

## Solución

Se construyó **GZ**: un agente de impresión local propio (`gz-agent/`, Node.js empaquetado a un `.exe` con `pkg`) que reemplaza a QZ Tray. Al ser software propio no hace falta certificado ni firma digital — no hay ningún diálogo de permiso que gestionar.

### Arquitectura

```
navegador (admin/*.html)
  └─ admin/gz-shim.js   → window.qz = { websocket, security(no-op), printers, configs, print }
       └─ fetch a http://127.0.0.1:8785 (gz-agent, corriendo en la PC del usuario)
            ├─ GET  /status     → chequeo de vida
            ├─ GET  /printers   → lista impresoras Windows + default
            └─ POST /print      → { printer, jobs } → RAW al spooler
```

`admin/gz-shim.js` implementa el mismo subconjunto de API `qz.*` que ya usaba el código existente (websocket.connect/isActive, printers.find/getDefault, configs.create, print, security.\* como no-ops). Por eso **no hizo falta tocar la lógica de impresión de ninguna pantalla** — cada página solo cambió qué hay detrás de `window.qz`.

### `gz-agent/` (agente local, Windows)

| Archivo | Rol |
|---|---|
| `server.js` | Servidor HTTP en `127.0.0.1:8785`, rutas `/status` `/printers` `/print` |
| `native/GZNative.cs` → `GZNative.exe` | Helper nativo único (compilado una vez con `csc.exe`, .NET Framework): `list` (impresoras vía `PrinterSettings.InstalledPrinters`) y `print <impresora> <archivo>` (RAW vía P/Invoke a `winspool.drv`) |
| `native-resolve.js` | Extrae `GZNative.exe` del snapshot de `pkg` a disco real una vez al arrancar (pkg no permite ejecutar assets directo desde el snapshot) + "calienta" una corrida para absorber el escaneo de Windows Defender en el arranque, no en el primer click |
| `escpos-image.js` | Rasteriza imágenes (QR) a comando ESC/POS `GS v 0` con Jimp — reemplaza la conversión que hacía QZ Tray internamente |
| `printers.js` | Wrapper de `GZNative.exe list` |
| `raw-print.js` | Wrapper de `GZNative.exe print` |
| `tray.js` | Ícono en la bandeja del sistema (`systray2`), menú "Salir" |
| `autostart.js` | Registro `HKCU\...\Run` (no requiere admin) apuntando al `.exe` |
| `scripts/build-icons.js` | `assets/Principal.png`/`Mini.png` → `.ico` (ícono del exe / bandeja) |
| `scripts/build-native.js` | Compila `GZNative.cs` una vez |
| `scripts/patch-base-icon.js` | Le pone el ícono al binario base de `pkg` **antes** de empaquetar (ver nota abajo) |

### Detalles de implementación no obvios

- **`GZNative.exe` en vez de PowerShell**: la primera versión usaba `powershell.exe` + `Add-Type` (compilaba C# en cada impresión, 1-3s de delay) y luego WMI (`Get-CimInstance Win32_Printer`, lento y con ventana visible) para listar impresoras. Ambos se reemplazaron por un único helper nativo precompilado — imprimir + listar bajó a **~0.1-0.2s**, sin ninguna ventana de PowerShell parpadeando.
- **`.exe` sin ventana de consola**: `gz-agent.exe` es una app de consola de Node; al arrancar se relanza a sí mismo con `spawn(process.execPath, process.argv.slice(1), { detached:true, stdio:'ignore', windowsHide:true })` y el proceso visible se cierra al instante. Truco no obvio: `pkg` inyecta un `argv[1]` sintético (ruta interna del snapshot) que su propio bootstrap necesita para resolver el módulo principal — hay que reenviarlo (`process.argv.slice(1)`, no `slice(2)` ni `[]`) o el proceso hijo no arranca (`TypeError: String.prototype.startsWith called on null or undefined`).
- **Ícono del `.exe`**: `pkg` no deja fijar el ícono directo, y aplicarlo *después* con `rcedit` sobre el `.exe` ya armado le trunca el payload que `pkg` le appendea al final (el exe deja de arrancar). Solución: `pkg-fetch` valida el hash del binario base "fetched-\*" contra una lista fija y lo re-descarga si detecta que fue tocado — pero acepta sin validar una variante "built-\*" en la misma carpeta de caché (pensada para binarios "compilados localmente"). `patch-base-icon.js` le aplica el ícono a esa variante y borra el "fetched-\*" para forzar que `pkg` la use.
- **Asset binario dentro del snapshot**: `GZNative.exe` y el binario de `systray2` (`traybin/`) se declaran en `pkg.assets` del `package.json`; se pueden **leer** (`fs.readFileSync`) desde el snapshot virtual pero no **ejecutar** directo — `native-resolve.js` los copia a `%TEMP%\gz-agent\` una vez por arranque antes de spawnearlos.

## Qué se quitó

- Carga de `https://cdn.jsdelivr.net/npm/qz-tray@2.2.5/qz-tray.js` en las 6 páginas del admin que imprimen.
- En `admin/qz-printing.js` (módulo compartido): fetch a `/certs/qz-site.crt`, todo el flujo `setCertificatePromise`/`setSignaturePromise`/`setSignatureAlgorithm("SHA512")` contra la Edge Function `qz-sign`, y el manejo especial de "Connection blocked / Site Manager".
- Mensajes de error que mencionaban "QZ Tray no está disponible" / certificado → ahora dicen "verificá que `gz-agent.exe` esté corriendo".

**Quedan como referencia histórica, sin uso activo:** `certs/` (certificado autofirmado), `docs/QZ-*`, `*QZ_TRAY*.md` en la raíz, la Edge Function `supabase/functions/qz-sign`, el secret `QZ_PRIVATE_KEY_B64` en Supabase. No hace falta borrarlos ni desplegarlos para que la impresión funcione, pero se pueden dar de baja cuando se audite deuda técnica.

## Qué se agregó

- `gz-agent/` completo (ver árbol arriba).
- `admin/gz-shim.js` — shim cliente, reemplaza `qz-tray.js`.
- Páginas migradas (las 6 que imprimían con QZ Tray): `closed-orders.html`, `labels.html`, `public-sales.html`, `sent-orders.html`, `stock.html`, `local-order-edit.html`.

## Fix adicional: desperdicio de etiquetas en "Imprimir Todo" (`labels.html`)

Al migrar se detectó (no relacionado con QZ vs GZ, bug preexistente): el botón "Imprimir Todo" armaba un trabajo de impresión **por talle**, y si un talle terminaba en cantidad impar, la ZPL de "etiqueta simple" ocupaba una fila física completa dejando la mitad derecha en blanco — se perdía una etiqueta por cada talle impar, no solo al final del lote.

Fix en `admin/labels.js`: la lista de talles/colores a imprimir se aplana a una sola secuencia (mismo orden color→talle de siempre) y se empareja de a dos **consecutivas sin reiniciar por talle** (`buildZplForDoubleLabelMixed`, nueva función — una fila física puede llevar dos talles/colores distintos, uno por lado). Se manda como un solo trabajo de impresión. Resultado: el desperdicio máximo posible es una etiqueta al final de **todo** el lote (si el total general es impar), no una por cada talle. El botón individual "Imprimir cantidad" (por talle suelto) no se tocó.

## Deuda / pendiente

- **Drift de calibración física en la Zebra**: el usuario detectó que la impresión se va corriendo levemente etiqueta a etiqueta hasta que la impresora salta una para recalibrarse contra el sensor de gap. Es un tema de calibración física de la impresora (o del valor `^LL` en el ZPL vs el largo real de la etiqueta), no de software — pendiente decidir si se ataca con `~JC` (auto-calibración ZPL) o calibración manual en la impresora. El usuario decidió no tocarlo por ahora.
- **QR del ticket sigue tardando ~1-2s**: se descarga desde `api.qrserver.com` (servicio externo), igual que hacía QZ Tray — no es una regresión de GZ. Si se quiere bajar ese tiempo, habría que generar el QR localmente en `gz-agent` (librería `qrcode` de Node) en vez de pedirlo a internet.
- Certificados/Edge Function QZ sin dar de baja formalmente (ver arriba).

## Instalación en una PC de venta/depósito

Ver [`gz-agent/README.md`](../../gz-agent/README.md) para el detalle completo. Resumen: `cd gz-agent && npm install && npm run build` genera `gz-agent/dist/gz-agent.exe` (un solo archivo). Copiarlo a la PC y ejecutarlo una vez — queda registrado para iniciar con Windows, sin ventana, con ícono en la bandeja.

## Verificación

1. `gz-agent.exe` corriendo → `curl http://127.0.0.1:8785/status` responde `{"ok":true,"agent":"GZ",...}`.
2. En cualquiera de las 6 páginas migradas, la consola del navegador no debe mostrar carga de `qz-tray.js` ni errores de certificado.
3. Imprimir un ticket/rótulo real y confirmar que sale sin ningún popup de permiso.
4. `grep -r "cdn.jsdelivr.net/npm/qz-tray" admin/` → sin resultados.

## Rollback

Si hiciera falta volver a QZ Tray en alguna página: reemplazar el `<script src="gz-shim.js">` por el `<script>` que carga `https://cdn.jsdelivr.net/npm/qz-tray@2.2.5/qz-tray.js` (ver historial git de cada `admin/*.html` antes de este cambio) y restaurar el flujo de certificado/firma en `admin/qz-printing.js` (también en git history). No requiere tocar `closed-orders.js`/`labels.js`/etc., ya que la lógica de impresión de cada pantalla es agnóstica a qué hay detrás de `window.qz`.
