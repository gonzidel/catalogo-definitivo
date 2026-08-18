import { getCustomerFromOrder, normalizePhoneDigitsForMatch } from "@/lib/orders/domain";
import type { AdminOrder, AdminOrderCustomer } from "@/types/orders";

export function normalizeCustomerSearchText(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeCustomerSearch(value: string): string[] {
  return normalizeCustomerSearchText(value)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

export const PHONE_SEARCH_SUFFIX_LEN = 7;

export function getPhoneSearchSuffix(
  text: string | null | undefined,
  suffixLen = PHONE_SEARCH_SUFFIX_LEN
): string {
  const d = normalizePhoneDigitsForMatch(text);
  if (!d) return "";
  const len = Math.min(suffixLen, d.length);
  return len >= 4 ? d.slice(-len) : "";
}

/** Coincide por últimos N dígitos (prioridad 7): tolera +54, espacios, guiones, etc. */
export function phonesMatchBySuffix(
  queryText: string | null | undefined,
  storedPhone: string | null | undefined,
  suffixLen = PHONE_SEARCH_SUFFIX_LEN
): boolean {
  const q = normalizePhoneDigitsForMatch(queryText);
  const p = normalizePhoneDigitsForMatch(storedPhone);
  if (!q || !p) return false;

  const compareLen = Math.min(suffixLen, q.length, p.length);
  if (compareLen < 4) return false;

  if (q.length >= suffixLen && p.length >= suffixLen) {
    return q.slice(-suffixLen) === p.slice(-suffixLen);
  }

  return q.slice(-compareLen) === p.slice(-compareLen);
}

/** Misma lógica flexible que PAU / orders-domain.js */
export function customerMatchesFlexible(
  searchTerm: string,
  customer: AdminOrderCustomer | null | undefined
): boolean {
  if (!customer) return false;
  const normQuery = normalizeCustomerSearchText(searchTerm);
  if (!normQuery) return true;

  const tokens = tokenizeCustomerSearch(normQuery);
  const fullName = normalizeCustomerSearchText(customer.full_name || "");
  const dni = String(customer.dni || "").toLowerCase();
  const email = String(customer.email || "").toLowerCase();
  const customerNumber = String(
    (customer as AdminOrderCustomer & { customer_number?: string | null }).customer_number || ""
  ).toLowerCase();
  const queryDigits = normalizePhoneDigitsForMatch(searchTerm);

  if (fullName === normQuery) return true;
  if (fullName.startsWith(normQuery)) return true;
  if (tokens.length > 0 && tokens.every((t) => fullName.includes(t))) return true;
  if (customerNumber && customerNumber.includes(normQuery)) return true;
  if (dni && dni.includes(normQuery)) return true;
  if (email && email.includes(normQuery)) return true;
  if (queryDigits && phonesMatchBySuffix(searchTerm, customer.phone)) return true;
  if (queryDigits && String(customer.phone || "").replace(/\D/g, "").includes(queryDigits)) {
    return true;
  }
  return false;
}

export function orderMatchesCustomerSearch(order: AdminOrder, searchTerm: string): boolean {
  const q = String(searchTerm || "").trim();
  if (!q) return true;
  return customerMatchesFlexible(q, getCustomerFromOrder(order));
}
