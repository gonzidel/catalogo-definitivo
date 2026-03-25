# Mejoras pantalla #/como-comprar – Propuesta y plan

## A. Diagnóstico UX breve de la versión actual

1. **Orden de pasos confuso:** Los pasos 2 y 3 se leen en orden lineal (“sumá durante 7 días” y después “enviá el pedido”), pero en la práctica la usuaria puede enviar para confirmación y *después* seguir sumando. No queda claro que “enviar para confirmación” y “seguir sumando 7 días” son ventanas que pueden solaparse según el flujo del negocio.

2. **Repetición de conceptos:** “Mínimo 4”, “7 días”, “confirmación de stock” aparecen en hero, pasos y FAQ; genera ruido y no suma escaneabilidad.

3. **Hero sobrecargado:** Tres líneas de lead + dos botones + cuatro chips concentran demasiada información antes del scroll; en mobile compite por atención.

4. **“Aclaraciones” poco operativas:** Las tres cards mezclan reserva/stock, retiro y envíos; faltan medios de pago (y recargo si aplica) y política de cambios, que son preguntas recurrentes.

5. **Ambigüedad “borrador” vs “enviado”:** No se distingue con claridad entre “pedido en armado” (borrador) y “pedido enviado para reserva/confirmación”, ni qué pasa en cada caso con los 7 días.

6. **CTA secundario “Ver pasos”:** Útil para quien quiere bajar directo a los pasos, pero el hero ya anuncia las reglas; puede mantenerse como ancla sin duplicar mensaje.

7. **FAQ limitado:** Solo 4 preguntas; faltan temas como cambios/devoluciones, tiempos de confirmación o recargo por tarjeta.

8. **Tip del callout genérico:** “Compartir link del artículo” es útil pero no central para entender el flujo; puede quedar como detalle sin competir con los pasos.

9. **Sin mención de pagos ni recargo:** No se explica cómo se paga ni si hay recargo (ej. 3%); la usuaria lo busca y no lo encuentra.

10. **Sin política de cambios:** Quien revende necesita saber en una línea si hay cambios o no; hoy no está.

---

## B. Nueva propuesta de arquitectura de contenido

- **Hero:** Reglas clave del sistema (mínimo, plazo, que no es pago online). Un CTA principal (“Empezar a comprar”) y opcionalmente “Ver pasos” como ancla. Chips reducidos a 4 ítems escaneables. Sin repetir el detalle de los 7 días ni la confirmación de stock aquí.

- **Pasos:** Secuencia clara: (1) Armar carrito, (2) Enviar para reserva cuando quieras (con mínimo 4), (3) Nosotros confirmamos stock y podés seguir sumando hasta 7 días, (4) Coordinamos envío y pago. Callout “Tip” se mantiene pero más breve.

- **Aclaraciones:** Cuatro cards fijas: Reserva y stock | Envíos y retiro | Medios de pago (y recargo si aplica) | Cambios. Texto corto en cada una.

- **FAQ:** 5–7 preguntas: mezclar talles/colores, pagar por web, sin stock, pedido confirmado, cambios/devoluciones, tiempo de confirmación, recargo por tarjeta (si aplica). Respuestas cortas.

- **CTA final:** Una frase + un botón “Ir al catálogo”. Sin repetir todo el flujo.

---

## C. Nueva propuesta de copy completa

### 1. Hero

- **Badge:** Mayorista
- **Título:** Cómo comprar por mayor
- **Texto principal:**  
  Mínimo 4 productos combinables. Armás tu pedido, lo enviás para reserva y te confirmamos stock. Sin pago online.
