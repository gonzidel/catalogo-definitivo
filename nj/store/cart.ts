"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CartItem {
  id: string;           // cart_items.id (uuid from Supabase) or temp local id
  variant_id: string;
  product_name: string;
  color: string;
  size: string;
  qty: number;
  price_snapshot: number;
  /** Precio de oferta activo al agregar (para UI: 🔥 + precio rojo). */
  is_offer?: boolean;
  imagen?: string;
  sku?: string;
  // Supabase sync state
  synced?: boolean;
}

interface CartState {
  items: CartItem[];
  cartId: string | null;    // Supabase carts.id
  isCheckingOut: boolean;
  checkoutError: string | null;
  checkoutSuccess: boolean;
  activeOrderStatus: string | null; // current order status, set by dashboard
  syntheticNotifications: Array<{ id: string; type: string; message: string; read: boolean; created_at: string }>;
  lastAddedAt: number | null; // timestamp of last addItem call — used for global flash
  // true mientras el PDP muestra su propia barra "Agregar N pares al carrito"
  // (hay talles elegidos en ESE producto) — le avisa a CartFloatingBar que
  // se tape, para no superponer dos barras. Fuera de ese momento puntual,
  // CartFloatingBar debe verse también en el PDP si ya hay ítems en el carrito.
  pdpOwnBarActive: boolean;

  // Actions
  setCartId: (id: string | null) => void;
  setItems: (items: CartItem[]) => void;
  addItem: (item: Omit<CartItem, "id" | "synced">) => void;
  removeItem: (variantId: string, size: string) => void;
  updateQty: (variantId: string, size: string, qty: number) => void;
  clearCart: () => void;
  setCheckingOut: (v: boolean) => void;
  setCheckoutError: (e: string | null) => void;
  setCheckoutSuccess: (v: boolean) => void;
  setActiveOrderStatus: (s: string | null) => void;
  setSyntheticNotifications: (n: Array<{ id: string; type: string; message: string; read: boolean; created_at: string }>) => void;
  setPdpOwnBarActive: (active: boolean) => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      cartId: null,
      isCheckingOut: false,
      checkoutError: null,
      checkoutSuccess: false,
      activeOrderStatus: null,
      syntheticNotifications: [],
      lastAddedAt: null,
      pdpOwnBarActive: false,

      setCartId: (id) => set({ cartId: id }),

      setItems: (items) => set({ items }),

      addItem: (newItem) => {
        const items = get().items;
        const key = (i: CartItem) =>
          `${i.variant_id}__${i.size.toLowerCase()}`;
        const incoming = `${newItem.variant_id}__${newItem.size.toLowerCase()}`;
        const existing = items.find((i) => key(i) === incoming);

        if (existing) {
          set({
            items: items.map((i) =>
              key(i) === incoming
                ? {
                    ...i,
                    qty: i.qty + newItem.qty,
                    price_snapshot: newItem.price_snapshot,
                    is_offer: newItem.is_offer ?? i.is_offer,
                    synced: false,
                  }
                : i
            ),
            lastAddedAt: Date.now(),
          });
        } else {
          const tempId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          set({ items: [...items, { ...newItem, id: tempId, synced: false }], lastAddedAt: Date.now() });
        }
      },

      removeItem: (variantId, size) =>
        set({
          items: get().items.filter(
            (i) => !(i.variant_id === variantId && i.size.toLowerCase() === size.toLowerCase())
          ),
        }),

      updateQty: (variantId, size, qty) => {
        if (qty <= 0) {
          get().removeItem(variantId, size);
          return;
        }
        set({
          items: get().items.map((i) =>
            i.variant_id === variantId && i.size.toLowerCase() === size.toLowerCase()
              ? { ...i, qty, synced: false }
              : i
          ),
        });
      },

      clearCart: () => set({ items: [], cartId: null }),

      setCheckingOut: (v) => set({ isCheckingOut: v }),
      setCheckoutError: (e) => set({ checkoutError: e }),
      setCheckoutSuccess: (v) => set({ checkoutSuccess: v }),
      setActiveOrderStatus: (s) => set({ activeOrderStatus: s }),
      setSyntheticNotifications: (n) => set({ syntheticNotifications: n }),
      setPdpOwnBarActive: (active) => set({ pdpOwnBarActive: active }),
    }),
    {
      name: "fyl-nj-cart",
      partialize: (s) => ({ items: s.items, cartId: s.cartId }),
    }
  )
);

// ─── Derived selectors ────────────────────────────────────────────────────────

export const selectCartCount = (s: CartState) =>
  s.items.reduce((acc, i) => acc + i.qty, 0);

export const selectCartTotal = (s: CartState) =>
  s.items.reduce((acc, i) => acc + i.price_snapshot * i.qty, 0);
