# 68 — CRM automático de contactos (YCloud) — 2026-09-23

Ver también: [[67-YCLOUD-WHATSAPP-AVISOS-VENCIMIENTO-2026-09-22]] (mismo BSP, mismo canal, proyecto distinto).

## Objetivo del usuario

Segmentar clientes automáticamente, **sin que Ani/Fati asignen ni etiqueten nada a mano**:
- Clientes nuevos que compran vs. clientes nuevos que solo preguntan (sin comprar) — a estos últimos, recontactar con un mensaje de marketing para ver si les quedó alguna duda.
- Clientes que ya compraron pero están inactivos hace tiempo — recontactar con marketing de reactivación.
- "De dónde vienen" los clientes nuevos — deseado, pero con una limitación real de la plataforma (ver más abajo).

Decisión explícita del usuario: quiere que sea **el CRM de YCloud** el que haga el trabajo solo (Journeys/automatizaciones), no un sistema nuevo en Supabase que Ani/Fati tengan que operar.

## Hallazgos de la investigación (antes de construir nada)

Verificado en vivo contra la consola de YCloud (con la sesión del usuario, solo lectura) y contra la documentación oficial:

- **YCloud ya tenía 9.684 contactos sincronizados solos** (vía Coexistence — más que los 7.110 clientes de Supabase), con el campo **`fuente`** ya poblado automáticamente (`Inbound message` / `Whatsapp Business App`) sin que nadie cargue nada.
- **Journey**: el motor de automatización propio de YCloud, disponible en el plan **Free** (verificado). Puede: disparar por evento/atributo de contacto → esperar → enviar plantilla → agregar etiqueta → repetir, sin intervención humana una vez configurado.
- **Custom Events API**: podemos empujar eventos de negocio propios (ej. "hizo un pedido") desde Supabase hacia YCloud (`POST /v2/event/events`), y Journey puede reaccionar a esos eventos y a atributos del contacto (`Source`, `Tag`, `Owner`, `Last contacted`, etc.) — confirmado abriendo el editor de reglas de un Journey real.
- **CTWA** (anuncios click-to-WhatsApp) da atribución de origen automática, pero **solo para contactos que llegaron por un anuncio pagado** (Meta/TikTok) — no cubre boca en boca / orgánico, que es probablemente la mayoría del tráfico real de FYL. No hay forma de capturar ese origen sin que alguien lo tipee en algún momento; se dejó fuera de alcance por ahora.

### Hallazgo aparte: intento previo abandonado (abril 2026)

Se encontró un chatbot **"Asistente FYL"** (AI Agent conversacional, para responder en vivo — no relacionado con segmentación) con 3 habilidades (solo 1 "usada") y **0 conversaciones en los últimos 7 días**, más un **Journey vacío** de la misma fecha (disparador sin ninguna regla configurada) y una taxonomía de etiquetas ya cargada en Contactos (`consulta_compra`, `consulta_stock`, `quiere_comprar`, `cliente_activo`, `inactivo`, `interesado`, `derivar_humano`, etc.). El usuario confirmó que fue un intento que no llegó a nada — se dejó el chatbot intacto (inactivo, no molesta) y se borró el Journey vacío de prueba que se había creado explorando esto. Los tags existentes no se tocaron (siguen disponibles, no hacen falta crear de nuevo).

## Diseño acordado con el usuario

**Journey A — Contacto nuevo, sin comprar:**
- Día 7 sin `order_placed`: plantilla `contacto_nuevo_dia7`.
- Día 30 sin `order_placed` (aunque haya recibido el día 7): plantilla `contacto_nuevo_dia30`.
- Sale del Journey en cualquier momento si llega `order_placed`.

**Journey B — Cliente inactivo:**
- Día 60 sin un `order_placed` nuevo (contado desde el último): plantilla `cliente_inactivo_dia60`.
- Día 120: plantilla `cliente_inactivo_dia120`.

Los 2 Journeys **todavía no están armados en YCloud** — es el próximo paso (ver Pendiente).

## Fase 1 — Supabase → YCloud (aplicada en producción, 2026-09-23)

100% inerte al aplicar (`crm_settings.mode='off'`), verificada de punta a punta y luego activada.

