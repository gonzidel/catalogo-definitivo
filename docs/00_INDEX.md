# Índice de contexto para agentes

Última revisión: 2026-09-23

Este índice resume la documentación estable de FyL Moda. El código, las migraciones SQL y la configuración ejecutable son la evidencia primaria del comportamiento técnico; el contexto empresarial confirmado es la autoridad para las reglas comerciales. Ninguna de esas fuentes debe sustituir silenciosamente a la otra cuando divergen. La bóveda histórica `docs/FYL-Obsidian/` conserva auditorías y evolución detallada; puede contener notas superadas.

## Convenciones

- **VERIFICADO EN CÓDIGO**: confirmado siguiendo implementación o configuración actual del repositorio.
- **INFERIDO**: conclusión razonable, todavía no confirmada en producción o por el negocio.
- **DESCONOCIDO**: falta contexto empresarial, acceso productivo o evidencia suficiente.
- Una migración en `supabase/canonical/` demuestra intención/versionado local, no necesariamente despliegue.
- Los archivos sin seguimiento Git se consideran trabajo local en curso.

Para reglas importantes, usar esta clasificación normalizada:

| Clasificación | Significado |
|---|---|
| **CANÓNICA** | Confirmada por el negocio y compatible con la implementación revisada. |
| **NEGOCIO CONFIRMADO** | Confirmada por el negocio, pero su implementación no fue verificada o diverge. |
| **TÉCNICA VERIFICADA** | Confirmada en código/configuración, pero falta validación comercial. |
| **HISTÓRICA** | Existió anteriormente o persiste en material legado; no usar como regla vigente sin validación. |
| **EN EVALUACIÓN** | Todavía no definida o aprobada. |
| **CONTRADICCIÓN** | Fuentes relevantes no coinciden; no elegir una silenciosamente. |

Las etiquetas anteriores complementan, no reemplazan, la separación entre evidencia de código, contexto empresarial e información desconocida.

## Empresa

Leer `01_EMPRESA.md` para identidad, oferta y datos empresariales confirmados o pendientes.

## Modelo de negocio

Leer `02_MODELO_NEGOCIO.md` antes de cambiar mínimos, precios, promociones, métodos de pago, estados visibles o experiencia de compra.

## Operación

Leer `03_OPERACION.md` antes de modificar administración, depósitos, compras, ventas, facturación, impresión o conciliación.

## Producto web

Leer `04_PRODUCTO_WEB.md` antes de tocar rutas, catálogo, PDP, búsqueda, carrito, autenticación, analytics, PWA o despliegues frontend.

## Arquitectura

Leer `05_ARQUITECTURA.md` antes de cambiar límites entre aplicaciones, Supabase, Edge Functions, backend ARCA, hosting o integraciones.

## Pedidos

Leer `06_PEDIDOS.md` antes de modificar carrito, checkout, ítems, estados, cierre, cancelación, vencimiento, concurrencia o Kanban.

## Stock

Leer `07_STOCK.md` antes de modificar disponibilidad, talles, depósitos, reservas, ventas, devoluciones o auditoría de inventario.

## Retiro local

Leer `08_RETIRO_LOCAL.md` antes de tocar transporte Retira Local, pedidos diferidos, tablero Retiro, cobro o conversión a venta pública.

## WhatsApp y CRM

Leer `09_WHATSAPP_CRM.md` antes de cambiar enlaces `wa.me`, avisos automáticos, YCloud, colas, webhooks, cron o journeys.

## Decisiones

Leer `10_DECISIONES.md` para decisiones deliberadas detectadas en código. Los motivos no confirmados están marcados como tales.

## Problemas y defensas

Leer `11_PROBLEMAS_Y_FIXES.md` antes de quitar locks, idempotencia, fuentes de stock, reconciliación, guards, reintentos o compatibilidad histórica.

## Pendientes

Leer y actualizar `12_PENDIENTES.md` cuando aparezcan contradicciones, datos externos faltantes o decisiones que requieran confirmación del dueño.

## Comunicación y tono

Leer `13_COMUNICACION_Y_TONO.md` antes de redactar textos visibles al cliente, WhatsApp, CRM, emails o notificaciones. También se debe leer el documento funcional del proceso comunicado.

## Ejemplos de mensajes

Consultar `14_EJEMPLOS_DE_MENSAJES.md` para reutilizar solamente mensajes aprobados, en prueba o históricos con estado explícito. No convertir una plantilla vacía en una regla de tono.

## Documentación especializada existente

- `docs/FYL-Obsidian/00-INDICE.md`: índice de auditorías técnicas históricas.
- `docs/STOCK_GOVERNANCE.md`: gobernanza de stock; tiene contradicciones actuales registradas en `11_PROBLEMAS_Y_FIXES.md`.
- `docs/RUNBOOK.md`: operación y despliegue.
- `admin/STOCK_OPERATIVA.md`: uso de pantallas de stock.
- `backend/README.md`: backend de facturación ARCA.
- `gz-agent/README.md`: agente local de impresión.
