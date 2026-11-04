# Decisiones detectadas

Última revisión: 2026-09-23

Este registro reconstruye decisiones a partir de código y documentación. Cuando el motivo no está escrito, no se lo inventa.

| Decisión | Clasificación | Evidencia | Motivo documentado | Revisión |
|---|---|---|---|---|
| Usar `variant_size_warehouse_stock` como fuente física por talle/depósito | TÉCNICA VERIFICADA | Migraciones 73, 84, 145, 148 | Evitar autoridades de stock divergentes | 2026-09-23 |
| Definir vendible como suma no negativa de `general` y `venta-publico` | TÉCNICA VERIFICADA | Migración 330 | Evitar restar reservas ya reflejadas por consumo físico | 2026-09-23 |
| Consumir `general` antes de `venta-publico` | TÉCNICA VERIFICADA | Migración 335 y parches | No documentado todavía | 2026-09-23 |
| Registrar el depósito consumido por línea | TÉCNICA VERIFICADA | `order_item_stock_sources` | Permitir devolución y auditoría correctas | 2026-09-23 |
| Hacer checkout idempotente y serializado por cliente | TÉCNICA VERIFICADA | `rpc_operations`, locks frontend y DB | Prevenir doble pedido/doble descuento por reintentos o pestañas | 2026-09-23 |
| Tomar precio efectivo desde DB al confirmar | TÉCNICA VERIFICADA | Migración 335 | No confiar en snapshots manipulables o vencidos del carrito | 2026-09-23 |
| Servir catálogo desde snapshot con fallback disponible | TÉCNICA VERIFICADA | `CATALOG_SOURCE`, migraciones 193/213 | Rendimiento y estabilidad de lectura | 2026-09-23 |
| Mantener Next.js y superficies legacy durante la transición | TÉCNICA VERIFICADA | Firebase redirects y árboles raíz/`nj` | No documentado todavía | 2026-09-23 |
| Separar operación de Retiro del tablero general | TÉCNICA VERIFICADA | `/admin/retiro`, dominio y migraciones 307-334 | Adaptar venta/cobro/apartado presencial | 2026-09-23 |
| Reemplazar QZ Tray por GZ Agent para impresión local | TÉCNICA VERIFICADA | `gz-agent`, `nj/lib/print/gz-agent.ts` | Confirmación formal pendiente | 2026-09-23 |
| Desregistrar el service worker legacy en Next | TÉCNICA VERIFICADA | Layout Next | Evitar que caches antiguos interfieran con la app actual | 2026-09-23 |
| Autorización admin en dos niveles: pertenencia y permisos | TÉCNICA VERIFICADA | `admins`, `admin_permissions`, layouts | Separar superadmin de colaboradores | 2026-09-23 |
| Introducir YCloud por modos graduales | EN EVALUACIÓN | Migraciones/funciones locales sin seguimiento | Reducir riesgo antes de envíos live | 2026-09-23 |
| Mantener cron de WhatsApp separado de los flujos de pedido | EN EVALUACIÓN | `wa_outbox`, `wa-dispatch` | Desacoplar transacción y proveedor externo | 2026-09-23 |
| Usar **FyL Moda** como nombre comercial vigente | CANÓNICA | Contexto + uso principal en producto | Reemplaza **FyL Calzados** salvo referencias históricas/técnicas | 2026-09-23 |
| Orientar la web principalmente al mayorista B2B con surtido libre | CANÓNICA | Contexto + producto web | Permitir variedad sin grandes cantidades del mismo modelo | 2026-09-23 |
| Exigir 4 productos surtidos en el pedido web normal | CANÓNICA | Contexto + UI Next | Mínimo comercial mayorista | 2026-09-23 |
| Excluir `local_deferred_pickup` del mínimo general | NEGOCIO CONFIRMADO | Contexto; implementación acoplada a zona | Regla específica de la modalidad | 2026-09-23 |
| No descontar/reservar inmediatamente en `local_deferred_pickup` | CANÓNICA | Contexto + migraciones 309/335 | El local confirma físicamente antes de apartar | 2026-09-23 |
| Dar 36 horas para retirar desde que el pedido local se comunica listo | CANÓNICA | Contexto + implementación parcial de plazo corto | Limitar la reserva posterior a la preparación | 2026-09-23 |
| Desarmar y dejar de reservar un retiro local no retirado tras 36 horas | CANÓNICA | Contexto del responsable | Liberar los productos para otros clientes | 2026-09-23 |
| Contactar al cliente ante un faltante y resolver entre revisión, reintegro o reemplazo voluntario | NEGOCIO CONFIRMADO | Contexto del responsable | No imponer una solución ni sustituir silenciosamente | 2026-09-23 |
| Ejecutar un cambio voluntario quitando el producto anterior y agregando el elegido | NEGOCIO CONFIRMADO | Contexto + flujo cliente parcial | Mantener conocimiento y decisión del cliente | 2026-09-23 |
| Limitar devoluciones/reintegros de pedidos enviados principalmente a problemas atribuibles a FyL | NEGOCIO CONFIRMADO | Contexto del responsable | Falla, producto incorrecto, error de preparación u otro caso atribuible | 2026-09-23 |
| Permitir cambios en el local, con calzado en condiciones adecuadas | NEGOCIO CONFIRMADO | Contexto del responsable | Política principal de cambio, no devolución automática de dinero | 2026-09-23 |
| Preferir “reservado” frente a “apartado” en mensajes al cliente cuando la reserva sea real | NEGOCIO CONFIRMADO | Contexto del responsable | Describir mejor la situación desde la perspectiva del cliente | 2026-09-23 |
| No usar “reservado” antes de la confirmación física en `local_deferred_pickup` | CANÓNICA | Contexto + flujo diferido | La creación no compromete stock | 2026-09-23 |
| Comunicar con voz cercana, clara, humana y rioplatense | NEGOCIO CONFIRMADO | Contexto del responsable | Evitar tono corporativo o de bot | 2026-09-23 |
| Evaluar journeys CRM de primer contacto e inactividad | EN EVALUACIÓN | Contexto del responsable | Seguimiento y reactivación sin insistencia excesiva | 2026-09-23 |

## Decisiones todavía no registradas

- Qué superficie es oficialmente canónica para cada tarea administrativa.
- Qué conjunto de migraciones representa el baseline reproducible de producción.
- Cuándo retirar root legacy, `catalogo1`, QZ y documentos históricos.
- Detalles legales y operativos de devoluciones/reintegros; señas y ejecución del desarme de retiros; stock negativo y ventas sin stock.
- Estrategia de CRM, WhatsApp productivo y ownership de datos del cliente.
