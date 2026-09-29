# 67 — YCloud/WhatsApp: avisos automáticos de vencimiento (2026-09-22)

Ver también: [[47-VENCIMIENTO-PEDIDOS-DIA-HABIL-2026-08-01]], [[48-AUDITORIA-ESTADOS-PEDIDOS-Y-FIXES-2026-08-01]], [[65-AUDITORIA-PEDIDOS-EXPIRED-INVISIBLES-Y-STOCK-FANTASMA-2026-09-15]], [[46-NJ-KANBAN-PEDIDOS-ADMIN-2026-07-15]], [[325-VINCULACION-ADMIN-NJ-ONBOARDING-2026-09-03]].

## Objetivo del proyecto

Conectar YCloud (BSP de WhatsApp Cloud API, vía Coexistence sobre el número real de la app) para dos usos:

1. **Avisos automáticos de pedido** — prioridad #1 del usuario: aviso de "por vencer" (24h antes) y "venció" (al desarmarse), sin depender de que Ani o Fati estén atendiendo.
2. **CRM/remarketing** (leads, origen, campañas) — decidido explícitamente para **más adelante**, panel aparte. Fuera de alcance de esta nota.

Decisión de negocio (usuario, 2026-09-21/22 — "opción B"): **no** se agrega link de prórroga ni ninguna mecánica nueva en los mensajes automáticos. El sistema de prórroga existente (dashboard, solo tras vencer, una vez, requiere cuenta vinculada) queda exactamente como estaba. Los avisos automáticos son puramente informativos.

## Auditoría previa (resumen)

- El repo es ~99% WhatsApp-first vía `wa.me` manual, no web-first: en los últimos 90 días, 2.828 de 2.851 pedidos tienen `source=admin`. De 7.107 clientes, solo 25 están vinculados a una cuenta web (`auth_provider IN ('google','email')`).
- `order_notifications` (outbox viejo, migración 123/256/257) tiene 2.258 filas sin enviar desde marzo — **no se usa** como fuente para esto (la 256 nunca se aplicó, el usuario ya había decidido dejarla apagada, ver [[65-AUDITORIA-PEDIDOS-EXPIRED-INVISIBLES-Y-STOCK-FANTASMA-2026-09-15]] punto B).
- `admin_order_expiry_warn_sent` (migración 305) ya existe y es lo que hoy evita que Ani/Fati reenvíen el aviso manual dos veces — se reutiliza como señal de "ya se avisó a mano" para que el automático no duplique.
- Ani y Fati tienen **números distintos**. Se arranca por el de Fati (el usado hoy para casi todo); Ani se conecta después. `pg_net` no estaba instalada en producción (verificado); `pg_cron` y `supabase_vault` sí.
- Verificado en producción: 6.910 de 7.107 teléfonos son convertibles a E.164 argentino (197 no); de los 159 pedidos con `dismantle_at` pendiente, todos tenían `kanban_inbox_owner` asignado (75 Ani / 84 Fati, 0 sin dueña).

## Reglas de negocio decididas

- Aplica a **todos** los pedidos (admin y clienta), no solo autogestionados.
- Mínimo **4 unidades** (igual que el resto del sistema de vencimiento).
- Excluye retiro local diferido y la zona de 36h (`fn_is_local_pickup_short_deadline_zone`).
- **Por vencer**: dispara exactamente 24h antes de `dismantle_at`. Texto: *"Hola 👋 Tu pedido {{1}} se vence mañana a las 17:00 hs."* — sin fecha explícita, sin link, sin mención de prórroga.
- **Venció**: dispara cuando `orders.status='expired'` (mismo momento en que `rpc_orders_daily_maintenance` ya desarma el pedido, ~17:00 AR). Texto: *"Hola 👋 Tu pedido {{1}} venció y el stock reservado se liberó. Cualquier consulta, respondé este mensaje 😊"*
- Sin duplicados: clave `(order_id, kind, dismantle_at)` — una prórroga cambia `dismantle_at` y genera un aviso nuevo, no repite el anterior.
- Si Ani/Fati ya mandaron el aviso a mano en las últimas 24h (`admin_order_expiry_warn_sent.sent_at`), el automático se saltea (`skip_reason='manual_warn_sent_recently'`).
- `wa_settings.launch_cutoff_at` evita reenviar el historial de pedidos que ya estaban vencidos/por vencer antes de encender el sistema — mientras esté `NULL`, **nada** se envía (`skip_reason='launch_cutoff_not_set'`), verificado en vivo (20 candidatos, 0 elegibles).

## Fase 1 — Fundaciones (aplicada en producción, 2026-09-22)

100% inerte: sin `pg_net`, sin cron, sin llamada a internet. Solo tablas + funciones de cálculo/encolado.

- **`351_wa_notifications_foundation.sql`**: tablas `wa_settings` (interruptor único: `mode` off/shadow/whitelist/live, `launch_cutoff_at`, `daily_cap`, `whitelist_phones`), `wa_channels` (canal por dueña; sembrado con `fati` como default y `ani`, ambos `status='pending'` — todavía no conectados), `wa_outbox` (cola, `UNIQUE(order_id,kind,dismantle_at)`), `wa_webhook_events` (log crudo, vacía hasta fase 2). RLS admin-only en las 4.
- **`352_wa_expiry_events_logic.sql`**: `fn_wa_phone_e164` (normaliza a E.164 AR), `fn_wa_format_deadline_es` (uso interno/logs, no va en los mensajes), `fn_wa_expiry_candidates` (helper: calcula candidatos + `skip_reason`, sin escribir nada), `rpc_wa_preview_expiry_events` (solo lectura, admin), `rpc_wa_enqueue_expiry_events` (admin; respeta `mode`/`daily_cap`/`whitelist_phones`; en `mode='off'` no inserta nada).

### Hallazgo y fix post-deploy: fuga de privilegios en el helper interno

**Verificación post-aplicación** (`has_function_privilege`) encontró que `fn_wa_expiry_candidates()` quedó ejecutable por `anon` **y** por `authenticated`, pese a `REVOKE ALL ... FROM PUBLIC` en el SQL de 352. Causa: este proyecto tiene *default privileges* que otorgan `EXECUTE` a `anon`/`authenticated` en toda función nueva, por rol — un `REVOKE ... FROM PUBLIC` no los cubre, hace falta revocar explícitamente por rol. Esto exponía nombres, teléfonos y datos de pedidos de clientas a cualquier visitante sin sesión, vía PostgREST.

Se verificó además que el patrón general del proyecto (tablas con RLS admin-only, RPCs con chequeo interno `IF NOT EXISTS (SELECT 1 FROM admins ...)`) está bien — comparado contra `rpc_admin_reopen_expired_order` y `admin_order_expiry_warn_sent`, que tienen el mismo `EXECUTE`/`SELECT` otorgado a nivel Postgres pero bloqueado por RLS o por el chequeo interno. El problema era específico de esta función sin RLS (por no ser una tabla).

**Fix aplicado en producción** (mismo día, ~minutos después): `352b_fix_wa_expiry_candidates_privilege_leak.sql` — `REVOKE EXECUTE ... FROM authenticated, anon` explícito. Verificado post-fix: `has_function_privilege` da `false` para ambos roles.

**Verificación general post-Fase 1** (en vivo, `fyl-core`):
- 4 tablas creadas, `wa_settings` con 1 fila (`mode='off'`), `wa_channels` con 2 filas (fati/ani).
- `fn_wa_phone_e164`: 4 casos probados, todos correctos (10 dígitos, E.164 con espacios, con 0 inicial, basura → NULL).
- `fn_wa_format_deadline_es('2026-09-28 20:00:00+00')` → `"lunes 28/09 a las 17:00"` (correcto, 28/09/2026 es lunes).
- `fn_wa_expiry_candidates()`: 20 candidatos reales, 0 elegibles (todos `launch_cutoff_not_set`).
- `SET ROLE anon` contra `wa_settings`/`wa_outbox`: 0 filas (RLS funcionando).

## Fase 2 — pg_net + Edge Functions + cron (aplicada en producción, 2026-09-22)

Sigue siendo seguro por diseño: `wa_settings.mode='off'` en todo momento durante esta fase, así que `wa_outbox` se mantiene vacía y nada de lo de abajo puede mandar un mensaje real todavía.

- **`353_wa_dispatch_cron.sql`**: instala `pg_net` (no estaba en producción); agrega `wa_settings.dispatch_function_url`; genera un secreto propio en Supabase Vault (`wa_dispatch_cron_secret`, no en texto plano); crea `rpc_wa_dispatch_trigger()` (dispara `wa-dispatch` por HTTP, no-op mientras falte URL o secreto); crea un **cron job nuevo y separado**, `wa-notifications-dispatch` (`*/15 * * * *`), que llama a `rpc_wa_cron_enqueue_expiry_events()` y luego a `rpc_wa_dispatch_trigger()`.

### Decisión de diseño: no tocar el cron `orders-daily-maintenance`

