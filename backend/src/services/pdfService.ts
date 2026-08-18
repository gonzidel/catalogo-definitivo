import { InvoicePdfGenerator, InvoiceData } from "@arcasdk/pdf";

export interface InvoiceItemRow {
  productName: string;
  quantity: number;
  precioUnitario: number;
  subtotal: number;
}

export interface InvoicePdfInput {
  orderNumber?: string | number;
  customerName: string;
  cuit: string;
  address?: string;
  locality?: string;
  cbteTipo: number;
  cbteLetra: string;
  puntoVenta: number;
  cbteNro: number;
  date: string;
  esFacturaA: boolean;
  montoFacturar: number;
  totalAmount: number;
  importeNeto: number;
  importeIva: number;
  items: InvoiceItemRow[];
}

export async function generatePdf(
  invoice: InvoicePdfInput,
  cae: { cae: string; caeFchVto: string }
): Promise<Buffer> {
  const data: InvoiceData = {
    emisor: {
      razonSocial: process.env.RAZON_SOCIAL!,
      domicilioComercial: process.env.DOMICILIO_COMERCIAL!,
      condicionIva: process.env.CONDICION_IVA!,
      cuit: process.env.CUIT_EMISOR!,
      iibb: process.env.IIBB!,
      fechaInicioActividades: process.env.FECHA_INICIO_ACTIVIDADES!,
    },
    receptor: {
      razonSocial: invoice.customerName,
      condicionIva: invoice.esFacturaA
        ? "IVA Responsable Inscripto"
        : "Consumidor Final",
      documentoTipo: invoice.esFacturaA ? "CUIT" : "DNI",
      documentoNro: invoice.cuit || "0",
      domicilio: [invoice.address, invoice.locality].filter(Boolean).join(" - "),
    },
    cbteTipo: invoice.cbteTipo,
    cbteLetra: invoice.cbteLetra,
    puntoVenta: invoice.puntoVenta,
    cbteDesde: invoice.cbteNro,
    cbteHasta: invoice.cbteNro,
    cbteFecha: invoice.date,
    concepto: 1,
    moneda: "PES",
    condicionVenta: "Contado",
    items: invoice.items.map((item) => ({
      descripcion: item.productName,
      cantidad: item.quantity,
      unidadMedida: "unidades",
      precioUnitario: item.precioUnitario,
      subtotal: item.subtotal,
      ...(invoice.esFacturaA ? { alicuotaIva: 21 } : {}),
    })),
    importeNetoGravado: invoice.importeNeto,
    importeIva: invoice.importeIva,
    importeTotal: invoice.montoFacturar,
    ...(invoice.esFacturaA
      ? {
          iva: [
            {
              id: 5,
              descripcion: "21%",
              baseImponible: invoice.importeNeto,
              importe: invoice.importeIva,
            },
          ],
        }
      : {}),
    cae: cae.cae,
    caeFechaVencimiento: cae.caeFchVto.replace(/-/g, ""),
    // Sin observaciones: el comprobante no debe hacer referencia a ningún
    // monto o porcentaje distinto del que efectivamente declara (importeTotal).
  };

  const esHomologacion = process.env.ARCA_PRODUCTION !== "true";

  const generator = new InvoicePdfGenerator({
    includeQr: true,
    copies: ["ORIGINAL", "DUPLICADO"],
    // Sello visible mientras se prueba contra el ambiente de homologación de
    // ARCA, para que nunca se confunda con un comprobante real (el CAE de
    // homologación tiene el mismo formato que uno de producción a simple vista,
    // pero no existe en el registro fiscal real).
    ...(esHomologacion && {
      footerText: "AMBIENTE DE HOMOLOGACIÓN — SIN VALOR FISCAL",
    }),
  });

  return generator.generate(data);
}
