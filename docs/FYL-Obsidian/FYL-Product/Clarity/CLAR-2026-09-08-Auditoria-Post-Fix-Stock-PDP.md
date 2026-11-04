# CLAR-2026-09-08-Auditoria-Post-Fix-Stock-PDP — Stock, carrito y PDP talle/cantidad

- **Fecha lectura:** 2026-09-08
- **Ventana de datos:** ultimos 3 dias, con foco en sesiones nuevas posteriores al fix del 2026-09-07
- **Sample size observado:** 53 grabaciones totales; revision puntual de sesiones nuevas y 3 sesiones con clics fallidos hoy
- **Filtro aplicado:** Microsoft Clarity, proyecto `yekz20nia8`; `date=Last 3 days` y `date=Today&deadClickCount=1`
- **Tipo:** sesion completa, carrito, dead click, PDP
- **Estado:** abierto
- **Severidad:** medio

## Que vimos

No se observo una repeticion clara del bug original: "la clienta agrega desde PDP y al entrar al carrito el producto aparece sin stock".

La senal post-fix mas fuerte fue positiva: una usuaria que habia quedado asociada a un caso viejo de carrito invalido volvio el 2026-09-08 y su carrito aparecio vacio, sin productos zombies.

Si aparecio una friccion nueva/importante para observar: en PDP, seleccionar un talle crea una fila de cantidad en `0`. Algunas clientas parecen no completar el segundo paso de tocar `+`, o vuelven rapido al listado tras abrir productos desde filtro de talle.

## Evidencia por sesion

| Hora | Visitor | Pantalla / flujo | Observacion |
|---|---|---|---|
| 2026-09-08 07:58 | `1fr6wlb` | Home -> PDP `301` -> PDP `30` -> carrito -> checkout | Flujo sano. Carrito con 2 lineas, total $30.000, `Hacer pedido` activo, confirma pedido. Sin aviso de stock. |
| 2026-09-08 06:40 | `e13uo8` | Home -> Ofertas -> Home -> carrito | Misma usuaria del caso viejo. No agrega nada en esta sesion. Carrito vacio. Buena senal post-fix. |
| 2026-09-08 09:05 | `1ozs4lh` | Home con carrito preexistente -> carrito | Carrito restaurado/preexistente de $74.000, una linea Beige, valido. Sin aviso de stock. No hay clics ni intento de checkout. |
| 2026-09-08 09:21 | `uxaj1l` | Home -> PDP `R2722` -> PDP `R2714` -> agrega | Agrega `R2714` tras alternar colores Morado/Negro. No llega al carrito. No se ve error de stock. |
| 2026-09-08 08:12 | `k266a6` | Calzado -> filtro talle 37 -> PDP `D1990`, `D1440`, `D1640` | Tres entradas rapidas a PDP con clics inactivos y vuelta al listado. No hay carrito ni stock invalido. Posible friccion de PDP/talle/cantidad. |
| 2026-09-08 08:03 | `n6rrzx` | PDP `202` | Toca un talle, aparece fila "Ahora elegi cantidad", queda en cantidad `0`, luego toca `Ver` carrito. Senal de confusion potencial. |
| 2026-09-08 08:04 | `7q4xik` | Onboarding/perfil | Completa datos, provincia Chaco, localidad Resistencia, `Guardar y continuar`. El clic fallido parece foco/dropdown; no bloquea. |

## Hipotesis de causa

El flujo actual de PDP requiere dos pasos:

1. Tocar talle: crea la fila de seleccion con cantidad `0`.
2. Tocar `+`: recien ahi suma unidades y habilita el CTA propio del PDP.

La decision de iniciar en `0` fue intencional para evitar agregados inconscientes. El costo UX observado es que algunas clientas pueden interpretar "elegi talle" como "ya elegi una unidad" y no notar que falta sumar cantidad.

## Confirmacion tecnica

- `nj/components/pdp/PdpSizePicker.tsx`: al tocar talle se llama `onSelectionChange(activeVariantId, talle, isSelected ? -1 : 0)`. El `0` es explicito.
- `nj/components/pdp/PdpInteractive.tsx`: `handleAddAllToCart()` retorna sin accion si `totalSelectedQty === 0`.
- `nj/components/pdp/PdpInteractive.tsx`: `stickyVisible = totalSelectedQty > 0 || addedFlash`, por lo que el CTA propio deberia estar oculto mientras la cantidad total sea `0`.
- Verificacion manual 2026-09-08 en `D1990`: talle 37 habilitado, sin errores de consola; al tocarlo aparece fila con cantidad `0`.
- La barra flotante de carrito global (`CartFloatingBar`) usa toda la barra como area clickeable (`div role="button"` con `onClick`), no solo el texto `Ver`.

## Impacto estimado

- Bug de stock post-fix: no reproducido en esta muestra.
- Friccion talle/cantidad: observada en 2 sesiones del filtro de clics fallidos (`k266a6`, `n6rrzx`).
- Frecuencia actual: baja muestra, pero importante porque afecta el momento de intencion de compra.

