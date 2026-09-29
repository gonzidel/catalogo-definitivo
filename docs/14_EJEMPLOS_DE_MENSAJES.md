# Ejemplos de mensajes

Última revisión: 2026-09-23

Estado: Colección inicial; terminología aprobada, sin mensajes completos aprobados  
Fuente: Código, documentación histórica y contexto confirmado por responsable del negocio  

Este documento conserva mensajes literales existentes. **En prueba** significa que el texto existe o fue ensayado, no que esté aprobado para todos los clientes ni desplegado en producción.

**NEGOCIO CONFIRMADO:** cuando existe una reserva real, se prefiere “reservado” frente a “apartado”. En `local_deferred_pickup` no se debe hablar de reserva antes de la preparación y confirmación física. Los textos literales que aún dicen “apartado” se conservan para auditoría, pero no están aprobados como modelo para mensajes nuevos.

## Fragmentos de terminología aprobada

Estado: Aprobado como terminología, no como mensaje completo  
Fuente: Contexto confirmado por responsable del negocio

Contexto:
La reserva ya existe y fue confirmada.

Objetivo:
Nombrar el estado con el término preferido para el cliente.

Mensaje:

```text
Tus productos están reservados.
Tu pedido mantiene los productos reservados hasta…
La reserva de tu pedido vence…
```

Por qué funciona:
Usa la palabra comercial confirmada sin afirmar una reserva antes de tiempo.

Evitar:
Usar estos fragmentos antes de confirmar stock, especialmente en `local_deferred_pickup`.

Antes de reutilizar un mensaje, leer `13_COMUNICACION_Y_TONO.md` y el documento funcional correspondiente. Los valores como `${url}` son campos dinámicos del texto original.

## Plantilla para cada ejemplo

```md
### Nombre del mensaje

Estado: Aprobado / En prueba / Histórico
Fuente: ...

Contexto:
...

Objetivo:
...

Mensaje:
...

Por qué funciona:
...

Evitar:
...
```

## Primer contacto

Ejemplos incorporados: Ninguno.

## Cliente nuevo sin compra

Ejemplos incorporados: Ninguno. El journey de días 7/30 tiene objetivos confirmados, pero todavía no textos aprobados.

## Cliente inactivo

Ejemplos incorporados: Ninguno. Los contactos a 60/120 días continúan en evaluación.

## Pedido creado

Ejemplos incorporados: Ninguno para el pedido normal.

## Pedido por vencer

### Aviso de último día desde administración

Estado: En prueba  
Fuente: `nj/lib/orders/customer-status-message.ts`  

Contexto:
Pedido todavía activo, próximo a terminar su plazo de reserva.

Objetivo:
Explicar qué ocurrirá y permitir revisar el pedido sin presión artificial.

Mensaje:

```text
Hola 👋 Tu pedido está a punto de vencer.

Recordá finalizarlo antes de que termine el plazo de reserva para evitar que se desarme. Si necesitás más tiempo, cuando venza el plazo podés solicitar una prórroga desde tu pedido.

Podés revisarlo acá: ${url} 😊
```

Por qué funciona:
Explica el evento, su consecuencia y la acción disponible con lenguaje cercano.

Evitar:
“ÚLTIMA OPORTUNIDAD 🚨” o cualquier urgencia no respaldada por el plazo real.

## Pedido vencido

### Pedido desarmado por vencimiento

Estado: En prueba  
Fuente: `nj/lib/orders/customer-status-message.ts`, migración 357 y prueba YCloud en whitelist  

Contexto:
El pedido ya pasó a `expired` y fue desarmado; no usar durante la ventana recuperable.

Objetivo:
Cerrar el ciclo e indicar un canal de consulta.

Mensaje:

```text
Hola 👋 Tu pedido venció y se desarmó porque finalizó el plazo de reserva.

Cualquier consulta, podés escribirnos 😊
```

Por qué funciona:
Describe el resultado sin amenazas ni lenguaje técnico.

Evitar:
Enviarlo antes de que mantenimiento haya desarmado realmente el pedido.

## Faltantes

### Ningún producto pudo apartarse — copy actual a revisar

Estado: En prueba; requiere actualización  
Fuente: `nj/lib/orders/customer-status-message.ts`  

Contexto:
La preparación terminó sin productos confirmados.

Objetivo:
Informar el faltante sin afirmar que el stock había sido garantizado.

Mensaje:

```text
Hola 👋 No pudimos apartar los productos de tu pedido porque ya no quedan disponibles.

Podés revisar cuáles son desde acá: ${url}.

Cualquier consulta, podés escribirnos 😊
```

