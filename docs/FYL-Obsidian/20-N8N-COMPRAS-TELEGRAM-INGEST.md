# N8N — Workflow Compras por Telegram (Proveedor Ingest)

> Última actualización: 2026-04-24 (RLS `proveedores` + panel Pedidos admin)
> Agente que documentó: Claude (sesión activa tras múltiples iteraciones de debug)
> Estado: **parcialmente funcional** — foto y audio procesan; creación de `purchase_orders` depende del pipeline y reglas; **admin y RLS** alineados para ver ingests/pedidos con permiso `proveedores` (ver §6 y §14)

---

## 1. Descripción del sistema

El workflow `Proveedores_Telegram_Ingest_marcadores` (ID: `AT0MYbvSXbm8h1oA`) en **n8n Cloud** (`gonzidel.app.n8n.cloud`) recibe mensajes de Telegram (foto, audio, texto) y los convierte en pedidos de compra en Supabase.

**Flujo general:**
```
Telegram → n8n → OpenAI (Vision/Whisper) → Supabase (purchase_*)
```

---

## 2. Tablas Supabase involucradas

| Tabla | Propósito |
|-------|-----------|
| `supplier_message_ingest` | Registro de cada mensaje recibido por Telegram. Campo `openai_response_raw` guarda la respuesta cruda de OpenAI. Campo `has_actionable_order` indica si OpenAI encontró datos de pedido. |
| `purchase_suppliers` | Proveedores de compra. Columnas: `id`, `display_name`, `slug`, `aliases[]`, `active`. |
| `purchase_supplier_rule_versions` | Reglas JSON versionadas por proveedor. Columnas: `id`, `supplier_id`, `version`, `is_active`, `rules jsonb`. |
| `purchase_seasons` | Temporadas activas. Columnas: `id`, `label`, `active`. |
| `purchase_orders` | Cabecera de pedido. Ref a `supplier_id`, `season_id`. |
| `purchase_order_lines` | Líneas del pedido. |

**RLS (lectura admin JWT, no service_role n8n):** las políticas de `supplier_message_*` y `purchase_*` usan la función **`public.purchase_module_admin_auth(auth.uid())`**: permite **`is_super_admin`** o colaborador con fila en **`admin_permissions`** con `permission_key = 'proveedores'` y algún `can_view` / `can_edit` / `can_delete`. Definición y políticas en SQL canónico: **`supabase/canonical/180_supplier_telegram_ingest.sql`** (ingest) y **`supabase/canonical/181_purchase_suppliers_module.sql`** (`purchase_*`). **Hay que re-ejecutar esos scripts en Supabase** si la base ya tenía las políticas viejas (`exists(select 1 from admins…)` sin chequear permiso).

**RPCs usadas:**
- `purchase_resolve_supplier(p_hint text)` → resuelve proveedor por `slug`, `display_name` o `aliases[]`
- `purchase_compute_lines(p_supplier_id, p_rules_version_id, p_items)` → calcula líneas del pedido
- `purchase_create_rule_version(p_supplier_id, p_rules jsonb)` → crea nueva versión de reglas (desde admin UI)

---

## 3. Arquitectura del workflow n8n

### 3.1 Nodos principales (en orden de ejecución)

```
Telegram_Trigger
  → Code_NormalizarMensaje
  → HTTP_GET_Ingest           (idempotencia — busca si ya procesamos este message_id)
  → Code_PostGET_Idempotencia
  → IF_YaProcesado            (si ya existe → skip)
  → HTTP_UpsertStub_Ingest    (crea/actualiza registro en supplier_message_ingest)
  → Code_JoinIngestId
  → IF_MessageIsText ──► [path texto]
  → IF_MessageIsVoice ──► [path audio]
  → IF_MessageIsPhoto ──► [path foto]
```

