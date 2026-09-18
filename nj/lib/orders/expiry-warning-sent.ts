/**
 * Avisos de vencimiento enviados — persistencia Supabase (compartida entre dispositivos).
 * Guarda sent_at para el cooldown azul de 24 h en la columna Vencido.
 */

"use client";

import { create } from "zustand";
import {
  clearAdminExpiryWarnSent,
  fetchAdminExpiryWarnSentEntries,
  markAdminExpiryWarnSent,
  type AdminExpiryWarnSentEntry,
} from "@/lib/supabase/admin-order-messages";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { isExpiryWarnCooldownActive } from "@/lib/orders/deadline";

interface ExpiryWarnSentState {
  hydrated: boolean;
  /** orderId → sent_at ISO */
  sentAtByOrderId: Map<string, string>;
  hydrate: () => Promise<void>;
  isSent: (orderId: string) => boolean;
  isCooldownActive: (orderId: string, now?: number) => boolean;
  getSentAt: (orderId: string) => string | null;
  markSent: (orderId: string) => Promise<void>;
  clearSent: (orderId: string) => Promise<void>;
}

function entriesToMap(entries: AdminExpiryWarnSentEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    if (e.orderId && e.sentAt) map.set(e.orderId, e.sentAt);
  }
  return map;
}

export const useExpiryWarnSentStore = create<ExpiryWarnSentState>((set, get) => ({
  hydrated: false,
  sentAtByOrderId: new Map(),

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const supabase = getSupabaseBrowserClient();
      const entries = await fetchAdminExpiryWarnSentEntries(supabase);
      set({ hydrated: true, sentAtByOrderId: entriesToMap(entries) });
    } catch {
      set({ hydrated: true, sentAtByOrderId: new Map() });
    }
  },

  isSent: (orderId) => get().sentAtByOrderId.has(orderId),

  getSentAt: (orderId) => get().sentAtByOrderId.get(orderId) ?? null,

  isCooldownActive: (orderId, now = Date.now()) => {
    const sentAt = get().sentAtByOrderId.get(orderId);
    return isExpiryWarnCooldownActive(sentAt, now);
  },

  markSent: async (orderId) => {
    const supabase = getSupabaseBrowserClient();
    await markAdminExpiryWarnSent(supabase, orderId);
    const next = new Map(get().sentAtByOrderId);
    next.set(orderId, new Date().toISOString());
    set({ sentAtByOrderId: next });
  },

  clearSent: async (orderId) => {
    const supabase = getSupabaseBrowserClient();
    await clearAdminExpiryWarnSent(supabase, orderId);
    const next = new Map(get().sentAtByOrderId);
    next.delete(orderId);
    set({ sentAtByOrderId: next });
  },
}));

/** Compat: Set de IDs con cooldown aún activo (campana / sort legacy). */
export function getExpiryWarnCooldownActiveIds(
  state: Pick<ExpiryWarnSentState, "sentAtByOrderId"> = useExpiryWarnSentStore.getState(),
  now = Date.now()
): Set<string> {
  return getExpiryWarnCooldownActiveIdsFromMap(state.sentAtByOrderId, now);
}

export function getExpiryWarnCooldownActiveIdsFromMap(
  sentAtByOrderId: Map<string, string>,
  now = Date.now()
): Set<string> {
  const ids = new Set<string>();
  for (const [orderId, sentAt] of sentAtByOrderId) {
    if (isExpiryWarnCooldownActive(sentAt, now)) ids.add(orderId);
  }
  return ids;
}

export function isExpiryWarningSent(orderId: string): boolean {
  return useExpiryWarnSentStore.getState().sentAtByOrderId.has(orderId);
}
