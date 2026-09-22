# CLAR-2026-09-19-Auditoria-3-Dias - Carrito persistido, pedido activo y performance

- **Fecha lectura:** 2026-09-19
- **Ventana:** ultimos 3 dias
- **Proyecto Clarity:** `yekz20nia8`
- **Volumen:** 65 sesiones, 17 usuarios unicos
- **Estado:** abierto
- **Prioridad general:** alta

## Resumen ejecutivo

No se reprodujo en esta muestra el flujo `agregar desde PDP -> entrar al carrito -> producto sin stock`. El caso de stock invalido observado nace con el producto ya presente al restaurar el carrito. Esto apunta a una falla de revalidacion/hidratacion del carrito persistido, no necesariamente al agregado actual desde PDP.

Tambien se confirmo una friccion clara en `Mi pedido`: una usuaria toca repetidamente la fila del producto antes de descubrir el menu de tres puntos. La fila parece accionable, pero la accion esta escondida.

La decision de iniciar una variante en cantidad `0` no muestra evidencia nueva suficiente para cambiarla a `1`. El tropiezo mas claro del PDP estuvo en talles sin stock que aun parecen tocables.

El problema transversal mas serio es performance: score 52/100, LCP 5,3 s, INP 280 ms y CLS 0,63. El movimiento de layout y la demora pueden estar generando parte de los clics fallidos.

## Metricas globales

| Metrica | Valor |
|---|---:|
| Sesiones | 65 |
| Usuarios unicos | 17 |
| Paginas por sesion | 9,92 |
| Profundidad de scroll | 70,45% |
| Tiempo activo | 2,8 min |
| Tiempo total | 5,8 min |
| Sesiones recurrentes | 57 (87,69%) |
| Clics fallidos | 26 sesiones (40%) |
| Retrocesos rapidos | 37 sesiones (56,92%) |
| Clics continuos | 1 sesion (1,54%) |
| Errores JavaScript | 0 |

Los porcentajes deben leerse con cautela: el usuario mas activo acumula 18 sesiones y el 87,69% del trafico es recurrente. La muestra todavia esta muy influida por usuarios frecuentes o de prueba.

## Hallazgos prioritarios

### P0 - Carrito persistido restaura una linea invalida

Sesion 2026-09-19 12:00, visitante `1rkmb54`, Chrome Mobile, 1m18:

- La usuaria no agrega productos durante la grabacion.
- Al entrar al carrito aparece una linea ya restaurada con `Cant. 0 - sin stock`.
- La linea conserva precio de $23.500, pero el total es $0.
- La interfaz muestra el aviso de producto sin stock y bloquea `Hacer pedido`.
- La usuaria toca la fila/estado de stock, vuelve rapido y elige `Ver catalogo`.

Diagnostico probable:

- El carrito persistido se hidrata antes de validar stock y cantidad contra el catalogo actual.
- Una linea con cantidad `0`, variante inexistente o stock agotado puede sobrevivir en almacenamiento local o estado remoto.
- El bloqueo evita finalizar un pedido invalido, pero deja a la clienta atrapada en una reparacion manual poco clara.

Accion recomendada:

- Revalidar todas las lineas al restaurar el carrito.
- Eliminar automaticamente lineas con `qty <= 0` o variante inexistente.
- Si el stock bajo, ajustar la cantidad al maximo disponible; si llego a 0, quitar la linea o mostrar una accion unica `Quitar agotados`.
- Recalcular total y persistencia en una sola operacion despues de sanear.
- Registrar motivo de saneamiento: `zero_qty`, `missing_variant`, `out_of_stock`, `stock_clamped`.

### P1 - La fila de pedido activo promete una accion que no entrega

Sesion 2026-09-19 10:25, visitante `ec6ekj`, Samsung Internet, 31m32:

- En `Pedido abierto`, toca varias veces la fila/texto del producto `Vison`.
- Uno de esos intentos queda marcado como clic fallido.
- Recién despues encuentra el menu de tres puntos y usa `Ver producto`.
- Tambien despliega y contrae `Ver productos mas` varias veces.
- Finalmente logra cerrar el pedido y confirmar la preparacion del envio.

Conclusion UX:

- No hace falta agrandar masivamente todas las cards.
- Conviene reemplazar `...` por un chevron hacia abajo.
- Al tocarlo, desplegar debajo de esa fila una barra del mismo ancho con `Editar cantidad`, `Ver producto` y `Quitar`.
- Toda la cabecera de la fila puede accionar el despliegue, con estado abierto/cerrado visible.
- Mantener 4 o 5 productos visibles y conservar `Ver N productos mas` evita que el pedido ocupe toda la pantalla.
- Aumentar moderadamente la altura/touch target de la fila puede ayudar sin reducir densidad.

