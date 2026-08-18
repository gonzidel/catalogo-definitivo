import { Arca, FileSystemTicketStorage } from "@arcasdk/core";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import { withMutex } from "../utils/mutex";
import type { InvoiceItemRow, InvoicePdfInput } from "./pdfService";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

interface OrderItemInput {
  productName: string;
  quantity: number;
  priceSnapshot?: number;
  subtotalBase: number;
}

interface EmitirFacturaBody {
  orderId: string;
  orderNumber?: string | number;
  customerName: string;
  cuit?: string;
  address?: string;
  locality?: string;
  totalAmount: number;
  montoFacturar: number;
  tipoFactura: "A" | "B";
  orderItems: OrderItemInput[];
}

export interface EmitirFacturaResult {
  invoiceData: InvoicePdfInput;
  caeResult: { cae: string; caeFchVto: string };
  invoiceId: number;
  driveFileUrl: string | null;
}

let arcaInstance: Arca | null = null;

function getArca(): Arca {
  if (arcaInstance) return arcaInstance;

  const certPath = process.env.CERT_CRT_PATH;
  const keyPath = process.env.CERT_KEY_PATH;
  const ticketPath = process.env.TICKET_PATH;
  const cuit = Number(process.env.CUIT_EMISOR);

  if (!certPath || !keyPath || !ticketPath || !cuit) {
    throw new Error(
      "Faltan variables de entorno ARCA (CERT_CRT_PATH, CERT_KEY_PATH, TICKET_PATH, CUIT_EMISOR)"
    );
  }

  const production = process.env.ARCA_PRODUCTION === "true";

  const ticketStorage = new FileSystemTicketStorage({
    ticketPath,
    cuit,
    production,
  });

  arcaInstance = new Arca({
    cert: fs.readFileSync(certPath, "utf8"),
    key: fs.readFileSync(keyPath, "utf8"),
    cuit,
    production,
    ticketStorage,
  });

  return arcaInstance;
}

