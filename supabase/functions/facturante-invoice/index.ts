/**
 * Edge Function: facturante-invoice
 *
 * Emite una Factura B (Consumidor Final) en Facturante para un pedido enviado.
 *
 * Secrets requeridos en Supabase Dashboard → Project Settings → Edge Functions:
 *   FACTURANTE_USUARIO   → nombre de usuario Facturante
 *   FACTURANTE_HASH      → contraseña Facturante
 *   FACTURANTE_EMPRESA   → ID numérico de empresa (provisto por LinkSide)
 *   FACTURANTE_ENDPOINT  → URL SOAP, ej: http://testing.facturante.com/api/Comprobantes.svc
 *   FACTURANTE_PREFIJO   → punto de venta, ej: 0002
 *   FACTURANTE_WEBHOOK_SECRET → token para verificar webhooks entrantes
 *
 * Variables automáticas de Supabase Edge Functions:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "http://localhost:5500",
  "http://localhost:8080",
  "http://127.0.0.1:5500",
  "http://127.0.0.1:8080",
  "https://catalogo-fyl-test.web.app",
  "https://catalogo-fyl.web.app",
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Vary": "Origin",
  };
}

// ---------------------------------------------------------------------------
// Auth: verifica JWT de admin
// ---------------------------------------------------------------------------
async function assertAdmin(req: Request): Promise<string> {
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    throw new Response("Unauthorized: missing bearer token", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";

  const supabaseAuth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error: userError } = await supabaseAuth.auth.getUser();
  if (userError || !user) throw new Response("Unauthorized: invalid token", { status: 401 });

  const { data: adminRow, error: adminError } = await supabaseAuth
    .from("admins")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminError || !adminRow) throw new Response("Forbidden: admin required", { status: 403 });

  return authHeader;
}

// ---------------------------------------------------------------------------
// SOAP helpers
// ---------------------------------------------------------------------------
function esc(value: string | number | null | undefined): string {
  const s = String(value ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isoDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

interface InvoiceItem {
  detalle: string;
  codigo: string;
  cantidad: number;
  precioUnitario: number; // neto (sin IVA)
  iva: number;            // alícuota %
  gravado: boolean;
}

interface InvoicePayload {
  order_number: string;
  emitido_en: string;
  cliente: {
    razon_social: string;
    nro_documento: string;
    tipo_documento: number;
    tratamiento_impositivo: number;
    direccion_fiscal: string;
    localidad: string;
    provincia: string;
  };
  encabezado: {
    tipo: string;
    prefijo: string;
    fecha: string;
  };
  items: InvoiceItem[];
}

function buildCrearComprobanteSOAP(payload: InvoicePayload): string {
  const usuario = esc(Deno.env.get("FACTURANTE_USUARIO") || "");
  const hash = esc(Deno.env.get("FACTURANTE_HASH") || "");
  const empresa = esc(Deno.env.get("FACTURANTE_EMPRESA") || "0");
  const webhookUrl = esc(buildWebhookUrl());

  const { cliente, encabezado, items } = payload;

  const itemsXml = items.map(item => `
        <b:ComprobanteItem>
          <b:Bonificacion>0</b:Bonificacion>
          <b:Cantidad>${item.cantidad}</b:Cantidad>
          <b:Codigo>${esc(item.codigo)}</b:Codigo>
          <b:Detalle>${esc(item.detalle)}</b:Detalle>
          <b:Gravado>${item.gravado ? "true" : "false"}</b:Gravado>
          <b:IVA>${item.iva}</b:IVA>
          <b:PrecioUnitario>${item.precioUnitario.toFixed(2)}</b:PrecioUnitario>
        </b:ComprobanteItem>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:ns="http://www.facturante.com.API"
  xmlns:a="http://schemas.datacontract.org/2004/07/FacturanteMVC.API"
  xmlns:b="http://schemas.datacontract.org/2004/07/FacturanteMVC.API.DTOs">
  <soap:Body>
    <ns:CrearComprobante>
      <ns:request>
        <a:Autenticacion>
          <b:Empresa>${empresa}</b:Empresa>
          <b:Hash>${hash}</b:Hash>
          <b:Usuario>${usuario}</b:Usuario>
        </a:Autenticacion>
        <a:Cliente>
          <b:CondicionPago>1</b:CondicionPago>
          <b:Contacto>${esc(cliente.razon_social)}</b:Contacto>
          <b:DireccionFiscal>${esc(cliente.direccion_fiscal)}</b:DireccionFiscal>
          <b:EnviarComprobante>false</b:EnviarComprobante>
          <b:Localidad>${esc(cliente.localidad)}</b:Localidad>
          <b:NroDocumento>${esc(cliente.nro_documento)}</b:NroDocumento>
          <b:PercibeIIBB>false</b:PercibeIIBB>
          <b:PercibeIVA>false</b:PercibeIVA>
          <b:Provincia>${esc(cliente.provincia)}</b:Provincia>
          <b:RazonSocial>${esc(cliente.razon_social)}</b:RazonSocial>
          <b:TipoDocumento>${cliente.tipo_documento}</b:TipoDocumento>
          <b:TratamientoImpositivo>${cliente.tratamiento_impositivo}</b:TratamientoImpositivo>
        </a:Cliente>
        <a:Encabezado>
          <b:Bienes>1</b:Bienes>
          <b:CondicionVenta>1</b:CondicionVenta>
          <b:EnviarComprobante>false</b:EnviarComprobante>
          <b:FechaHora>${esc(encabezado.fecha)}</b:FechaHora>
          <b:ImporteImpuestosInternos>0</b:ImporteImpuestosInternos>
          <b:ImportePercepcionesMunic>0</b:ImportePercepcionesMunic>
          <b:Moneda>2</b:Moneda>
          <b:PercepcionIIBB>0</b:PercepcionIIBB>
          <b:PercepcionIVA>0</b:PercepcionIVA>
          <b:PorcentajeIIBB>0</b:PorcentajeIIBB>
          <b:Prefijo>${esc(encabezado.prefijo)}</b:Prefijo>
          <b:TipoComprobante>FB</b:TipoComprobante>
          <b:TipoDeCambio>1</b:TipoDeCambio>
        </a:Encabezado>
        <a:Items>${itemsXml}
        </a:Items>
        <a:WebHook>
          <b:Url>${webhookUrl}</b:Url>
        </a:WebHook>
      </ns:request>
    </ns:CrearComprobante>
  </soap:Body>
</soap:Envelope>`;
}

function buildWebhookUrl(): string {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const secret = Deno.env.get("FACTURANTE_WEBHOOK_SECRET") || "";
  // La URL de la Edge Function de Supabase + secret como query param
  const base = supabaseUrl.replace(/\/$/, "");
  return `${base}/functions/v1/facturante-webhook?secret=${encodeURIComponent(secret)}`;
}

// ---------------------------------------------------------------------------
// Parser de respuesta SOAP CrearComprobante
// ---------------------------------------------------------------------------
function parseCrearComprobanteResponse(xml: string): { estado: string; mensaje: string; idComprobante: number | null } {
  const estado = extractTag(xml, "Estado") ?? "";
  const mensaje = extractTag(xml, "Mensaje") ?? "";
  const idRaw = extractTag(xml, "IdComprobante");
  const idComprobante = idRaw ? parseInt(idRaw, 10) : null;
  return { estado, mensaje, idComprobante };
}

function extractTag(xml: string, tag: string): string | null {
  // Busca <Tag>value</Tag> o <ns:Tag>value</ns:Tag>
  const re = new RegExp(`<[^>:]*:?${tag}[^>]*>([^<]*)<`, "i");
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Cálculo IVA
// Los precios en FYL (price_snapshot) son FINALES (incluyen IVA 21%)
// Para Factura B necesitamos el neto: precioUnitario = precio / 1.21
// ---------------------------------------------------------------------------
function calcPrecioNeto(precioConIva: number): number {
  return Math.round((precioConIva / 1.21) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // 1. Verificar admin
  try {
    await assertAdmin(req);
  } catch (authResponse) {
    if (authResponse instanceof Response) {
      return new Response(await authResponse.text(), {
        status: authResponse.status,
        headers: corsHeaders,
      });
    }
    throw authResponse;
  }

  let body: { order_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { order_id } = body;
  if (!order_id) {
    return new Response(JSON.stringify({ error: "order_id requerido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Cliente con SERVICE_ROLE para operaciones DB sin RLS
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // -------------------------------------------------------------------------
  // 2. TRIPLE LOCK — Capa 3 DB: UPDATE atómico
  // Solo actualiza si invoice_status está en estado facturable
  // -------------------------------------------------------------------------
  const { data: lockData, error: lockError } = await supabase
    .from("orders")
    .update({ invoice_status: "processing" })
    .eq("id", order_id)
    .in("invoice_status", ["sin_facturar", "error"])
    .select("id")
    .maybeSingle();

  if (lockError) {
    console.error("❌ Error al bloquear pedido:", lockError);
    return new Response(
      JSON.stringify({ error: "Error interno al iniciar facturación" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!lockData) {
    // El UPDATE no afectó ninguna fila: ya está processing o approved
    // Verificar cuál es el estado actual para dar un mensaje claro
    const { data: currentOrder } = await supabase
      .from("orders")
      .select("invoice_status, invoice_number, invoice_prefix")
      .eq("id", order_id)
      .maybeSingle();

    const status = currentOrder?.invoice_status ?? "unknown";
    const msg = status === "approved"
      ? `Este pedido ya fue facturado (${currentOrder?.invoice_prefix}-${currentOrder?.invoice_number})`
      : status === "processing"
      ? "Este pedido ya está siendo procesado por Facturante"
      : "No se pudo iniciar la facturación";

    return new Response(
      JSON.stringify({ error: msg, invoice_status: status }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // -------------------------------------------------------------------------
  // 3. Obtener datos del pedido + items + cliente
  // -------------------------------------------------------------------------
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(`
      id,
      order_number,
      total_amount,
      sent_at,
      order_items (
        id,
        product_name,
        color,
        size,
        quantity,
        price_snapshot,
        status,
        sku
      ),
      customers (
        id,
        full_name,
        dni,
        customer_number,
        address,
        city,
        province
      )
    `)
    .eq("id", order_id)
    .maybeSingle();

  if (orderError || !order) {
    await rollbackToError(supabase, order_id, "Error al obtener datos del pedido");
    return new Response(
      JSON.stringify({ error: "No se encontró el pedido" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const customer = order.customers as Record<string, unknown>;
  if (!customer) {
    await rollbackToError(supabase, order_id, "El pedido no tiene cliente asociado");
    return new Response(
      JSON.stringify({ error: "El pedido no tiene cliente asociado" }),
      { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Filtrar items activos (excluir missing, cancelled, expired)
  const EXCLUDED_STATUSES = ["missing", "cancelled", "expired"];
  const activeItems = (order.order_items as Record<string, unknown>[]).filter(
    (item) => !EXCLUDED_STATUSES.includes(item.status as string),
  );

  if (activeItems.length === 0) {
    await rollbackToError(supabase, order_id, "El pedido no tiene ítems activos para facturar");
    return new Response(
      JSON.stringify({ error: "El pedido no tiene ítems activos para facturar" }),
      { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // -------------------------------------------------------------------------
  // 4. Resolver NroDocumento para Consumidor Final
  // Facturante requiere NroDocumento > 0. Si no hay DNI, usar customer_number.
  // -------------------------------------------------------------------------
  const rawDni = String(customer.dni ?? "").replace(/\D/g, "");
  const rawCustomerNumber = String(customer.customer_number ?? "0").replace(/\D/g, "");
  const nroDocumento = rawDni || rawCustomerNumber || "1";

  // -------------------------------------------------------------------------
  // 5. Construir items de factura
  // price_snapshot incluye IVA 21% → PrecioUnitario = price_snapshot / 1.21
  // -------------------------------------------------------------------------
  const invoiceItems: InvoiceItem[] = activeItems.map((item) => {
    const precioFinal = Number(item.price_snapshot ?? 0);
    const precioNeto = calcPrecioNeto(precioFinal);
    const productName = String(item.product_name ?? "Producto");
    const color = String(item.color ?? "");
    const size = String(item.size ?? "");
    const detalleParts = [productName, color, size].filter(Boolean);
    const detalle = detalleParts.join(" - ").substring(0, 250);
    const codigo = String(item.sku ?? item.id ?? "").substring(0, 20) || "SIN-SKU";

    return {
      detalle,
      codigo,
      cantidad: Number(item.quantity ?? 1),
      precioUnitario: precioNeto,
      iva: 21,
      gravado: true,
    };
  });

  // -------------------------------------------------------------------------
  // 6. Construir payload snapshot fiscal (inmutable)
  // -------------------------------------------------------------------------
  const prefijo = Deno.env.get("FACTURANTE_PREFIJO") || "0001";
  const fechaHora = isoDate(new Date());

  const invoicePayload: InvoicePayload = {
    order_number: String(order.order_number ?? ""),
    emitido_en: fechaHora,
    cliente: {
      razon_social: String(customer.full_name ?? "Consumidor Final"),
      nro_documento: nroDocumento,
      tipo_documento: 1, // DNI
      tratamiento_impositivo: 3, // Consumidor Final
      direccion_fiscal: String(customer.address ?? "Sin dirección"),
      localidad: String(customer.city ?? ""),
      provincia: String(customer.province ?? ""),
    },
    encabezado: {
      tipo: "FB",
      prefijo,
      fecha: fechaHora,
    },
    items: invoiceItems,
  };

  // -------------------------------------------------------------------------
  // 7. Llamar a Facturante: CrearComprobante
  // -------------------------------------------------------------------------
  const facturanteEndpoint = Deno.env.get("FACTURANTE_ENDPOINT") || "";
  if (!facturanteEndpoint) {
    await rollbackToError(supabase, order_id, "FACTURANTE_ENDPOINT no configurado");
    return new Response(
      JSON.stringify({ error: "Configuración de Facturante incompleta (endpoint)" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const soapXml = buildCrearComprobanteSOAP(invoicePayload);

  let soapResponse: Response;
  try {
    soapResponse = await fetch(facturanteEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": "http://www.facturante.com.API/IComprobantes/CrearComprobante",
      },
      body: soapXml,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (fetchErr) {
    const msg = `Error de red al contactar Facturante: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
    await rollbackToError(supabase, order_id, msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const responseXml = await soapResponse.text();
  console.log("📨 Facturante response status:", soapResponse.status);

  // -------------------------------------------------------------------------
  // 8. Parsear respuesta
  // -------------------------------------------------------------------------
  const parsed = parseCrearComprobanteResponse(responseXml);
  console.log("📋 Facturante resultado:", parsed);

  if (!parsed.idComprobante || parsed.estado?.toString() !== "0") {
    // Estado 0 = OK en Facturante; cualquier otro es error
    const errMsg = parsed.mensaje || `Error Facturante (estado: ${parsed.estado})`;
    await rollbackToError(supabase, order_id, errMsg);
    return new Response(
      JSON.stringify({ error: errMsg, facturante_estado: parsed.estado }),
      { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // -------------------------------------------------------------------------
  // 9. Guardar facturante_id + invoice_payload en DB
  //    invoice_status ya está en 'processing' desde el UPDATE atómico
  // -------------------------------------------------------------------------
  const { error: updateError } = await supabase
    .from("orders")
    .update({
      facturante_id: parsed.idComprobante,
      invoice_payload: invoicePayload,
    })
    .eq("id", order_id);

  if (updateError) {
    console.error("⚠️ Error al guardar facturante_id (la factura SÍ fue creada en Facturante):", updateError);
    // No hacer rollback: la factura existe en Facturante con ese ID
    // Loguear para recuperación manual
  }

  console.log(`✅ Factura creada: order=${order_id} facturante_id=${parsed.idComprobante}`);

  return new Response(
    JSON.stringify({
      success: true,
      invoice_status: "processing",
      facturante_id: parsed.idComprobante,
      message: "Factura enviada a AFIP para autorización. El resultado llegará vía webhook.",
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

// ---------------------------------------------------------------------------
// Helper: rollback invoice_status a 'error'
// ---------------------------------------------------------------------------
async function rollbackToError(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
  errorMsg: string,
): Promise<void> {
  console.error("🔴 Rollback a error:", errorMsg);
  await supabase
    .from("orders")
    .update({ invoice_status: "error", invoice_error: errorMsg })
    .eq("id", orderId);
}
