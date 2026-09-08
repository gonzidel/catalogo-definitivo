"use client";

import { useEffect, useRef } from "react";
import { useCartStore, type CartItem } from "@/store/cart";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  acquireCheckoutInFlight,
  buildCartFingerprint,
  CHECKOUT_IN_FLIGHT_MESSAGE,
  releaseCheckoutInFlight,
  resolveCheckoutOperation,
} from "@/lib/cart/checkout-operation";

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function ensureCart(customerId: string): Promise<string | null> {
  const supabase = getSupabaseBrowserClient();
  const { data: existing } = await supabase
    .from("carts")
    .select("id")
    .eq("customer_id", customerId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
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

  // Siempre resolver por carrito+variante+talle. Un id persistido de un carrito
  // vaciado (checkout anterior) no debe updatear una fila que ya no existe.
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
      .update({
        quantity: item.qty,
        qty: item.qty,
        price_snapshot: item.price_snapshot,
      })
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

/** Calls rpc_checkout_cart with the same signature as client/dashboard-instant.js */
export async function checkoutCart(items: CartItem[]): Promise<{ success: boolean; error?: string }> {
  if (!acquireCheckoutInFlight()) {
    return { success: false, error: CHECKOUT_IN_FLIGHT_MESSAGE };
  }
  try {
    const supabase = getSupabaseBrowserClient();
    const operation = resolveCheckoutOperation(buildCartFingerprint(items));
    const { error } = await supabase.rpc("rpc_checkout_cart", {
      p_operation_id: operation.operationId,
      p_request: operation.request,
    });
    if (error) return { success: false, error: error.message };
    operation.markCompleted();
    return { success: true };
  } finally {
    releaseCheckoutInFlight();
  }
}

// ─── Hook: useCartSync ────────────────────────────────────────────────────────

/**
 * Syncs local (unsynced) cart items to Supabase.
 * - Only runs for authenticated users with a valid customerId.
 * - Concurrent callers share one in-flight Promise instead of failing.
 * - Does NOT include `items` in the useEffect dep array to prevent infinite loops.
 *   Instead reads items via a ref on each sync pass.
 */
export function useCartSync(customerId: string | null) {
  const { items, cartId, setItems, setCartId } = useCartStore();

  // Use refs to read latest state inside the effect without adding to deps
  const itemsRef    = useRef(items);
  const cartIdRef   = useRef(cartId);
  const inFlight    = useRef<Promise<boolean> | null>(null);
  itemsRef.current  = items;
  cartIdRef.current = cartId;

  // Load cart from Supabase on mount
  useEffect(() => {
    if (!customerId) return;
    loadCartFromSupabase(customerId).then(({ cartId: cid, items: serverItems }) => {
      if (cid) setCartId(cid);
      if (serverItems.length > 0) {
        const localByKey = new Map(
          itemsRef.current.map((i) => [
            `${i.variant_id}__${String(i.size).toLowerCase()}`,
            i,
          ])
        );
        const serverKeys = new Set(
          serverItems.map((i) => `${i.variant_id}__${String(i.size).toLowerCase()}`)
        );
        const mergedServer = serverItems.map((si) => {
          const local = localByKey.get(
            `${si.variant_id}__${String(si.size).toLowerCase()}`
          );
          return local?.is_offer ? { ...si, is_offer: true } : si;
        });
        const localOnly = itemsRef.current.filter(
          (i) =>
            i.id.startsWith("local_") &&
            !serverKeys.has(`${i.variant_id}__${String(i.size).toLowerCase()}`)
        );
        setItems([...mergedServer, ...localOnly]);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // Empuja el carrito local al carrito open del cliente. Antes del checkout
  // hay que mandar TODOS los ítems: synced:true puede ser de un carrito ya
  // vaciado y el RPC solo lee carts.status='open' en Supabase.
  function syncNow(): Promise<boolean> {
    if (inFlight.current) return inFlight.current;

    const run = (async (): Promise<boolean> => {
      if (!customerId) return false;

      const currentItems = itemsRef.current;
      const toSync = currentItems.filter(
        (i) => i.variant_id && !i.variant_id.startsWith("local_") && i.qty > 0
      );
      if (toSync.length === 0) return false;

      const cid = await ensureCart(customerId);
      if (!cid) return false;
      cartIdRef.current = cid;
      setCartId(cid);

      const updatedItems = [...currentItems];
      let pushed = 0;
      for (const item of toSync) {
        const realId = await upsertCartItem(cid, item);
        if (realId) {
          pushed += 1;
          const idx = updatedItems.findIndex((i) => i.id === item.id);
          if (idx !== -1) updatedItems[idx] = { ...updatedItems[idx], id: realId, synced: true };
        }
      }
      setItems(updatedItems);
      return pushed === toSync.length;
    })();

    inFlight.current = run;
    void run.finally(() => {
      if (inFlight.current === run) inFlight.current = null;
    });
    return run;
  }

  return {
    syncNow,
    removeFromSupabase: deleteCartItem,
  };
}
