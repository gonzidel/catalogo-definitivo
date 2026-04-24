/**
 * Genera workflows n8n compatibles con importación conservadora.
 *
 *   node scripts/build-n8n-proveedores-workflow.mjs
 *
 * Salidas:
 *   docs/n8n-proveedores-ingest-minimal.workflow.json  — solo rama texto (sin voz/foto)
 *   docs/n8n-proveedores-ingest.workflow.json         — texto + voz + foto (IF encadenados, sin Switch)
 *   docs/n8n-proveedores-ingest-minimal.placeholder.workflow.json — igual minimal, sin $env:
 *       reemplazá en el editor __SUPABASE_PROJECT_REF__, __SUPABASE_SERVICE_ROLE_JWT__,
 *       __TELEGRAM_BOT_TOKEN__, __OPENAI_API_KEY__ y luego importá (nunca commitees valores reales).
 *   docs/n8n-proveedores-ingest.placeholder.workflow.json — igual full, mismos marcadores.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outMinimal = path.join(root, "docs", "n8n-proveedores-ingest-minimal.workflow.json");
const outFull = path.join(root, "docs", "n8n-proveedores-ingest.workflow.json");
const outMinimalPh = path.join(root, "docs", "n8n-proveedores-ingest-minimal.placeholder.workflow.json");
const outFullPh = path.join(root, "docs", "n8n-proveedores-ingest.placeholder.workflow.json");

const SYS_PROMPT = [
  "Extraccion MINIMA de pedido de compras a proveedores (espanol). Devuelves SOLO JSON valido sin markdown.",
  "NO calcules pares, descuentos, netos ni totales. NO inventes datos.",
  "Raiz: supplier_hint (string|null), currency_hint (string|null), confidence (0-1), needs_review (bool), has_actionable_order (bool), items[].",
  "Cada item: raw_line_text, article_code, color, size, quantity (number), unit_text (literal del mensaje: tareas, pares, docenas...),",
  "unit_price (number|null), price_basis_hint: per_par|per_tarea|unknown, confidence, needs_review.",
  "Para message_type=photo prioriza OCR de texto MANUSCRITO (notas de proveedor en papel).",
  "Si hay encabezado con nombre de proveedor (ej: DONNA), usarlo como supplier_hint.",
  "Interpretar cantidades y unidades aunque haya ruido de OCR (ej: '3 tareas').",
  "No bloquear por ortografia imperfecta (ej: azil/azul): preservar en raw_line_text y completar campos con mejor lectura posible sin inventar.",
  "Si no hay pedido util: has_actionable_order false e items []. Si duda: null + needs_review true.",
].join(" ");

/** IDs estables (evita sorpresas en import / diffs). */
const I = {
  telegram: "prov_tg_trigger",
  norm: "prov_code_norm",
  httpGet: "prov_http_get_ing",
  postGet: "prov_post_get",
  ifSkip: "prov_if_skip",
  noopDup: "prov_noop_dup",
  noopTipo: "prov_noop_tipo",
  httpUpsert: "prov_http_upsert",
  join: "prov_join_ingest",
  ifText: "prov_if_is_text",
  ifVoice: "prov_if_is_voice",
  ifPhoto: "prov_if_is_photo",
  setText: "prov_set_text",
  httpGFV: "prov_http_gf_v",
  httpDLV: "prov_http_dl_v",
  whisper: "prov_http_whisper",
  voiceJoin: "prov_code_voice_j",
  httpGFP: "prov_http_gf_p",
  httpDLP: "prov_http_dl_p",
  codePhoto: "prov_code_photo",
  openaiBody: "prov_code_oai_body",
  openaiHttp: "prov_http_oai",
  validate: "prov_code_validate",
  ifOrder: "prov_if_order",
  rpcResolve: "prov_http_rpc_res",
  postResolve: "prov_code_post_res",
  ifResOk: "prov_if_res_ok",
  getRules: "prov_http_rules",
  mergeRules: "prov_code_merge_rules",
  ifRulesOk: "prov_if_rules_ok",
  rpcCompute: "prov_http_rpc_comp",
  postCompute: "prov_code_post_comp",
  ifCompOk: "prov_if_comp_ok",
  getSeason: "prov_http_season",
  buildOrd: "prov_code_build_ord",
  postOrd: "prov_http_post_ord",
  mergeOrd: "prov_code_merge_ord",
  ifOrdPost: "prov_if_ord_post",
  buildLines: "prov_code_build_lines",
  postLines: "prov_http_post_lines",
  afterLines: "prov_code_after_lines",
  patchCode: "prov_code_patch",
  patchHttp: "prov_http_patch",
};

/**
 * URLs Supabase en una sola expresión ={{ ... }}.
 * @param {"env"|"placeholder"} mode
 */
function buildSupabaseUrls(mode) {
  const base =
    mode === "placeholder"
      ? '"https://__SUPABASE_PROJECT_REF__.supabase.co"'
      : '($env.SUPABASE_URL || "")';
  /** Evita /rest/v1/rest/v1/ si SUPABASE_URL o la base ya traen /rest/v1 al final. */
  const b = `${base}.replace(/\\/$/, "").replace(/\\/rest\\/v1\\/?$/, "")`;
  return {
    getIngest: `={{ ${b} + "/rest/v1/supplier_message_ingest?telegram_chat_id=eq." + $json["telegram_chat_id"] + "&telegram_message_id=eq." + $json["telegram_message_id"] + "&select=id,is_processed" }}`,
    upsertIngest: `={{ ${b} + "/rest/v1/supplier_message_ingest?on_conflict=telegram_chat_id,telegram_message_id" }}`,
    patchIngest: `={{ ${b} + "/rest/v1/supplier_message_ingest?id=eq." + $json["ingest_id"] }}`,
    rpcResolve: `={{ ${b} + "/rest/v1/rpc/purchase_resolve_supplier" }}`,
    getRules: `={{ ${b} + "/rest/v1/purchase_supplier_rule_versions?supplier_id=eq." + $json["supplier_id"] + "&is_active=eq.true&select=id,version" }}`,
    rpcCompute: `={{ ${b} + "/rest/v1/rpc/purchase_compute_lines" }}`,
    getSeason: `={{ ${b} + "/rest/v1/purchase_seasons?active=eq.true&order=created_at.desc&limit=1&select=id,label" }}`,
    postOrders: `={{ ${b} + "/rest/v1/purchase_orders" }}`,
    postLines: `={{ ${b} + "/rest/v1/purchase_order_lines" }}`,
  };
}