function getFechaArgentinaYYYYMMDD(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}${m}${d}`;
}

function buildItemsFacturados(
  orderItems: OrderItemInput[],
  montoFacturar: number,
  totalAmount: number
): InvoiceItemRow[] {
  const baseReparto = orderItems.reduce((s, i) => s + i.subtotalBase, 0);
  if (baseReparto === 0) {
    throw new Error(
      "El pedido no tiene productos activos (base de reparto = 0). No se puede facturar."
    );
  }

  const diffConTotal = Math.abs(baseReparto - totalAmount);
  if (diffConTotal > totalAmount * 0.05) {
    console.warn(
      `[factura] Base de reparto ($${baseReparto}) difiere >5% del total_amount ($${totalAmount}). Se usa la suma de items como base.`
    );
  }

  const itemsFacturados: InvoiceItemRow[] = orderItems.map((item) => {
    const proporcion = item.subtotalBase / baseReparto;
    const montoItem = montoFacturar * proporcion;
    const precioUnitario =
      Math.round((montoItem / item.quantity) * 100) / 100;
    const subtotal =
      Math.round(precioUnitario * item.quantity * 100) / 100;
    return {
      productName: item.productName,
      quantity: item.quantity,
      precioUnitario,
      subtotal,
    };
  });

  const sumaSubtotales = itemsFacturados.reduce((s, i) => s + i.subtotal, 0);
  const ajuste = Math.round((montoFacturar - sumaSubtotales) * 100) / 100;
  if (ajuste !== 0 && itemsFacturados.length > 0) {
    const last = itemsFacturados[itemsFacturados.length - 1];
    last.subtotal = Math.round((last.subtotal + ajuste) * 100) / 100;
  }

  return itemsFacturados;
}

export async function emitirFactura(
  body: EmitirFacturaBody,
  adminUserId: string
): Promise<EmitirFacturaResult> {
  const {
    orderNumber,
    customerName,
    cuit,
    address,
    locality,
    totalAmount,
    montoFacturar,
    tipoFactura,
    orderItems,
  } = body;

  const ptoVta = Number(process.env.PUNTO_VENTA) || 1;
  const esFacturaA = tipoFactura === "A";
  const cbteTipo = esFacturaA ? 1 : 6;
  const cbteLetra = esFacturaA ? "A" : "B";

  const docNroClean = String(cuit || "").replace(/\D/g, "");
  const docTipo =
    docNroClean.length === 11 ? 80 : docNroClean.length === 8 ? 96 : 99;

  return withMutex(`order-${body.orderId}`, async () => {
    const { data: existing } = await supabase
      .from("invoices")
      .select(
        `
        id, cae, cae_vto, cbte_nro, cbte_tipo, punto_venta, cbte_fecha,
        monto_facturado, total_amount,
        customer_name, cuit, doc_tipo, doc_nro, address, locality,
        drive_file_url
      `
      )
      .eq("order_id", body.orderId)
      .maybeSingle();

    if (existing) {
      const { data: savedItems, error: itemsErr } = await supabase
        .from("invoice_items")
        .select("product_name, quantity, unit_price, subtotal")
        .eq("invoice_id", existing.id);

      if (itemsErr) {
        throw new Error(
          `Error recuperando items de factura: ${itemsErr.message}`
        );
      }

      const monto = Number(existing.monto_facturado);
      const esFacturaA_ = existing.cbte_tipo === 1;

      return {
        invoiceData: {
          orderNumber: body.orderNumber,
          cbteNro: existing.cbte_nro,
          cbteTipo: existing.cbte_tipo,
          cbteLetra: esFacturaA_ ? "A" : "B",
          puntoVenta: existing.punto_venta,
          date: existing.cbte_fecha,
          esFacturaA: esFacturaA_,
          montoFacturar: monto,
          totalAmount: Number(existing.total_amount),
          // ARCA exige el desglose Neto/IVA siempre que ImpNeto > 0, sea
          // Factura A o B (error 10070 si no se manda) — no depende de esFacturaA_.
          importeNeto: Math.round((monto / 1.21) * 100) / 100,
          importeIva: Math.round((monto - monto / 1.21) * 100) / 100,
          customerName: existing.customer_name,
          cuit: existing.cuit ?? "",
          address: existing.address ?? "",
          locality: existing.locality ?? "",
          items: (savedItems ?? []).map((i) => ({
            productName: i.product_name,
            quantity: Number(i.quantity),
            precioUnitario: Number(i.unit_price),
            subtotal: Number(i.subtotal),
          })),
        },
        caeResult: { cae: existing.cae, caeFchVto: existing.cae_vto },
        invoiceId: existing.id,
        driveFileUrl: existing.drive_file_url ?? null,
      };
    }

    return withMutex(`${ptoVta}-${cbteTipo}`, async () => {
      const itemsFacturados = buildItemsFacturados(
        orderItems,
        montoFacturar,
        totalAmount
      );

      // ARCA exige el desglose Neto/IVA siempre que ImpNeto > 0, sea Factura
      // A o B (rechaza con error 10070 "objeto IVA es obligatorio" si no se
      // manda). La diferencia entre A y B es si se lo discrimina en el PDF
      // al cliente, no si se le declara a ARCA.
      const importeNeto = Math.round((montoFacturar / 1.21) * 100) / 100;
      const importeIva = Math.round((montoFacturar - importeNeto) * 100) / 100;

      const date = getFechaArgentinaYYYYMMDD();

      const UMBRAL_IDENTIFICACION = 78400;
      if (
        !esFacturaA &&
        docTipo === 99 &&
        montoFacturar > UMBRAL_IDENTIFICACION
      ) {
        throw new Error(
          `Monto $${montoFacturar} supera el umbral ($${UMBRAL_IDENTIFICACION}). Requerido DNI del comprador.`
        );
      }

      const arca = getArca();
      const lastVoucher = await arca.electronicBillingService.getLastVoucher(
        ptoVta,
        cbteTipo
      );
      const nextNro = lastVoucher.cbteNro + 1;

      const wsfePayload = {
        CantReg: 1,
        PtoVta: ptoVta,
        CbteTipo: cbteTipo,
        Concepto: 1,
        DocTipo: docTipo,
        DocNro: Number(docNroClean) || 0,
        CbteDesde: nextNro,
        CbteHasta: nextNro,
        CbteFch: date,
        ImpTotal: montoFacturar,
        ImpTotConc: 0,
        ImpNeto: importeNeto,
        ImpOpEx: 0,
        ImpIVA: importeIva,
        ImpTrib: 0,
        MonId: "PES",
        MonCotiz: 1,
        CondicionIVAReceptorId: esFacturaA ? 1 : 5,
        Iva: [{ Id: 5, BaseImp: importeNeto, Importe: importeIva }],
      };

      const result =
        await arca.electronicBillingService.createVoucher(wsfePayload);

      // Guardia: ARCA puede devolver un CAE vacío (ej. si hubo una observación
      // o rechazo parcial que no vino como excepción). No seguir adelante si
      // no hay un CAE real — evita guardar una "factura" sin CAE válido.
      if (!result.cae || !result.cae.trim()) {
        console.error(
          "[emitirFactura] ARCA devolvió CAE vacío. Respuesta cruda:",
          JSON.stringify(result.response)
        );
        throw new Error(
          `ARCA no devolvió un CAE válido para el comprobante ${nextNro} ` +
          `(PtoVta ${ptoVta}, CbteTipo ${cbteTipo}). Revisar observaciones en ` +
          `los logs del backend antes de reintentar — no se registró nada localmente.`
        );
      }

      const { data: invoiceRow, error: insertInvoiceErr } = await supabase
        .from("invoices")
        .insert({
          order_id: body.orderId,
          punto_venta: ptoVta,
          cbte_tipo: cbteTipo,
          cbte_nro: nextNro,
          cbte_fecha: date,
          cae: result.cae,
          cae_vto: result.caeFchVto,
          monto_facturado: montoFacturar,
          total_amount: totalAmount,
          customer_name: customerName,
          cuit: docNroClean,
          doc_tipo: docTipo,
          doc_nro: Number(docNroClean) || 0,
          address: address ?? null,
          locality: locality ?? null,
          created_by: adminUserId,
        })
        .select("id")
        .single();

      if (insertInvoiceErr) {
        throw new Error(
          `Factura emitida en ARCA (CAE ${result.cae}) pero no se pudo registrar localmente — contactar a soporte antes de reintentar. Error: ${insertInvoiceErr.message}`
        );
      }

      const { error: insertItemsErr } = await supabase
        .from("invoice_items")
        .insert(
          itemsFacturados.map((item) => ({
            invoice_id: invoiceRow!.id,
            product_name: item.productName,
            quantity: item.quantity,
            unit_price: item.precioUnitario,
            subtotal: item.subtotal,
          }))
        );

      if (insertItemsErr) {
        throw new Error(
          `Factura emitida en ARCA (CAE ${result.cae}) y registrada en invoices, pero falló el guardado de items — contactar a soporte. Error: ${insertItemsErr.message}`
        );
      }

      return {
        invoiceData: {
          orderNumber,
          customerName,
          cuit: docNroClean,
          address: address ?? "",
          locality: locality ?? "",
          totalAmount,
          montoFacturar,
          puntoVenta: ptoVta,
          cbteNro: nextNro,
          cbteTipo,
          cbteLetra,
          importeNeto,
          importeIva,
          esFacturaA,
          date,
          items: itemsFacturados,
        },
        caeResult: { cae: result.cae, caeFchVto: result.caeFchVto },
        invoiceId: invoiceRow!.id,
        driveFileUrl: null,
      };
    });
  });
}