## Decision UX abierta: cantidad inicial 0 vs 1

### Mantener `0`

Ventajas:

- Evita que una clienta toque talles explorando y agregue unidades sin querer.
- Es mas seguro para productos donde se comparan varios talles/colores.
- Reduce carritos accidentales, sobre todo en mobile.

Riesgos:

- El paso "talle -> cantidad" no queda suficientemente obvio.
- Puede generar clics muertos, abandono rapido del PDP o visitas al carrito sin haber sumado nada.
- El texto `Agregar al carrito 0 productos $0` puede aparecer en DOM/Clarity aunque el sticky este oculto, ensuciando lectura de grabaciones.

### Cambiar a `1`

Ventajas:

- Coincide con expectativa comun de ecommerce: tocar talle selecciona una unidad.
- Reduce pasos para comprar.
- Si toca dos talles, agrega `1` de cada talle, lo cual puede ser correcto para mayorista cuando la usuaria arma variedad.

Riesgos:

- Puede cargar unidades no intencionales si la clienta explora talles tocandolos.
- En productos con varios colores/talles, una exploracion rapida podria sumar mas lineas de las deseadas.
- Requiere feedback muy claro para que la clienta entienda que cada talle tocado suma una unidad.

### Recomendacion provisional

No cambiar todavia directo a `1` sin medir un poco mas. Mantener `0` tiene una razon fuerte: evita agregados accidentales. Pero el hallazgo merece observacion prioritaria.

Mejor primer ajuste de bajo riesgo:

- Mantener `0`.
- Reforzar visualmente la fila recien creada: "Ahora toca + para sumar unidades".
- Hacer que el estado `0` se vea incompleto, no como una seleccion final.
- Instrumentar evento Clarity/custom: `pdp_size_selected_qty_zero`, `pdp_qty_increment`, `pdp_add_attempt_zero_qty`.
- Revisar en 24-48 h si las sesiones repiten: talle seleccionado -> no toca `+` -> abandono o carrito.

Si se repite mucho, cambiar a `1` pasa a ser candidato fuerte. En ese caso, cada talle tocado deberia sumar 1 unidad, y tocar el mismo talle nuevamente deberia quitar esa fila o volverla a 0 segun se decida.

## Accion

- [ ] Seguir observando sesiones con `deadClickCount=1` y PDP tras filtro de talle.
- [ ] Crear metrica/evento para intentos de agregar con cantidad `0`.
- [ ] Evaluar microcopy/estado visual de fila de cantidad en `0`.
- [ ] Reabrir decision si aparecen mas sesiones con talle elegido sin `+`.
- [ ] Mantener vigilancia del bug de carrito sin stock post-fix.

## Lectura 2026-09-09: 24 h adicionales

- **Ventana:** `date=Today` y `date=Last 3 days`, foco en sesiones del 2026-09-09.
- **Volumen observado:** 32 grabaciones de hoy; 123 sesiones en ultimos 3 dias; 47 usuarios unicos.
- **Eventos inteligentes:** `Agregar al carro` en 11 sesiones; `Comenzar finalizacion de la compra` en 3 sesiones; `Enviar formulario` en 10 sesiones; `Iniciar sesion` en 13 sesiones.
- **Ideas Clarity:** clics fallidos en 37 sesiones de ultimos 3 dias; retrocesos rapidos en 69 sesiones; errores JS 0.

### Hallazgos

No aparece una nueva reproduccion clara del bug original de carrito con productos sin stock. En las sesiones nuevas con `Agregar al carro`, las usuarias completan correctamente la secuencia `opcion/talle -> + -> Agregar al carrito / Ver carrito`.

Sesiones relevantes:

| Hora | Visitor | Flujo | Observacion |
|---|---|---|---|
| 2026-09-09 16:46 | `1c28a35` | Ropa -> PDP `R2704` -> carrito; luego Bota -> PDP `3010` -> carrito | Toca color/talle, luego `+`, luego agrega. No parece confusion por cantidad `0`. |
| 2026-09-09 13:02 | `uxaj1l` | Home -> PDP `460` -> carrito -> pedido | Toca color Negro, luego `+`, agrega y llega a `Hacer pedido` / `Si, hacer pedido`. La friccion posterior esta mas en editar/quitar productos del carrito que en PDP. |
| 2026-09-09 12:56 | `1c28a35` | Ropa -> PDP `R2718` -> login/onboarding | Toca talle/opcion, luego `+`, agrega al carrito y sigue a login/onboarding. |
| 2026-09-09 09:06 | `k266a6` | Home -> PDP `RMAT` -> Ofertas -> varios PDP -> carrito/pedido | Clarity marca clics muertos al seleccionar talles: primero toca `RMAT`, color Negro y el area/texto "Elegi talle en Negro"; se va sin agregar. Mas tarde vuelve a `RMAT`, toca `Unico`, luego `+`, va al carrito y confirma pedido. Senal real de tropiezo inicial, pero no abandono definitivo. |

### Interpretacion

La muestra nueva no justifica cambiar inmediatamente `seleccionar talle = 1`. Las sesiones de compra observadas muestran que las usuarias que convierten entienden el segundo paso y tocan `+`.

