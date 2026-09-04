/**
 * Avisos de vencimiento enviados — persistencia Supabase (compartida entre dispositivos).
 */

"use client";

import { create } from "zustand";
import {
  fetchAdminExpiryWarnSentOrderIds,
  markAdminExpiryWarnSent,
} from "@/lib/supabase/admin-order-messages";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

interface ExpiryWarnSentState {
  hydrated: boolean;
  sentIds: Set<string>;
  hydrate: () => Promise<void>;
  isSent: (orderId: string) => boolean;
  markSent: (orderId: string) => Promise<void>;
}

export const useExpiryWarnSentStore = create<ExpiryWarnSentState>((set, get) => ({
  hydrated: false,
  sentIds: new Set(),

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const supabase = getSupabaseBrowserClient();
      const ids = await fetchAdminExpiryWarnSentOrderIds(supabase);
      set({ hydrated: true, sentIds: ids });
    } catch {
      set({ hydrated: true, sentIds: new Set() });
    }
  },

  isSent: (orderId) => get().sentIds.has(orderId),

  markSent: async (orderId) => {
    const supabase = getSupabaseBrowserClient();
    await markAdminExpiryWarnSent(supabase, orderId);
    const next = new Set(get().sentIds);
    next.add(orderId);
    set({ sentIds: next });
  },
}));

export function isExpiryWarningSent(orderId: string): boolean {
  return useExpiryWarnSentStore.getState().sentIds.has(orderId);
}
