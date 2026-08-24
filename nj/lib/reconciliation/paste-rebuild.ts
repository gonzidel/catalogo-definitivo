/**
 * Reconstruye texto pegable desde filas de planilla (prefiera raw_line).
 */
export function rowsToPasteText(
  rows: Array<{
    rawLine?: string | null;
    rawTransportDateText: string;
    rawCustomerNameText: string;
    rawAmountText: string;
  }>
): string {
  return rows
    .map((r) => {
      const line = r.rawLine?.replace(/\r$/, "").trim();
      if (line) return line;
      return `${r.rawTransportDateText}\t${r.rawCustomerNameText}\t${r.rawAmountText}`;
    })
    .join("\n");
}