**Path Foto:**
```
HTTP_TG_GetFile_Photo        (descarga binario de Telegram)
  → Code_Foto_Base64yTexto   (convierte binario → base64) ← FOCO PRINCIPAL DE DEBUG
  → HTTP_OpenAI_Interpretar  (Vision API gpt-4o-mini)
  → [continúa igual que audio/texto]
```

**Path Audio:**
```
HTTP_TG_Download_Voice
  → HTTP_OpenAI_Whisper      (transcripción)
  → [continúa]
```

**Path común (post-OpenAI):**
```
Code_OpenAI_Result           (parsea respuesta, extrae supplier_hint, items[])
  → HTTP_GET_ActiveRuleVersion  (busca reglas activas del proveedor)
  → HTTP_GET_DefaultSeason      (obtiene temporada activa)
  → HTTP_RPC_ResolveSupplier    (resuelve supplier_id desde hint)
  → HTTP_RPC_ComputeLines       (calcula líneas con precios/unidades)
  → HTTP_POST_PurchaseOrder     (crea purchase_order)
  → HTTP_POST_PurchaseOrderLines (crea líneas)
  → HTTP_PATCH_Ingest_Final     (marca ingest como procesado)
```

---

## 4. Bug crítico resuelto: doble `/rest/v1/` en URLs

### Causa raíz
Los nodos HTTP fueron creados con un patrón de URL tipo:
```javascript
{{ "https://dtfznewwvsadkorxwzft.supabase.co/rest/v1/".replace(/\/$/, "") + "/rest/v1/tabla" }}
```
Esto genera: `https://.../rest/v1/rest/v1/tabla` → Supabase devuelve `Invalid path`.

### Nodos corregidos (todos via REST API PATCH)

| Nodo | URL correcta aplicada |
|------|-----------------------|
| `HTTP_RPC_ResolveSupplier` | `.../rest/v1/rpc/purchase_resolve_supplier` |
| `HTTP_RPC_ComputeLines` | `.../rest/v1/rpc/purchase_compute_lines` |
| `HTTP_POST_PurchaseOrder` | `.../rest/v1/purchase_orders` |
| `HTTP_POST_PurchaseOrderLines` | `.../rest/v1/purchase_order_lines` |
| `HTTP_GET_ActiveRuleVersion` | `.../rest/v1/purchase_supplier_rule_versions?supplier_id=eq.{{$json["supplier_id"]}}&is_active=eq.true&select=id,version` |
| `HTTP_GET_DefaultSeason` | `.../rest/v1/purchase_seasons?active=eq.true&order=created_at.desc&limit=1&select=id,label` |

**Método de corrección:** REST API PATCH directamente a n8n Cloud:
```javascript
fetch('/rest/workflows/AT0MYbvSXbm8h1oA', { credentials: 'include' })
  .then(r => r.json())
  .then(wf => {
    const nodes = wf.data.nodes.map(n =>
      n.id === 'NODE_ID' ? { ...n, parameters: { ...n.parameters, url: 'URL_CORRECTA' } } : n
    );
    return fetch('/rest/workflows/AT0MYbvSXbm8h1oA', {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...wf.data, nodes })
    });
  })
```

---

## 5. Bug crítico resuelto: binario Telegram en n8n Cloud (modo filesystem-v2)

### Síntoma
`Code_Foto_Base64yTexto` fallaba al intentar convertir la foto a base64.

### Causa raíz (hallada tras múltiples ejecuciones de debug)
En n8n Cloud, los binarios NO se almacenan en memoria. La estructura de `items[0].binary.data` es:
```
{
  mimeType: "application/octet-stream",   // ← siempre es esto para fotos de Telegram
  fileExtension: "jpg",
  data: <filesystem-v2 reference object>, // ← NO es base64, es un handle interno
  directory: "https://api.telegram.org/file/bot{TOKEN}/photos/file_N.jpg",  // ← URL REAL
  fileName: "file_N.jpg",
  id: "filesystem-v2",                    // ← modo de storage, NO un UUID real
  fileSize: <número>,
  bytes: <número>                         // ← solo el tamaño, NO los bytes reales
}
```