/** @param {"env"|"placeholder"} mode */
function httpHeadersJson(mode) {
  if (mode === "placeholder") {
    return {
      parameters: [
        { name: "apikey", value: "__SUPABASE_SERVICE_ROLE_JWT__" },
        { name: "Authorization", value: "Bearer __SUPABASE_SERVICE_ROLE_JWT__" },
        { name: "Content-Type", value: "application/json" },
      ],
    };
  }
  return {
    parameters: [
      { name: "apikey", value: "={{ $env.SUPABASE_SERVICE_ROLE_KEY }}" },
      { name: "Authorization", value: '={{ "Bearer " + $env.SUPABASE_SERVICE_ROLE_KEY }}' },
      { name: "Content-Type", value: "application/json" },
    ],
  };
}

/** Fragmento JS dentro de ={{ ... }} para el token del bot. */
function telegramTokenExpr(mode) {
  return mode === "placeholder" ? '"__TELEGRAM_BOT_TOKEN__"' : "$env.TELEGRAM_BOT_TOKEN";
}

/** Bearer OpenAI dentro de expresión n8n. */
function openaiBearerExpr(mode) {
  return mode === "placeholder"
    ? '={{ "Bearer " + "__OPENAI_API_KEY__" }}'
    : '={{ "Bearer " + $env.OPENAI_API_KEY }}';
}

function ifBool(id, name, position, leftValue, operation, singleValue = true) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
        conditions: [{ id: "c", leftValue, rightValue: "", operator: { type: "boolean", operation, singleValue } }],
        combinator: "and",
      },
      options: {},
    },
    id,
    name,
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position,
  };
}

