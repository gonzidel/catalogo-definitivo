const TICKET_WIDTH = 42;
const TIMEZONE_BUENOS_AIRES = "America/Argentina/Buenos_Aires";

export type EscposTicketItem = {
  product_name: string;
  color?: string | null;
  size?: string | null;
  qty: number;
  price: number;
  is_return?: boolean;
};

export type EscposTicketInput = {
  saleNumber: string;
  createdAt: string;
  customerName?: string | null;
  orderNumber?: string | null;
  payMethod?: string | null;
  items: EscposTicketItem[];
  total: number;
  creditUsed?: number;
};

function padRight(text: string, width: number): string {
  const s = String(text || "");
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function padLeft(text: string, width: number): string {
  const s = String(text || "");
  if (s.length >= width) return s.slice(-width);
  return " ".repeat(width - s.length) + s;
}

function center(text: string, width = TICKET_WIDTH): string {
  const s = String(text || "");
  if (s.length >= width) return s.slice(0, width);
  const left = Math.floor((width - s.length) / 2);
  return " ".repeat(left) + s;
}

function money(n: number): string {
  return `$${Math.abs(n).toLocaleString("es-AR")}`;
}

/** Ticket ESC/POS en texto, paridad con `buildEscposTicket` de public-sales. */
export function buildEscposTicketText(input: EscposTicketInput): string {
  const saleDate = new Date(input.createdAt);
  const dateStr = saleDate.toLocaleDateString("es-AR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIMEZONE_BUENOS_AIRES,
  });
  const timeStr = saleDate.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE_BUENOS_AIRES,
  });

  const lines: string[] = [];
  lines.push(center("FYL moda"));
  lines.push("-".repeat(TICKET_WIDTH));
  lines.push("");
  lines.push(`Venta: ${input.saleNumber}`);
  if (input.orderNumber) lines.push(`Pedido: ${input.orderNumber}`);
  if (input.payMethod) lines.push(`Pago: ${input.payMethod}`);
  lines.push(`Fecha: ${dateStr}`);
  lines.push(`Hora: ${timeStr}`);
  if (input.customerName) {
    lines.push(`Cliente: ${input.customerName.substring(0, TICKET_WIDTH - 9)}`);
  }
  lines.push("");
  lines.push("-".repeat(TICKET_WIDTH));
  lines.push(center("DETALLE DE LA COMPRA"));
  lines.push("-".repeat(TICKET_WIDTH));

  const colProducto = 22;
  const colCant = 4;
  const colPrecio = 8;
  const colTotal = 8;
  lines.push(
    padRight("Producto", colProducto) +
      padLeft("Cant", colCant) +
      padLeft("Precio", colPrecio) +
      padLeft("Total", colTotal)
  );
  lines.push("-".repeat(TICKET_WIDTH));

  for (const item of input.items) {
    const price = Number(item.price) || 0;
    const qty = Number(item.qty) || 0;
    const total = price * qty;
    const isReturn = Boolean(item.is_return);
    let productName = item.product_name || "N/A";
    if (item.color) productName += ` - ${item.color}`;
    if (item.size) productName += ` (${item.size})`;
    if (isReturn) productName += " [DEV]";

    const priceStr = money(price);
    const totalStr = `${isReturn || total < 0 ? "-" : ""}${money(total)}`;
    lines.push(
      padRight(productName.slice(0, colProducto), colProducto) +
        padLeft(String(qty), colCant) +
        padLeft(priceStr, colPrecio) +
        padLeft(totalStr, colTotal)
    );
  }

  lines.push("-".repeat(TICKET_WIDTH));
  lines.push("");

  const creditUsed = Number(input.creditUsed) || 0;
  if (creditUsed > 0) {
    lines.push(`Credito Aplicado: ${padLeft(`-$${creditUsed.toLocaleString("es-AR")}`, TICKET_WIDTH - 20)}`);
    lines.push("");
  }

  const totalAmount = Number(input.total) || 0;
  const totalStr = `${totalAmount < 0 ? "-" : ""}${money(totalAmount)}`;
  lines.push(padLeft(`TOTAL: ${totalStr}`, TICKET_WIDTH));
  lines.push("");
  if (totalAmount < 0) {
    lines.push("Saldo a favor (Credito):");
    lines.push(padLeft(totalStr, TICKET_WIDTH));
    lines.push("");
  }

  lines.push("-".repeat(TICKET_WIDTH));
  lines.push(center("DOCUMENTO NO VALIDO"));
  lines.push(center("COMO FACTURA"));
  lines.push("");
  return lines.join("\n");
}
