# GZ Agent

Agente de impresión local que reemplaza a QZ Tray en el admin de Catálogo FYL.

No usa certificados ni firma digital: es software nuestro, así que no hay
diálogo de "permitir este sitio" que gestionar. Corre en `127.0.0.1` (no
acepta conexiones desde otras máquinas) y expone tres rutas HTTP que
consume `admin/gz-shim.js` desde el navegador:

- `GET /status` — chequeo de vida.
- `GET /printers` — lista impresoras instaladas en Windows + la predeterminada.
- `POST /print` — `{ printer, jobs }`, imprime RAW (ESC/POS, ZPL, TSPL o
  imagen rasterizada) en la impresora indicada.

## Requisitos

- Windows (usa `native/GZNative.exe` + `winspool.drv` para impresión RAW).
- La impresora debe estar instalada en Windows (aparecer en
  "Dispositivos e impresoras"), no hace falta driver especial: alcanza con
  que el spooler de Windows la reconozca.
- Para compilar (`npm install` / `npm run build`), la PC necesita `csc.exe`
  (.NET Framework, viene de fábrica en Windows) para armar `GZNative.exe` una
  única vez. En las PCs donde solo se *usa* el `.exe` ya compilado no hace
  falta nada de esto.

## Uso en desarrollo

```bash
cd gz-agent
npm install
npm start
```

Deja la ventana abierta; escucha en `http://127.0.0.1:8785` (cambiable con
la variable de entorno `GZ_PORT`).

## Compilar a .exe

```bash
cd gz-agent
npm install
npm run build
```

Genera `gz-agent/dist/gz-agent.exe`, un único ejecutable sin necesidad de
tener Node.js instalado en la PC de destino, ya con:

- **Ícono propio** (`assets/Principal.png` → `assets/icon.ico`) en el .exe.
- **Ícono en la bandeja del sistema** (`assets/Mini.png` → `assets/tray-icon.ico`)
  mientras corre, con un ítem "Salir" para cerrarlo.
- **Sin ventana de consola**: apenas arranca se relanza a sí mismo oculto
  (windowsHide) y el proceso visible se cierra al toque — un solo archivo,
  sin acceso directo ni `.vbs` aparte.
- **Registro automático para iniciar con Windows** (ver abajo) la primera vez
  que se ejecuta el .exe empaquetado.

Para regenerar los íconos a partir de PNGs nuevos, reemplazá
`assets/Principal.png` (ícono del .exe, cuadrado, se ve bien grande) y
`assets/Mini.png` (ícono de bandeja, tiene que leerse bien chico) y corré
`npm run build` de nuevo.

### Por qué el build tiene un paso extra (`patch-base-icon.js`)

`pkg` no deja fijar el ícono del `.exe` directamente, y aplicarlo *después*
con `rcedit` sobre el binario ya armado le rompe el payload que `pkg` le
appendea al final (queda un `.exe` que no arranca). El build primero le
aplica el ícono a una copia del binario base de Node que usa `pkg`, y recién
ahí corre `pkg` sobre esa copia — así el ícono queda embebido sin tocar nada
después. Es un detalle interno del build, no hace falta entenderlo para usar
`npm run build`.

## Instalación en una PC de venta/depósito

1. Copiar `gz-agent.exe` a la PC (por ejemplo `C:\GZ\gz-agent.exe`). Es el
   único archivo que hace falta.
2. Ejecutarlo (doble clic). No muestra ninguna ventana — la consola de
   Windows aparece una fracción de segundo y se cierra sola apenas el
   agente se relanza oculto. Con eso:
   - aparece el ícono en la bandeja del sistema,
   - queda registrado para iniciar con Windows en cada inicio de la PC
     (siempre oculto, no solo la primera vez).
3. Si alguien lo cierra desde la bandeja y hace falta abrirlo de nuevo sin
   reiniciar la PC, doble clic de nuevo en `gz-agent.exe` — se comporta
   igual, sin ventana.
4. Recargar la página del admin — `admin/gz-shim.js` se conecta solo, sin
   ningún paso de "confiar en este sitio".

Para sacarlo del inicio automático de Windows: `gz-agent.exe --uninstall-startup`.

El registro de inicio automático usa `HKCU\...\Run` (no requiere admin) y
apunta a la ruta exacta donde esté el `.exe` en ese momento — si lo movés de
carpeta, volvé a ejecutarlo una vez desde la nueva ubicación para que se
actualice.

## Notas

- El ancho de imagen usado para rasterizar QR/logos es 384 puntos (impresoras
  térmicas de 80mm estándar). Si tu impresora es de otro ancho, se puede pasar
  `options.widthDots` en el job de imagen o cambiar `DEFAULT_WIDTH_DOTS` en
  `escpos-image.js`.
- Todo el texto raw (ESC/POS, ZPL, TSPL) se manda byte a byte tal cual lo arma
  el admin, igual que lo hacía QZ Tray — no se traduce a ninguna codepage.
- **Velocidad y sin ventanas emergentes**: tanto imprimir como listar
  impresoras usan `native/GZNative.exe` (compilado una sola vez, ver
  `scripts/build-native.js`) — GZ no vuelve a levantar PowerShell para nada.
  Antes, listar impresoras (WMI) y firmar cada impresión (`Add-Type`) abrían
  una ventana de PowerShell por cada operación y sumaban varios segundos;
  ahora un ciclo completo de "Imprimir todo" (dos consultas de impresora +
  dos trabajos de impresión) tarda bien por debajo de un segundo, sin
  ninguna ventana visible.
- **Primer uso del día**: la primera vez que `GZNative.exe` se ejecuta en la
  PC, Windows Defender suele escanearlo antes de dejarlo correr (agrega unos
  segundos). El agente "gasta" ese costo solo, en segundo plano, al arrancar
  — así no le toca a la primera impresión del día.
- Si el ticket incluye el QR del cliente, ese paso puede tardar 1-2s más
  porque descarga la imagen desde `api.qrserver.com` (un servicio externo)
  — es el mismo comportamiento que tenía QZ Tray, no algo nuevo de GZ.
