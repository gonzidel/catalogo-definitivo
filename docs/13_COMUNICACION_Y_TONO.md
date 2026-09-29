# Comunicación y tono

Última revisión: 2026-09-23

Estado: Vigente como guía general; detalles por canal todavía incompletos  
Fuente: Contexto confirmado por responsable del negocio  

Esta guía define la voz general de FyL Moda. No reemplaza las reglas funcionales ni convierte un borrador en mensaje aprobado.

Las reglas relevantes usan las clasificaciones definidas en `00_INDEX.md`. Los estados “Vigente”, “En evaluación” o similares describen madurez editorial, no sustituyen esa clasificación de evidencia.

## Contexto antes de redactar

Antes de escribir cualquier texto visible al cliente, identificar y confirmar:

- tipo de cliente;
- estado real del pedido;
- modalidad de entrega;
- si existe reserva o compromiso de stock;
- si el mensaje es automático o manual;
- objetivo concreto del mensaje.

También se debe leer el documento funcional correspondiente. Por ejemplo, para retiro local diferido deben consultarse `08_RETIRO_LOCAL.md` y `06_PEDIDOS.md`, además de esta guía.

## Personalidad de la marca

Estado: Vigente  
Fuente: Contexto confirmado por responsable del negocio  

FyL debe comunicarse de forma:

- cercana;
- clara;
- humana;
- profesional sin sonar formal o corporativa;
- directa;
- simple.

El mensaje debe parecer escrito por una persona de atención al cliente, no por una empresa grande ni por un bot.

## Tono general y tratamiento

Estado: Vigente  
Fuente: Contexto confirmado por responsable del negocio  

- Usar lenguaje natural rioplatense/argentino.
- Preferir `vos` y formas como “te ayudamos”, “podés”, “querés”, “tu pedido” y “escribinos”.
- Mantener calidez sin agregar entusiasmo artificial.
- Evitar formalidad distante salvo que exista una razón específica.

Formas a evitar como apertura o fórmula automática:

- “Estimado cliente”;
- “Le informamos que”;
- “Procederemos a”;
- “Agradecemos su preferencia”.

Sigue pendiente definir si algún canal legal, fiscal o de reclamos requiere un tratamiento distinto.

## Emojis

Estado: Vigente  
Fuente: Contexto confirmado por responsable del negocio  

- Se permiten de manera moderada.
- `👋` y `😊` son ejemplos habituales.
- No saturar el mensaje.
- Evitar alarmas o urgencia exagerada salvo necesidad real.

## Longitud y estructura

Estado: Vigente para WhatsApp  
Fuente: Contexto confirmado por responsable del negocio  

- Priorizar mensajes cortos y fáciles de escanear.
- Comunicar una idea principal clara.
- Si hay mucha información, separarla conceptualmente en lugar de crear un bloque extenso.
- Mostrar primero qué ocurrió, luego qué significa y finalmente qué debe o puede hacer el cliente.
- La longitud y estructura exactas para web, email y notificaciones todavía no están definidas por separado.

## Mensaje transaccional y marketing

### Transaccional

Estado: Vigente como criterio general  
Fuente: Contexto confirmado por responsable del negocio  

- Debe describir un estado real del pedido, pago, stock, retiro o envío.
- No debe prometer reserva, preparación, pago o despacho si el sistema o una persona todavía no lo confirmó.
- Debe ofrecer el siguiente paso cuando corresponda.
- En `local_deferred_pickup`, aclarar antes de la confirmación que el pedido sigue pendiente y los productos todavía no están reservados.

### Marketing y CRM

Estado: En evaluación  
Fuente: Contexto confirmado por responsable del negocio  

- No reclamarle al contacto que todavía no compró.
- Evitar insistencia excesiva.
- Ofrecer ayuda y una vía clara para volver al catálogo o armar un pedido.
- Consentimiento, baja, frecuencia legal y retención de datos continúan pendientes.

## Cómo comunicar urgencia

Estado: Vigente  
Fuente: Contexto confirmado por responsable del negocio  

- Explicar qué está por suceder.
- Indicar qué acción puede realizar el cliente.
- Evitar amenazas y presión comercial artificial.
- Preferir “Tu pedido está a punto de vencer…” frente a “ÚLTIMA OPORTUNIDAD 🚨”.
- Para retiro local listo, usar el plazo canónico de 36 horas desde la comunicación de “listo”; no reutilizar referencias de 24 o 48 horas.

## Cómo explicar errores

Estado: Vigente  
Fuente: Contexto confirmado por responsable del negocio  

1. Explicar qué ocurrió con palabras sencillas.
2. Decir qué significa para el cliente.
3. Ofrecer la siguiente acción disponible.

No exponer nombres de RPC, tablas, estados internos, trazas ni jerga técnica.

## Cómo comunicar faltantes

Estado: Vigente  
Fuente: Contexto confirmado por responsable del negocio  

- Informar el faltante con claridad.
- Identificar qué producto presenta el problema.
- Explicar que ese producto no pudo confirmarse o entregarse.
- No insinuar que FyL había garantizado una unidad que todavía no estaba confirmada.
- Diferenciar con claridad lo listo, lo pendiente y lo no disponible.
- Ser especialmente preciso en `local_deferred_pickup`, donde crear el pedido no equivale a reservar stock.
- Ofrecer las alternativas disponibles: revisar lo ocurrido, reintegrar el importe cuando corresponda o permitir que el cliente elija otro producto.
- No presentar el reemplazo como obligatorio ni comunicar una sustitución que el cliente no eligió.
- Evitar lenguaje técnico interno y resolver el caso con el cliente.

