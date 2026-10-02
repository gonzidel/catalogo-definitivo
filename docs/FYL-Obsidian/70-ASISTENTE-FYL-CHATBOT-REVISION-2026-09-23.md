# Asistente FYL (chatbot YCloud) — revisión y conector de transportes

Fecha: 2026-09-23
Estado: en progreso, bot sigue INACTIVO (0 conversaciones en Rendimiento, seguro de editar)
chatbotId: `69dffa400ddc4718fc66715f`

> **Nota de normalización (2026-09-23):** las referencias de esta auditoría a “mínimo 4 pares” y “fábrica propia” no son reglas comerciales vigentes. La regla **CANÓNICA** para la web es un mínimo de 4 productos surtidos. El claim “fábrica propia” está **EN EVALUACIÓN** y no debe usarse en textos nuevos sin confirmación. La conclusión de ocultar por completo “apartado/reservado” queda **HISTÓRICA**: la decisión vigente es preferir “reservado” cuando la reserva existe, evitar “apartado” en mensajes nuevos y no afirmar reserva antes de la confirmación física de `local_deferred_pickup`.

## Contexto

Bot de IA armado en YCloud en abril 2026 y nunca activado en producción. El
pedido del dueño de FYL fue retomarlo, revisar/mejorar sus prompts y
Conocimiento contra la documentación real del negocio (Obsidian + código), y
dejarlo listo para activar más adelante — sin activarlo todavía.

Se auditó el Perfil, Instrucciones, Recomendación (cierre/escalado/tags/
atributos), Conocimiento (14 Q&A) y Habilidades (3 actionbooks, 2
deshabilitadas) contra:
- `docs/FYL-Obsidian/49-REGLAS-UX-FLUJO-COMPRA-CLIENTE-2026-08-10.md`
- `nj/app/layout.tsx` (mínimo 4 pares, fábrica propia, envíos a todo el país)
- `client/transportes-data.js` y sus fuentes de datos

La mayoría de los hechos comerciales del bot seguían vigentes. Se
confirmaron dos cambios necesarios con el dueño:

## 1) El cliente nunca ve estados de reserva/apartado

Confirmado explícitamente por el dueño: el sistema actual **no** muestra al
cliente estados internos como "apartado" o "reservado". El cliente arma su
pedido y lo único que puede llegar a ver es una incidencia si el staff marca
explícitamente algo como **"Sin stock"**. Nada más.

Pendiente de aplicar en YCloud: reescribir la respuesta de Conocimiento a
"¿El pedido se reserva?" (actualmente habla de "proceso de reserva"),
quitando ese lenguaje interno, alineado con
`49-REGLAS-UX-FLUJO-COMPRA-CLIENTE-2026-08-10.md` (el cliente no debe ver
"Reservado"/"Confirmado"/"Por confirmar"/"Pedido en espera").

## 2) Conector de datos en vivo: cobertura de transportes por localidad

El dueño pidió que el bot pueda responder "¿hacen envíos a mi localidad
(ej. Catamarca Capital)?" con la cobertura real por transporte, la misma
que ya usa la web. Se evaluaron tres caminos (lista estática en el prompt,
archivo vinculado, conector de datos en vivo) y se eligió explícitamente
**"Conector de datos en vivo (Recomendado)"**: YCloud Data Connector llama
un endpoint HTTPS propio en tiempo real.

### Lo construido (aplicado y verificado en `dtfznewwvsadkorxwzft` / fyl-core)

- **`supabase/canonical/360_transport_coverage_lookup.sql`** (+ ROLLBACK +
  tests): tabla `public.transport_coverage` con copia fiel y completa de
  las 7 listas fuente de `client/transportes-data.js` (destinos_transporte/
  SEDE, retiro_del_local, expreso_norte, CREDIFIN_PROVINCIAS aplanado,
  `viaCargoLocalities`, `snaiderLocalities`, mym_cobertura) — **1005 filas**
  (sede=86, retiro=6, expreso=17, credifin=328, via_cargo=475, snaider=92,
  mym=1), extraídas programáticamente de los archivos fuente (no
  transcriptas a mano) y verificadas byte a byte contra el JS antes de
  insertar.
- Función `public.fn_transportes_disponibles(provincia, localidad)`:
  réplica 1:1 del algoritmo de `getTransportesDisponibles()` — override
  SEDE, excepción Corrientes Capital (solo Retira local + MyM), orden fijo
  retiro→expreso→credifin→snaider→via_cargo→mym, fallback a Correo
  Argentino. `REVOKE` de `authenticated`/`anon` (patrón lección 352b): solo
  la llama el Edge Function con service role.