function ifStringEq(id, name, position, leftValue, rightValue) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
        conditions: [
          {
            id: "c",
            leftValue,
            rightValue,
            operator: { type: "string", operation: "equals" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    id,
    name,
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position,
  };
}

const JOIN_SYNC = `const base = $('Code_PostGET_Idempotencia').first().json;
const row = items[0].json;
const arr = Array.isArray(row) ? row : [row];
const id = arr[0]?.id;
if (!id) throw new Error('ingest_upsert_sin_id: usar Prefer return=representation en HTTP_UpsertStub_Ingest');
return [{ json: { ...base, ingest_id: id } }];`;

const SYS_ESC = JSON.stringify(SYS_PROMPT);

const CODE_VALIDATE = `const base = $('Code_BuildOpenAIBody').first().json;
const resp = items[0].json;
const content = resp?.choices?.[0]?.message?.content;
if (!content) {
  const msg = resp?.error?.message || resp?.message || resp?.hint || 'openai_empty_or_error';
  return [{ json: {
    ingest_id: base.ingest_id,
    telegram_chat_id: base.telegram_chat_id,
    telegram_message_id: base.telegram_message_id,
    message_type: base.message_type,
    parse_error: String(msg),
    parsed_status: 'failed',
    needs_review: true,
    needs_review_source: 'orchestrator',
    supplier_hint: null,
    items: [],
    has_actionable_order: false,
    openai_model: 'gpt-4o',
    openai_response_raw: resp,
    openai_input_text: base.openai_input_text,
    transcript_text: base.transcript_text,
    caption_text: base.caption_text,
    raw_text: base.raw_text,
    telegram_update_raw: base.telegram_update_raw,
    _skip_order: true
  } }];
}
let parsed;
try {
  parsed = typeof content === 'string' ? JSON.parse(content) : content;
} catch (e) {
  return [{ json: {
    ingest_id: base.ingest_id,
    telegram_chat_id: base.telegram_chat_id,
    telegram_message_id: base.telegram_message_id,
    message_type: base.message_type,
    parse_error: String(e),
    parsed_status: 'failed',
    needs_review: true,
    needs_review_source: 'orchestrator',
    supplier_hint: null,
    items: [],
    has_actionable_order: false,
    openai_model: 'gpt-4o',
    openai_response_raw: resp,
    openai_input_text: base.openai_input_text,
    transcript_text: base.transcript_text,
    caption_text: base.caption_text,
    raw_text: base.raw_text,
    telegram_update_raw: base.telegram_update_raw,
    _skip_order: true
  } }];
}
if (!Array.isArray(parsed.items)) parsed.items = [];
for (const it of parsed.items) {
  if (!it.unit_text && it.unit) it.unit_text = it.unit;
}
if (!parsed.items || parsed.items.length === 0) parsed.has_actionable_order = false;
const hasOrder = parsed.has_actionable_order === true && parsed.items.length > 0;
const hintRaw = parsed.supplier_hint;
const hint = hintRaw != null ? String(hintRaw).trim() : '';
let needsReview = !!parsed.needs_review;
if (hasOrder && !hint) needsReview = true;
if (hasOrder) {
  for (const it of parsed.items) {
    const q = it.quantity;
    const qNum = typeof q === 'number' ? q : Number(q);
    if (!Number.isFinite(qNum) || qNum <= 0) {
      needsReview = true;
      it.needs_review = true;
    }
  }
}
let parsed_status = hasOrder ? 'parsed' : 'no_order_content';
if (needsReview) parsed_status = 'needs_review';
return [{ json: {
  ingest_id: base.ingest_id,
  telegram_chat_id: base.telegram_chat_id,
  telegram_message_id: base.telegram_message_id,
  message_type: base.message_type,
  parse_error: null,
  parsed_status,
  needs_review: needsReview,
  needs_review_source: needsReview ? (parsed.needs_review ? 'openai' : 'orchestrator') : null,
  supplier_hint: hint || null,
  items: parsed.items,
  currency_hint: parsed.currency_hint || null,
  confidence: parsed.confidence,
  has_actionable_order: hasOrder,
  openai_model: 'gpt-4o',
  openai_response_raw: resp,
  openai_input_text: base.openai_input_text,
  transcript_text: base.transcript_text,
  caption_text: base.caption_text,
  raw_text: base.raw_text,
  telegram_update_raw: base.telegram_update_raw,
  _skip_order: !hasOrder
} }];`;

const CODE_PATCH = `const ctx = $('Code_ValidarExtraccionCompras').first().json;
let purchase_supplier_id = null;
let orchestrator_fail = false;
let fail_reason = null;
try {
  const pr = $('Code_PostResolveSupplier').first().json;
  if (pr && pr.supplier_id) purchase_supplier_id = pr.supplier_id;
  if (pr && pr._resolve_ok === false) {
    orchestrator_fail = true;
    fail_reason = pr._resolve_error || 'resolve';
  }
} catch (e) {}
try {
  const mr = $('Code_MergeRulesAndBuildItems').first().json;
  if (mr && mr._rules_ok === false) {
    orchestrator_fail = true;
    fail_reason = 'no_active_rules';
  }
} catch (e) {}
try {
  const pc = $('Code_PostComputeLines').first().json;
  if (pc && pc._compute_ok === false) {
    orchestrator_fail = true;
    fail_reason = 'compute_lines_failed';
  }
} catch (e) {}
try {
  const br = $('Code_BuildPurchaseLineRows').first().json;
  if (br && br.supplier_id) purchase_supplier_id = br.supplier_id;
} catch (e) {}
try {
  const mor = $('Code_MergePostPurchaseOrder').first().json;
  if (mor && mor._purchase_post_failed) {
    orchestrator_fail = true;
    if (!fail_reason) fail_reason = 'purchase_order_post_failed';
  }
} catch (e) {}
try {
  const al = $('Code_AfterPostLinesCheck').first().json;
  if (al && al._lines_http_failed) {
    orchestrator_fail = true;
    fail_reason = 'purchase_lines_post_failed';
  }
} catch (e) {}
let parsed_status = ctx.parsed_status;
if (orchestrator_fail && ctx.has_actionable_order) parsed_status = 'needs_review';
const needs_review = !!ctx.needs_review || orchestrator_fail;
let purchaseSuccess = false;
try {
  const al = $('Code_AfterPostLinesCheck').first().json;
  const mor = $('Code_MergePostPurchaseOrder').first().json;
  if (mor && mor._purchase_post_failed === false && mor.order_id && al && al._lines_http_failed === false) {
    purchaseSuccess = true;
  }
} catch (e) {}
const terminalIngest = !ctx.has_actionable_order || ctx.parsed_status === 'failed' || !!ctx.parse_error;
let is_processed;
if (purchaseSuccess) is_processed = true;
else if (orchestrator_fail) is_processed = false;
else if (terminalIngest) is_processed = true;
else is_processed = true;
const patch = {
  raw_text: ctx.raw_text,
  transcript_text: ctx.transcript_text,
  caption_text: ctx.caption_text,
  openai_input_text: ctx.openai_input_text,
  openai_model: ctx.openai_model,
  openai_response_raw: ctx.openai_response_raw,
  parse_error: ctx.parse_error || (orchestrator_fail ? fail_reason : null),
  parse_confidence: typeof ctx.confidence === 'number' ? ctx.confidence : null,
  needs_review,
  has_actionable_order: ctx.has_actionable_order,
  inferred_supplier_name: ctx.supplier_hint || null,
  parsed_status,
  is_processed,
  purchase_supplier_id
};
return [{ json: { ingest_id: ctx.ingest_id, patch } }];`;

function buildPurchaseChainFromResolve(mode = "env") {
  const U = buildSupabaseUrls(mode);
  const H = httpHeadersJson(mode);
  return [
    {
      parameters: {
        method: "POST",
        url: U.rpcResolve,
        sendHeaders: true,
        headerParameters: {
          parameters: [
            ...H.parameters,
            { name: "Prefer", value: "return=representation" },
          ],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify({ p_hint: $json.supplier_hint }) }}",
        options: {},
      },
      id: I.rpcResolve,
      name: "HTTP_RPC_ResolveSupplier",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [3740, 300],
    },
    {
      parameters: {
        jsCode: `const ctx = $('Code_ValidarExtraccionCompras').first().json;
let res = items[0].json;
if (Array.isArray(res)) res = res[0];
if (res && typeof res.message === 'string' && res.code && res.ok !== true) {
  return [{ json: { ...ctx, supplier_id: null, _resolve_ok: false, _resolve_error: 'supabase_http', _resolve_detail: res } }];
}
const ok = !!(res && res.ok === true);
const supplier_id = ok ? res.supplier_id : null;
return [{ json: {
  ...ctx,
  supplier_id,
  _resolve_ok: ok,
  _resolve_error: ok ? null : (res && res.reason) || 'resolve_failed',
  _resolve_detail: res
}}];`,
      },
      id: I.postResolve,
      name: "Code_PostResolveSupplier",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [3960, 300],
    },
    ifBool(I.ifResOk, "IF_ResolveSupplierOk", [4180, 300], "={{ $json._resolve_ok }}", "true"),
    {
      parameters: {
        method: "GET",
        url: U.getRules,
        sendHeaders: true,
        headerParameters: { parameters: H.parameters },
        options: {},
      },
      id: I.getRules,
      name: "HTTP_GET_ActiveRuleVersion",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [4400, 220],
    },
    {
      parameters: {
        jsCode: `const ctx = $('Code_PostResolveSupplier').first().json;
const raw = items[0].json;
const rows = Array.isArray(raw) ? raw : [raw];
const first = rows[0];
if (first && typeof first.message === 'string' && first.code) {
  return [{ json: { ...ctx, rules_version_id: null, p_items: [], _rules_ok: false } }];
}
const rules_version_id = first?.id || null;
if (!rules_version_id) {
  return [{ json: { ...ctx, rules_version_id: null, p_items: [], _rules_ok: false } }];
}
const p_items = (ctx.items || []).map((it) => ({
  quantity: it.quantity,
  unit_text: it.unit_text,
  unit_price: it.unit_price == null ? null : Number(it.unit_price),
  price_basis_hint: it.price_basis_hint || 'unknown',
  article_code: it.article_code ?? null,
  color: it.color ?? null,
  size: it.size ?? null,
  raw_line_text: it.raw_line_text ?? null,
  confidence: it.confidence == null ? null : Number(it.confidence),
  needs_review: !!it.needs_review
}));
return [{ json: { ...ctx, rules_version_id, p_items, _rules_ok: true } }];`,
      },
      id: I.mergeRules,
      name: "Code_MergeRulesAndBuildItems",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [4620, 220],
    },
    ifBool(I.ifRulesOk, "IF_ActiveRulesOk", [4840, 220], "={{ $json._rules_ok }}", "true"),
    {
      parameters: {
        method: "POST",
        url: U.rpcCompute,
        sendHeaders: true,
        headerParameters: {
          parameters: [
            ...H.parameters,
            { name: "Prefer", value: "return=representation" },
          ],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody:
          "={{ JSON.stringify({ p_supplier_id: $json.supplier_id, p_rules_version_id: $json.rules_version_id, p_items: $json.p_items }) }}",
        options: {},
      },
      id: I.rpcCompute,
      name: "HTTP_RPC_ComputeLines",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [5060, 140],
    },
    {
      parameters: {
        jsCode: `const ctx = $('Code_MergeRulesAndBuildItems').first().json;
let comp = items[0].json;
if (Array.isArray(comp)) comp = comp[0];
if (comp && typeof comp.message === 'string' && comp.code && comp.ok !== true) {
  return [{ json: { ...ctx, compute: { ok: false, errors: [{ code: 'supabase_http' }] }, _compute_ok: false } }];
}
const ok = !!(comp && comp.ok === true);
return [{ json: { ...ctx, compute: comp, _compute_ok: ok } }];`,
      },
      id: I.postCompute,
      name: "Code_PostComputeLines",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [5280, 140],
    },
    ifBool(I.ifCompOk, "IF_ComputeLinesOk", [5500, 140], "={{ $json._compute_ok }}", "true"),
    {
      parameters: {
        method: "GET",
        url: U.getSeason,
        sendHeaders: true,
        headerParameters: { parameters: H.parameters },
        options: {},
      },
      id: I.getSeason,
      name: "HTTP_GET_DefaultSeason",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [5720, 100],
    },
    {
      parameters: {
        jsCode: `const ctx = $('Code_PostComputeLines').first().json;
const srows = Array.isArray(items[0].json) ? items[0].json : [items[0].json];
const season_id = srows[0]?.id || null;
const c = ctx.compute || {};
const totals = c.totals || {};
const linesArr = Array.isArray(c.lines) ? c.lines : [];
const anyLineReview = linesArr.some((l) => l && l.needs_review === true);
const needs_review = !!ctx.needs_review || anyLineReview;
let needs_review_source = null;
if (anyLineReview) needs_review_source = 'rpc';
else if (ctx.needs_review) needs_review_source = ctx.needs_review_source || 'openai';
const order_payload = {
  ingest_id: ctx.ingest_id,
  supplier_id: ctx.supplier_id,
  season_id,
  status: 'open',
  needs_review,
  needs_review_source,
  review_reason: anyLineReview ? 'line_compute_or_missing_price' : null,
  notes: null,
  total_gross: totals.total_gross ?? null,
  total_discount: totals.total_discount ?? null,
  total_net: totals.total_net ?? null,
  total_estimated_pairs: totals.total_estimated_pairs ?? null
};
return [{ json: { ...ctx, season_id, order_payload, compute: c } }];`,
      },
      id: I.buildOrd,
      name: "Code_BuildPurchaseOrderPayload",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [5940, 100],
    },
    {
      parameters: {
        method: "POST",
        url: U.postOrders,
        sendHeaders: true,
        headerParameters: {
          parameters: [...H.parameters, { name: "Prefer", value: "return=representation" }],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify($json.order_payload) }}",
        options: {},
      },
      id: I.postOrd,
      name: "HTTP_POST_PurchaseOrder",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [6160, 100],
    },
    {
      parameters: {
        jsCode: `const ctx = $('Code_BuildPurchaseOrderPayload').first().json;
const row = items[0].json;
const r = Array.isArray(row) ? row[0] : row;
if (r && typeof r.message === 'string' && r.code) {
  return [{ json: { ...ctx, order_id: null, _purchase_post_failed: true, _purchase_post_detail: r } }];
}
if (!r?.id) {
  return [{ json: { ...ctx, order_id: null, _purchase_post_failed: true, _purchase_post_detail: r } }];
}
return [{ json: { ...ctx, order_id: r.id, _purchase_post_failed: false, _purchase_post_detail: null } }];`,
      },
      id: I.mergeOrd,
      name: "Code_MergePostPurchaseOrder",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [6270, 100],
    },
    ifBool(I.ifOrdPost, "IF_PurchaseOrderPostOk", [6380, 100], "={{ $json._purchase_post_failed }}", "false"),
    {
      parameters: {
        jsCode: `const ctx = $('Code_MergePostPurchaseOrder').first().json;
const orderId = ctx.order_id;
if (!orderId) throw new Error('sin_purchase_order_id');
const linesArr = Array.isArray(ctx.compute?.lines) ? ctx.compute.lines : [];
const lines_payload = linesArr.map((l, idx) => ({
  order_id: orderId,
  line_index: idx,
  raw_line_text: l.raw_line_text,
  article_code: l.article_code,
  color: l.color,
  size: l.size,
  unit_text: l.unit_text,
  normalized_unit_code: l.normalized_unit_code,
  qty_ordered: l.qty_ordered,
  unit_price: l.unit_price,
  currency: l.currency,
  price_basis_hint: l.price_basis_hint,
  price_basis_resolved: l.price_basis_resolved,
  estimated_pairs: l.estimated_pairs,
  gross_amount: l.gross_amount,
  discount_pct_applied: l.discount_pct_applied,
  discount_amount: l.discount_amount,
  net_amount: l.net_amount,
  rules_version_id: l.rules_version_id,
  calculation_snapshot: l.calculation_snapshot,
  needs_review: l.needs_review,
  needs_review_source: l.needs_review_source,
  review_reason: l.review_reason,
  parse_confidence: l.parse_confidence
}));
return [{ json: { ...ctx, order_id: orderId, lines_payload } }];`,
      },
      id: I.buildLines,
      name: "Code_BuildPurchaseLineRows",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [6500, 60],
    },
    {
      parameters: {
        method: "POST",
        url: U.postLines,
        sendHeaders: true,
        headerParameters: {
          parameters: [...H.parameters, { name: "Prefer", value: "return=minimal" }],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify($json.lines_payload) }}",
        options: {},
      },
      id: I.postLines,
      name: "HTTP_POST_PurchaseOrderLines",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [6720, 60],
    },
    {
      parameters: {
        jsCode: `const j = items[0].json;
let lines_http_failed = false;
if (j && typeof j.code === 'string' && typeof j.message === 'string' && j.ok !== true) lines_http_failed = true;
return [{ json: { _lines_http_failed: lines_http_failed, _lines_http_detail: j } }];`,
      },
      id: I.afterLines,
      name: "Code_AfterPostLinesCheck",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [6840, 60],
    },
  ];
}

