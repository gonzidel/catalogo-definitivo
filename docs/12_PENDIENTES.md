# Pendientes y preguntas para FyL Moda

Última revisión: 2026-09-23

Estas preguntas siguen requiriendo respuesta humana o acceso productivo. Las respuestas ya confirmadas fueron trasladadas a sus documentos de dominio.

- **CRÍTICA:** una respuesta incorrecta puede producir cambios equivocados en comportamiento, datos o comunicación.
- **IMPORTANTE:** mejora considerablemente el contexto y la calidad de las decisiones.
- **COMPLEMENTARIA:** aporta contexto útil, pero no bloquea el trabajo habitual.

## Top 10 pendientes críticos

| Orden | ID | Pregunta de mayor valor inmediato |
|---|---|---|
| 1 | ARQ-01 | ¿Cuál es la topología productiva oficial y qué superficie atiende cada URL? |
| 2 | ARQ-02 | ¿Qué migraciones, cron jobs, Edge Functions y variables están realmente desplegados? |
| 3 | ARQ-03 | ¿Cuáles son las definiciones y grants efectivos de las RPCs críticas? |
| 4 | OPE-01 | ¿Quién es responsable y quién autoriza excepciones en cada área? |
| 5 | PED-03 | ¿Cuál es el procedimiento legal y operativo completo de devoluciones, reintegros y notas de crédito? |
| 6 | STO-04 | ¿Cuál es la semántica comercial completa de `reserved_qty`? |
| 7 | ENV-01 | ¿Qué política comercial rige Expreso Norte y Andreani? |
| 8 | WAC-01 | ¿Cuál es el estado productivo real y autorizado de YCloud? |
| 9 | CLI-02 | ¿Cuál es la fuente maestra de identidad, consentimiento y datos fiscales del cliente? |
| 10 | PED-01 | ¿Cuándo se considera comercialmente aceptado un pedido y qué compromiso genera? |

## Empresa y modelo de negocio

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| EMP-01 | CRÍTICA | ¿Cuáles son razón social, CUIT, domicilio legal/fiscal, teléfonos y horarios oficiales? ¿Av. Alberdi 1099 es solo punto de retiro o también domicilio comercial/legal? |
| EMP-02 | CRÍTICA | ¿Cuál es la política legal/fiscal completa y quién puede autorizar excepciones a mínimos, precios, descuentos o condiciones comerciales? |
| EMP-03 | IMPORTANTE | ¿Debe retirarse el claim público “fábrica propia” de todos los canales actuales o existe algún canal/entidad donde todavía sea válido? |

## Operación

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| OPE-01 | CRÍTICA | ¿Quiénes son responsables nominales y quién tiene autoridad de excepción en ventas, stock, local, logística, facturación, comunicación y sistemas? |
| OPE-02 | IMPORTANTE | Además de los plazos de reserva conocidos, ¿cuáles son los SLA de preparación, despacho, respuesta y entrega? |
| OPE-03 | IMPORTANTE | ¿Qué manuales y procedimientos de escalamiento existen ante faltantes, diferencias de stock o fallas de checkout, facturación, mensajería e impresión? |

## Clientes

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| CLI-01 | IMPORTANTE | ¿Qué reglas comerciales cambian entre revendedoras, emprendedoras, comercios, local y consumidor final? |
| CLI-02 | CRÍTICA | ¿Cuál es la fuente maestra de identidad, teléfono, consentimiento y datos fiscales de cada cliente? |
| CLI-03 | IMPORTANTE | ¿Qué definición exacta y configurable determina que un cliente sea nuevo, habitual o inactivo? |

## Catálogo

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| CAT-01 | CRÍTICA | ¿Cuál es hoy el catálogo canónico productivo y NJ continúa siendo una experiencia de testers o ya es general? |
| CAT-02 | IMPORTANTE | ¿Cuál es la fuente y quién aprueba contenido, publicación, precios y promociones? |
| CAT-03 | IMPORTANTE | ¿Qué política decide publicar, ocultar o mostrar productos/variantes/talles sin disponibilidad? |

## Pedidos

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| PED-01 | CRÍTICA | ¿En qué momento el pedido se considera comercialmente aceptado y qué compromiso asume FyL sobre precio y stock? |
| PED-02 | CRÍTICA | ¿Quién puede forzar cierre, reabrir, cancelar, editar o vender sin stock y qué auditoría requiere cada excepción? |
| PED-03 | CRÍTICA | Ya está confirmado que los faltantes se resuelven con el cliente, sin sustitución silenciosa, y que en envíos los reintegros/devoluciones corresponden principalmente a problemas atribuibles a FyL. ¿Cuál es el procedimiento legal y operativo completo: responsables, evidencia, plazos, medio de reintegro, notas de crédito, costos y tratamiento de casos no contemplados? |
| PED-04 | IMPORTANTE | ¿Qué cadencia de avisos debe ser la política oficial: 3/2/1 días, 2/1 día, plazo cumplido, desarme final u otra combinación? |

## Stock

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| STO-01 | CRÍTICA | ¿Quién responde por `general` y `venta-publico` y cuál es el límite operativo exacto entre depósito y local? |
| STO-02 | CRÍTICA | ¿Cuál es el procedimiento oficial para conteos, ajustes, transferencias y aprobación de diferencias? |
| STO-03 | CRÍTICA | ¿Cuándo se permite vender sin stock, quién lo autoriza y qué motivo debe registrarse? |
| STO-04 | CRÍTICA | ¿Cuándo debe aumentar/disminuir `reserved_qty`, qué reservas lo componen, qué ocurre al vencer/cancelar y debe incluir o excluir `local_deferred_pickup`? |
| STO-05 | IMPORTANTE | ¿Qué ventas o movimientos ocurren fuera de las RPCs canónicas y cómo se reconcilian? |

