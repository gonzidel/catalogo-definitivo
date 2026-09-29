# FyL Moda: guía para agentes

Este repositorio pertenece a **FyL Moda**, negocio mayorista B2B de calzado, indumentaria y accesorios.

- La entrada de la documentación para agentes es `docs/00_INDEX.md`.
- Antes de modificar lógica importante, leer los documentos del dominio afectado y seguir las llamadas hasta el SQL/RPC efectivo.
- No inventar reglas de negocio ni completar huecos con supuestos.
- Si código y documentación se contradicen, informar la contradicción. Para describir el comportamiento técnico actual, priorizar la evidencia ejecutable más reciente; no convertirla automáticamente en política comercial ni usarla para reemplazar una regla de negocio confirmada.
- No eliminar comportamiento aparentemente redundante sin verificar si protege una regla comercial, concurrencia, idempotencia, stock o compatibilidad histórica.
- Preservar las reglas existentes salvo que la tarea pida explícitamente cambiarlas.
- No tratar una migración local, una nota histórica o un archivo sin seguimiento Git como prueba de que algo está desplegado en producción.
- Antes de redactar textos para clientes, WhatsApp, CRM, emails o notificaciones, leer `docs/13_COMUNICACION_Y_TONO.md`, `docs/14_EJEMPLOS_DE_MENSAJES.md` y la documentación funcional del estado comunicado. Por ejemplo, un mensaje de retiro local diferido también requiere leer `docs/08_RETIRO_LOCAL.md`.
- Al documentar reglas importantes, usar las clasificaciones de `docs/00_INDEX.md`: **CANÓNICA**, **NEGOCIO CONFIRMADO**, **TÉCNICA VERIFICADA**, **HISTÓRICA**, **EN EVALUACIÓN** o **CONTRADICCIÓN**.
