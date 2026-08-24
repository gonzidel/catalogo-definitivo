/**
 * Enriquecimiento read-only de match_candidates viejos sin customerDisplayName.
 * No muta DB: solo completa el objeto en memoria al cargar la rendición.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RemittanceRowDetail } from "@/lib/reconciliation/remittance-queries";

type CandObj = Record<string, unknown>;

function needsDisplayName(c: CandObj): boolean {
  const display = String(c.customerDisplayName ?? "").trim();
  if (display) return false;
  return Boolean(c.customerId || c.orderId);
}

/**
 * Completa customerDisplayName / customerNumber / labelCustomerName
 * para candidatos persistidos antes de esta metadata UX.
 */
export async function enrichMatchCandidatesDisplayNames(
  supabase: SupabaseClient,
  rows: RemittanceRowDetail[]
): Promise<RemittanceRowDetail[]> {
  const customerIds = new Set<string>();
  const orderIds = new Set<string>();

  for (const row of rows) {
    for (const raw of row.matchCandidates ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as CandObj;
      if (!needsDisplayName(c)) continue;
      if (typeof c.customerId === "string" && c.customerId) {
        customerIds.add(c.customerId);
      } else if (typeof c.orderId === "string" && c.orderId) {
        orderIds.add(c.orderId);
      }
    }
  }

  if (customerIds.size === 0 && orderIds.size === 0) return rows;

  const byCustomerId = new Map<
    string,
    { full_name: string | null; customer_number: string | null }
  >();
  const byOrderId = new Map<
    string,
    {
      customerId: string | null;
      full_name: string | null;
      customer_number: string | null;
      label: string | null;
    }
  >();

  const custList = [...customerIds];
  for (let i = 0; i < custList.length; i += 80) {
    const chunk = custList.slice(i, i + 80);
    const { data, error } = await supabase
      .from("customers")
      .select("id, full_name, customer_number")
      .in("id", chunk);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      byCustomerId.set(String(row.id), {
        full_name: (row.full_name as string | null) ?? null,
        customer_number:
          row.customer_number != null ? String(row.customer_number) : null,
      });
    }
  }

  const orderList = [...orderIds];
  for (let i = 0; i < orderList.length; i += 80) {
    const chunk = orderList.slice(i, i + 80);
    const { data, error } = await supabase
      .from("orders")
      .select(
        `
        id,
        label_customer_name,
        customer_id,
        customers (
          id,
          full_name,
          customer_number
        )
      `
      )
      .in("id", chunk);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const custRaw = row.customers as
        | { id?: string; full_name?: string | null; customer_number?: unknown }
        | { id?: string; full_name?: string | null; customer_number?: unknown }[]
        | null;
      const cust = Array.isArray(custRaw) ? custRaw[0] : custRaw;
      byOrderId.set(String(row.id), {
        customerId: (row.customer_id as string | null) ?? cust?.id ?? null,
        full_name: cust?.full_name ?? null,
        customer_number:
          cust?.customer_number != null ? String(cust.customer_number) : null,
        label: (row.label_customer_name as string | null) ?? null,
      });
    }
  }

  return rows.map((row) => {
    if (!row.matchCandidates?.length) return row;
    const next = row.matchCandidates.map((raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const c = { ...(raw as CandObj) };
      if (!needsDisplayName(c)) return c;

      let meta = typeof c.customerId === "string" ? byCustomerId.get(c.customerId) : undefined;
      let label: string | null = null;
      if (!meta && typeof c.orderId === "string") {
        const o = byOrderId.get(c.orderId);
        if (o) {
          meta = { full_name: o.full_name, customer_number: o.customer_number };
          label = o.label;
          if (!c.customerId && o.customerId) c.customerId = o.customerId;
        }
      }

      if (meta?.full_name?.trim()) {
        c.customerDisplayName = meta.full_name.trim();
      }
      if (!c.customerNumber && meta?.customer_number) {
        c.customerNumber = meta.customer_number;
      }
      if (!c.labelCustomerName && label?.trim()) {
        c.labelCustomerName = label.trim();
      }
      return c;
    });
    return { ...row, matchCandidates: next };
  });
}