### P1 - Performance y estabilidad visual

- Performance score: 52/100.
- LCP: 5,3 s, pobre.
- INP: 280 ms, necesita mejora.
- CLS: 0,63, pobre.
- Solo 9,8% de las vistas se clasifican como buenas; 53% son pobres.

Clarity muestra algunas URLs de producto con LCP extremos de 60 a 350 s. Esos valores puntuales pueden incluir pestañas ocultas, reproduccion o muestras anomalas; no deben tomarse literalmente. El agregado global si confirma un problema sostenido.

Prioridades tecnicas:

- Reservar dimensiones/aspect-ratio para imagenes, cards, banners y barras sticky.
- Servir miniaturas del tamano correcto y formatos comprimidos.
- No aplicar lazy-load a la imagen principal visible al entrar al PDP.
- Evitar que stock, selector de talle o sticky de carrito inserten altura sin reserva previa.
- Revisar primero Samsung Internet, que representa 53,85% de las sesiones.

### P2 - Talles sin stock todavia parecen accionables

Sesion 2026-09-19 09:19, visitante `1hg36b0`, producto `405`:

- Toca varios talles, incluidos estados visualmente tachados o deshabilitados.
- Clarity registra un clic fallido durante esa exploracion.
- Luego selecciona una opcion valida, toca `+` y agrega correctamente.

Mejora candidata:

- Reducir contraste, borde y elevacion de opciones agotadas.
- Agregar leyenda `Tachado = sin stock` o feedback breve `Talle sin stock` al tocar.
- Mantener los talles disponibles claramente por encima de los agotados en jerarquia visual.

### P2 - Imagenes y miniaturas necesitan feedback mas claro

En una sesion desktop de 9m12 se observan varios toques sobre imagen principal y miniaturas. El modal de imagen existe y funciona, pero algunos toques repetidos sobre la miniatura activa pueden terminar clasificados como fallidos.

Mejora candidata:

- Marcar la miniatura activa con borde/indicador inequívoco.
- Mantener el toque sobre imagen principal como apertura de zoom.
- No abrir menus de edicion al tocar la imagen del pedido; esa accion debe quedar en el chevron de la fila.

## Cantidad inicial 0 vs 1

### Decision actual

Mantener `0` por ahora.

La nueva evidencia no muestra abandono repetido por no tocar `+`:

- En producto `405`, la usuaria finalmente incremento y agrego.
- En producto `R2800`, otra usuaria uso el incremento correctamente.
- La friccion mas visible se concentra en talles agotados y affordance, no en el valor inicial.

Para que `0` funcione mejor:

- Mostrar la fila como paso incompleto: `Toca + para sumar una unidad`.
- Deshabilitar el CTA con etiqueta explicativa, no solo con aspecto apagado.
- Medir `size_selected`, `qty_incremented`, `add_to_cart` y abandono posterior.
- Cambiar a `1` solo si una proporcion relevante selecciona talle y abandona sin incrementar. Umbral inicial sugerido para revisar: 15-20% en una muestra mayor y no dominada por testers.

## Retrocesos rapidos

La mayoria de los retrocesos revisados parecen comparacion normal de catalogo: abrir producto, mirar foto/color/talle y volver. No conviene tratar el 56,92% como bug por si solo.

Tomar como accionable un retroceso rapido solo cuando coincide con:

- clic fallido,
- aviso de stock,
- selector sin respuesta,
- perdida de posicion de scroll,
- abandono del flujo de carrito o pedido.

## Plan sugerido

- [ ] P0: sanear y revalidar carrito al restaurar.
- [ ] P1: implementar chevron y panel de acciones en filas de pedido activo.
- [ ] P1: atacar CLS/LCP en listado y PDP.
- [ ] P2: reforzar estado visual y feedback de talles agotados.
- [ ] P2: reforzar seleccion activa de miniaturas.
- [ ] Mantener cantidad inicial `0` y medir el embudo talle -> incremento -> agregado.

## Cruces

- [[CLAR-2026-09-08-Auditoria-Post-Fix-Stock-PDP]]
- [[../../61-AUDITORIA-PDP-CARRITO-OOS-2026-09-07]]
- [[../Metricas/00-KPIs-Catalogo]]