- **Reutiliza infraestructura YA EXISTENTE** del módulo COD en vez de
  duplicarla: `public.fn_canonicalize_transport_name` /
  `fn_normalize_transport_key` (usadas por `resolve_transport_id`,
  `fn_closed_order_transport_category`, etc.) ya canonicalizaban nombres de
  transporte con las mismas reglas de `scripts/transport-canonical.js`.
  Solo se agregó `fn_transport_coverage_normalize_locality` (nueva, para
  normalizar provincia/localidad, que no existía). `public.transports` es
  solo el catálogo de 9 entidades transporte (con duplicado histórico
  "Retira Local"/"Retiro de Local"), sin cobertura por localidad — por eso
  la tabla nueva no es redundante.
- Bug encontrado y corregido durante la verificación: `array || 'texto'`
  sin cast explícito en plpgsql puede ser interpretado por Postgres como un
  literal de array malformado en vez de un append de elemento. Fix: cast
  `::text` explícito en cada concatenación.
- Advisor de seguridad de Supabase marcó ambas funciones nuevas con
  "role mutable search_path" (hallazgo real, no relacionado a los datos):
  se les agregó `SET search_path TO 'public', 'pg_catalog', 'extensions'`,
  igual que el resto de funciones del proyecto. Verificado post-fix: 0
  advisories sobre `transport_coverage`/`fn_transportes_disponibles`.
- Tests (`360_transport_coverage_lookup_tests.sql`) corridos en
  transacción con ROLLBACK contra la base real: SEDE override (Charata),
  excepción Corrientes Capital, Resistencia (Retira local), Tandil
  (Credifin + Correo Argentino), localidad sin cobertura (Ushuaia →
  Correo Argentino), normalización de acentos/mayúsculas, input vacío,
  privilegios (`authenticated`/`anon` sin EXECUTE). Todos OK.
- **`supabase/functions/transport-lookup/index.ts`**: Edge Function
  desplegada (`verify_jwt=false`, mismo patrón que `wa-dispatch`), gatea
  con secreto compartido propio (header `x-api-key` vs. secret
  `TRANSPORT_LOOKUP_API_KEY`, NO con JWT de Supabase, porque quien llama es
  YCloud, no un cliente del catálogo). Llama
  `fn_transportes_disponibles` vía RPC con service role y devuelve
  `{ ok, provincia, localidad, transportes: string[], hay_cobertura }`.
  URL: `https://dtfznewwvsadkorxwzft.supabase.co/functions/v1/transport-lookup`
  (GET con `?provincia=...&localidad=...` o POST con JSON body).

### Pendiente (para retomar)

1. **El dueño debe configurar el secret** `TRANSPORT_LOOKUP_API_KEY` en
   Supabase Dashboard → Edge Functions → transport-lookup → Secrets (se
   generó una clave aleatoria para este fin en la sesión, no persistida
   acá por ser secreta — pedirla de nuevo o generar otra si se perdió).
2. Configurar el **Data Connector** en YCloud (Habilidades del bot) para
   que apunte a esa URL con el header `x-api-key`, y armar la Habilidad
   que lo dispare cuando el cliente pregunte por cobertura de envío a una
   localidad.
3. Probar el Data Connector end-to-end desde la consola de YCloud (con la
   key configurada) antes de dar por cerrado este punto.