function buildCoreIngestNodes(mode = "env") {
  const U = buildSupabaseUrls(mode);
  const H = httpHeadersJson(mode);
  return [
    {
      parameters: { updates: ["message"] },
      id: I.telegram,
      name: "Telegram_Trigger",
      type: "n8n-nodes-base.telegramTrigger",
      typeVersion: 1,
      position: [0, 300],
      credentials: {},
    },
    {
      parameters: {
        jsCode: `const u = items[0].json;
const m = u.message || u.edited_message || {};
const chatId = m.chat?.id;
const messageId = m.message_id;
if (!chatId || !messageId) {
  return [{ json: { error: 'no_message', raw: u } }];
}
let message_type = 'other';
const raw_text = m.text ?? null;
const caption_text = m.caption ?? null;
const voice_file_id = m.voice?.file_id ?? null;
const photo_file_id = (m.photo && m.photo.length) ? m.photo[m.photo.length - 1].file_id : null;
if (raw_text && !m.photo && !m.voice) message_type = 'text';
else if (voice_file_id) message_type = 'voice';
else if (photo_file_id) message_type = 'photo';
return [{ json: {
  telegram_chat_id: chatId,
  telegram_message_id: messageId,
  message_type,
  raw_text,
  caption_text,
  voice_file_id,
  photo_file_id,
  telegram_update_raw: u,
  mime_type: m.voice?.mime_type || null
} }];`,
      },
      id: I.norm,
      name: "Code_NormalizarMensaje",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [220, 300],
    },
    {
      parameters: {
        method: "GET",
        url: U.getIngest,
        sendHeaders: true,
        headerParameters: { parameters: H.parameters },
        options: {},
      },
      id: I.httpGet,
      name: "HTTP_GET_Ingest",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [440, 300],
      /** Sin esto, respuesta [] no genera items y el Code siguiente no recibe entrada (n8n #16163). */
      alwaysOutputData: true,
    },
    {
      parameters: {
        jsCode: `const base = $('Code_NormalizarMensaje').first().json;
if (base.error) return [{ json: { ...base, _skip: true, _reason: 'bad_normalize' } }];

function ingestRowsFromJson(j) {
  if (j === undefined || j === null) return [];
  if (Array.isArray(j)) return j;
  if (typeof j === 'object' && j !== null && (j.id !== undefined || j.is_processed !== undefined) && !Array.isArray(j)) {
    if (typeof j.message === 'string' && j.code !== undefined && j.id === undefined) return [];
    return [j];
  }
  return [];
}

function collectRowsFromItems(arr) {
  const out = [];
  for (const it of arr) {
    for (const r of ingestRowsFromJson(it.json)) out.push(r);
  }
  return out;
}

let rows = collectRowsFromItems(items);
if (!rows.length) {
  try {
    rows = collectRowsFromItems($('HTTP_GET_Ingest').all());
  } catch (e) {
    rows = [];
  }
}

if (rows.length && rows[0].is_processed === true) {
  return [{ json: { ...base, _skip: true, _reason: 'already_processed', _ingest_id: rows[0].id } }];
}
return [{ json: { ...base, _skip: false, _ingest_id: rows[0]?.id || null } }];`,
      },
      id: I.postGet,
      name: "Code_PostGET_Idempotencia",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [660, 300],
    },
    ifBool(I.ifSkip, "IF_YaProcesado", [880, 300], "={{ $json._skip }}", "true"),
    { parameters: {}, id: I.noopDup, name: "NoOp_SalirDuplicado", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [1100, 160] },
    { parameters: {}, id: I.noopTipo, name: "NoOp_TipoNoSoportado", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [1540, 520] },
    {
      parameters: {
        method: "POST",
        url: U.upsertIngest,
        sendHeaders: true,
        headerParameters: {
          parameters: [
            ...H.parameters,
            { name: "Prefer", value: "resolution=merge-duplicates,return=representation" },
          ],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody:
          "={{ JSON.stringify({ telegram_chat_id: $json.telegram_chat_id, telegram_message_id: $json.telegram_message_id, message_type: $json.message_type, telegram_update_raw: $json.telegram_update_raw, parsed_status: 'received', is_processed: false }) }}",
        options: {},
      },
      id: I.httpUpsert,
      name: "HTTP_UpsertStub_Ingest",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [1100, 380],
    },
    {
      parameters: { jsCode: JOIN_SYNC },
      id: I.join,
      name: "Code_JoinIngestId",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1320, 380],
    },
  ];
}