Por qué funciona:
Conserva evidencia del texto actualmente implementado y ofrece revisión y contacto.

Evitar:
Reutilizarlo como mensaje aprobado: dice “apartar”, no identifica el producto afectado y no presenta las alternativas confirmadas de revisión, reintegro o reemplazo voluntario.

## Pedido listo

### Todos los productos apartados — copy actual a revisar

Estado: En prueba; requiere actualización terminológica  
Fuente: `nj/lib/orders/customer-status-message.ts`  

Contexto:
Todos los productos del pedido están confirmados y apartados.

Objetivo:
Confirmar el avance y dirigir al detalle del pedido.

Mensaje:

```text
Hola 👋 Todos los productos de tu pedido ya están apartados y listos.

Podés revisar tu pedido cuando quieras desde acá: ${url} 😊
```

Por qué funciona:
Es breve y comunica un estado confirmado, pero conserva terminología que ya no es la preferida.

Evitar:
Usarlo si quedan ítems `waiting`, `awaiting_apartado` o sin resolver. Para textos nuevos, reemplazar el concepto visible “apartados” por “reservados” sin cambiarlo en código durante esta etapa.

## Retiro local

### Pedido listo para retirar

Estado: En prueba  
Fuente: `nj/lib/orders/customer-status-message.ts`  

Contexto:
Pedido confirmado como listo para retiro. El plazo canónico es de 36 horas desde esta comunicación y el número se completa desde el pedido vivo.

Objetivo:
Comunicar disponibilidad, lugar, identificación y acceso al detalle.

Mensaje:

```text
Hola 👋 Tu pedido ya está listo para retirar.

Podés pasar por nuestro local en Av. Alberdi 1099. Tenés tiempo hasta ${plazo}.

Al retirar, indicá tu nombre o número de pedido ${numero_pedido}.

Podés revisar tu pedido acá: ${url} 😊
```

Por qué funciona:
Da la información operativa necesaria con campos obtenidos del pedido.

Evitar:
Fijar “mañana 15:00” manualmente sin calcular el plazo real, o comunicar 24/48 horas.

## Retiro local diferido

### Pedido recibido, todavía no reservado

Estado: En prueba  
Fuente: `nj/components/cart/ActiveOrderTab.tsx`  

Contexto:
Primer estado visible tras crear un pedido de zona/modalidad diferida.

Objetivo:
Dejar claro que falta preparación y que se avisará cuando esté listo.

Mensaje:

```text
Recibimos tu pedido

Ahora vamos a preparar y confirmar los productos que pediste.

Te avisamos cuando esté listo

Vas a recibir un mensaje por WhatsApp cuando tu pedido esté preparado para retirar.
```

Por qué funciona:
No presenta la mercadería como reservada antes de la confirmación física.

Evitar:
Decir “reservado” o iniciar las 36 horas de retiro antes de la confirmación/comunicación de que está listo.

## Pago pendiente

Ejemplos incorporados: Ninguno.

## Pago confirmado

### Confirmación breve con seguimiento

Estado: En prueba  
Fuente: Contexto confirmado por responsable del negocio  

Contexto:
El pago ya fue confirmado y el flujo tendrá seguimiento de envío.

Objetivo:
Confirmar el pago y anticipar el siguiente paso.

Mensaje:

```text
Pago confirmado; te enviamos seguimiento.
```

Por qué funciona:
Es directo y comunica la siguiente acción.

Evitar:
Enviarlo antes de contar con evidencia válida del pago.

## Envío

### Coordinación por transferencia

Estado: En prueba  
Fuente: `nj/lib/transport/shipping-helpers.ts`  

Contexto:
Pedido con transporte que requiere coordinación de pago previo.

Objetivo:
Anticipar el contacto humano y el método de pago.

Mensaje:

```text
Te escribiremos por WhatsApp cuando esté listo para coordinar el pago por transferencia y el envío.
```

Por qué funciona:
No promete despacho antes de preparación y pago.

Evitar:
Usarlo para transportes contra reembolso.

## Testers

Ejemplos incorporados: Ninguno. La comunicación de testers está confirmada solo como contexto histórico, no como texto literal aprobado.

## Errores o problemas

Ejemplos incorporados: Ninguno.

## Marketing

Ejemplos incorporados: Ninguno.

## CRM / reactivación

Ejemplos incorporados: Ninguno. Existen objetivos de journeys, pero todavía no copys aprobados.