Se creó un job de `pg_cron` **separado** (`wa-notifications-dispatch`, jobid 3) en vez de extender el job existente `orders-daily-maintenance` (jobid 1), pese a que ese es el patrón usado antes (`rpc_close_stuck_customer_requested_orders` se sumó a ese mismo job). Motivo: ese job es crítico y tiene historial de incidentes en cascada — un error en cualquier bloque hace rollback de **todo** el intento, para **todos** los pedidos (ver incidente de la migración 260/265 en [[48-AUDITORIA-ESTADOS-PEDIDOS-Y-FIXES-2026-08-01]]). Aislar el nuevo trabajo en su propio job acota el radio de daño si algo de WhatsApp falla.

### Hallazgo de diseño: pg_cron no tiene sesión (`auth.uid()` es NULL)

Al preparar el cron se detectó que `rpc_wa_enqueue_expiry_events()` (352, admin-facing) no puede ser invocada directamente por `pg_cron`: su chequeo `IF NOT EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid())` fallaría siempre desde un contexto sin JWT. Se creó `rpc_wa_cron_enqueue_expiry_events()` — misma lógica, sin el chequeo de admin, pero con `EXECUTE` **revocado explícitamente** de `authenticated` y `anon` (no solo `PUBLIC`, aplicando la lección de 352b). `rpc_wa_enqueue_expiry_events()` ahora delega en ella tras validar admin, para no duplicar el loop en dos lugares.

**Nota aparte, NO corregida en este cambio:** al verificar este patrón se encontró que `rpc_orders_daily_maintenance()` (la función central de vencimiento, preexistente) **sí** tiene `EXECUTE` otorgado a `authenticated` sin ningún chequeo interno — cualquier clienta logueada podría invocarla desde el navegador y forzar el vencimiento anticipado de pedidos ajenos. Se dejó una tarea aparte para auditar y corregir esto (no se tocó como parte de este cambio, para no mezclar alcance). Ver tarea `task_d936cf07`.

### Edge Functions desplegadas (`verify_jwt=false`, mismo patrón que `facturante-webhook`/`meta-feed`)

- **`supabase/functions/wa-dispatch/index.ts`**: lee `wa_outbox` (`status='queued'`), resuelve el canal (`wa_channels`) por `channel_owner`, llama `POST /v2/whatsapp/messages` de YCloud con `externalId = wa_outbox.id` (para que el webhook pueda calzar la respuesta). Si el canal no está `connected` o `YCLOUD_API_KEY` no está seteada, **deja la fila en `queued`** (no la marca `failed`) para reintentar sola. Al enviar con éxito, también actualiza `admin_order_expiry_warn_sent` (misma tabla que ya usa el Kanban para el aviso manual) para que Ani/Fati no reenvíen por duplicado. Protegida por secreto propio (`X-Cron-Secret` / `WA_DISPATCH_CRON_SECRET`), no por la firma de YCloud.
- **`supabase/functions/wa-webhook/index.ts`**: verifica la firma HMAC de YCloud (`YCloud-Signature: t=...,s=...`, ventana de 300s), guarda cada evento crudo en `wa_webhook_events` (idempotente por `event_id`), y en `whatsapp.message.updated` actualiza `wa_outbox` por `externalId` con guarda de orden de estado (no retrocede de `read`/`delivered` a un estado anterior). Otros tipos de evento (mensajes entrantes, cambio de categoría de plantilla) quedan logueados sin procesar — fases futuras.

**Verificado en vivo (2026-09-22):**
- `curl -X POST` a ambas funciones sin credenciales → `401` en las dos (no filtran nada).
- `GET` a `wa-dispatch` → `405` (solo acepta POST).
- `has_function_privilege`: `rpc_wa_cron_enqueue_expiry_events` y `rpc_wa_dispatch_trigger` → `false` para `authenticated` y `anon`; `rpc_wa_enqueue_expiry_events` (admin-facing) → `true` para `authenticated` (correcto, la bloquea su chequeo interno).
- `cron.job`: 3 jobs activos, `orders-daily-maintenance` sin modificar, `wa-notifications-dispatch` nuevo con el comando esperado.
- Circuito completo probado de punta a punta: `wa_settings.dispatch_function_url` seteada a la URL real de `wa-dispatch`; `SELECT rpc_wa_dispatch_trigger()` manual generó una llamada real vía `pg_net` (`net._http_response`, `status_code=401` — esperado, todavía sin `WA_DISPATCH_CRON_SECRET` configurado del lado de la función).

## Pendiente — un solo paso, del lado del usuario

1. En el dashboard de Supabase → Edge Functions → `wa-dispatch` → Secrets: agregar `WA_DISPATCH_CRON_SECRET` con el valor generado en Vault (se le compartió una sola vez por chat; si se pierde, se puede rotar con `vault.update_secret` + actualizar el secret de la función).
2. Cuando haya cuenta/canal YCloud real: `YCLOUD_API_KEY` en `wa-dispatch` y `YCLOUD_WEBHOOK_SECRET` en `wa-webhook` (el `secret` que devuelve YCloud al crear el webhook endpoint, apuntando a `https://dtfznewwvsadkorxwzft.supabase.co/functions/v1/wa-webhook`).
3. Reconexión del número de Fati por Coexistence (QR) — la hace el usuario, "cuando sea necesaria" según avance la implementación. Completar `wa_channels.phone_e164` / `status='connected'` para `fati` recién ahí.
4. Crear las plantillas `pedido_por_vencer` / `pedido_vencido` en la consola de YCloud (requiere canal conectado).
5. Recién con todo lo anterior: setear `wa_settings.launch_cutoff_at` y pasar `mode` a `shadow` → `whitelist` → `live`.

## Fuera de alcance de esta nota

- Panel CRM/remarketing — decidido explícitamente para después.
- Bots de respuesta automática — decidido explícitamente para después.

## Bloqueo en Fase 0 (usuario): error al conectar Fati por Coexistence (2026-09-22)

Al intentar vincular el número de Fati (+54 9 362 486-6768) en YCloud, Meta rechazó el alta con: *"Tu número de teléfono ya está vinculado a los eventos automáticos..."* (`#3441061:01a0c942-1bea-7240-99b2-be05a452e84f`). Es un error conocido y documentado en la industria (Wati/Pabbly/Chakra reportan el mismo código), casi siempre por un intento previo con otro BSP o herramienta.

**Verificado en vivo** (Meta Business Suite, `business.facebook.com`, negocio "FyL MODA", `business_id=1996340927145918`, navegador del usuario vía Claude in Chrome — solo lectura, sin tocar nada):

- El portfolio "FyL MODA" tiene **8 cuentas de WhatsApp (WABAs) distintas**, varias con nombres casi idénticos: `fylmoda`, `Fyl Moda`, `FyL calzados` (x2), `FYL Moda`, `FyLCalzados`, `Proto 1`, `FyLModa` — evidencia de múltiples intentos de alta con distintas herramientas a lo largo del tiempo.
- El número **+54 9 362 486-6768 ya figura "Conectado"** bajo la WABA `fylmoda` (Identificador `112764648454416`, tag "Aplicación de WhatsApp Business" = Coexistence activa).
- Esa WABA tiene **0 personas, 0 partners, 0 usuarios del sistema** asignados — sin ningún BSP externo con acceso vía el sistema de Partners de Meta. No es una integración de terceros activa y visible; es una conexión huérfana de un intento anterior.
- `Usuarios del sistema` a nivel del negocio: **vacío**, ningún token de sistema vigente.

**Diagnóstico:** el número ya tiene una conexión Coexistence activa (huérfana) contra la WABA `fylmoda` dentro del propio portfolio del usuario. El flujo de alta de YCloud intenta crear/registrar el número de nuevo (probablemente contra una WABA nueva) y Meta lo bloquea porque el número ya está activamente conectado en otro lado de su propio sistema.

**Recomendación dada al usuario (pendiente de confirmar si funcionó):**
1. Si el flujo de YCloud permite elegir una WABA existente en vez de crear una nueva, usar `fylmoda` (`112764648454416`).
2. Si no, desconectar desde el celular: WhatsApp Business app → Ajustes → Cuenta → Plataforma de negocio → Desconectar (mismo paso de "Baja" documentado en la guía de Coexistence del skill `ycloud-whatsapp`) y reintentar el alta en YCloud.

**No se tocó nada** en Meta Business Suite (no se asignaron personas, no se desconectó ninguna WABA) — todo lo de arriba es solo lectura. Pendiente: limpiar a futuro las WABAs duplicadas/huérfanas del portfolio si se confirma que no se usan (no se decidió, no se tocó).

### Cambio de orden 2026-09-22: Ani primero, no Fati

El usuario decidió **no** desconectar el número de Fati por ahora: ese número está vinculado a todas las cuentas de Facebook/Instagram del negocio (Páginas, cuentas publicitarias) y prefiere no arriesgarlas sin verificar antes que "Desconectar Plataforma de negocio" (solo WhatsApp) no las afecta. Se prueba primero con el número de **Ani**.

`public.wa_channels.is_default` actualizado: `ani=true`, `fati=false` (cambio de datos, sin riesgo — ese flag no participa en ninguna lógica de envío/enqueue, es solo informativo/orden de conexión).

### Número de Ani (+54 9 362 517-2874): mismo problema, mapeado