function buildOpenAiNodes(mode = "env") {
  const U = buildSupabaseUrls(mode);
  const H = httpHeadersJson(mode);
  const bearer = openaiBearerExpr(mode);
  return [
    {
      parameters: {
        jsCode: `const SYS = ${SYS_ESC};
const j = items[0].json;
let userContent;
if (j.message_type === 'photo' && j.image_base64) {
  userContent = [
    { type: 'text', text: 'CONTEXTO message_type=photo. Texto/caption: ' + (j.openai_input_text || '') },
    { type: 'image_url', image_url: { url: 'data:' + (j.image_mime || 'image/jpeg') + ';base64,' + j.image_base64 } }
  ];
} else {
  const t = (j.openai_input_text || '') + (j.transcript_text ? ('\\n[transcripcion voz]: ' + j.transcript_text) : '');
  userContent = 'CONTEXTO message_type=' + j.message_type + '\\n' + t;
}
const openai_body = {
  model: 'gpt-4o',
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: SYS },
    { role: 'user', content: userContent }
  ]
};
return [{ json: { ...j, openai_body } }];`,
      },
      id: I.openaiBody,
      name: "Code_BuildOpenAIBody",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [2640, 300],
    },
    {
      parameters: {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: "Authorization", value: bearer },
            { name: "Content-Type", value: "application/json" },
          ],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify($json.openai_body) }}",
        options: {},
      },
      id: I.openaiHttp,
      name: "HTTP_OpenAI_Interpretar",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [2860, 300],
    },
    {
      parameters: { jsCode: CODE_VALIDATE },
      id: I.validate,
      name: "Code_ValidarExtraccionCompras",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [3080, 300],
    },
    ifBool(I.ifOrder, "IF_CrearPedido", [3300, 300], "={{ $json._skip_order }}", "false"),
    {
      parameters: { jsCode: CODE_PATCH },
      id: I.patchCode,
      name: "Code_BuildPatchIngestFinal",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [7000, 300],
    },
    {
      parameters: {
        method: "PATCH",
        url: U.patchIngest,
        sendHeaders: true,
        headerParameters: { parameters: H.parameters },
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify($json.patch) }}",
        options: {},
      },
      id: I.patchHttp,
      name: "HTTP_PATCH_Ingest_Final",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [7220, 300],
    },
  ];
}

