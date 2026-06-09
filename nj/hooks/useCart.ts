"use client";

import { useEffect, useRef } from "react";
import { useCartStore, type CartItem } from "@/store/cart";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function ensureCart(customerId: string): Promise<string | null> {
  const supabase = getSupabaseBrowserClient();
  const { data: existing } = await supabase
    .from("carts")
    .select("id")
    .eq("customer_id", customerId)
    .eq("status", "open")
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("carts")
    .insert({ customer_id: customerId, status: "open" })
    .select("id")
    .single();

  if (error) {
    console.warn("[cart] ensureCart error:", error.message);
    return null;
  }
  return created?.id ?? null;
}

async function upsertCartItem(cartId: string, item: CartItem): Promise<string | null> {
  // Guard: skip items with invalid variant_id
  if (!item.variant_id || item.variant_id.startsWith("local_")) {
    console.warn("[cart] skipping item with invalid variant_id:", item.variant_id);
    return null;
  }

  const supabase = getSupabaseBrowserClient();

  // If item already has a real Supabase id, update qty (both columns for compatibility)
  if (item.id && !item.id.startsWith("local_")) {
    const { data } = await supabase
      .from("cart_items")
      .update({ quantity: item.qty, qty: item.qty })
      .eq("id", item.id)
      .select("id")
      .single();
    return data?.id ?? item.id;
  }

  // Check if row already exists for this variant+size in this cart
  const { data: existing } = await supabase
    .from("cart_items")
    .select("id")
    .eq("cart_id", cartId)
    .eq("variant_id", item.variant_id)
    .ilike("size", item.size)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("cart_items")
      .update({ quantity: item.qty, qty: item.qty })
      .eq("id", existing.id);
    return existing.id;
  }

  // Insert new — same fields as cart-persistent.js
  const { data: inserted, error } = await supabase
    .from("cart_items")
    .insert({
      cart_id: cartId,
      variant_id: item.variant_id,
      product_name: item.product_name,
      color: item.color,
      size: item.size,
      quantity: item.qty,
      qty: item.qty,
      price_snapshot: item.price_snapshot,
      status: "reserved",
      imagen: item.imagen ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.warn("[cart] upsertCartItem error:", error.message);
    return null;
  }
  return inserted?.id ?? null;
}

async function deleteCartItem(itemId: string) {
  if (!itemId || itemId.startsWith("local_")) return;
  const supabase = getSupabaseBrowserClient();
  await supabase.from("cart_items").delete().eq("id", itemId);
}

// ─── Load cart from Supabase ──────────────────────────────────────────────────

export async function loadCartFromSupabase(customerId: string): Promise<{
  cartId: string | null;
  items: CartItem[];
}> {
  const supabase = getSupabaseBrowserClient();
  const { data: cart } = await supabase
    .from("carts")
    .select("id, cart_items(id, variant_id, qty, quantity, price_snapshot, product_name, color, size, imagen, status)")
    .eq("customer_id", customerId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!cart) return { cartId: null, items: [] };

  const items: CartItem[] = ((cart.cart_items ?? []) as any[]).map((ci) => ({
    id: ci.id,
    variant_id: ci.variant_id,
    qty: Number(ci.qty ?? ci.quantity ?? 0),
    price_snapshot: ci.price_snapshot,
    product_name: ci.product_name,
    color: ci.color,
    size: ci.size,
    imagen: ci.imagen,
    synced: true,
  }));

  return { cartId: cart.id, items };
}

// ─── Checkout ─────────────────────────────────────────────────────────────────

function generateOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildCartFingerprint(items: CartItem[]): string {
  if (!items.length) return "empty";
  const lines = items
    .map((item) => ({
      vid: String(item.variant_id ?? "").trim(),
      sz: String(item.size ?? "").trim().toLowerCase(),
      qty: Number(item.qty ?? 0),
      price: Number(item.price_snapshot ?? 0),
    }))
    .sort((a, b) => {
      const k1 = `${a.vid}|${a.sz}`;
      const k2 = `${b.vid}|${b.sz}`;
      return k1 < k2 ? -1 : k1 > k2 ? 1 : 0;
    });
  // djb2 hash — same as original dashboard
  const raw = JSON.stringify(lines);
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = (((h << 5) + h) + raw.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

/** Calls rpc_checkout_cart with the same signature as client/dashboard-instant.js */
export async function checkoutCart(items: CartItem[]): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseBrowserClient();
  const operationId = generateOperationId();
  const request = {
    source: "dashboard-nj",
    action: "checkout_cart",
    cart_fingerprint: buildCartFingerprint(items),
  };
  const { error } = await supabase.rpc("rpc_checkout_cart", {
    p_operation_id: operationId,
    p_request: request,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ─── Hook: useCartSync ────────────────────────────────────────────────────────

/**
 * Syncs local (unsynced) cart items to Supabase.
 * - Only runs for authenticated users with a valid customerId.
 * - Uses a ref-based lock to prevent concurrent sync runs.
 * - Does NOT include `items` in the useEffect dep array to prevent infinite loops.
 *   Instead reads items via a ref on each sync pass.
 */
export function useCartSync(customerId: string | null) {
  const { items, cartId, setItems, setCartId } = useCartStore();

  // Use refs to read latest state inside the effect without adding to deps
  const itemsRef    = useRef(items);
  const cartIdRef   = useRef(cartId);
  const syncing     = useRef(false);
  itemsRef.current  = items;
  cartIdRef.current = cartId;

  // Load cart from Supabase on mount
  useEffect(() => {
    if (!customerId) return;
    loadCartFromSupabase(customerId).then(({ cartId: cid, items: serverItems }) => {
      if (cid) setCartId(cid);
      if (serverItems.length > 0) {
        const serverKeys = new Set(serverItems.map((i) => `${i.variant_id}__${i.size}`));
        const localOnly  = itemsRef.current.filter(
          (i) => i.id.startsWith("local_") && !serverKeys.has(`${i.variant_id}__${i.size}`)
        );
        setItems([...serverItems, ...localOnly]);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // Sync unsynced items — triggered manually via syncNow()
  async function syncNow() {
    if (!customerId || syncing.current) return;

    const currentItems = itemsRef.current;
    const unsynced = currentItems.filter(
      (i) => !i.synced && i.variant_id && !i.variant_id.startsWith("local_")
    );
    if (unsynced.length === 0) return;

    syncing.current = true;
    try {
      let cid = cartIdRef.current;
      if (!cid) {
        cid = await ensureCart(customerId);
        if (cid) setCartId(cid);
      }
      if (!cid) return;

      const updatedItems = [...currentItems];
      for (const item of unsynced) {
        const realId = await upsertCartItem(cid, item);
        if (realId) {
          const idx = updatedItems.findIndex((i) => i.id === item.id);
          if (idx !== -1) updatedItems[idx] = { ...updatedItems[idx], id: realId, synced: true };
        }
      }
      setItems(updatedItems);
    } finally {
      syncing.current = false;
    }
  }

  return {
    syncNow,
    removeFromSupabase: deleteCartItem,
  };
}