## Retiro local

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| RET-01 | CRÍTICA | ¿Qué zonas/clientes habilitan `local_deferred_pickup` y cuál es la fuente configurable de esa elegibilidad? La excepción comercial al mínimo ya está definida por modalidad, no por domicilio. |
| RET-02 | CRÍTICA | ¿Existen seña o penalidad y cuál es el procedimiento operativo para desarmar y liberar la reserva una vez cumplidas las 36 horas? |
| RET-03 | IMPORTANTE | ¿Quién confirma apartado, cobro, entrega y finalización de la venta presencial? |
| RET-05 | IMPORTANTE | Para cambios en el local, ¿cuál es el plazo máximo, qué empaque/comprobante se exige, qué excepciones aplican por uso o deterioro y cómo se tratan categorías distintas del calzado? |

## Envíos y pagos

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| ENV-01 | CRÍTICA | ¿Cuál es la modalidad de pago confirmada para Expreso Norte y Andreani, y quién puede cambiarla? |
| ENV-02 | IMPORTANTE | ¿Qué cobertura, costos, seguros y plazos corresponden a cada transporte y región? |
| ENV-03 | CRÍTICA | ¿Qué evidencia confirma un pago y quién puede marcarlo, revertirlo o conciliarlo? |
| ENV-04 | CRÍTICA | ¿Qué procedimiento y responsabilidad se aplican ante rechazo, devolución o pérdida del transporte? |

## WhatsApp / CRM

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| WAC-01 | CRÍTICA | ¿Cuál es el estado productivo real de YCloud: modo, números, plantillas, webhooks y responsables autorizados para pasar a `live`? |
| WAC-02 | CRÍTICA | ¿Existe en infraestructura `crm-events-dispatch` u otro servicio que procese eventos CRM? |
| WAC-03 | CRÍTICA | ¿Cuál es la política jurídica de consentimiento, opt-in, horarios, baja y retención de datos/conversaciones? |
| WAC-04 | IMPORTANTE | ¿Qué arquitectura definitiva habrá entre IA de WhatsApp, YCloud y CRM propio en `/admin`? |
| WAC-05 | IMPORTANTE | ¿Quién es responsable de cada contacto, qué métricas se usarán y quién aprueba journeys, plantillas, campañas y límites? |
| WAC-06 | IMPORTANTE | ¿Cómo se identifica un mensaje automático y qué casos deben pasar obligatoriamente a atención humana? |
| WAC-07 | CRÍTICA | ¿Qué validaciones y aprobación faltan antes de activar el asistente IA de YCloud y su Data Connector de transportes? |

## Arquitectura / producción

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| ARQ-01 | CRÍTICA | ¿Cuál es la topología productiva oficial: URLs, Firebase, hosting Next, Supabase, backend ARCA y agentes locales? |
| ARQ-02 | CRÍTICA | ¿Qué migraciones, cron jobs, Edge Functions y variables están realmente desplegados? Verificar sin copiar secretos. |
| ARQ-03 | CRÍTICA | ¿Cuáles son las definiciones y grants efectivos de las RPCs críticas, incluido `rpc_orders_daily_maintenance`? |
| ARQ-04 | IMPORTANTE | ¿Qué ambientes, monitoreo, backups, alertas y procedimientos de despliegue/rollback son oficiales? |

## Decisiones técnicas

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| TEC-01 | CRÍTICA | ¿NJ reemplazó completamente al sistema legacy y GZ Agent reemplazó formalmente a QZ? |
| TEC-02 | CRÍTICA | ¿Qué baseline de migraciones representa de manera reproducible el estado productivo? |
| TEC-03 | IMPORTANTE | ¿Cuál es la política de retiro para `catalogo1`, root legacy, QZ y documentación superada? |
| TEC-04 | IMPORTANTE | ¿Cuándo pueden actualizarse `supabase/canonical/RPC_CANONICAL_MAP.md`, `supabase/README.md` y los resúmenes históricos con una fuente autoritativa? |

## Otros

| ID | Prioridad | Pregunta pendiente |
|---|---|---|
| OTR-01 | IMPORTANTE | ¿Existen diferencias de tono obligatorias para web, WhatsApp, email, notificaciones, documentos fiscales o reclamos? |
| OTR-02 | IMPORTANTE | ¿Qué dominios y formatos de enlace son oficiales y se permiten acortadores? |
| OTR-03 | IMPORTANTE | ¿Quién aprueba un mensaje como vigente, en prueba o histórico? |
| OTR-04 | COMPLEMENTARIA | ¿Qué conversaciones o campañas pueden incorporarse como ejemplos autorizados y anonimizados? |

## Fuentes necesarias para responder

- Datos legales, políticas comerciales y manuales internos vigentes.
- Recorridos de la operación diaria por rol.
- Export seguro de schema, funciones, grants y cron de producción.
- Lista de canales desplegados, URLs y responsables.
- Textos y plantillas aprobados, con estado y fecha de vigencia.
- Responsables humanos por área y por aprobación de comunicación.