function buildMediaNodesFull(mode = "env") {
  const tt = telegramTokenExpr(mode);
  const bearer = openaiBearerExpr(mode);
  return [
    ifStringEq(I.ifText, "IF_MessageIsText", [1540, 300], "={{ $json.message_type }}", "text"),
    {
      parameters: {
        jsCode: `const j = items[0].json;
const text = [j.raw_text, j.caption_text].filter(Boolean).join('\\n') || '';
return [{ json: { ...j, transcript_text: null, openai_input_text: text } }];`,
      },
      id: I.setText,
      name: "Set_TextoParaInterpretar",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1760, 200],
    },
    ifStringEq(I.ifVoice, "IF_MessageIsVoice", [1540, 380], "={{ $json.message_type }}", "voice"),
    {
      parameters: {
        method: "GET",
        url: `={{ "https://api.telegram.org/bot" + ${tt} + "/getFile?file_id=" + encodeURIComponent($json.voice_file_id) }}`,
        options: {},
      },
      id: I.httpGFV,
      name: "HTTP_TG_GetFile_Voice",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [1760, 360],
    },
    {
      parameters: {
        method: "GET",
        url: `={{ "https://api.telegram.org/file/bot" + ${tt} + "/" + ($json.result?.file_path || "") }}`,
        options: { response: { response: { responseFormat: "file" } } },
      },
      id: I.httpDLV,
      name: "HTTP_TG_Download_Voice",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [1980, 360],
    },
    {
      parameters: {
        method: "POST",
        url: "https://api.openai.com/v1/audio/transcriptions",
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: "Authorization", value: bearer }],
        },
        sendBody: true,
        contentType: "multipart-form-data",
        bodyParameters: {
          parameters: [
            { name: "model", value: "whisper-1" },
            { name: "file", parameterType: "formBinaryData", inputDataFieldName: "data" },
          ],
        },
        options: {},
      },
      id: I.whisper,
      name: "HTTP_OpenAI_Transcribe",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [2200, 360],
    },
    {
      parameters: {
        jsCode: `const base = $('Code_JoinIngestId').first().json;
const t = items[0].json.text || items[0].json.transcript || '';
return [{ json: { ...base, transcript_text: t, openai_input_text: t } }];`,
      },
      id: I.voiceJoin,
      name: "Code_TrasVoz_Unir",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [2420, 360],
    },
    ifStringEq(I.ifPhoto, "IF_MessageIsPhoto", [1540, 460], "={{ $json.message_type }}", "photo"),
    {
      parameters: {
        method: "GET",
        url: `={{ "https://api.telegram.org/bot" + ${tt} + "/getFile?file_id=" + encodeURIComponent($json.photo_file_id) }}`,
        options: {},
      },
      id: I.httpGFP,
      name: "HTTP_TG_GetFile_Photo",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [1760, 520],
    },
    {
      parameters: {
        method: "GET",
        url: `={{ "https://api.telegram.org/file/bot" + ${tt} + "/" + ($json.result?.file_path || "") }}`,
        options: { response: { response: { responseFormat: "file" } } },
      },
      id: I.httpDLP,
      name: "HTTP_TG_Download_Photo",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.1,
      position: [1980, 520],
    },
    {
      parameters: {
        jsCode: `const base = $('Code_JoinIngestId').first().json;
const bin = items[0].binary?.data;
if (!bin?.data) throw new Error('sin_binario_foto');
const mime = bin.mimeType || 'image/jpeg';
return [{ json: {
  ...base,
  transcript_text: null,
  openai_input_text: base.caption_text || '',
  image_base64: typeof bin.data === 'string' ? bin.data : Buffer.from(bin.data).toString('base64'),
  image_mime: mime
} }];`,
      },
      id: I.codePhoto,
      name: "Code_Foto_Base64yTexto",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [2200, 520],
    },
  ];
}