**`this.helpers.getBinaryDataBuffer(items[0], 'data')` falla** porque en n8n cloud el archivo ya no existe en disco cuando se intenta leer (o el storage está en S3 y el path no es local).

### Solución aplicada (nodo `Code_Foto_Base64yTexto`, ID: `ea87e67c-3a33-49e0-9ea3-0112e2651d57`)
```javascript
const base = $('Code_JoinIngestId').first().json;
const bd = items[0].binary && items[0].binary.data;
let buf = null;

// Try 1: getBinaryDataBuffer (funciona en n8n self-hosted)
try {
  buf = await this.helpers.getBinaryDataBuffer(items[0], 'data');
} catch(_) {
  // Try 2: bd.directory contiene la URL completa de Telegram — descargar directamente
  const url = bd && bd.directory && bd.directory.startsWith('http') ? bd.directory : null;
  if (!url) throw new Error('no_url|dir=' + (bd && bd.directory));
  const resp = await this.helpers.httpRequest({
    method: 'GET', url: url, encoding: 'arraybuffer', returnFullResponse: false
  });
  buf = Buffer.from(resp);
}

if (!buf || buf.length < 100) throw new Error('empty_buf|len=' + (buf && buf.length));

const b64 = Buffer.from(buf).toString('base64');
const mime = (bd && bd.mimeType && bd.mimeType.startsWith('image/')) ? bd.mimeType : 'image/jpeg';

return [{ json: {
  ...base,
  transcript_text: null,
  openai_input_text: (base.caption_text || ''),
  image_base64: b64,
  image_mime: mime
} }];
```

**Clave:** `bd.directory` = URL completa de Telegram. `bd.id` = string `"filesystem-v2"` (no es un ID).

---

## 6. Módulo admin `compras-proveedores.html/.js`

### Ubicación
`admin/compras-proveedores.html` + `admin/compras-proveedores.js`

### 6.1 Panel «Pedidos» (cambio 2026-04-24)

- **Pestaña por defecto:** al abrir la página, la primera pestaña activa es **Pedidos** (antes era Temporadas; muchos no llegaban a ver `purchase_orders`).
- **Tabla `purchase_orders`:** el `select` incluye join a **`purchase_suppliers(display_name)`** y **`purchase_seasons(label)`**, columna **`status`**, y mensajes cuando no hay filas (explica que el pedido vive en `purchase_orders`, no solo en ingest).
- **Diagnóstico Telegram/n8n:** debajo, tabla de los últimos registros de **`supplier_message_ingest`** (`parsed_status`, `has_actionable_order`, `is_processed`, `parse_error` truncado con `title` completo). Sirve para ver **por qué no se creó** `purchase_orders` aunque el flujo n8n haya tocado el ingest.
- **Recargar:** el botón recarga **pedidos + ingests** (`loadOrdersPanel()`).

### Función crítica corregida: `buildBasicRulesFromForm()`
El JSON que genera para `purchase_supplier_rule_versions.rules` debe tener esta estructura:
```json
{
  "currency": "ARS",
  "default_discount_pct": 0,
  "units": {
    "par": { "pairs_per_unit": 1, "default_price_basis": "per_par", "match": ["par","pares","prs","pr"] },
    "tarea": { "pairs_per_unit": 24, "default_price_basis": "per_tarea", "allowed_price_bases": ["per_tarea","per_par"], "match": ["tarea","tareas","tar"] }
  }
}
```

**Bug previo:** usaba `unit_map` y `discount_pct_default` — incompatible con `purchase_compute_lines`.
**Corrección:** usa `units` y `default_discount_pct`.

---

## 7. Proveedores activos configurados (a 2026-04-24)