- **CTA principal:** Empezar a comprar
- **CTA secundario:** Mantener “Ver pasos” (ancla a #howto-steps) — sí conviene para quien quiere bajar directo.
- **Chips:** Mínimo 4 · Hasta 7 días para armar · Reserva sin pago online · Envíos a todo el país

### 2. Sección de pasos

- **Título:** Comprá en 4 pasos
- **Subtítulo:** No pagás por la web: enviás el pedido y coordinamos después.
- **Pasos:**
  1. **Armá tu carrito**  
     Elegí modelos, talles y colores. Podés combinar lo que quieras; el mínimo son 4 productos.
  2. **Enviá el pedido para reserva**  
     Cuando llegás al mínimo, enviás el pedido. Ahí lo pasamos a reserva y revisamos stock.
  3. **Sumá productos hasta 7 días**  
     Mientras tanto podés seguir agregando ítems durante 7 días. Te avisamos si algo no tiene stock para que lo reemplaces.
  4. **Coordinamos envío y pago**  
     Te confirmamos el total y coordinamos envío. Pagás por transferencia o contra reembolso según acordemos.
- **Callout Tip:** Para compartir un producto con alguien, copiá el link de la ficha y enviáselo.

### 3. Aclaraciones importantes (4 cards)

- **Reserva y stock**  
  El pedido se reserva cuando lo enviás. Si algo no está, te avisamos y podés cambiarlo por otro modelo/talle/color.

- **Envíos y retiro**  
  Enviamos a todo el país. Si retirás en el local, también enviá el pedido y esperá nuestra confirmación para evitar faltantes.

- **Medios de pago**  
  Transferencia o contra reembolso según localidad. Si pagás con tarjeta puede haber un recargo (ej. 3%); te lo indicamos al confirmar.

- **Cambios**  
  Consultá cambios y devoluciones con nosotros al confirmar; te pasamos las condiciones según el caso.

### 4. FAQ (6 preguntas)

1. **¿Puedo mezclar modelos, talles y colores?**  
   Sí. El mínimo es 4 productos y los combinás como quieras.

2. **¿Tengo que pagar desde la web?**  
   No. Enviás el pedido, te confirmamos stock y después coordinamos pago y envío.

3. **¿Qué pasa si un producto no tiene stock?**  
   Te avisamos al confirmar y podés reemplazarlo por otro disponible.

4. **¿Cómo sé si mi pedido está confirmado?**  
   Te avisamos por WhatsApp o en la sección Pedidos una vez que revisamos el stock.

5. **¿Hay cambios o devoluciones?**  
   Consultalo con nosotros al confirmar; te pasamos la política según el producto y el caso.

6. **¿Puede haber recargo por pagar con tarjeta?**  
   En algunos casos sí (por ejemplo 3%). Te lo decimos al confirmar el pedido.

### 5. CTA final

- **Título:** ¿Lista para armar tu pedido?
- **Texto:** Entrá al catálogo, elegí tus productos y enviá el pedido cuando llegues al mínimo.
- **Botón:** Ir al catálogo

---

## D. Propuesta técnica mínima de implementación

- **index2.html:** Reemplazar solo el bloque `<main id="howto-page" class="howto is-hidden" ...> ... </main>` (desde la línea de apertura del main hasta el cierre `</main>`) por el nuevo HTML que implementa la sección C. No cambiar id, clase ni estructura de secciones (howto-hero, howto-section, howto-final); no tocar ids que usa el JS: `howto-page`, `howto-title`, `howto-steps`, `howto-notes`, `howto-faq`, `howto-steps-title`, `howto-notes-title`, `howto-faq-title`; mantener `data-action="go-home"`, `href="#howto-steps"`, y la estructura de `.faq-item` (`.faq-q`, `.faq-a`, `.faq-icon`).
- **index.html:** Replicar exactamente el mismo reemplazo del bloque `#howto-page` para mantener paridad.
- **scripts/como-comprar.js:** No tocar. `initInternalAnchors()` sigue aplicando a `a[href^="#howto-"]`; `initFAQ()` a `.faq-q` dentro de `#howto-page`; `initGoHomeHandlers()` a `[data-action="go-home"]`.
- **styles.css:** Cambio mínimo aplicado: en el media query `(min-width: 700px)`, `.howto .cards` pasó de `grid-template-columns: 1fr 1fr 1fr` a `1fr 1fr` para que las 4 cards queden en 2x2 en tablet/desktop. El resto de estilos se mantiene.

---

## E. Diff aplicado

- **index2.html** e **index.html:** reemplazado el bloque completo `<main id="howto-page">…</main>` por el nuevo contenido (hero, pasos, aclaraciones 4 cards, FAQ 6 ítems, CTA final). IDs, clases y atributos usados por el JS se mantienen.
- **styles.css:** en la sección "PÁGINA CÓMO COMPRAR", dentro del `@media (min-width: 700px)`, la regla `.howto .cards` ahora usa `grid-template-columns: 1fr 1fr`.