function connectionsMinimal() {
  return {
    Telegram_Trigger: { main: [[{ node: "Code_NormalizarMensaje", type: "main", index: 0 }]] },
    Code_NormalizarMensaje: { main: [[{ node: "HTTP_GET_Ingest", type: "main", index: 0 }]] },
    HTTP_GET_Ingest: { main: [[{ node: "Code_PostGET_Idempotencia", type: "main", index: 0 }]] },
    Code_PostGET_Idempotencia: { main: [[{ node: "IF_YaProcesado", type: "main", index: 0 }]] },
    IF_YaProcesado: {
      main: [
        [{ node: "NoOp_SalirDuplicado", type: "main", index: 0 }],
        [{ node: "HTTP_UpsertStub_Ingest", type: "main", index: 0 }],
      ],
    },
    HTTP_UpsertStub_Ingest: { main: [[{ node: "Code_JoinIngestId", type: "main", index: 0 }]] },
    Code_JoinIngestId: { main: [[{ node: "Set_TextoParaInterpretar", type: "main", index: 0 }]] },
    Set_TextoParaInterpretar: { main: [[{ node: "Code_BuildOpenAIBody", type: "main", index: 0 }]] },
    Code_BuildOpenAIBody: { main: [[{ node: "HTTP_OpenAI_Interpretar", type: "main", index: 0 }]] },
    HTTP_OpenAI_Interpretar: { main: [[{ node: "Code_ValidarExtraccionCompras", type: "main", index: 0 }]] },
    Code_ValidarExtraccionCompras: { main: [[{ node: "IF_CrearPedido", type: "main", index: 0 }]] },
    IF_CrearPedido: {
      main: [
        [{ node: "HTTP_RPC_ResolveSupplier", type: "main", index: 0 }],
        [{ node: "Code_BuildPatchIngestFinal", type: "main", index: 0 }],
      ],
    },
    ...connectionsPurchaseRest(),
    Code_BuildPatchIngestFinal: { main: [[{ node: "HTTP_PATCH_Ingest_Final", type: "main", index: 0 }]] },
  };
}

function connectionsPurchaseRest() {
  return {
    HTTP_RPC_ResolveSupplier: { main: [[{ node: "Code_PostResolveSupplier", type: "main", index: 0 }]] },
    Code_PostResolveSupplier: { main: [[{ node: "IF_ResolveSupplierOk", type: "main", index: 0 }]] },
    IF_ResolveSupplierOk: {
      main: [
        [{ node: "HTTP_GET_ActiveRuleVersion", type: "main", index: 0 }],
        [{ node: "Code_BuildPatchIngestFinal", type: "main", index: 0 }],
      ],
    },
    HTTP_GET_ActiveRuleVersion: { main: [[{ node: "Code_MergeRulesAndBuildItems", type: "main", index: 0 }]] },
    Code_MergeRulesAndBuildItems: { main: [[{ node: "IF_ActiveRulesOk", type: "main", index: 0 }]] },
    IF_ActiveRulesOk: {
      main: [
        [{ node: "HTTP_RPC_ComputeLines", type: "main", index: 0 }],
        [{ node: "Code_BuildPatchIngestFinal", type: "main", index: 0 }],
      ],
    },
    HTTP_RPC_ComputeLines: { main: [[{ node: "Code_PostComputeLines", type: "main", index: 0 }]] },
    Code_PostComputeLines: { main: [[{ node: "IF_ComputeLinesOk", type: "main", index: 0 }]] },
    IF_ComputeLinesOk: {
      main: [
        [{ node: "HTTP_GET_DefaultSeason", type: "main", index: 0 }],
        [{ node: "Code_BuildPatchIngestFinal", type: "main", index: 0 }],
      ],
    },
    HTTP_GET_DefaultSeason: { main: [[{ node: "Code_BuildPurchaseOrderPayload", type: "main", index: 0 }]] },
    Code_BuildPurchaseOrderPayload: { main: [[{ node: "HTTP_POST_PurchaseOrder", type: "main", index: 0 }]] },
    HTTP_POST_PurchaseOrder: { main: [[{ node: "Code_MergePostPurchaseOrder", type: "main", index: 0 }]] },
    Code_MergePostPurchaseOrder: { main: [[{ node: "IF_PurchaseOrderPostOk", type: "main", index: 0 }]] },
    IF_PurchaseOrderPostOk: {
      main: [
        [{ node: "Code_BuildPurchaseLineRows", type: "main", index: 0 }],
        [{ node: "Code_BuildPatchIngestFinal", type: "main", index: 0 }],
      ],
    },
    Code_BuildPurchaseLineRows: { main: [[{ node: "HTTP_POST_PurchaseOrderLines", type: "main", index: 0 }]] },
    HTTP_POST_PurchaseOrderLines: { main: [[{ node: "Code_AfterPostLinesCheck", type: "main", index: 0 }]] },
    Code_AfterPostLinesCheck: { main: [[{ node: "Code_BuildPatchIngestFinal", type: "main", index: 0 }]] },
  };
}