**Dato importante:** este número **no es solo interno de Ani** — está hardcodeado como `WHATSAPP_NUMBER` en `catalogo1/lib/utils/whatsapp.ts` y se repite en 12 archivos del repo (todas las páginas de categoría del catálogo público, `quienes-somos.html`, `scripts/whatsapp.js`, etc.): es el número al que caen los botones "Consultar por WhatsApp" de **todo el sitio público**. Esto no cambia el riesgo de desconectar "Plataforma de negocio" (los links `wa.me` siguen funcionando igual, no dependen del estado Cloud API/Coexistence), pero es contexto relevante para cualquier cambio futuro sobre este número.

El usuario reportó el mismo error de Meta (`#3441061`) al intentar conectarlo. Verificado en vivo (mismo método, solo lectura): el número **+54 9 362 517-2874 ya está "Conectado"** (calidad **Alta**) bajo la WABA **`FyLCalzados`** (Identificador `343005040292549`, "Aplicación de WhatsApp Business" = Coexistence), con **0 partners asignados** — mismo patrón que Fati: conexión huérfana de un intento previo, sin ningún BSP externo activo.

De paso se mapearon las 8 WABAs del portfolio (todas sin partners asignados, ninguna con Usuarios del sistema — el negocio no tiene ninguna integración de terceros activa hoy vía el sistema de Partners de Meta):

| WABA | Identificador | Número | Estado |
|---|---|---|---|
| `fylmoda` | 112764648454416 | +54 9 362 486-6768 (Fati) | Conectado |
| `Fyl Moda` | 1330469284138384 | +54 9 362 462-9427 | Fuera de internet |
| `FyL calzados` (1ra) | 1513594623203908 | +54 9 362 518-2461 | Rechazado |
| `FyL calzados` (2da) | 1259366209333439 | (sin número) | — |
| `FYL Moda` | 1468401634876001 | +54 9 362 517-9278 | Rechazado |
| `FyLCalzados` | 343005040292549 | +54 9 362 517-2874 (Ani) | **Conectado** |
| `Proto 1` | (no verificado) | — | — |
| `FyLModa` | (no verificado) | — | — |

**Recomendación dada (misma que para Fati):** (1) si YCloud permite elegir una WABA existente en el alta, usar `FyLCalzados` (`343005040292549`); (2) si no, desconectar desde el celular de Ani (Ajustes → Cuenta → Plataforma de negocio → Desconectar) y reintentar. Pendiente de que el usuario confirme cuál probó y si funcionó.

### Seguimiento: "Plataforma para empresas" en el celular no muestra nada conectado (ninguno de los dos números)

El usuario revisó desde el celular (app WhatsApp Business → Ajustes → Cuenta → Plataforma para empresas) tanto el número de Ani como el de Fati, y **ninguno muestra nada conectado** — contradice el "Conectado" que muestra Meta Business Suite. Esto es coherente con un comportamiento conocido de la plataforma: el **registro Cloud API del número** (lo que ve Meta en el backend, con estado "Conectado") y el **enlace Coexistence con la app del celular** (lo que se ve en Ajustes de la app) son dos cosas separadas — un intento previo pudo completar el registro Cloud API sin nunca completar el pairing con la app (o completarlo y luego perderlo, ej. reinstalación de la app), dejando el número "fantasma": registrado para Meta, sin nada que desconectar del lado del teléfono.

**Se buscó (sin éxito) un botón de autoservicio para desregistrar/eliminar el número** directamente desde Meta, en dos herramientas distintas (solo lectura, sin tocar nada):
- Meta Business Suite → Cuentas de WhatsApp → `FyLCalzados` → perfil del número (`362453121635717`): solo permite editar foto/nombre/categoría/dirección/redes sociales conectadas (**1 página de Facebook conectada** a esta WABA) — sin opción de eliminar o desregistrar.
- Administrador de WhatsApp dedicado (`business.facebook.com/latest/whatsapp_manager/phone_numbers`) para la misma WABA: mismo panel "Perfil", mismo resultado — sin acción de desregistro visible.

**Conclusión:** no hay una opción de autoservicio visible para este caso (número "fantasma", sin conexión activa en el celular para cortar). Coincide con lo reportado en el foro de Pabbly (ver mensaje anterior de esta sesión): ese caso solo se resolvió con intervención directa de soporte del BSP/Meta, no con un botón en la interfaz.

**Recomendación actualizada:** escribirle a soporte de YCloud (o de Meta Business) pasando el detalle exacto ya relevado acá — ahorra idas y vueltas:
- Número de Ani: `+54 9 362 517-2874`, WABA `FyLCalzados` (`343005040292549`), ID del número `362453121635717`, error `#3441061`.
- Número de Fati: `+54 9 362 486-6768`, WABA `fylmoda` (`112764648454416`), error `#3441061`.
- Contexto: "Plataforma para empresas" en el celular no muestra nada conectado para ninguno de los dos; probablemente registros Cloud API huérfanos de un intento previo (BSP no identificado).

Alternativa más técnica, no intentada todavía (requeriría una app de desarrollador de Meta con permiso `whatsapp_business_management` sobre este Business Manager, que no se confirmó que exista): usar Graph API Explorer para llamar `POST /{phone-number-id}/deregister` sobre `362453121635717` (Ani). No se intentó sin confirmar primero que hay una app apta y sin aprobación explícita del usuario, por ser una acción irreversible sobre su cuenta de Meta.

### Verificación de apps de desarrollador (2026-09-22) — ninguna sirve para esto

El usuario pensó que podía tener alguna app de Meta ya vinculada a estos números. Se revisaron **las 3 apps** que existen bajo este Business Manager (`developers.facebook.com/apps/`, solo lectura):

| App | ID | Producto WhatsApp | Números con acceso |
|---|---|---|---|
| PublicacionesAutomáticas | 1335892324493984 | Sí (Cloud API activo) | `FyLModa` (+54 9 362 415 6486), `FyL Moda` (517-9278), `FyL calzados` (518-2461) — **ninguno es Ani/Fati** |
| Analytics Dashboard | 26581595628123991 | No tiene el producto WhatsApp | — |
| Analytics Dashboard | 1618270599454283 | No tiene el producto WhatsApp | — |

**Ninguna de las 3 apps tiene acceso a las WABAs `fylmoda` (Fati) o `FyLCalzados` (Ani).** La vía de Graph API Explorer queda descartada por ahora: usarla requeriría primero conectar una de estas apps (o crear una nueva) a esas WABAs específicas — un cambio de configuración adicional en la cuenta de Meta, no solo una consulta. No se hizo. **Conclusión: contactar a soporte de YCloud (ver detalle arriba) sigue siendo el camino más directo.**

### Pivote 2026-09-22: piloto con un número de prueba, en paralelo

Mientras se resuelve lo de Ani/Fati, el usuario decidió usar un número que YCloud sí muestra como "Registrado" sin conflicto: **+54 9 362 462-9427** ("Fyl Moda" en Meta, WABA `1330469284138384`, estaba "Fuera de internet" — posiblemente registrable como Cloud API puro, sin necesidad de Coexistence). Se usa para validar todo el circuito de punta a punta; cuando funcione, se retoma la conexión de los números reales.

`wa_channels` actualizado: fila `fati` reasignada temporalmente a este número (`status='connected'`, `display_name` marcado explícitamente como "TEST temporal — reemplazar por Fati" para que no se confunda con la Fati real en una sesión futura). `ani` sigue `pending`, sin tocar.

### Investigación paralela (agente en background, 2026-09-22): cómo liberar los números de Ani/Fati

Mientras el usuario avanzaba con el número de prueba, se lanzó un agente de investigación (solo lectura, fuentes citadas) sobre el bloqueo `#3441061`. Hallazgos clave:

- **Pista nueva, no probada todavía**: el mensaje de error manda a buscar "Etiquetas automáticas" en la app del celular (ubicación obsoleta en versiones nuevas). El control real, según la documentación oficial de Meta ([Automatic Events API](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/automatic-events-api)), está en **Meta Business Suite → Configuración → Cuentas de WhatsApp → [WABA] → pestaña Resumen → "Privacidad y uso compartido de datos" → toggles "Identificar automáticamente..."** — a nivel de la WABA específica (`fylmoda` / `FyLCalzados`), no en el celular. Pendiente de probar.
- El código `#3441061` **no está en la referencia pública de errores de Meta** — es interno del flujo de Embedded Signup, no documentado con ese número.
- El endpoint oficial `POST /{phone-number-id}/deregister` existe, pero la propia documentación de Meta dice que **no se puede usar mientras el número esté en Coexistence activo** — relevante si se evalúa la vía técnica a futuro.
- Comparado con otros BSPs (360dialog, Gupshup, Wati): **ninguno tiene autoservicio distinto** a lo ya probado. 360dialog documenta explícitamente que, si el BSP anterior no coopera, la única salida es borrar la cuenta de la app y volver a empezar — exactamente lo que se quiere evitar.
- El caso público de Pabbly (mismo error) se resolvió solo con soporte humano por videollamada, no autoservicio.
- **Alerta:** apareció en la búsqueda un supuesto número de teléfono de soporte de Meta que tiene características de scam/SEO de terceros — no usar, cualquier contacto con Meta debe salir del propio Business Manager (Ayuda → Contactar soporte).

