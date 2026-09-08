export type HydrateCartItem = {
  id: string;
  variant_id: string;
  size: string;
  qty: number;
  synced?: boolean;
  is_offer?: boolean;
};

export function cartLineKey(item: { variant_id: string; size: string }): string {
  return `${item.variant_id}__${String(item.size).toLowerCase()}`;
}

/**
 * Merge server cart into local without clobbering a newer unsynced qty.
 * Does not attempt cross-tab qty sync beyond that.
 */
export function mergeHydratedCartItems<T extends HydrateCartItem>(
  localItems: T[],
  serverItems: T[]
): T[] {
  const localByKey = new Map(localItems.map((item) => [cartLineKey(item), item]));
  const serverKeys = new Set(serverItems.map((item) => cartLineKey(item)));

  const mergedServer = serverItems.map((serverItem) => {
    const local = localByKey.get(cartLineKey(serverItem));
    if (!local) return serverItem;
    const withOffer = local.is_offer ? { ...serverItem, is_offer: true } : serverItem;
    if (local.synced === false && local.qty !== serverItem.qty) {
      return { ...withOffer, qty: local.qty, synced: false, id: serverItem.id };
    }
    return withOffer;
  });

  const localOnly = localItems.filter(
    (item) => item.id.startsWith("local_") && !serverKeys.has(cartLineKey(item))
  );

  return [...mergedServer, ...localOnly];
}

export function isUniqueConflict(
  error: { code?: string; message?: string; status?: number } | null | undefined
): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  if (Number(error.status) === 409) return true;
  return /duplicate key|unique constraint|ux_cart_items_cart_variant_size/i.test(
    error.message ?? ""
  );
}