| display_name | slug | aliases principales |
|---|---|---|
| Cara Regina | cara-regina | cara regina, cara, regina |
| Donna | donna | donna, dona |
| Pied i Pedi | pied-i-pedi | piedi, pedi |
| Tezis | tezis | ale benites, ale, benitez |
| Runner | runner | runer, runner |
| Gurin | gurin | gurin, guri |
| Patito | patito | patito, pati |
| Rosalin | rosalin | (ver DB) |

---

## 8. Estado actual del flujo (2026-04-24)

### Lo que funciona ✅
- **Path texto**: no testeado pero no tiene bugs visibles
- **Path audio**: transcripción Whisper ✅ → parsing ✅ → `HTTP_GET_ActiveRuleVersion` ✅ (recién corregido) → pendiente test completo
- **Path foto**: descarga binario ✅ → conversión base64 ✅ → OpenAI Vision ✅ → parsing ✅ → pendiente test completo hasta crear pedido

### Lo que falta probar ⚠️
1. **Flujo audio completo** — ejecución 31 falló en `HTTP_GET_ActiveRuleVersion` (ya corregido). Falta verificar que `HTTP_GET_DefaultSeason`, `HTTP_RPC_ResolveSupplier`, `HTTP_RPC_ComputeLines`, `HTTP_POST_PurchaseOrder` funcionen encadenados.

2. **Foto con lista real** — la foto de la nota "Donna / 8800 azu 3 tareas" aún no fue procesada con el fix del binario activo.

3. **Creación del pedido** — ninguna ejecución llegó hasta `HTTP_POST_PurchaseOrder` exitosamente. La tabla `purchase_orders` está vacía.

### Diagnóstico de ejecución 29 (última exitosa, foto de prueba)
OpenAI respondió:
```json
{ "supplier_hint": null, "has_actionable_order": false, "confidence": 0.6, "items": [] }
```
→ foto enviada sin contenido de pedido real. El workflow terminó correctamente pero no creó pedido.

---

## 9. Cómo diagnosticar ejecuciones fallidas

### Navegar al debug de una ejecución
```
https://gonzidel.app.n8n.cloud/workflow/AT0MYbvSXbm8h1oA/debug/{execution_id}
```

### Consultar el registro de ingest en Supabase
```javascript
window.supabase
  .from('supplier_message_ingest')
  .select('*')
  .order('created_at', { ascending: false })
  .limit(1)
  .then(({data}) => console.log(data[0]));
```
Campos clave: `has_actionable_order`, `inferred_supplier_name`, `openai_result`, `openai_response_raw`, `parse_confidence`, `needs_review`.

### Ver pedidos creados
```javascript
window.supabase.from('purchase_orders').select('*').order('ordered_at', {ascending: false}).limit(10)
```

Equivalente operativo: abrir **`admin/compras-proveedores.html`** en la pestaña **Pedidos** (lista + últimos ingests).

---

## 10. IDs de nodos clave

| Nodo | ID |
|------|----|
| `Code_Foto_Base64yTexto` | `ea87e67c-3a33-49e0-9ea3-0112e2651d57` |
| `HTTP_GET_ActiveRuleVersion` | `138726d0-5b66-466c-93a2-f4417d21e384` |
| `HTTP_GET_DefaultSeason` | `9671a773-25fa-445f-beb8-385717e6970e` |

Para obtener todos los IDs:
```javascript
fetch('/rest/workflows/AT0MYbvSXbm8h1oA', { credentials: 'include' })
  .then(r => r.json())
  .then(wf => console.log(wf.data.nodes.map(n => ({name: n.name, id: n.id}))));
```

---

## 11. Infra y credenciales (referencias)

- **Supabase project**: `dtfznewwvsadkorxwzft`
- **n8n Cloud**: `gonzidel.app.n8n.cloud` — versión `2.16.2`
- **Workflow ID**: `AT0MYbvSXbm8h1oA`
- **Telegram bot token**: en el nodo `Telegram_Trigger` y en las URLs de descarga de archivos
- **Admin panel local**: `http://localhost:5500/admin/compras-proveedores.html`