**Plan actualizado**: (1) probar el toggle de Business Suite en ambas WABAs; (2) si no alcanza, soporte de YCloud con los IDs ya recopilados (WABA `fylmoda`=`112764648454416`, `FyLCalzados`=`343005040292549`, teléfono B `362453121635717`, `business_id`=`1996340927145918`); (3) en paralelo, caso en Meta Business Help Center desde el Business Manager; (4) API deregister como último recurso, probablemente bloqueado sin soporte de por medio.

**Pendiente para el primer envío de prueba real** (nada de esto se hizo todavía):
1. Terminar de conectar el número en YCloud (el usuario, en curso).
2. `YCLOUD_API_KEY` (YCloud → Developers → API Keys) → pegar en Supabase Edge Functions → `wa-dispatch` → Secrets.
3. Crear plantillas `pedido_por_vencer` / `pedido_vencido` en YCloud (ofrecido hacerlo vía Chrome).
4. Registrar webhook en YCloud → `https://dtfznewwvsadkorxwzft.supabase.co/functions/v1/wa-webhook` → pegar el `whsec_...` en Supabase Edge Functions → `wa-webhook` → Secrets.
5. `wa_settings.mode` → `whitelist` con el teléfono del usuario, recién con todo lo anterior listo.

### ¡Resuelto! Fati conectada en YCloud (2026-09-22)

El usuario logró vincular el número real de Fati en YCloud — verificado en vivo: WABA `fylmoda` (`112764648454416`, la misma que ya existía en Meta), número `+54 9 362 486-6768`, **Estado: Conectado**, calificación de calidad "Desconocido" (normal para un número recién conectado, sin historial de envíos). No se determinó qué destrabó el bloqueo `#3441061` (probablemente un reintento, o el paso previo de revisar "Plataforma para empresas" desde el celular terminó de sincronizar algo del lado de Meta) — no crítico, ya está andando.

`wa_channels` actualizado con el número **real** (reemplaza el número de prueba temporal que se había puesto ahí antes — ya no hace falta, se puede probar todo el circuito con la Fati real):
- `fati`: `phone_e164='+5493624866768'`, `status='connected'`, `ycloud_channel_id='112764648454416'`, `display_name='Fati'`.
- `ani`: sigue `pending` (el bloqueo `#3441061` para Ani sigue sin resolver, ver plan de soporte YCloud/Meta más arriba).

**Con esto ya se puede avanzar a probar el circuito completo** (pasos 2-5 de arriba), usando la Fati real en vez de un número de prueba.

### Decisión de alcance (2026-09-22): piloto solo con "pedido vencido"

El usuario decidió arrancar el piloto **solo con el aviso de vencimiento**, no con "por vencer" todavía. Se agregó `wa_settings.enabled_kinds` (migración `354`) — interruptor explícito por tipo de aviso, para que `order_expiring_soon` nunca se encole mientras no se decida activarlo (en vez de fallar por falta de plantilla). `enabled_kinds = {order_expired}`. Verificado: ningún candidato `order_expiring_soon` queda con `skip_reason IS NULL` (no se enviaría ninguno).

**`YCLOUD_API_KEY` configurada y verificada** (sin ver el valor — se confirmó disparando `rpc_wa_dispatch_trigger()` y viendo que la respuesta pasó de `{"note":"ycloud_api_key_not_set"}` a `{"ok":true,"processed":0,...}`).

**Plantilla `pedido_vencido` creada y enviada a revisión de Meta** (2026-09-22, vía Chrome con la sesión del usuario): categoría Utilidad, idioma Spanish (ARG), cuerpo `"Hola 👋 Tu pedido {{numero_pedido}} venció y el stock reservado se liberó.\n\nCualquier consulta, respondé este mensaje 😊"` (coincide exacto con el texto que arma `rpc_wa_cron_enqueue_expiry_events`). Estado al momento de creación: **En revisión**. Nota de UI: el editor de plantillas de YCloud reordena el texto si se escribe la variable `{{n}}` junto con emojis en un solo tipeo — hay que insertar la variable con el botón dedicado "+ Variables" en el punto exacto del cursor, no escribirla a mano mezclada con el resto.

**Pendiente:**
1. Esperar aprobación de Meta (15 min a 24h).
2. Registrar el webhook en YCloud → `wa-webhook`, pegar `whsec_...` en Supabase.
3. `wa_settings.mode` → `whitelist` con el teléfono del usuario.
4. Definir `launch_cutoff_at` antes de habilitar el whitelist (para no disparar los 12 `order_expired` históricos ya detectados).

## Rediseño 2026-09-23: ventana de gracia de 24hs antes de desarmar (aplicado en producción)

El usuario detectó que el mensaje `pedido_vencido` afirmaba algo que en el nuevo diseño ya no sería cierto ("tu pedido venció y el stock se liberó") si el desarme deja de ser inmediato. Rediseño completo de la secuencia de vencimiento, aprovechando mecanismos **que ya existían en el código** (cero cambios de frontend):

### Flujo final (4 mensajes)

1. **Día 7, vence** — pedido pasa a "vencido, pendiente de desarmar" pero **sigue reservado**. Si tiene ≥4 unidades: mensaje A (puede extender 24hs sola desde `{URL_PEDIDO}`, texto del usuario). Si tiene <4: mensaje A' (mismo texto + nota de mínimo).
2. **Si extiende** (usa `rpc_customer_request_order_extension_24h`, YA EXISTE, sin cambios) → nuevo `dismantle_at` = próximo día hábil 17:00 (vía `fn_compute_order_deadline`, YA EXISTE). Al vencer esa 2da vez: mensaje C ("ya usaste tu prórroga, respondé este mensaje").
3. **24hs después del vencimiento** (original o extendido, lo que corresponda), sin acción: recién ahí se desarma de verdad y se libera el stock.
4. **Al desarmar**: mensaje D — se reutiliza la plantilla `pedido_vencido` ya enviada a revisión (el texto le queda bien igual).

### Hallazgo clave: el 90% de la mecánica ya estaba construida

- `rpc_customer_request_order_extension_24h` ya exigía `now() >= dismantle_at` para poder usarse, y ya limita a **una sola vez** (`customer_enable_24h_uses`). Antes de este cambio, esa ventana de uso real era de ~15 min (hasta que el cron desarmaba), prácticamente inutilizable.
- El botón "Extender 24h" del dashboard y el mensaje "Ya usaste tu prórroga, escribinos por WhatsApp" **ya existen en `ActiveOrderTab.tsx`**, condicionados por `isOrderExpired` (`nj/lib/orders/deadline.ts`), que compara `now() >= dismantle_at` **sin mirar `order.status`** — verificado en código. Conclusión: alcanza con que el pedido siga en `active`/`closing_soon` durante la ventana de gracia para que toda la UI ya funcione sola.

### Cambio real aplicado (único, quirúrgico)

`355_orders_daily_maintenance_grace_window.sql` — una sola condición dentro del bloque D.3 de `rpc_orders_daily_maintenance()` (traída completa y literal de producción vía `pg_get_functiondef` antes de tocarla, para no perder ningún fix histórico 260/265/266):

```sql
-- antes:
WHERE o.status IN ('active','closing_soon') AND o.dismantle_at IS NOT NULL AND now() >= o.dismantle_at

-- después:
WHERE o.status IN ('active','closing_soon') AND o.dismantle_at IS NOT NULL AND (
  (coalesce(o.local_deferred_pickup, false) = true AND now() >= o.dismantle_at)  -- retiro local: SIN CAMBIOS
  OR
  (coalesce(o.local_deferred_pickup, false) = false AND now() >= o.dismantle_at + interval '24 hours')  -- envío: +24hs de gracia
)
```

Decisiones del usuario que definieron el diseño: sin hora fija para el corte de gracia (simplemente `dismantle_at + 24h`, sin snap a una hora del día siguiente); sin lógica de día hábil para la ventana de gracia en sí (eso ya lo maneja `fn_compute_order_deadline` para la fecha de *extensión*, que sí es día hábil — si vence viernes y extiende, el nuevo vencimiento cae lunes, sin tocar nada); retiro local (36hs) explícitamente afuera de este cambio.

**Verificado en producción tras aplicar:** función contiene la ventana de gracia y la distinción de retiro local (`LIKE` sobre `pg_get_functiondef`); `SELECT rpc_orders_daily_maintenance()` ejecutado manualmente sin error; verificación previa (antes de aplicar) confirmó 0 pedidos en el borde exacto en ese momento, sin impacto inmediato visible.

**Pendiente (siguiente paso, no hecho todavía):**
- Reescribir `fn_wa_expiry_candidates`/`rpc_wa_*_enqueue_expiry_events` para los kinds A/A'/C (probablemente colapsables en un solo kind `order_deadline_reached` con selección de plantilla por `customer_enable_24h_uses` + unidades, reutilizando la idempotencia existente por `(order_id, kind, dismantle_at)` — cambia sola al extender, sin necesidad de un kind nuevo por evento).
- Crear las 3 plantillas nuevas en YCloud con el texto final del usuario, sin el número de pedido interno (decisión de la sesión anterior).
- Actualizar `wa_outbox` CHECK constraint de `kind` y `wa_settings.enabled_kinds` para el nuevo taxonomy.

## Plantillas de YCloud creadas (2026-09-22, vía Chrome)

Las 4 plantillas del nuevo diseño quedaron creadas en YCloud, todas categoría **Utilidad**, idioma Spanish (ARG), enviadas a revisión de Meta:

