# 23 - Cambios operativos 2026-04-29

Registro consolidado de cambios aplicados en UI admin (mobile-first) y búsquedas de pedidos/clientes.

---

## 1) Admin Stock (`admin/stock.html` / `admin/stock.js`)

### Modo lector QR (wizard mobile)

- Se agregó flujo de reconteo por QR dentro del wizard mobile de editar stock.
- Toggle: `Modo lector (reconteo por QR)` disponible cuando el modo es **Modificar**.
- Vista lector:
  - barra de escaneo,
  - estado de lectura,
  - grilla de talles con contador por talle,
  - botón `Reiniciar`.
- Reglas operativas:
  - reconteo inicia en 0,
  - QR de otra variante/producto se rechaza con aviso,
  - talles no escaneados quedan en 0 al guardar (modo modify).

### UX adicional

- Se agregó contador visual grande de `Total sumado` en el wizard.
- El total refleja la suma de todos los talles (modo normal y modo lector).

### Performance del lector

- Se optimizó lectura con:
  - cache QR por variante,
  - índices en memoria por talle/rowId,
  - cola de escaneo secuencial,
  - debounce más corto.
- Se corrigió corte de código parcial:
  - solo procesa códigos numéricos completos (mínimo 6 dígitos).
- En mobile no se fuerza `focus()` al activar lector:
  - evita apertura automática del teclado en celular.

---

## 2) Admin Move Stock (`admin/move-stock.html` / `admin/move-stock.js`)

### Contador de lector QR

- Se agregó contador visual para modo lector:
  - inicialmente bloque con texto + número,
  - luego simplificado a cuadro cuadrado con número verde,
  - finalmente alineado a la derecha en la misma fila del toggle de lector.

### Performance y robustez de lector

- Se aplicó optimización similar a stock:
  - cache de metadata por QR,
  - cache temporal de stock por variante (TTL corto),
  - invalidación de cache al mover stock,
  - cola de escaneo más ágil,
  - debounce más corto.
- Protección contra lectura parcial:
  - solo se encola/procesa QR numérico con largo mínimo 6.
- En mobile no se fuerza `focus()` al activar lector:
  - evita apertura del teclado al marcar modo lector.

---

## 3) Orders (`admin/orders.html`) - Búsquedas de clientes y productos

### Búsqueda de productos en crear/editar pedido (`admin/order-creator.js`)

- Ajuste para evitar disparo prematuro cuando el usuario escribe códigos numéricos:
  - mínimo mantiene 2 caracteres (compatibilidad con productos de 2 dígitos),
  - debounce dinámico:
    - texto: más rápido,
    - numérico: más conservador para evitar búsquedas a mitad de tipeo.

### Búsqueda por QR en crear/editar pedido

- Endurecida validación para evitar fragmentos:
  - procesamiento sólo con código numérico de largo mínimo 6.

### Búsqueda de clientes (dos barras)

Aplicado tanto en:
- barra principal de `orders.html` (`admin/orders.js`), y
- barra de cliente en modal crear/editar (`admin/order-creator.js`).

Mejoras:
- matching flexible por tokens (nombre/apellido en cualquier orden),
- normalización (sin tildes, case-insensitive),
- búsqueda por:
  - nombre,
  - DNI,
  - teléfono,
  - email,
  - número de cliente (`customer_number`).

### Presentación visual (modal crear/editar)

- En resultados de clientes se agregó:
  - resaltado visual de coincidencias,
  - chips de motivo de match (`Nombre`, `Nº cliente`, `DNI`, `Teléfono`, `Email`).

---

## Catálogo público — Banner F&L Originals (clic → PDP)

**Problema:** En home (`/catalogo` e `index`), al tocar una card del banner F&L Originals no se abria el PDP.

**Causa técnica:** El helper `obtenerSKUDefecto` del banner dependia de `window.skuIndex`, que no existe en runtime (el indice vive solo dentro de `main-supabase.js`). Las cards quedaban sin `data-sku` util y el flujo fallaba en silencio o dependia de fallbacks fragiles.

**Solución aplicada:** Alinear `obtenerSKUDefecto` con la heuristica del catalogo (`variantDetails`); encadenar `abrirPdpPorSkuIfPossible` cuando el SKU no esta en cache local; mantener fallbacks `abrirModalConResultado` y grid. Detalle en [[22-BANNER-FYL-ORIGINALS]] (seccion *Reparo 2026-04 — PDP que no abria al tocar la card*).

**Estado:** Comportamiento verificado OK tras implementacion.

---

## Impacto esperado

- Menos errores operativos por escaneo parcial.
- Flujo mobile más estable (sin teclado emergente no deseado al activar lector).
- Mayor velocidad percibida en lectores QR.
- Mejor encontrabilidad de clientes independientemente del orden nombre/apellido.
- Menor fricción en alta/edición de pedidos.