---

## 12. Tareas pendientes para próxima sesión

- [ ] Enviar foto de la nota "Donna / 8800 azu 3 tareas" desde Telegram y verificar que se crea el pedido
- [ ] Verificar flujo audio completo con un audio del tipo "Donna, 3 tareas del 8800 azul a 8800 pesos"
- [ ] Confirmar que `HTTP_GET_DefaultSeason` lee la temporada correcta (columna `active` vs `is_active` — revisar nombre exacto)
- [ ] Verificar que `purchase_compute_lines` recibe el formato correcto de `items[]` desde `Code_OpenAI_Result`
- [ ] Revisar si `HTTP_GET_Ingest` y `HTTP_UpsertStub_Ingest` tienen el bug `.replace()` latente (funcionan ahora pero pueden romperse si cambia el env)
- [ ] Agregar manejo de error cuando `has_actionable_order = false` — actualmente termina silenciosamente, sería útil que el bot responda al usuario
- [ ] Verificar path texto completo

---

## 13. Notas técnicas adicionales

### Sobre `purchase_supplier_rule_versions.rules` (contrato JSON)
Ver `docs/PURCHASE_RULES_SCHEMA.md`. Estructura mínima requerida por `purchase_compute_lines`:
- `currency: string`
- `default_discount_pct: number`
- `units: { [unitName]: { pairs_per_unit, default_price_basis, match[] } }`

### Sobre el nodo `Code_Foto_Base64yTexto` y versiones de n8n
- **n8n self-hosted**: `getBinaryDataBuffer` funciona, el código tiene fallback
- **n8n cloud**: binarios en filesystem-v2, `directory` contiene la URL de Telegram
- Si n8n cloud cambia su storage (ej. migra a S3), el `directory` podría dejar de ser la URL de Telegram — en ese caso habría que usar el campo `id` con el endpoint `/rest/binary-data/{id}`

### Sobre el formato de la respuesta de OpenAI (Vision)
El prompt enviado a OpenAI espera un JSON con:
```json
{
  "supplier_hint": "string o null",
  "currency_hint": "string o null",
  "confidence": 0.0-1.0,
  "needs_review": boolean,
  "has_actionable_order": boolean,
  "items": [{ "description": "...", "qty": N, "unit": "...", "price": N }]
}
```
Si la foto no tiene texto legible de pedido → `has_actionable_order: false` y el workflow termina sin crear pedido (comportamiento correcto).

---

## 14. Cambio SQL + admin documentado aquí (2026-04-24)

Resumen para quien despliega o audita sin revisar el diff del repo:

| Área | Archivo(s) | Qué cambió |
|------|------------|------------|
| RLS ingest Telegram | `supabase/canonical/180_supplier_telegram_ingest.sql` | Políticas `supplier_message_ingest`, `supplier_orders`, `supplier_order_lines`: de «cualquier fila en `admins`» a **`purchase_module_admin_auth`** (permiso `proveedores` o super_admin). Función `create or replace` + `grant execute` a `authenticated` / `service_role`. |
| RLS compras `purchase_*` | `supabase/canonical/181_purchase_suppliers_module.sql` | Misma función **`purchase_module_admin_auth`**; políticas `purchase_*` renombradas a `*_module_all` y condición unificada. Drops de políticas legacy `*_admin_all` para reaplicar sin duplicados. |
| Admin UI | `admin/compras-proveedores.html`, `admin/compras-proveedores.js` | Pedidos como pestaña inicial; mensajes vacío/error; preview **`supplier_message_ingest`**; joins en query de pedidos. |

**Acción en Supabase:** volver a ejecutar **`180`** y luego **`181`** (o el equivalente en migraciones) sobre el proyecto donde corre n8n con **service_role** (n8n no se ve afectado por RLS JWT).
