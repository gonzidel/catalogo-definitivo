/**
 * Mensajes WhatsApp al cerrar pedido desde el dashboard clienta.
 * Paridad con fn_build_closed_order_* en migración 320.
 */

import { formatPriceAr } from "@/lib/orders/domain";
import { canonicalizeTransportName } from "@/lib/transport/index";

export const FYL_TRANSFER_ALIAS = "0170218940000003684953";
export const FYL_TRANSFER_CBU = "calzados.fyl.2025";
export const FYL_TRANSFER_TITULAR = "DE LA FUENTE FERNANDO";

export type ClosedOrderTransportCategory =
  | "cod"
  | "transfer"
  | "correo"
  | "local_pickup"
  | "other";

export function getClosedOrderTransportCategory(
  transporte?: string | null,
  opts?: { customerPrefersPagado?: boolean; orderPaymentMethod?: string | null }
): ClosedOrderTransportCategory {
  const canon = canonicalizeTransportName(transporte || "");
  const base =
    canon === "MyM" || canon === "SEDE" || canon === "Expreso Norte"
      ? "cod"
      : canon === "Via Cargo" || canon === "Credifin" || canon === "Snaider"
        ? "transfer"
        : canon === "Correo Argentino"
          ? "correo"
          : canon === "Retira local" || canon === "Retiro de Local"
            ? "local_pickup"
            : "other";

  const pm = String(opts?.orderPaymentMethod || "").trim().toLowerCase();
  const pagado =
    opts?.customerPrefersPagado ||
    pm === "pagado" ||
    pm === "pago" ||
    pm === "transferencia";

  if (base === "cod" && pagado) return "transfer";
  return base;
}

export function isCustomerClosedNotificationKind(kind: string): boolean {
  return (
    kind === "customer_closed_cod" ||
    kind === "customer_closed_transfer" ||
    kind === "customer_closed_correo"
  );
}

export function customerClosedKindRequiresPaymentPending(kind: string): boolean {
  return kind === "customer_closed_transfer" || kind === "customer_closed_correo";
}

export function buildClosedOrderCodMessage(opts: {
  transporte: string;
  totalPedido: number;
}): string {
  const transporte = opts.transporte.trim() || "tu transporte";
  return `Hola 👋 Tu pedido fue finalizado correctamente.

🚚 El transporte asignado para tu envío es *${transporte}*.

El total de tu pedido es de *${formatPriceAr(opts.totalPedido)}*. Este monto deberás abonarlo *en efectivo al transportista al momento de recibir el paquete*, junto con el costo del envío.

Cualquier duda que tengas sobre tu envío o el pago, podés escribirnos 😊`;
}

export function buildClosedOrderTransferMessage(opts: {
  transporte: string;
  totalPedido: number;
}): string {
  const transporte = opts.transporte.trim() || "tu transporte";
  return `Hola 👋 Tu pedido fue finalizado correctamente.

🚚 El transporte asignado para tu envío es *${transporte}*.

El total de tu pedido es de *${formatPriceAr(opts.totalPedido)}* y deberá abonarse por transferencia antes del envío.

🏦 *Datos para la transferencia*
Alias: ${FYL_TRANSFER_ALIAS}
CBU/CVU: ${FYL_TRANSFER_CBU}
Titular: ${FYL_TRANSFER_TITULAR}

Una vez realizada la transferencia, por favor envianos el comprobante por este medio.

Cualquier duda que tengas, podés escribirnos 😊`;
}

export function buildClosedOrderCorreoMessage(opts: {
  totalPedido: number;
  costoEnvio: number;
}): string {
  const totalTransferir = opts.totalPedido + opts.costoEnvio;
  return `Hola 👋 Tu pedido fue finalizado correctamente.

📦 El envío se realizará por *Correo Argentino*.

Para realizar el despacho, deberás abonar previamente el valor del pedido y el costo del envío.

Productos: *${formatPriceAr(opts.totalPedido)}*
Envío: *${formatPriceAr(opts.costoEnvio)}*
*Total a transferir: ${formatPriceAr(totalTransferir)}*

El costo del envío es calculado por Correo Argentino según el peso y tamaño del paquete.

🏦 *Datos para la transferencia*
Alias: ${FYL_TRANSFER_ALIAS}
CBU/CVU: ${FYL_TRANSFER_CBU}
Titular: ${FYL_TRANSFER_TITULAR}

Una vez realizada la transferencia, por favor envianos el comprobante por este medio.

Cualquier duda que tengas, podés escribirnos 😊`;
}

export function buildPaymentConfirmedMessage(): string {
  return `Confirmamos correctamente el pago de tu pedido.

Ahora vamos a prepararlo para el despacho. Una vez enviado, te enviaremos los datos de seguimiento para que puedas consultar el estado de tu envío.

Cualquier consulta, podés escribirnos 😊`;
}
