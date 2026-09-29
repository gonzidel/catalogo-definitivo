# WhatsApp y CRM

Última revisión: 2026-09-23

## VERIFICADO EN CÓDIGO

### Contacto manual

Estado: Vigente  
Fuente: Frontend y dominio de pedidos  
Última revisión: 2026-09-23

La integración estable visible en el producto genera enlaces `wa.me` para que una persona abra WhatsApp con un mensaje prearmado. Hay usos en catálogo, cliente y administración. Esta modalidad no demuestra envío automático ni recepción de eventos.

### Base YCloud local

Estado: En evaluación / trabajo local no consolidado  
Fuente: archivos sin seguimiento Git y notas de auditoría locales  
Última revisión: 2026-09-23

El árbol local contiene:

- tablas/configuración para canales, modos y `wa_outbox`;
- función `supabase/functions/wa-dispatch/index.ts` para despachar pendientes;
- función `supabase/functions/wa-webhook/index.ts` para validar firma, deduplicar y registrar eventos;
- modos documentados `off`, `shadow`, `whitelist` y `live`;
- migraciones y pruebas recientes para plantillas, estados e idempotencia.

La presencia de estos archivos no prueba que estén versionados, desplegados, configurados ni activos. Las notas que dicen "producción" son evidencia documental externa al código ejecutable local y deben verificarse en Supabase/YCloud antes de operar.

### CRM local

Estado: Fundación en evaluación  
Fuente: migración local 358  
Última revisión: 2026-09-23

`358_crm_events_foundation.sql` define una base de eventos CRM y pruebas. La documentación local menciona un Edge Function `crm-events-dispatch`, pero ese directorio no existe en el repositorio revisado. Por lo tanto, el circuito automático completo no está verificable aquí.

## CONTEXTO CONFIRMADO POR EL NEGOCIO

Estado: En evaluación  
Fuente: Contexto confirmado por responsable del negocio  
Última revisión: 2026-09-23

- WhatsApp es uno de los principales canales comerciales y de atención.
- Se está trabajando con YCloud para automatización e integración de WhatsApp y como posible base de procesos CRM.
- Los objetivos del CRM son identificar contactos nuevos y potenciales, distinguir compradores, detectar inactividad, hacer seguimiento, automatizar eventos web, responder consultas repetitivas y generar reactivación.
- También se evaluó un agente de IA dentro de WhatsApp.
- La arquitectura entre IA de WhatsApp, YCloud y un CRM propio en `/admin` **no está resuelta**.
- No existe confirmación empresarial de un servicio externo `crm-events-dispatch`; mientras tampoco exista en el repositorio o infraestructura verificable, debe permanecer pendiente.
- Journeys en evaluación: contacto nuevo sin compra en días 7 y 30; cliente inactivo alrededor de 60 y 120 días. Los intervalos y la definición de inactividad siguen siendo configurables/no aprobados.

### Trabajo local concurrente: asistente IA y transportes

Estado: En progreso; no tratar como activado  
Fuente: nota local sin seguimiento `docs/FYL-Obsidian/70-ASISTENTE-FYL-CHATBOT-REVISION-2026-09-23.md` y archivos 360  
Última revisión: 2026-09-23

- La nota describe un asistente de YCloud creado pero inactivo, sin conversaciones reales.
- El árbol local agrega `transport_coverage`, `fn_transportes_disponibles` y `transport-lookup` para responder cobertura por localidad mediante Data Connector.
- Configuración del secreto, conexión end-to-end y activación del bot siguen pendientes. La nota afirma aplicación en un proyecto Supabase, pero eso requiere verificación independiente antes de considerarlo estado productivo.

### Seguridad e idempotencia

- `wa-dispatch` espera autenticación de cron y credenciales externas mediante secretos de entorno.
- `wa-webhook` valida firma/HMAC y conserva idempotencia de eventos.
- No se deben incluir claves, tokens, firmas ni payloads con datos personales en esta documentación.
- Cualquier paso a `live` requiere verificar destinatarios, plantillas aprobadas, permisos, opt-in, rate limits, reintentos y observabilidad.

### Reglas importantes

| Regla | Estado | Fuente | Revisión |
|---|---|---|---|
| `wa.me` es el canal verificable estable | Verificado | Frontend | 2026-09-23 |
| YCloud no puede considerarse productivo por archivos locales | Verificado como límite de evidencia | Git/status local | 2026-09-23 |
| Webhooks deben validar firma y deduplicar | Verificado en implementación local | `wa-webhook` | 2026-09-23 |
| El despachador CRM mencionado no está en el repo | Verificado | Búsqueda del árbol | 2026-09-23 |

## Tablas y componentes clave

- Tablas locales recientes: `wa_settings`, canales/outbox/eventos de WhatsApp y base de eventos CRM; confirmar nombres y versión en la migración aplicada.
- Funciones: `wa-dispatch`, `wa-webhook`.
- Frontend: helpers de mensajes y enlaces `wa.me` en dominio/pedidos.

## Archivos clave

- `supabase/functions/wa-dispatch/index.ts`
- `supabase/functions/wa-webhook/index.ts`
- `supabase/canonical/351_wa_notifications_foundation.sql`
- `supabase/canonical/352_wa_expiry_events_logic.sql`
- `supabase/canonical/353_wa_dispatch_cron.sql`
- `supabase/canonical/358_crm_events_foundation.sql`
- `docs/FYL-Obsidian/67-YCLOUD-WHATSAPP-AVISOS-VENCIMIENTO-2026-09-22.md`
- `docs/FYL-Obsidian/68-CRM-AUTOMATICO-YCLOUD-2026-09-23.md`
- `nj/lib/orders/domain.ts`
- `supabase/canonical/360_transport_coverage_lookup.sql`
- `supabase/functions/transport-lookup/index.ts`

## INFERIDO / DESCONOCIDO

- **Inferido:** se busca migrar de enlaces manuales a mensajería transaccional gradual, con shadow/whitelist antes de live.
- **Desconocido:** qué cuenta, número, plantillas y webhook están configurados realmente en YCloud.
- **Desconocido:** si las migraciones 351-358 fueron aplicadas y si cron está activo.
- **Desconocido:** consentimiento, política de baja, horarios de contacto y responsable comercial de cada conversación.
- **Desconocido:** fuente maestra del cliente, etapas del CRM, ownership de leads y métricas de conversión.
- **Desconocido:** cuándo y bajo qué aprobación podría activarse el asistente IA.