function connectionsFull() {
  return {
    Telegram_Trigger: { main: [[{ node: "Code_NormalizarMensaje", type: "main", index: 0 }]] },
    Code_NormalizarMensaje: { main: [[{ node: "HTTP_GET_Ingest", type: "main", index: 0 }]] },
    HTTP_GET_Ingest: { main: [[{ node: "Code_PostGET_Idempotencia", type: "main", index: 0 }]] },
    Code_PostGET_Idempotencia: { main: [[{ node: "IF_YaProcesado", type: "main", index: 0 }]] },
    IF_YaProcesado: {
      main: [
        [{ node: "NoOp_SalirDuplicado", type: "main", index: 0 }],
        [{ node: "HTTP_UpsertStub_Ingest", type: "main", index: 0 }],
      ],
    },
    HTTP_UpsertStub_Ingest: { main: [[{ node: "Code_JoinIngestId", type: "main", index: 0 }]] },
    Code_JoinIngestId: { main: [[{ node: "IF_MessageIsText", type: "main", index: 0 }]] },
    IF_MessageIsText: {
      main: [
        [{ node: "Set_TextoParaInterpretar", type: "main", index: 0 }],
        [{ node: "IF_MessageIsVoice", type: "main", index: 0 }],
      ],
    },
    Set_TextoParaInterpretar: { main: [[{ node: "Code_BuildOpenAIBody", type: "main", index: 0 }]] },
    IF_MessageIsVoice: {
      main: [
        [{ node: "HTTP_TG_GetFile_Voice", type: "main", index: 0 }],
        [{ node: "IF_MessageIsPhoto", type: "main", index: 0 }],
      ],
    },
    HTTP_TG_GetFile_Voice: { main: [[{ node: "HTTP_TG_Download_Voice", type: "main", index: 0 }]] },
    HTTP_TG_Download_Voice: { main: [[{ node: "HTTP_OpenAI_Transcribe", type: "main", index: 0 }]] },
    HTTP_OpenAI_Transcribe: { main: [[{ node: "Code_TrasVoz_Unir", type: "main", index: 0 }]] },
    Code_TrasVoz_Unir: { main: [[{ node: "Code_BuildOpenAIBody", type: "main", index: 0 }]] },
    IF_MessageIsPhoto: {
      main: [
        [{ node: "HTTP_TG_GetFile_Photo", type: "main", index: 0 }],
        [{ node: "NoOp_TipoNoSoportado", type: "main", index: 0 }],
      ],
    },
    HTTP_TG_GetFile_Photo: { main: [[{ node: "HTTP_TG_Download_Photo", type: "main", index: 0 }]] },
    HTTP_TG_Download_Photo: { main: [[{ node: "Code_Foto_Base64yTexto", type: "main", index: 0 }]] },
    Code_Foto_Base64yTexto: { main: [[{ node: "Code_BuildOpenAIBody", type: "main", index: 0 }]] },
    Code_BuildOpenAIBody: { main: [[{ node: "HTTP_OpenAI_Interpretar", type: "main", index: 0 }]] },
    HTTP_OpenAI_Interpretar: { main: [[{ node: "Code_ValidarExtraccionCompras", type: "main", index: 0 }]] },
    Code_ValidarExtraccionCompras: { main: [[{ node: "IF_CrearPedido", type: "main", index: 0 }]] },
    IF_CrearPedido: {
      main: [
        [{ node: "HTTP_RPC_ResolveSupplier", type: "main", index: 0 }],
        [{ node: "Code_BuildPatchIngestFinal", type: "main", index: 0 }],
      ],
    },
    ...connectionsPurchaseRest(),
    Code_BuildPatchIngestFinal: { main: [[{ node: "HTTP_PATCH_Ingest_Final", type: "main", index: 0 }]] },
  };
}

function buildMinimalWorkflow(mode = "env") {
  const setTextNode = {
    parameters: {
      jsCode: `const j = items[0].json;
const text = [j.raw_text, j.caption_text].filter(Boolean).join('\\n') || '';
return [{ json: { ...j, transcript_text: null, openai_input_text: text } }];`,
    },
    id: I.setText,
    name: "Set_TextoParaInterpretar",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1540, 300],
  };
  const nodes = [
    ...buildCoreIngestNodes(mode),
    setTextNode,
    ...buildOpenAiNodes(mode),
    ...buildPurchaseChainFromResolve(mode),
  ];
  return {
    name:
      mode === "placeholder"
        ? "Proveedores_Telegram_Ingest_MINIMAL_marcadores"
        : "Proveedores_Telegram_Ingest_MINIMAL",
    nodes,
    connections: connectionsMinimal(),
    active: false,
    settings: { executionOrder: "v1" },
  };
}

function buildFullWorkflow(mode = "env") {
  const nodes = [
    ...buildCoreIngestNodes(mode),
    ...buildMediaNodesFull(mode),
    ...buildOpenAiNodes(mode),
    ...buildPurchaseChainFromResolve(mode),
  ];
  return {
    name: mode === "placeholder" ? "Proveedores_Telegram_Ingest_marcadores" : "Proveedores_Telegram_Ingest",
    nodes,
    connections: connectionsFull(),
    active: false,
    settings: { executionOrder: "v1" },
  };
}

fs.mkdirSync(path.dirname(outMinimal), { recursive: true });
fs.writeFileSync(outMinimal, JSON.stringify(buildMinimalWorkflow("env"), null, 2), "utf8");
fs.writeFileSync(outFull, JSON.stringify(buildFullWorkflow("env"), null, 2), "utf8");
fs.writeFileSync(outMinimalPh, JSON.stringify(buildMinimalWorkflow("placeholder"), null, 2), "utf8");
fs.writeFileSync(outFullPh, JSON.stringify(buildFullWorkflow("placeholder"), null, 2), "utf8");
console.log("Wrote", outMinimal);
console.log("Wrote", outFull);
console.log("Wrote", outMinimalPh);
console.log("Wrote", outFullPh);