Pero la sesion `k266a6` confirma que la interfaz todavia puede generar clics muertos alrededor del selector de talle. La friccion no parece grave como para romper conversion por si sola, pero si suficiente para mejorar el feedback visual.

### Decision provisional actualizada

Mantener cantidad inicial `0` por ahora, pero subir prioridad a una mejora de UX:

- Convertir la fila en `0` en un estado claramente incompleto.
- Hacer mas obvio el proximo paso: `Toca + para sumar 1 unidad`.
- Evitar que textos o contenedores no accionables alrededor de "Elegi talle..." parezcan botones.
- Medir especificamente `pdp_size_selected_qty_zero` y si luego ocurre `pdp_qty_increment`.

Si en la siguiente muestra aparecen varios casos con `talle seleccionado -> no + -> abandono`, cambiar a `1` pasa de opcion a recomendacion.

## Otros hallazgos UX generales 2026-09-09

Ademas del flujo PDP/carrito, el filtro `date=Today&deadClickCount=1` mostro 14 sesiones con clics fallidos. No se detecto un bug bloqueante unico, pero si varios patrones de mejora.

### 1. Gestion de carrito / pedido activo confusa

Sesiones `uxaj1l` 13:02 y 12:21 muestran varios clics alrededor de `Carrito`, `Mi pedido`, `Hacer pedido`, menu `...`, `Editar cantidad`, `Quitar`, `Cancelar` y lineas de producto. La usuaria logra avanzar, pero hay muchos clics inactivos o repetidos.

Senales observadas:

- Clics repetidos en `Hacer pedido` antes de que la UI responda o antes de confirmar.
- Clics inactivos sobre lineas de producto dentro de carrito/pedido activo.
- Dudas entre tabs `Carrito` y `Mi pedido`.
- Intentos de editar/quitar desde menus `...` que parecen poco directos.

Hipotesis:

- La clienta no siempre distingue entre carrito editable, pedido abierto y pedido confirmado.
- Las lineas de producto parecen tocables, pero no siempre tienen una accion clara.
- Acciones importantes de edicion/quitar quedan escondidas atras de `...`.

Mejora candidata:

- Hacer mas explicito el estado: `Carrito editable` vs `Pedido abierto`.
- En mobile, exponer acciones primarias por linea: `Editar`, `Quitar`, `Ver producto`, en vez de depender solo de `...`.
- Si tocar una linea de producto no hace nada, evitar que parezca tappable o convertirla en `Ver detalle`.

### 2. Clics inactivos en textos/areas que parecen accionables

Ademas del caso de PDP, aparecen clics sobre textos descriptivos o lineas completas:

- `Elegi talle en Negro`
- lineas de producto en carrito/pedido
- textos de resumen como `Ver X productos mas del pedido`

Mejora candidata:

- Todo bloque que parezca una tarjeta o fila tocable deberia tener una accion clara.
- Si no tiene accion, bajar affordance visual: menos borde/sombra/hover/tap target.

### 3. Retrocesos rapidos por exploracion de producto

Sigue apareciendo mucho `retroceso rapido`: 69 sesiones en ultimos 3 dias. En varios casos es exploracion normal de catalogo, pero en otros parece que entran a un PDP, prueban colores/talles, vuelven y saltan a otro producto.

Mejora candidata:

- Mejorar preview de producto en cards: colores/talles disponibles, precio y stock resumido.
- En listados, preservar posicion de scroll al volver desde PDP.
- Revisar si algunos productos inducen entrada/salida rapida por foto, stock, color o talle.

### 4. Busqueda / navegacion

Hay sesiones que entran por busquedas (`q=Cartera`, `q=Zapa`, `q=Matero`) y terminan en PDP rapidamente, con algunos clics fallidos. No se vio bloqueo claro, pero conviene observar busqueda porque es un flujo de intencion alta.

Mejora candidata:

- Revisar que resultados de busqueda muestren claramente si el producto tiene stock, variantes y precio.
- Si la busqueda no encuentra algo exacto, mostrar alternativas ordenadas y no solo resultados amplios.

### 5. Performance visual

Panel Clarity ultimos 3 dias:

- Performance score: 66/100.
- LCP: 4,8 s, pobre.
- CLS: 0,3, pobre.
- INP: 220 ms, necesita mejoras.

Esto puede contaminar clics fallidos: si la pagina se mueve o tarda, la usuaria toca donde espera una accion y el elemento cambia o aun no esta listo.

Mejora candidata:

- Priorizar imagen principal/listados y reservar espacio estable para cards.
- Reducir cambios de layout al cargar imagenes, banners, sticky bars y secciones de catalogo.
- Medir especificamente mobile Samsung Internet y Chrome Mobile, que concentran buena parte del trafico.

## Cruces

- [[../../61-AUDITORIA-PDP-CARRITO-OOS-2026-09-07]]
- [[../UX/UX-004-Color-Swatches-Touch-Target]]
- [[../Metricas/00-KPIs-Catalogo]]