| Kind interno | Nombre real en YCloud | Estado al crear |
|---|---|---|
| Venció (desarme final, mensaje D) | `pedido_vencido` | Activo-Calidad pendiente |
| Día 7, ≥4 unidades (mensaje A) | **`pedido_plazo_extendible2`** (⚠️ con el `2`, ver nota) | En revisión |
| Día 7, <4 unidades (mensaje A') | `pedido_plazo_faltan_productos` | En revisión |
| Prórroga ya usada, vence de nuevo (mensaje C) | `pedido_plazo_ultimo_aviso` | En revisión |

**`pedido_vencido` corregido**: se sacó la variable `{{numero_pedido}}` (decisión de la sesión anterior — no exponer el número interno de pedido al cliente). Texto final, sin variables: *"Hola 👋 Tu pedido venció y se desarmó porque finalizó el plazo de reserva.\n\nCualquier consulta, podés escribirnos 😊"*.

**⚠️ Nota importante para el SQL de `fn_wa_expiry_candidates`**: el nombre real de la plantilla del mensaje A es `pedido_plazo_extendible2`, **no** `pedido_plazo_extendible`. Motivo: se creó primero como categoría Marketing por error de click en el selector de YCloud; al intentar borrarla y recrearla como Utilidad con el mismo nombre, Meta devolvió *"You can't change the category for this message template while the existing Spanish (ARG) content is being deleted. Try again in 4 weeks or use MARKETING as the category."* — Meta bloquea reusar nombre+idioma con categoría distinta por 4 semanas tras un borrado. Se resolvió creándola con el nombre `pedido_plazo_extendible2`. Cualquier código (SQL, Edge Function) que arme el nombre de plantilla para este kind debe usar `pedido_plazo_extendible2` tal cual.

Texto de `pedido_plazo_extendible2` (sin variables, mismo link fijo del dashboard para todos los clientes vía `getDashboardActiveOrderUrl()`):
```
Hola 👋 Tu pedido ya cumplió el plazo de reserva de 7 días.

Si todavía querés finalizarlo, podés darte 24 hs más desde tu pedido para conservarlo un día adicional 😊

👉 https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart

Si no extendés el plazo ni nos respondés, mañana por la mañana el pedido se desarmará automáticamente.
```

## Migración 357 (aplicada en producción, 2026-09-22): SQL del nuevo taxonomy

Reescrito `fn_wa_expiry_candidates()` / `rpc_wa_preview_expiry_events()` / `rpc_wa_cron_enqueue_expiry_events()` para el diseño de la ventana de gracia (355) y las 4 plantillas reales de YCloud.

- **Kind `order_expiring_soon` → `order_deadline_reached`**: ya no dispara 24hs antes; dispara cuando `status IN ('active','closing_soon') AND now() >= dismantle_at` — el momento exacto en que el pedido "vence" pero sigue reservado por la ventana de gracia de 355. `order_expired` (mensaje final, pedido ya desarmado) queda sin cambios de condición.
- **Selección de plantilla** (en `rpc_wa_cron_enqueue_expiry_events`, por orden de prioridad): `order_expired` → `pedido_vencido`; `order_deadline_reached` con `customer_enable_24h_uses >= 1` → `pedido_plazo_ultimo_aviso`; si no, `units < 4` → `pedido_plazo_faltan_productos`; si no → `pedido_plazo_extendible2`.
- **Función nueva `fn_wa_customer_24h_uses(notes text)`**: lee `customer_enable_24h_uses` de `orders.notes` (mismo campo que `rpc_customer_request_order_extension_24h`), defensiva (devuelve 0 ante NULL/vacío/no-JSON/no-objeto, sin lanzar excepción — a diferencia de la RPC de la clienta, que sí explota si el JSON está corrupto, porque acá es solo lectura para elegir plantilla).
- **Se eliminó el skip `below_minimum_units`**: antes, un pedido con <4 unidades nunca generaba ningún aviso. Ahora, por diseño (existe una plantilla dedicada "faltan productos"), sí se avisa. El desarme real tampoco filtraba por unidades, así que esto alinea el aviso con lo que el pedido efectivamente vive.
- **`template_params` pasa a ser siempre `'[]'::jsonb`**: ninguna de las 4 plantillas usa variables (se sacó `numero_pedido` de `pedido_vencido` en la sesión anterior, y las 3 nuevas se diseñaron sin variables desde el vamos).
- **Lección 352b aplicada de nuevo**: `fn_wa_expiry_candidates()` y `rpc_wa_preview_expiry_events()` cambiaron su `RETURNS TABLE` (columna `customer_enable_24h_uses` nueva) → hizo falta `DROP FUNCTION` + `CREATE` (no alcanza `CREATE OR REPLACE` cuando cambia el tipo de retorno), lo que resetea los privilegios por defecto del proyecto. Se volvió a revocar `EXECUTE` de `authenticated`/`anon` explícitamente en la misma migración, verificado con `has_function_privilege()` en el archivo de tests — sin este paso se habría repetido la fuga de 352.
- **`wa_outbox.kind` CHECK** actualizado a `('order_deadline_reached', 'order_expired')` — tabla estaba vacía (`mode='off'` desde su creación), sin filas que migrar.
- **`wa-dispatch` (Edge Function) corregido y redesplegado (v4)**: antes armaba siempre un componente `body` con `parameters: []` cuando una plantilla no tenía variables — riesgoso, ya que WhatsApp Cloud API puede rechazar un componente `body` vacío para una plantilla sin `{{n}}`. Ahora omite el campo `components` por completo cuando `template_params` está vacío (el caso de las 4 plantillas actuales).
- **Archivos**: `357_wa_deadline_reached_taxonomy.sql` / `_ROLLBACK_` / `_tests.sql`. Aplicado con `mcp_supabase.apply_migration`, tests corridos en transacción vía `execute_sql` — todas las aserciones pasaron (privilegios revocados, kind viejo ausente, columna nueva accesible, constraint actualizado, `wa_settings.mode` sigue `off`, `wa_outbox` sigue vacía).

**Pendiente (sin cambios de fondo, ya estaba antes):**
1. Esperar aprobación de Meta de las 3 plantillas nuevas (`pedido_plazo_extendible2`, `pedido_plazo_faltan_productos`, `pedido_plazo_ultimo_aviso`) — quedaron "En revisión"/"Activo-Calidad pendiente".
2. Sumar `'order_deadline_reached'` a `wa_settings.enabled_kinds` recién cuando Meta apruebe las 3 plantillas nuevas.
3. Resolver el bloqueo de Ani (`#3441061`) — sigue sin resolver, soporte YCloud/Meta pendiente de confirmar si se escribió.

## Webhook + modo whitelist activados (2026-09-22/23)

**Webhook registrado en YCloud** (Developers → Webhooks → "Agregar puntos finales"), vía Chrome con la sesión del usuario:
- URL: `https://dtfznewwvsadkorxwzft.supabase.co/functions/v1/wa-webhook`
- Eventos suscriptos: `whatsapp.message.updated` (el único que procesa `wa-webhook` hoy, actualiza `wa_outbox`), `whatsapp.inbound_message.received` (logueado sin procesar todavía — fase futura, útil para cuando la clienta responda al mensaje C), `whatsapp.template.reviewed` (para ver en el log cuándo Meta aprueba/rechaza las 3 plantillas nuevas).
- Estado: **Activo**. Secret (`YCLOUD_WEBHOOK_SECRET`) capturado interceptando `navigator.clipboard.writeText` (la UI de YCloud solo lo muestra truncado, ni siquiera en el diálogo de "Editar") y compartido una única vez por chat — el usuario lo cargó como `YCLOUD_WEBHOOK_SECRET` en Supabase → Edge Functions → `wa-webhook` → Secrets (no lo hizo el asistente: entrar API keys/secrets en campos es una acción que el asistente tiene prohibido hacer por su cuenta).

**`wa_settings` pasado a modo whitelist** para poder probar `pedido_vencido` (ya `Activo-Calidad pendiente`, kind `order_expired` ya estaba en `enabled_kinds` desde 354) sin esperar a las 3 plantillas nuevas:
- `launch_cutoff_at` = `2026-09-23 00:55:59 UTC` (momento de aplicar el cambio).
- `mode` = `'whitelist'`.
- `whitelist_phones` = `['+5493624755101']` (teléfono personal del usuario, convertido a E.164 AR con `fn_wa_phone_e164`).

**Verificado antes y después del cambio**: en el momento de aplicar había 12 pedidos `order_expired` reales (clientas) detectados como candidatos históricos — con `launch_cutoff_at` seteado, los 12 pasaron a `skip_reason='before_launch_cutoff'` (0 se habrían enviado). Ningún pedido real de clienta puede dispararse ahora: el cutoff bloquea todo lo anterior a este momento, y el whitelist bloquea todo lo posterior salvo el teléfono del usuario.

**Para probar de punta a punta**: hace falta un pedido de prueba (en la app nj de test) cuyo `customers.phone` sea el número del usuario y cuyo `dismantle_at` ya haya pasado (o esperar a que un pedido de prueba nuevo llegue naturalmente a esa condición) — recién ahí `rpc_wa_cron_enqueue_expiry_events` (corre cada 15 min vía el cron `wa-notifications-dispatch`) lo va a encolar y `wa-dispatch` lo va a mandar por WhatsApp real.

### Primer envío real de prueba: ¡funcionó! (2026-09-23)

El usuario armó el pedido **A57310** (su propio número, `+5493624755101`, ya en la whitelist) y pidió forzar el vencimiento para probar el circuito completo ya, en vez de esperar al ciclo natural (7 días + 24hs de gracia). Se forzó manualmente, en producción, con permiso explícito del usuario:

1. Verificación previa: `0` pedidos estaban en el umbral de desarme en ese momento (confirma que forzar esto no iba a afectar a ningún otro pedido, de prueba o real).
2. `UPDATE orders SET dismantle_at = now() - interval '25 hours' WHERE order_number = 'A57310'` (pasa el umbral de gracia de 24hs de 355).
3. `SELECT rpc_orders_daily_maintenance()` manual (en vez de esperar el cron) → el pedido pasó a `status='expired'`, `expired_at` seteado.
4. `SELECT rpc_wa_cron_enqueue_expiry_events()` manual → encoló 1 fila en `wa_outbox` (`kind=order_expired`, `template_name=pedido_vencido`, `template_params=[]`, `to_phone_e164=+5493624755101`).
5. `SELECT rpc_wa_dispatch_trigger()` manual → **`wa_outbox.status` pasó a `delivered`** con `ycloud_message_id` real. Primer mensaje de WhatsApp automático de FyL, entregado de punta a punta.

**Receta para repetir esto con cualquier pedido de prueba futuro** (en vez de esperar el ciclo natural):
```sql
UPDATE public.orders SET dismantle_at = now() - interval '25 hours' WHERE order_number = '<...>';
SELECT public.rpc_orders_daily_maintenance();          -- desarma de verdad (o esperar el cron, corre cada 15 min)
SELECT public.rpc_wa_cron_enqueue_expiry_events();      -- encola en wa_outbox
SELECT public.rpc_wa_dispatch_trigger();                -- dispara el envío real vía wa-dispatch
```
Solo dispara mensajes reales a números en `wa_settings.whitelist_phones` mientras `mode='whitelist'` — seguro de repetir con cualquier pedido de prueba propio.

## Cómo habilitar esto para clientas reales (checklist, NO ejecutar hasta que el usuario lo pida explícitamente)

Decisión del usuario (2026-09-22/23): mientras se sigue probando, **ninguna clienta real debe recibir nada**, solo su propio número. Hoy eso está garantizado por `wa_settings.mode='whitelist'` + `whitelist_phones=['+5493624755101']`. El día que se decida ir a producción con clientas reales, el cambio es mínimo y reversible — no hace falta tocar código ni plantillas, solo esta config:

1. (Opcional pero recomendado) Confirmar que las métricas de calidad de las plantillas en YCloud siguen en verde (`pedido_vencido` y, si ya están aprobadas, las 3 nuevas de `order_deadline_reached`).
2. `UPDATE public.wa_settings SET mode = 'live' WHERE id = true;` — sin esto, aunque se saque el whitelist, `mode` sigue filtrando. `live` manda a cualquier clienta elegible.
3. Revisar `wa_settings.daily_cap` (hoy 50/día) — subirlo si hace falta para el volumen real.
4. Si ya se aprobaron las 3 plantillas nuevas y se quiere activar también el flujo de "plazo vencido, todavía con gracia" (no solo el desarme final): `UPDATE public.wa_settings SET enabled_kinds = ARRAY['order_deadline_reached','order_expired'] WHERE id = true;`. Si se quiere seguir solo con el aviso de desarme por ahora, dejar `enabled_kinds` como está (`{order_expired}`).
5. **No hace falta tocar `launch_cutoff_at`** — ya está seteado (2026-09-23), así que nada anterior a esa fecha se puede disparar retroactivamente aunque pase a `live`.

Para volver a modo seguro en cualquier momento (ej. si algo sale mal): `UPDATE public.wa_settings SET mode = 'off' WHERE id = true;` — corta todo de inmediato, sin perder nada en `wa_outbox` (las filas `queued` quedan esperando, no se pierden, se reintentan solas cuando `mode` vuelva a `whitelist`/`live`).

## Sesión 2026-09-23: Meta aprobó las 3 plantillas nuevas — hallazgo de recategorización + 2 envíos reales más + incidente con pedido de prueba

### Hallazgo: Meta recategorizó 3 de las 4 plantillas de Utilidad a Marketing durante la revisión

Verificado llamando directo a la API interna de YCloud desde la consola (`POST /api/whatsapp/templates/meta-insights/page`, respuesta con `category` y `previousCategory` por plantilla — la UI de YCloud solo muestra `category` actual, no alcanza con mirar la tabla):

| Plantilla | Categoría actual | Categoría original | Estado Meta |
|---|---|---|---|
| `pedido_vencido` | **UTILITY** (sin cambios) | UTILITY | APPROVED |
| `pedido_plazo_extendible2` | **MARKETING** | UTILITY | APPROVED |
| `pedido_plazo_faltan_productos` | **MARKETING** | UTILITY | APPROVED |
| `pedido_plazo_ultimo_aviso` | **MARKETING** | UTILITY | APPROVED |

Las 4 están `APPROVED` (utilizables), pero Meta decidió unilateralmente que 3 de ellas son contenido de Marketing, no Utility — probablemente por el tono/redacción (ofrecen una acción/beneficio — "podés darte 24hs más" — en vez de ser puramente informativas como `pedido_vencido`). Esto **no se puede revertir editando la plantilla** (cambiar de categoría con el mismo nombre+idioma vuelve a chocar con el bloqueo de 4 semanas de Meta, ver más arriba). Implicancias a tener en cuenta antes de ir a producción real:
- Marketing está sujeto a límites de "frecuencia de mensajes de marketing" por destinatario y a scoring de calidad más estricto por parte de Meta — mayor riesgo de que la calidad del número baje o los mensajes se demoren/bloqueen si el volumen crece.
- A partir del 1/oct/2026 el costo entre Marketing y Utility se iguala (banner propio de YCloud), así que el costo ya no es un diferencial.
- Que Meta las haya aprobado como Marketing NO es un blocker técnico para encolar/enviar — `rpc_wa_cron_enqueue_expiry_events` no filtra por categoría, solo por nombre de plantilla. Es una consideración de política/calidad a evaluar antes de pasar a `mode='live'` con clientas reales, no antes de seguir probando con el propio número.

### 2 envíos reales más, exitosos (mismo pedido de prueba A57310, antes de que se borrara — ver incidente abajo)

Con `order_deadline_reached` habilitado temporalmente en `enabled_kinds` (se volvió a sacar al final, ver abajo):

1. **`pedido_plazo_extendible2`** — pedido reseteado a `status='active'`, `notes='{}'`, `dismantle_at = now() - 1 minuto`, unidades=5 (≥4, sin prórroga usada). `rpc_wa_cron_enqueue_expiry_events` lo encoló correctamente con ese template. `rpc_wa_dispatch_trigger` → **`delivered`**, `ycloud_message_id` real.
   - **Nota para el próximo test similar**: la primera vez dio `inserted:0` con `skip_reason='manual_warn_sent_recently'` — el envío exitoso anterior (`pedido_vencido`) había hecho `upsert` en `admin_order_expiry_warn_sent` (mismo mecanismo que usa el Kanban para no duplicar avisos manuales), y esa tabla bloquea cualquier aviso nuevo al mismo pedido por 24hs. Para reencolar en el mismo pedido de prueba hay que `DELETE FROM admin_order_expiry_warn_sent WHERE order_id = '<...>'` antes de cada re-test. **Esto es comportamiento correcto y esperado en producción** (evita duplicar avisos a una clienta real) — solo hay que tenerlo presente al reusar el mismo pedido de prueba varias veces seguidas.

2. Intento de probar **`pedido_plazo_faltan_productos`** (necesita unidades < 4): para simular esto en el mismo pedido de prueba, se bajó la cantidad de un `order_item` (`4→2`) y se puso el otro en `status='cancelled'` (para que sumen `<4`). Esto **disparó un trigger de producción no relacionado con testing** (ver incidente abajo) y borró el pedido antes de poder correr el enqueue. **No se llegó a probar.**

### Incidente: cancelar un `order_item` borró el pedido de prueba entero

Al poner `order_items.status='cancelled'` en uno de los ítems del pedido A57310, se disparó `order_items_after_cancelled_try_empty_order` (trigger en `order_items`, función `trg_order_items_cancelled_try_empty_order`), que llama a `maint_try_delete_order_if_eligible(order_id, 'trigger_order_items_cancelled')`. Este es un mecanismo de limpieza automática **ya existente en producción, sin relación con este proyecto de WhatsApp** — no es un bug introducido acá, fue un efecto secundario no anticipado de manipular `order_items` a mano en vez de a través de un flujo real de la app.

**Efecto**: el pedido `A57310` se borró por completo (cascada incluyó `wa_outbox` vía `order_id ... ON DELETE CASCADE`). Queda registrado en `public.order_empty_deletion_audit`:
```
id: b8986cbe-ab54-4c7d-977b-a55253237227
order_id: 8a8bdb1f-2b5c-41e7-a99d-72a95dbd03fe
order_number: A57310
source: trigger_order_items_cancelled
deleted_at: 2026-09-23 01:06:56 UTC
```
**No se investigó a fondo la condición exacta de "elegible para borrar"** de `maint_try_delete_order_if_eligible` (probablemente: sin pago/factura asociada, pedido de bajo compromiso) — quedó fuera del alcance de esta sesión (no es código de WhatsApp). **Lección para cualquier agente que siga probando el flujo de WhatsApp con pedidos de prueba**: para simular "unidades < 4", **no tocar `order_items.status`**; en cambio, ajustar solo `order_items.quantity` hacia abajo (sin cambiar `status`) o crear un pedido de prueba nuevo con pocas unidades desde el flujo real de la app/admin. Cancelar un ítem puede borrar el pedido entero sin aviso.

### Estado final al cierre de esta sesión (2026-09-23, verificado)

- `wa_settings`: `mode='whitelist'`, `whitelist_phones=['+5493624755101']`, `launch_cutoff_at='2026-09-23 00:55:59 UTC'`, **`enabled_kinds=['order_expired']`** (se sacó `order_deadline_reached` de nuevo tras las pruebas — decisión pendiente de cuándo habilitarlo para clientas reales, ver checklist arriba).
- Pedido de prueba `A57310`: **ya no existe** (borrado por el trigger, ver incidente). Cualquier prueba nueva necesita un pedido de prueba nuevo.
- 3 de 4 plantillas mandadas y confirmadas `delivered` en el celular real del usuario: `pedido_vencido`, `pedido_plazo_extendible2`. Falta probar `pedido_plazo_faltan_productos` (unidades<4) y `pedido_plazo_ultimo_aviso` (`customer_enable_24h_uses>=1` — este es más simple de simular, no requiere tocar `order_items`, solo `UPDATE orders SET notes = '{"customer_enable_24h_uses":1}' WHERE ...`).
- Ningún cambio de código pendiente — todo lo de esta sesión fue config (`wa_settings`) y datos de un pedido de prueba que ya no existe. El sistema sigue 100% seguro para clientas reales (`mode='whitelist'` + `launch_cutoff_at` seteado).

**Para retomar mañana o en otra sesión** (checklist concreto):
1. Si se quiere terminar de probar `pedido_plazo_faltan_productos` / `pedido_plazo_ultimo_aviso`: pedirle al usuario que arme un pedido de prueba nuevo (con su propio teléfono, `+5493624755101`, ya en whitelist) — uno con <4 unidades para el primero, cualquiera para el segundo (se simula con el `UPDATE notes` de arriba, no hace falta que sea un pedido especial).
2. Volver a habilitar `order_deadline_reached` en `enabled_kinds` solo mientras se prueba, y volver a sacarlo si no se decide ir a producción real con clientas todavía (mismo patrón que esta sesión).
3. **Decisión del usuario (2026-09-23): sí importa que hayan quedado en Marketing — plan es reescribir el texto de las 3 plantillas para intentar que Meta las clasifique como Utility.** Ver sección siguiente.
4. Cuando el usuario decida ir a producción con clientas reales: seguir el checklist "Cómo habilitar esto para clientas reales" más arriba en este mismo documento.
5. Sigue pendiente, sin relación con lo de arriba: resolver el bloqueo de Ani (`#3441061`, número `+54 9 362 517-2874`) y registrar el webhook también para su WABA cuando se conecte.

## Pendiente (2026-09-23): reescribir las 3 plantillas para intentar que Meta las clasifique como Utility

Decisión del usuario: no conformarse con que hayan quedado en Marketing — la próxima sesión debería **reescribir el texto** de `pedido_plazo_extendible2`, `pedido_plazo_faltan_productos` y `pedido_plazo_ultimo_aviso` para maximizar la chance de que Meta las apruebe como Utility esta vez. Todavía no se hizo nada de esto — es trabajo para una sesión futura.

**Por qué cayeron en Marketing — confirmado, no es solo hipótesis**: el skill `anthropic-skills:ycloud-whatsapp` (`references/templates.md`, fuente docs.ycloud.com + política de Meta) ya tenía esto documentado ANTES de crear las plantillas, y describe exactamente lo que pasó:

> "Si el mensaje pide una acción para evitar una consecuencia (ej. confirmar antes de que se libere el stock), redactarlo neutro y factual; es el más propenso a ser reclasificado, así que probar y mirar la categoría final."

Reglas completas del skill para no caer en Marketing:
1. Referirse a un pedido concreto (número, estado, fecha). Datos, no invitaciones.
2. Sin ofertas, descuentos, "aprovechá", "no te pierdas", cupones ni links a catálogo.
3. Sin pedir reseñas ni preguntar si quiere comprar más.
4. Un solo propósito por plantilla.
5. Si el mensaje pide una acción para evitar una consecuencia, redactarlo neutro y factual (la regla que más aplica acá).

Las 3 plantillas reclasificadas piden exactamente eso — una acción para evitar una consecuencia ("podés darte 24 hs más... 😊", "podés agregar lo que te falta... 😊", "respondé este mensaje... te ayudamos a revisar el pedido") — con tono de beneficio/invitación (los emojis 😊 refuerzan ese tono). `pedido_vencido` (la que se mantuvo Utility) no pide ninguna acción ni ofrece nada: solo constata un hecho ya ocurrido, sin invitación — coincide exactamente con el patrón esperado por el skill.

**Nota para la próxima sesión**: el skill ya tenía esta regla documentada antes de escribir las 3 plantillas nuevas; no se consultó el skill en el momento de crearlas (se usó el texto exacto que dio el usuario, sin pasar por esta revisión). Para la reescritura, conviene invocar `Skill(anthropic-skills:ycloud-whatsapp)` con el texto propuesto antes de crear cualquier plantilla nueva en YCloud, no después.

**Restricciones a respetar al reescribir** (para no perder lo ya acordado con el usuario):
- No se puede simplemente re-enviar con el mismo nombre — Meta bloquea el cambio de categoría del mismo nombre+idioma por 4 semanas tras un intento fallido/borrado (ver más arriba, caso `pedido_plazo_extendible` → `pedido_plazo_extendible2`). Cualquier reintento con texto nuevo necesita **nombre nuevo** (o esperar el período de 4 semanas desde el 2026-09-23 sobre los nombres actuales).
- Mantener el contenido factual: qué pasó (venció el plazo de 7 días), qué puede hacer la clienta (extender 24hs / completar el mínimo / responder), y las consecuencias si no actúa (se desarma mañana). No inventar información nueva.
- Sin variable `{{numero_pedido}}` (decisión ya tomada, no exponer el número interno).
- Mismo link fijo del dashboard (`https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart` en test; cambiar a la URL de producción cuando corresponda, ver `getDashboardActiveOrderUrl()`).

**Sugerencia de enfoque para la próxima sesión** (no ejecutado, para discutir con el usuario antes de crear nada en YCloud) — aplicando la regla 5 del skill ("acción para evitar una consecuencia → redactar neutro y factual"): sacar el emoji 😊 y el tono de invitación ("si querés... podés...", "te ayudamos a"), reformular como aviso de estado + plazo concreto sin marco de oferta. Ej.:
- Actual: *"Si todavía querés finalizarlo, podés darte 24 hs más desde tu pedido para conservarlo un día adicional 😊"*
- Más neutro/factual: *"Tenés hasta mañana a la mañana para extender el plazo 24hs desde tu pedido. Si no lo hacés, se desarma automáticamente."*

Antes de crear nada en YCloud: (1) invocar el skill `ycloud-whatsapp` con el texto propuesto para chequearlo contra las 5 reglas, (2) confirmar el texto final con el usuario (no inventarlo — mismo patrón de esta sesión, usar exactamente lo que el usuario apruebe), (3) usar nombres nuevos para las plantillas (no reusar `pedido_plazo_extendible2` etc., por el bloqueo de 4 semanas de Meta al cambiar de categoría).

## Número de Ani conectado — TÉCNICA VERIFICADA (2026-09-24)

El bloqueo de Meta `#3441061` que frenaba el número de Ani (pendiente desde el 2026-09-22, ver sección arriba) **se resolvió** — el usuario conectó el número por su cuenta. Verificado en vivo en la consola de YCloud (WhatsApp Manager → Cuentas de WhatsApp): WABA `FyLCalzados` (`343005040292549`), número `+5493625172874`, **Estado: Conectado**, Calidad: Alta.

**Completado en Supabase** (mismo patrón que Fati, `public.wa_channels`):
```sql
UPDATE wa_channels SET phone_e164='+5493625172874', ycloud_channel_id='343005040292549', status='connected' WHERE owner_key='ani';
```
Resultado: `ani` → `phone_e164='+5493625172874'`, `ycloud_channel_id='343005040292549'`, `status='connected'`.

**Verificado, no hace falta nada extra para esto:**
- La API Key de YCloud (`Developers → Clave API`) es **de toda la cuenta**, no por WABA — la misma que ya usa `wa-dispatch` sirve para el número de Ani también.
- El webhook (`Developers → Webhooks`) está registrado **a nivel de cuenta** (una sola URL, `wa-webhook`), no por WABA — no hace falta un segundo endpoint para Ani.

**Pendiente real antes de que Ani pueda mandar avisos automáticos — confirmado con el skill `ycloud-whatsapp` (`references/templates.md`)**: las plantillas de WhatsApp se crean con un `wabaId` específico (`POST /v2/whatsapp/templates` lo exige) — **son por WABA, no por cuenta**. Como Ani está en una WABA distinta (`FyLCalzados`, `343005040292549`) a la de Fati (`fylmoda`, `112764648454416`), **ninguna de las plantillas ya aprobadas para Fati (`pedido_vencido`, `pedido_plazo_extendible2`, etc.) existe para la WABA de Ani** — hay que crearlas y volver a mandarlas a revisión de Meta ahí, aunque el texto sea idéntico.

**Cómo sigue esto** (no ejecutado, pendiente de decisión del usuario): con `wa_channels.ani` ya `connected`, el trigger/enqueue de avisos (`fn_wa_expiry_candidates`) puede empezar a generar filas en `wa_outbox` para pedidos con dueña Ani (`kanban_inbox_owner`) — pero `wa-dispatch` va a fallar el envío hasta que existan las plantillas aprobadas para su WABA. No hay riesgo de mensajes rotos mientras `wa_settings.mode` siga en `whitelist` (solo el teléfono de prueba recibe algo); revisar antes de ampliar el modo.

## Plantillas de Ani creadas — intento de mejora de tono para Utility (2026-09-24)

Se crearon las 4 plantillas en la WABA `FyLCalzados` (mismos nombres que Fati, necesario porque `rpc_wa_cron_enqueue_expiry_events` elige el `template_name` por `kind`, sin diferenciar por canal/dueña).

**Cambio de link**: se detectó que el link "de test" (`nj-fyl-testing.vercel.app`) no es un placeholder descartable — es el único que hoy funciona de verdad. `https://www.fylmoda.com.ar/dashboard?tab=active-order` (el dominio "real") **redirige a `/catalogo`**, una página distinta, porque el cutover de `nj/` a producción (ver [[58-NJ-PRELAUNCH-CUTOVER-2026-09-04]]) todavía no se ejecutó — verificado en vivo navegando a ambas URLs. Se mantuvo el link de test también en las 4 plantillas nuevas de Ani. **No se tocó `nj/lib/site-url.ts`** (el usuario solo pidió intentar la mejora de texto, no el cutover completo).

**Reescritura de texto**: siguiendo la regla 5 del skill `ycloud-whatsapp` ("si pide una acción para evitar una consecuencia, redactar neutro y factual") y `docs/13_COMUNICACION_Y_TONO.md` ("Cómo pedir una acción": una sola acción, explicar por qué y hasta cuándo, sin inventar presión — coincide con la regla del skill), se sacó el tono de invitación/beneficio ("si querés... podés... 😊") de las 3 plantillas que habían caído en Marketing, reemplazándolo por hecho + plazo + consecuencia. `pedido_vencido` se copió sin cambios (ya era Utility). Textos exactos usados:

- `pedido_vencido`: sin cambios.
- `pedido_plazo_extendible2`: *"Hola 👋 Tu pedido cumplió el plazo de reserva de 7 días.\n\nTenés hasta mañana a la mañana para extender el plazo 24 hs desde tu pedido. Si no lo hacés, se desarma automáticamente.\n\n👉 [link]"*
- `pedido_plazo_faltan_productos`: mismo patrón + mención del mínimo de 4 productos.
- `pedido_plazo_ultimo_aviso`: mismo patrón, acción = responder el mensaje.

**Resultado parcial (verificado en vivo, 2026-09-24 20:38)**: de las 4, `pedido_plazo_extendible2` **ya volvió a caer en Marketing** — se resolvió en ~2 minutos, antes incluso de que terminara la revisión completa (quedó "Activo-Calidad pendiente"). Las otras 3 (`pedido_vencido`, `pedido_plazo_faltan_productos`, `pedido_plazo_ultimo_aviso`) seguían "En revisión" al cierre de la sesión — Meta puede tardar hasta 24hs. **Pendiente**: revisar el estado final de las 3 restantes en una próxima sesión (`WhatsApp Manager → Plantillas`, filtrar por WABA `FyLCalzados`, sacar el filtro de estado default que oculta resultados).

**Nota**: que `pedido_plazo_extendible2` haya caído en Marketing otra vez, pese a la reescritura, sugiere que ofrecer una extensión de 24hs (el contenido mismo, no el tono) puede ser lo que dispara la reclasificación — no necesariamente algo que se arregle solo con más ajustes de texto. Evaluar si vale la pena seguir iterando el texto o aceptar Marketing para ese mensaje en particular.

### Causa raíz confirmada (2026-09-25) — TÉCNICA VERIFICADA, corrige hipótesis anteriores

El usuario reportó que las 3 plantillas restantes también terminaron en Marketing. Se investigó la doc oficial de Meta (`developers.facebook.com/.../template-categorization`, fetch directo) para encontrar el patrón real, en vez de seguir probando a ciegas. Resultado — ver el skill `ycloud-whatsapp` (`references/templates.md`, sección "El patrón real que dispara Marketing") para el detalle completo con ejemplos oficiales citados:

- **La hipótesis del link/URL queda descartada**: la doc oficial de Meta muestra varios ejemplos Utility con "click below" (cancelar y reembolsar un backorder, subir una foto pendiente, ver pasos de un fraude) — un link no es señal de Marketing por sí solo.
- **El patrón real es la subcategoría "Retargeting" de Meta**: algo está por vencer/perderse + una acción que lo evita/recupera + link. Ejemplo oficial casi idéntico a nuestro caso: *"Your subscription will expire on {{date}}! Renew today to save {{discount}}."* Nuestras 3 plantillas con oferta de extensión (`pedido_plazo_extendible2`, `pedido_plazo_faltan_productos`, `pedido_plazo_ultimo_aviso`) calzan en ese molde estructural — por eso cayeron en Marketing pese a la reescritura neutra del 2026-09-24. `pedido_vencido` (hecho consumado, sin oferta) se mantiene Utility de forma consistente en ambas WABAs.
- **Conclusión práctica**: seguir puliendo el tono no va a cambiar el resultado mientras el mensaje siga ofreciendo la extensión proactivamente. Las opciones reales son (a) aceptar Marketing para esos 3 mensajes, o (b) rediseñarlos para no ofrecer la extensión en el mensaje automático (solo informar el vencimiento, y que la clienta la pida respondiendo — patrón "Continue a Conversation" de Utility). No se decidió todavía cuál camino tomar.

### Rediseño v2 — probado en vivo, resultado EN CURSO (2026-09-25)

Decisión del usuario: rediseñar los 3 mensajes sacando la oferta proactiva de extensión, dejando hecho + consecuencia como dato + invitación cálida a escribir (sin ofrecer la acción como beneficio). Iteración de texto con el usuario (3 vueltas: sacar "si no hay novedades" por sonar mal, sacar "se desarma automáticamente" por sonar brusco, sacar "liberar los productos" por ser jerga interna) hasta llegar a:

> Hola 👋 [hecho: cumplió el plazo / la prórroga terminó]. Mañana por la mañana dejamos de guardarte los productos.
>
> Si necesitás algo, escribinos por acá o revisá tu pedido: 👉 [link] 😊

**Se crearon 6 plantillas nuevas** (3 en cada WABA, sufijo `_v2`, sin borrar las viejas — `pedido_plazo_extendible_v2`, `pedido_plazo_faltan_productos_v2`, `pedido_plazo_ultimo_aviso_v2`), categoría solicitada Utilidad. **Nada conectado al sistema todavía** — es solo una prueba de categorización, el `template_name` en `rpc_wa_cron_enqueue_expiry_events` (357) sigue apuntando a los nombres viejos.

**Hallazgo importante sobre confiabilidad de la categoría mostrada mientras dice "En revisión"**: `pedido_plazo_faltan_productos_v2` en la WABA de Fati mostró "Utilidad" apenas creada, y **cambió a "Marketing" ~5 minutos después**, todavía sin terminar la revisión completa. Conclusión: la categoría que se ve en la lista mientras el estado es "En revisión" es provisoria, no definitiva — no reportar como resultado final hasta confirmar en una sesión posterior (Meta puede tardar hasta 24hs).

**Estado al cierre de esta sesión (provisorio, puede seguir cambiando):**

| Plantilla | Fati (`fylmoda`) | Ani (`FyLCalzados`) |
|---|---|---|
| `pedido_plazo_extendible_v2` | Marketing | Utilidad (provisorio) |
| `pedido_plazo_faltan_productos_v2` | Marketing (cambió desde Utilidad) | Utilidad (provisorio) |
| `pedido_plazo_ultimo_aviso_v2` | Utilidad (provisorio) | Utilidad (provisorio) |

**Pendiente**: revisar el estado final de las 6 en una próxima sesión (`WhatsApp Manager → Plantillas`, buscar `_v2`, por cada WABA). Recién con el resultado firme decidir: si alguna quedó Utilidad de forma estable, actualizar `rpc_wa_cron_enqueue_expiry_events` (nueva migración) para que apunte al nombre `_v2` correspondiente — y ahí sí borrar la plantilla vieja equivalente si corresponde. Si terminan todas en Marketing igual, aceptar esa categoría y no seguir iterando texto (ya se probaron 2 rediseños completos sin éxito consistente).