4. **Aún no aplicado en YCloud** (reportado al dueño, sin editar el bot
   todavía):
   - Reescribir la Q&A de "¿El pedido se reserva?" (punto 1 de este doc).
   - Confirmar si se habilitan las 2 Habilidades deshabilitadas ("Stock
     específico.", "Saludo inicial") — propuesto como bajo riesgo (bot sin
     conversaciones reales todavía), sin confirmación final explícita.
   - Confirmar/actualizar dirección y horario de retiro (actualmente Av.
     Alberdi 1099, Resistencia, Chaco; no verificable desde código).
   - Evaluar sumar a la Fondo de marca / Q&A de retiro las demás
     localidades de "Retiro de Local" que ya soporta el código
     (Barranqueras, Fontana, Margarita Belén, Colonia Benítez, Corrientes
     Capital), hoy el bot solo menciona Resistencia.
   - Confirmar medios de pago vigentes (bot dice "transferencia o contra
     reembolso").
5. Si `client/transportes-data.js` o sus archivos de datos cambian, la
   tabla `transport_coverage` debe volver a sincronizarse manualmente (no
   hay trigger automático).
   - **2026-10-02:** Snaider en Tacuarendí (Santa Fe) confirmado por el
     negocio. Web: `SNAIDER_LOCALIDADES_EXTRA` en `client/transportes-data.js`
     (fuera del Excel de `import-snaider-xlsx.mjs`). Bot:
     `364_transport_coverage_snaider_tacuarendi.sql` agrega 2 filas
     (`Tacuarendi` y `Tacuarendi (Emb. Kilometro 421)`) → **1007 filas**,
     snaider=94. Si se re-ejecuta 360, volver a correr 364.

## 2026-09-26 — Bug de YCloud: guardado de Conocimiento roto (bloqueante)

**TÉCNICA VERIFICADA:** ningún guardado de Q&A del Conocimiento de este bot
se persiste, sin importar qué entrada se edite ni desde dónde (UI real o
llamada directa a la API interna de YCloud).

### Cómo se reprodujo

1. Se abrió la edición de "¿El pedido se reserva?" desde la UI de YCloud
   (Conocimiento → lápiz de edición), se reemplazó el texto de la
   respuesta y se tocó "Guardar".
2. La UI mostró un toast de error rojo:
   **`Segment b02cfce2-0545-4ebb-9ed5-bd052dc03406 not found`**
3. Se repitió el mismo intento sobre una entrada distinta ("¿Hacen
   envíos?") para descartar que fuera un problema de esa fila puntual:
   **mismo `Segment b02cfce2-...-03406`, mismo error.**
4. La request de red (`PUT
   https://www.ycloud.com/omni-api/chatbotAi/knowledge/qa/update`)
   devuelve HTTP 200 pero con `code:1` y ese mensaje en el body — es decir,
   la UI no distingue esto de un guardado exitoso a simple vista; solo se
   nota por el toast momentáneo y porque `updateTime` no cambia al
   reconsultar `qa/get`.
5. Se había intentado antes, en la sesión del 2026-09-23, actualizar la
   misma entrada llamando directamente al endpoint interno
   `chatbotAi/knowledge/qa/update` (PUT) por fuera de la UI — mismo error,
   mismo Segment ID. Confirma que no es un artefacto de la UI ni de cómo
   se disparó la acción: es un recurso interno (probablemente el
   índice/embedding de Conocimiento de este bot específico) que YCloud no
   encuentra del lado del servidor.

### Impacto

Mientras esto no se resuelva del lado de YCloud, **no se puede guardar
ningún cambio en el Conocimiento de "Asistente FYL"** — ni por acá ni a
mano por el dueño. No afecta Habilidades ni Perfil (no probado a fondo,
pero el error es específico del endpoint `knowledge/qa/*`).

### Acción recomendada

Escribir a soporte de YCloud citando textualmente el error y estos datos:
- chatbotId: `69dffa400ddc4718fc66715f`
- Segment ID del error: `b02cfce2-0545-4ebb-9ed5-bd052dc03406`
- Endpoint: `PUT /omni-api/chatbotAi/knowledge/qa/update` devuelve
  `HTTP 200` con `{"code":1,"msg":"Segment ... not found"}` en el body.

### Textos listos para aplicar apenas se pueda guardar de nuevo

**"¿El pedido se reserva?" (reemplazar respuesta completa):**

> No exactamente 😊 Tu pedido queda armado con los productos que elegiste, y lo podés dejar abierto hasta 7 días para seguir sumando antes de cerrarlo. Si algún producto no tiene stock, te avisamos para que lo cambies o lo saques.

**"¿Hacen envíos?" (reemplazar respuesta completa — versión corregida tras
feedback del dueño de que "hacemos envíos a todo el país" como apertura
sonaba prepotente al preguntar por una localidad puntual, ej. Catamarca):**

> Trabajamos con estos transportes según la zona:
> - Chaco, Formosa, Corrientes y Misiones: reparto propio, Expreso Norte, Transporte Snaider o Credifin, según la localidad.
> - Buenos Aires, CABA, Córdoba, Santa Fe, Cuyo, NOA, Entre Ríos y Patagonia: Via Cargo y/o Credifin.
> - Resistencia, Barranqueras, Fontana, Margarita Belén, Colonia Benítez (Chaco) y Corrientes Capital: también podés retirar en persona.
> Si tu localidad no entra en esas zonas, la alternativa es Correo Argentino.
> Decime tu localidad por WhatsApp y te confirmamos el transporte exacto 😊

### CONTRADICCIÓN abierta (no resuelta por esta nota)

La "Nota de normalización" al inicio de este documento fue editada por
otro proceso/sesión después del 2026-09-23 y ahora dice que ocultar por
completo "apartado/reservado" es **HISTÓRICA**, con política vigente
"preferir reservado cuando la reserva existe, evitar apartado en mensajes
nuevos". Esto **contradice directamente** lo que el dueño confirmó de
palabra en la conversación del 2026-09-26: *"el cliente ya no ve estados
de apartado... simplemente hace su pedido y lo único que ve es si no hay
stock"*. El texto de reemplazo para "¿El pedido se reserva?" de esta nota
sigue la versión del dueño (sin "reservado"), no la nota de normalización
editada. Esta contradicción coincide con `PED-05` en
`docs/12_PENDIENTES.md` (todavía abierto, CRÍTICA) y no se resuelve acá —
el dueño debe decidir cuál de las dos versiones vale antes de aplicar el
texto.

## Mantenimiento de esta nota

Actualizar esta sección cuando se apliquen los cambios de contenido del
bot en YCloud, se configure el Data Connector, o se decida activar el bot.