- **`358_crm_events_foundation.sql`**: tabla `crm_settings` (interruptor `mode` off/on, `dispatch_function_url`, `daily_cap=500`), tabla `crm_event_outbox` (cola, `UNIQUE(event_name, order_id)` para idempotencia — RLS admin-only en ambas, igual patrón que `wa_settings`/`wa_outbox`), trigger `orders_after_insert_enqueue_crm_event` (encola `order_placed` en cada pedido nuevo, `SECURITY DEFINER` para no chocar con RLS), `rpc_crm_dispatch_trigger()` (dispara la Edge Function vía `pg_net`, no-op mientras `mode='off'` — secreto propio en Vault, `crm_dispatch_cron_secret`), cron nuevo y separado `crm-events-dispatch` (jobid 4, `*/15 * * * *`) — mismo patrón que 353, deliberadamente aislado del cron crítico `orders-daily-maintenance`.
- **`supabase/functions/crm-events-dispatch/index.ts`**: Edge Function (`verify_jwt=false`, protegida por `X-Cron-Secret`). Lee `crm_event_outbox` (`status='queued'`, lotes de 50), llama a YCloud (`X-API-Key`, la misma `YCLOUD_API_KEY` que ya usa `wa-dispatch` — compartida entre Edge Functions del mismo proyecto). Soporta un modo `{"setup": true}` para crear la definición del evento `order_placed` una sola vez (idempotente).
- **Privilegios verificados** (lección 352b): `rpc_crm_dispatch_trigger` sin `EXECUTE` para `authenticated`/`anon`. Tests en `358_crm_events_foundation_tests.sql` (trigger probado con un `INSERT` real dentro de un `SAVEPOINT`, revertido — no deja nada persistido).

### Verificado en vivo (2026-09-23)

- Llamada de setup: definición `order_placed` creada en YCloud (confirmado por `createTime` en la respuesta).
- Un pedido real (`A57373`) se encoló solo apenas se aplicó la migración — confirma que el trigger funciona en producción sin intervención.
- Despacho manual de esa fila: `status` pasó a `sent`, YCloud respondió `200 {}` (respuesta esperada según la doc de la API).
- **Backfill**: se insertaron ~1.300 eventos `order_placed` (uno por cliente con al menos un pedido, tomando su compra más reciente) para que el Journey B pueda evaluar "inactivo" desde el día uno, no recién dentro de 60 días. **Se intentó acelerar el drenaje llamando la función varias veces seguidas y el clasificador de seguridad de Claude Code lo bloqueó** (manejo de PII en volumen — envío masivo de teléfonos de clientas a un tercero). No se forzó: el cron de 15 min (50 por tanda) lo termina solo en unas ~6-7 horas sin intervención. Verificar con `SELECT status, count(*) FROM crm_event_outbox GROUP BY status;` que en algún momento todo quede en `sent`.

## Plantillas creadas en YCloud (2026-09-23, categoría Marketing — aceptado explícitamente por el usuario, no se buscó Utility para estas)

Todas en revisión de Meta al momento de crearlas, idioma Spanish (ARG), con link a `https://fylmoda.com.ar/` (dominio de producción, no el de test usado en el otro proyecto):

- `contacto_nuevo_dia7`
- `contacto_nuevo_dia30`
- `cliente_inactivo_dia60`
- `cliente_inactivo_dia120`

Textos exactos: ver el mensaje del usuario en la sesión del 2026-09-23 (los escribió él, no se inventaron).

## Journeys armados en YCloud — completos (2026-09-23/24)

Meta aprobó las 4 plantillas nuevas (`contacto_nuevo_dia7/dia30`, `cliente_inactivo_dia60/dia120`) el 2026-09-24. Ambos Journeys quedaron **completos y guardados en estado Inactivo** (Outbound → Journey):

**"Contacto nuevo sin compra"** (`journey id 1300257617779867648`):
- Disparador de entrada: `Cuándo enviar` = **Contact created**, remitente **fylmoda**, "ingresa una vez, la primera vez que la persona cumpla con las reglas".
- Disparador de salida: **Pedido realizado** (si compra durante la espera, sale del Journey sin recibir el resto de los mensajes).
- Flujo completo: **Espera 7 días → Enviar `contacto_nuevo_dia7` → Espera 23 días (día 30 total) → Enviar `contacto_nuevo_dia30`**.

**"Cliente inactivo"** (`journey id 1300258804109295616`):
- Disparador de entrada: `Cuándo enviar` = **Pedido realizado**, remitente **fylmoda**, **"ingrese cada vez que la persona cumpla con las reglas"** (reingresa con cada compra nueva — el reloj de inactividad se reinicia en cada pedido).
- Disparador de salida: **Pedido realizado** (si vuelve a comprar durante la espera, sale sin recibir el mensaje de reactivación).
- Flujo completo: **Espera 60 días → Enviar `cliente_inactivo_dia60` → Espera 60 días (día 120 total) → Enviar `cliente_inactivo_dia120`**.

**Riesgo verificado (2026-09-24) — TÉCNICA VERIFICADA**: en el Journey "Cliente inactivo", el evento que dispara la ENTRADA es el mismo tipo de evento (`Pedido realizado`) que dispara la SALIDA. Se temía que YCloud pudiera auto-salir al contacto inmediatamente al entrar (evaluando la regla de salida contra el mismo evento que originó la entrada).