## Lenguaje interno y visible

**NEGOCIO CONFIRMADO:** en mensajes visibles al cliente se prefiere **“reservado”** frente a **“apartado”**. Usar “apartado” en nuevos mensajes solo si existe una razón concreta.

**CANÓNICA:** nunca comunicar que un producto está reservado si todavía no existe una reserva real. En `local_deferred_pickup`, crear el pedido no descuenta ni reserva stock de inmediato.

Antes de preparar/confirmar un retiro diferido, preferir:

- “Recibimos tu pedido”.
- “Está pendiente de preparación”.
- “Te avisamos cuando esté listo”.
- “Todavía estamos confirmando la disponibilidad en el local”.

Después de que el local confirma, prepara y compromete el stock, puede comunicarse que los productos están **reservados** y el pedido está listo para retirar.

**CONTRADICCIÓN TÉCNICA:** existen textos actuales que usan “apartado”, “apartados” y “apartar”. Deben distinguirse siempre:

- lenguaje interno de operación y estados técnicos;
- lenguaje visible para un pedido normal;
- lenguaje visible para `local_deferred_pickup` antes y después de la confirmación física.

La existencia de esos textos no reemplaza la preferencia comercial confirmada.

## Cambios, sustituciones y reintegros

**NEGOCIO CONFIRMADO:**

- Un cambio voluntario debe describirse como decisión del cliente: se quita el producto anterior y se agrega el nuevo elegido.
- Ante un faltante, no decir que FyL “cambió” el producto si el cliente todavía no eligió una alternativa.
- En pedidos enviados, solo prometer devolución o reintegro cuando el caso y la responsabilidad de FyL estén confirmados.
- Para cambios en el local, comunicar la posibilidad de cambio sin prometer automáticamente devolución de dinero.
- Los casos no contemplados deben pasar a resolución humana.

## Cómo pedir una acción

Estado: Vigente como criterio general  
Fuente: Contexto confirmado por responsable del negocio  

- Pedir una sola acción principal por vez.
- Explicar por qué hace falta y, si existe, hasta cuándo puede realizarse.
- No inventar plazos ni consecuencias para generar presión.

## Cómo incluir enlaces

Estado: Parcialmente definido  
Fuente: Contexto confirmado por responsable del negocio  

- En el seguimiento de un contacto nuevo puede ser útil incluir el enlace al catálogo/web.
- En mensajes transaccionales, explicar qué encontrará el cliente al abrirlo.
- Usar únicamente URLs verificadas para el entorno y flujo correspondiente.
- Los dominios canónicos de producción y la política sobre acortadores continúan pendientes.

## Comunicación según relación con el cliente

### Cliente nuevo sin compra

Estado: Journey en evaluación  
Fuente: Contexto confirmado por responsable del negocio  

- Día 7: recordar el contacto, ofrecer ayuda, resolver dudas y facilitar el regreso a la web.
- Día 30: segundo y último contacto, ofreciendo ayuda para el primer pedido.
- No reprochar que todavía no compró.
- Los días son parámetros en evaluación, no una verdad universal aprobada.

### Cliente habitual

Estado: Guía específica pendiente  
Fuente: Contexto externo pendiente  

Aplican la voz general y las reglas transaccionales. Todavía no se definieron personalización, frecuencia ni beneficios específicos.

### Cliente inactivo

Estado: Journey en evaluación  
Fuente: Contexto confirmado por responsable del negocio  

- Se evaluaron contactos alrededor de 60 y 120 días.
- El objetivo es comunicar novedades, ofrecer ayuda y facilitar un nuevo pedido.
- La definición de “inactivo” y los intervalos pueden ajustarse.

## Mensajes automáticos y humanos

Estado: Parcialmente definido  
Fuente: Contexto confirmado por responsable del negocio  

- Ambos deben conservar una voz humana, cercana y clara.
- Un mensaje automático debe depender de un evento verificable y ser conservador cuando el estado sea incierto.
- Un mensaje humano puede adaptar contexto, pero no contradecir reglas de stock, pago, retiro o vencimiento.
- Sigue pendiente decidir si el cliente debe recibir una identificación explícita del carácter automático y qué casos exigen intervención humana.

## Gobierno y vigencia

- Responsable de aprobar mensajes definitivos: Pendiente de definir.
- Ejemplos vigentes, en prueba e históricos: `14_EJEMPLOS_DE_MENSAJES.md`.
- Textos presentes en código no equivalen automáticamente a aprobación empresarial.
- Fecha y responsable de cada revisión: Pendiente de formalizar.

## Documentos funcionales relacionados

- `02_MODELO_NEGOCIO.md`
- `06_PEDIDOS.md`
- `07_STOCK.md`
- `08_RETIRO_LOCAL.md`
- `09_WHATSAPP_CRM.md`
- `12_PENDIENTES.md`
- `14_EJEMPLOS_DE_MENSAJES.md`
