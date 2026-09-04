# Catálogo FYL

Pequeña PWA que muestra un catálogo de productos usando Google Sheets (OpenSheet) o Supabase como origen de datos. Incluye soporte PWA (service worker), optimizaciones Cloudinary y utilidades de descarga/compartir.

Contenido relevante:

- `index.html` - punto de entrada del frontend.
- `scripts/` - lógica de la aplicación (config, cliente Supabase, data-source, main, etc.).
- `sw.js` - service worker para cache y modo offline.
- `manifest.json` - manifiesto PWA.
- `cloudinary-optimize/` - utilidad Node para optimizar imágenes vía Cloudinary.
- `clave/` - contiene credenciales privadas (NO subir a repositorio).
- `docs/FYL-Obsidian/` - documentación técnica viva del sistema (bóveda Obsidian; ver sección siguiente y [CONTRIBUTING.md](CONTRIBUTING.md)).

## Documentación viva

La carpeta **`docs/FYL-Obsidian/`** es parte del proyecto: describe arquitectura, flujos de stock y pedidos, RPCs, tablas, permisos y catálogo a partir del código y las migraciones. Debe **mantenerse al día** junto con los cambios de lógica o de esquema; no es material colateral opcional.

Las reglas de cuándo y qué actualizar están en [CONTRIBUTING.md](CONTRIBUTING.md) (mantenimiento de la bóveda y checklist por tipo de cambio). La [meta-auditoría](docs/FYL-Obsidian/99-AUDITORIA-DOCUMENTACION.md) contrasta periódicamente la bóveda con el código.

Cómo probar localmente (estático):

1. Servir la carpeta con un servidor estático.

Opciones en PowerShell (Windows):

```powershell
# Si tienes Python instalado, usa el lanzador `py` (recomendado en Windows):
py -3 -m http.server 8080

# Si `py`/`python` no está disponible, puedes usar Node (si tienes npm):
npx http-server . -p 8080

# O instala http-server globalmente y luego ejecútalo:
# npm install -g http-server
# http-server . -p 8080
```

2. Abrir `http://localhost:8080` y comprobar que la app carga.

Diagnóstico rápido en PowerShell si el comando falla:

1. "no se encontró Python" o mensaje sobre alias:

   - Asegúrate de tener Python instalado: https://www.python.org/downloads/
   - En el instalador de Windows activa "Add Python to PATH" o usa `py -3`.

2. Si usas Node y `npx` no funciona:

   - Instala Node.js desde https://nodejs.org/ y vuelve a intentarlo.

3. Puerto en uso:
   - Si `8080` está ocupado, prueba con otro puerto, por ejemplo `8081`.

Ejemplo final (PowerShell):

```powershell
py -3 -m http.server 8080
# o
npx http-server . -p 8080
```

Advertencias y notas:

- `clave/` contiene un archivo JSON con credenciales de Firebase admin. Mantener fuera del control de versiones.
- `scripts/config.js` contiene las claves públicas de Supabase (anon). Si quieres desactivar Supabase, borra o deja vacías `SUPABASE_URL` y `SUPABASE_ANON_KEY`.
- `scripts/config.js` NO debe contener claves sensibles. Para claves locales, copia `scripts/config.local.example.js` a `scripts/config.local.js` y completa las variables (este archivo está en `.gitignore` y no se subirá al repo).
- El service worker cachea muchas rutas. Revisa `sw.js` si necesitas actualizar archivos cacheados.

Siguientes pasos recomendados:

- Añadir tests mínimos si deseas automatizar builds.
- Opcional: separar configuración sensible en variables de entorno para despliegues.

## Husky pre-commit (escaneo de secretos)

Si querés prevenir commits que contengan secretos, podés habilitar el hook pre-commit que ejecuta el escaneo básico antes de cada commit.

1. Instalar dependencias de desarrollo:

```powershell
npm install
```

2. Habilitar Husky (crea los hooks locales):

```powershell
npm run prepare
```

A partir de ese momento, antes de cada commit se ejecutará `npm run test:secrets`. Si el escaneo encuentra coincidencias, el commit será cancelado y deberás resolver los secretos detectados.

Nota: los hooks son locales a tu copia del repo y no se ejecutarán en otras máquinas hasta que hagan `npm install` y `npm run prepare`.

## Impresión (GZ Agent)

El proyecto usa **GZ**, un agente de impresión local propio (`gz-agent/`), en
todas las páginas del admin que imprimen (pedidos, etiquetas, ventas). QZ Tray
ya no se usa en ningún lado — GZ lo reemplaza por completo: al ser software
propio no requiere certificados, firma digital ni Edge Function de firmado,
así que no hay popup de "confiar en este sitio" que gestionar.

- Agente local: [`gz-agent/README.md`](gz-agent/README.md) — cómo correrlo en
  desarrollo, compilarlo a `.exe` (un solo archivo, sin ventana de consola,
  arranca solo con Windows) e instalarlo en una PC de venta/depósito.
- Lado navegador: `admin/gz-shim.js` implementa el mismo subconjunto de API
  `qz.*` que ya usaba el código de cada página (`admin/qz-printing.js` y las
  pantallas que imprimen), así que no hubo que tocar la lógica de impresión
  de cada una — solo qué hay detrás de `window.qz`.

Los documentos y certificados de QZ Tray (`certs/`, `docs/QZ-*`,
`*QZ_TRAY*.md`, la Edge Function `qz-sign`, el secret `QZ_PRIVATE_KEY_B64`)
quedan como referencia histórica del intento anterior — ya no hace falta
generarlos, configurarlos ni desplegarlos para que la impresión funcione.