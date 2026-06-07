/**
 * Edge Function: facturante-webhook
 *
 * Receptor asíncrono del WebHook de Facturante.
 * Facturante llama a este endpoint (POST con XML) después de recibir
 * la respuesta de AFIP para un comprobante creado con CrearComprobante.
 *
 * El XML recibido contiene el DetalleComprobante con CAE, número, PDF, etc.
 *
 * Seguridad: se verifica el query param ?secret= contra FACTURANTE_WEBHOOK_SECRET.
 *
 * Secrets requeridos:
 *   FACTURANTE_WEBHOOK_SECRET  → token secreto compartido con facturante-invoice
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (automáticos en Edge Functions)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Estados finales de Facturante (EstadoConfirmado)
// ---------------------------------------------------------------------------
const ESTADO_OK = [2, 3, 4]; // ENVIANDO, SIN ENVIO, PROCESADO → approved
const ESTADO_ERROR = [6];    // ERROR EN COMPROBANTE → AFIP rechazó

// ---------------------------------------------------------------------------
// Parser XML mínimo (sin DOMParser en Deno)
// ---------------------------------------------------------------------------
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<[^>:]*:?${tag}[^>]*>([^<]*)<`, "i");
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

function parseWebhookXml(xml: string) {
  const idComprobante = extractTag(xml, "IdComprobante");
  const numero = extractTag(xml, "Numero");
  const prefijo = extractTag(xml, "Prefijo");
  const cae = extractTag(xml, "CAE");
  const urlPdf = extractTag(xml, "URLPDF");
  const fechaHoraCAE = extractTag(xml, "FechaHoraCAE");
  const estadoConfirmado = extractTag(xml, "EstadoConfirmado");
  const estadoComprobante = extractTag(xml, "EstadoComprobante");
  const mensajeAFIP = extractTag(xml, "MensajeAFIP");

  return {
    idComprobante: idComprobante ? parseInt(idComprobante, 10) : null,
    numero: numero ? parseInt(numero, 10) : null,
    prefijo: prefijo?.trim() || null,
    cae: cae ? BigInt(cae) : null,
    urlPdf: urlPdf || null,
    fechaHoraCAE: fechaHoraCAE || null,
    estadoConfirmado: estadoConfirmado ? parseInt(estadoConfirmado, 10) : null,
    estadoComprobante: estadoComprobante || null,
    mensajeAFIP: mensajeAFIP || null,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
serve(async (req: Request) => {
  // Solo POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Verificar secret en query param
  const url = new URL(req.url);
  const receivedSecret = url.searchParams.get("secret") || "";
  const expectedSecret = Deno.env.get("FACTURANTE_WEBHOOK_SECRET") || "";

  if (!expectedSecret || receivedSecret !== expectedSecret) {
    console.warn("⚠️ Webhook: secret inválido. Received:", receivedSecret.substring(0, 8) + "...");
    // Responder 200 igual para no alertar a un posible atacante (best practice)
    return new Response("OK", { status: 200 });
  }

  let xml: string;
  try {
    xml = await req.text();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  console.log("📥 Webhook Facturante recibido. Tamaño XML:", xml.length);

  const data = parseWebhookXml(xml);
  console.log("📋 Datos parseados:", JSON.stringify({
    idComprobante: data.idComprobante,
    numero: data.numero,
    prefijo: data.prefijo,
    estadoConfirmado: data.estadoConfirmado,
    estadoComprobante: data.estadoComprobante,
  }));

  if (!data.idComprobante) {
    console.error("❌ Webhook: no se encontró IdComprobante en el XML");
    return new Response("OK", { status: 200 }); // 200 para que Facturante no reintente
  }

  // Determinar invoice_status según EstadoConfirmado
  let newStatus: string;
  if (data.estadoConfirmado !== null && ESTADO_OK.includes(data.estadoConfirmado)) {
    newStatus = "approved";
  } else if (data.estadoConfirmado !== null && ESTADO_ERROR.includes(data.estadoConfirmado)) {
    newStatus = "error";
  } else {
    // Estado temporal (7=COMUNICACIÓN CON AFIP, 8=ESPERANDO CAE, etc.)
    // No actualizar todavía — esperar otro webhook
    console.log("⏳ Estado temporal, ignorando:", data.estadoConfirmado, data.estadoComprobante);
    return new Response("OK", { status: 200 });
  }

  // Construir el update en DB
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const updatePayload: Record<string, unknown> = {
    invoice_status: newStatus,
    invoice_error: newStatus === "error"
      ? `AFIP rechazó: ${data.mensajeAFIP || data.estadoComprobante || "Error desconocido"}`
      : null,
  };

  if (newStatus === "approved") {
    updatePayload.invoice_prefix = data.prefijo;
    updatePayload.invoice_number = data.numero;
    updatePayload.invoice_cae = data.cae?.toString() ?? null;
    updatePayload.invoice_pdf_url = data.urlPdf;
    updatePayload.invoice_created_at = data.fechaHoraCAE
      ? new Date(data.fechaHoraCAE).toISOString()
      : new Date().toISOString();
  }

  const { error: updateError } = await supabase
    .from("orders")
    .update(updatePayload)
    .eq("facturante_id", data.idComprobante);

  if (updateError) {
    console.error("❌ Error al actualizar order desde webhook:", updateError);
    // Aún así responder 200 para que Facturante no reintente indefinidamente
    return new Response("OK", { status: 200 });
  }

  console.log(`✅ Webhook procesado: facturante_id=${data.idComprobante} → ${newStatus}`);
  return new Response("OK", { status: 200 });
});