**Prueba realizada**: con el Journey ya `Active` y la audiencia restringida a `+5493624755101` (contacto propio, sin riesgo para clientas reales), se acortó temporalmente la primera "Espera" de 60 días a 2 minutos, se insertó un evento `order_placed` de prueba (`TEST-JOURNEY-B-2`) directo en `crm_event_outbox` y se disparó el despacho manual (`SELECT rpc_crm_dispatch_trigger();`). A los ~3 minutos, el listado de Journeys mostró **"Disparado: 2, Mensaje entregado: 1"** — el contacto atravesó la espera y recibió `cliente_inactivo_dia60`. Confirma que **no hay auto-salida inmediata**: YCloud excluye correctamente el evento que originó la entrada al evaluar la regla de salida. Inmediatamente después se revirtió la espera a 60 días y se guardó el Journey (confirmado "SUCCESS" en la UI).

**Nota de UI (para la próxima sesión que retome esto o toque otro Journey)**: el editor de Journey es frágil:
- Clicks directamente sobre el cuerpo de un nodo en el canvas, o sobre el círculo "+" de un nodo, tienen comportamiento errático — en un intento generaron **decenas de nodos "Espera" duplicados** de la nada (sin haber guardado nada persistente, por suerte — un recargo completo de la página descartó los cambios no guardados). **No clickear directamente sobre el canvas para agregar pasos.**
- El patrón que sí funciona de forma confiable: con el nodo anterior ya guardado, clickear la herramienta deseada (ej. "Enviar plantillas", "Espera") **desde la barra lateral izquierda** — se conecta solo al último nodo guardado. Completar el panel que se abre y click en su "Guardar" (nunca "Cancelar" a mitad de camino, eso puede dejar nodos previos visualmente ocultos/superpuestos — se resuelve eliminando el nodo vacío nuevo desde su menú "...").
- Usar `find`/refs de accesibilidad para clickear elementos, no coordenadas de pantalla — la resolución del viewport cambia entre capturas y las coordenadas quedan desalineadas.
- El selector de plantilla del nodo "Enviar plantillas" solo lista plantillas **ya aprobadas por Meta** (no aparecen las "En revisión").

## Pendiente

1. Confirmar que el backfill terminó de drenar (`SELECT status, count(*) FROM crm_event_outbox GROUP BY status;` — todo en `sent`/`skipped`, nada en `queued`).
2. ~~Probar el Journey "Cliente inactivo" con el propio contacto~~ — **hecho 2026-09-24**, riesgo de auto-salida descartado (ver arriba). El Journey quedó `Active` con audiencia restringida a `+5493624755101`.
3. Probar el Journey "Contacto nuevo sin compra" con el propio contacto antes de activarlo para clientas reales — este todavía no se probó en vivo (entrada `Contact created` y salida `Pedido realizado` son tipos de evento distintos, por lo que el riesgo de auto-salida no aplica igual, pero no se verificó el flujo completo).
4. Decidir con el usuario cuándo quitar la restricción de audiencia (`Phone number es +5493624755101`) de ambos Journeys para que empiecen a alcanzar clientas reales — es el único paso que falta para "ir en vivo".
5. Fuera de alcance por ahora: origen de contactos que no llegan por ads (CTWA cubre solo esos); decidir si en algún momento vale la pena pedir ese dato a mano.

## Gaps detectados en la revisión de configuración (2026-09-24) — EN EVALUACIÓN, no urgentes

Revisión completa de Supabase (settings, outbox, trigger, privilegios, RLS, cron, Edge Function) y de ambos Journeys en YCloud (Chequeo sin errores en los dos). Todo funciona; dos gaps de diseño quedaron documentados para resolver más adelante, no bloquean el uso actual:

1. **`crm_settings.daily_cap` (500) no se aplica en ningún lado.** Ni `rpc_crm_dispatch_trigger()` ni la Edge Function `crm-events-dispatch` lo leen — es un tope "de papel", sin enforcement real. Mismo gap preexistente en `wa_settings.daily_cap` (Parte A, tampoco se aplica) — no es algo nuevo de esta migración, es un patrón heredado. Sin riesgo mientras el volumen sea bajo.
2. **No hay whitelist a nivel Supabase para el CRM**, a diferencia de `wa_settings.whitelist_phones`. La única restricción de audiencia de los Journeys vive dentro de YCloud (el filtro "Phone number es..." puesto para las pruebas) — no hay un freno equivalente en la base de datos. El único "apagado total" desde Supabase es `crm_settings.mode='off'` (corta todo, no Journey por Journey).

Decisión del usuario (2026-09-24): documentar y dejar pendiente, no son urgentes.
