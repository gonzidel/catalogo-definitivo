import {
  computeWarehouseQtySplitForOrderItem,
  computeOrderTotalFromItems,
  parseOrderNotesObject,
  type OrderNotesExtras,
} from "@/lib/orders/domain";
import { normalizeSize } from "@/lib/utils/size-normalizer";
import { loadWarehouses } from "@/lib/supabase/order-queries";
import type { WarehouseIds } from "@/types/orders";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface OrderEditDraftItem {
  product_name: string;
  color: string | null;
  size: string;
  quantity: number;
  price_snapshot: number;
  variant_id: string | null;
  qty_from_general?: number;
  qty_from_venta?: number;
  status: string;
  admin_confirmed_missing: boolean;
  imagen?: string | null;
  is_special_extra?: boolean;
}

export function buildSpecialExtraDraftItem(
  description: string,
  amount: number
): OrderEditDraftItem {
  return {
    product_name: description,
    color: null,
    size: "",
    quantity: 1,
    price_snapshot: amount,
    variant_id: null,
    qty_from_general: 0,
    qty_from_venta: 0,
    status: "picked",
    admin_confirmed_missing: false,
    is_special_extra: true,
  };
}

export async function syncOrderTotalAndNotes(
  supabase: SupabaseClient,
  orderId: string,
  notesExtras: OrderNotesExtras,
  rawNotes: string | null | undefined
): Promise<void> {
  const { data: order, error } = await supabase
    .from("orders")
    .select("notes, order_items(price_snapshot, quantity)")
    .eq("id", orderId)
    .single();

  if (error || !order) throw new Error("No se pudo recalcular el total del pedido.");

  const total = computeOrderTotalFromItems(order.order_items || [], notesExtras);
  const notesObj = parseOrderNotesObject(rawNotes ?? order.notes);
  const extrasLabel = String(notesExtras.extras_label || "").trim();
  const nextNotes = {
    ...notesObj,
    shipping: notesExtras.shipping,
    discount: notesExtras.discount,
    extras_amount: notesExtras.extras_amount,
    extras_percentage: notesExtras.extras_percentage,
    extras_label: extrasLabel,
  };
  if (!extrasLabel) {
    delete (nextNotes as { extras_label?: string }).extras_label;
    delete (nextNotes as { extras_name?: string }).extras_name;
  }

  const { error: updateError } = await supabase
    .from("orders")
    .update({
      total_amount: total,
      notes: JSON.stringify(nextNotes),
    })
    .eq("id", orderId);

  if (updateError) throw updateError;
}

export interface ProductSearchVariant {
  variant_id: string;
  color: string;
  price_snapshot: number | null;
  sizes: { size: string; sku: string | null }[];
}

export interface ProductSearchGroup {
  product_id: string;
  product_name: string;
  variants: ProductSearchVariant[];
}

export function mergeDraftItem(
  draft: OrderEditDraftItem[],
  item: OrderEditDraftItem
): OrderEditDraftItem[] {
  if (item.is_special_extra) {
    return [...draft, { ...item, quantity: item.quantity || 1 }];
  }

  const idx = draft.findIndex(
    (d) =>
      !d.is_special_extra &&
      d.variant_id === item.variant_id &&
      normalizeSize(d.size) === normalizeSize(item.size) &&
      d.status === item.status
  );
  if (idx >= 0) {
    const next = [...draft];
    next[idx] = {
      ...next[idx],
      quantity: (Number(next[idx].quantity) || 0) + (Number(item.quantity) || 1),
    };
    delete next[idx].qty_from_general;
    delete next[idx].qty_from_venta;
    return next;
  }
  return [...draft, { ...item, quantity: item.quantity || 1 }];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Precio efectivo de una variante (lista o oferta activa por color). */
export async function getEffectivePrice(
  supabase: SupabaseClient,
  variantId: string
): Promise<number | null> {
  if (!isValidUUID(variantId)) return null;
  const { data, error } = await supabase.rpc("get_effective_price", {
    p_variant_id: variantId,
  });
  if (error) {
    console.warn("get_effective_price:", error.message);
    return null;
  }
  const n = Number(data);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Mapa variant_id → precio efectivo (oferta por color si aplica). */
export async function getEffectivePricesMap(
  supabase: SupabaseClient,
  variantIds: string[]
): Promise<Map<string, number>> {
  const unique = [...new Set((variantIds || []).filter((id) => isValidUUID(id)))];
  const map = new Map<string, number>();
  if (!unique.length) return map;
  await Promise.all(
    unique.map(async (id) => {
      const price = await getEffectivePrice(supabase, id);
      if (price != null) map.set(id, price);
    })
  );
  return map;
}

export function catalogPriceGuardMessage(productName?: string | null): string {
  const name = String(productName || "").trim();
  return name
    ? `"${name}" no tiene precio de catálogo.`
    : "El producto no tiene precio de catálogo.";
}

export async function searchProductsGroupedByPrefix(
  supabase: SupabaseClient,
  prefix: string
): Promise<ProductSearchGroup[]> {
  const term = String(prefix || "").trim();
  if (term.length < 2) return [];
  const lower = term.toLowerCase();
  const escaped = term.replace(/[%_]/g, "");

  const { data: products, error } = await supabase
    .from("products")
    .select(`
      id,
      name,
      product_variants (
        id,
        color,
        price,
        sku,
        active
      )
    `)
    .ilike("name", `${escaped}%`)
    .in("status", ["active", "pending_stock", "draft"])
    .limit(12);

  if (error) throw error;

  const grouped: ProductSearchGroup[] = [];
  for (const product of products || []) {
    const nameMatches = String(product.name || "").toLowerCase().startsWith(lower);
    const variants: ProductSearchVariant[] = [];

    for (const v of product.product_variants || []) {
      if (!v?.id) continue;

      const { data: sizesData } = await supabase
        .from("variant_sizes")
        .select("size, sku")
        .eq("variant_id", v.id);

      let sizes = (sizesData || [])
        .map((s) => ({ size: normalizeSize(s.size), sku: s.sku }))
        .filter((s) => s.size);

      const variantSkuMatch = String(v.sku || "").toLowerCase().startsWith(lower);
      const matchingSizes = sizes.filter((s) =>
        String(s.sku || "").toLowerCase().startsWith(lower)
      );

      if (!nameMatches && !variantSkuMatch && matchingSizes.length === 0) continue;
      if (!nameMatches && !variantSkuMatch) sizes = matchingSizes;
      if (!sizes.length) continue;

      variants.push({
        variant_id: v.id,
        color: v.color || "—",
        price_snapshot: v.price,
        sizes,
      });
    }

    if (variants.length > 0) {
      grouped.push({
        product_id: product.id,
        product_name: product.name,
        variants,
      });
    }
  }

  // Precio efectivo (ofertas por color), misma regla que PAU / orders-ops.
  const allVariantIds = grouped.flatMap((g) => g.variants.map((v) => v.variant_id));
  const effectiveMap = await getEffectivePricesMap(supabase, allVariantIds);
  for (const g of grouped) {
    for (const v of g.variants) {
      const effective = effectiveMap.get(v.variant_id);
      if (effective != null) v.price_snapshot = effective;
    }
  }

  return grouped;
}

export async function enrichDraftItemsWithStock(
  supabase: SupabaseClient,
  items: OrderEditDraftItem[]
): Promise<OrderEditDraftItem[]> {
  const warehouseIds = await loadWarehouses(supabase);
  const out: OrderEditDraftItem[] = [];

  for (const item of items) {
    if (item.is_special_extra) {
      out.push(item);
      continue;
    }

    const variantId = item.variant_id;
    const size = normalizeSize(item.size);
    if (!variantId || !size) {
      out.push(item);
      continue;
    }

    const q = Number(item.quantity) || 1;
    const existingSplit =
      (Number(item.qty_from_general) || 0) + (Number(item.qty_from_venta) || 0);
    if (existingSplit === q) {
      out.push({ ...item, size });
      continue;
    }

    let stockGeneral = 0;
    let stockVenta = 0;
    if (warehouseIds.general && warehouseIds.ventaPublico) {
      const { data: rows } = await supabase
        .from("variant_size_warehouse_stock")
        .select("warehouse_id, stock_qty")
        .eq("variant_id", variantId)
        .eq("size", size)
        .in("warehouse_id", [warehouseIds.general, warehouseIds.ventaPublico]);

      for (const row of rows || []) {
        if (row.warehouse_id === warehouseIds.general) stockGeneral = Number(row.stock_qty) || 0;
        if (row.warehouse_id === warehouseIds.ventaPublico) stockVenta = Number(row.stock_qty) || 0;
      }
    }

    const split = computeWarehouseQtySplitForOrderItem(q, stockGeneral, stockVenta);
    const hasStock = split.qty_from_general + split.qty_from_venta >= q;
    out.push({
      ...item,
      size,
      qty_from_general: split.qty_from_general,
      qty_from_venta: split.qty_from_venta,
      // Agregado manualmente por el admin: siempre queda "picked" (apartado) aunque
      // no haya stock real confirmado — la clienta lo ve como Apartado, no "Sin
      // stock". El stock se inyecta y descuenta atómico vía
      // rpc_admin_manual_inject_and_deduct (ver applyManualConfirmedItems), y
      // admin_confirmed_missing=true queda como trazabilidad interna de que fue
      // una confirmación manual sin stock real verificado. Mismo criterio que
      // admin/order-creator.js (createNewOrder / addItemsToExistingOrder).
      status: item.status || "picked",
      admin_confirmed_missing: !hasStock,
    });
  }

  return out;
}

export function itemQualifiesForStockDeduction(item: OrderEditDraftItem): boolean {
  if (item.is_special_extra) return false;
  if (!item.variant_id || !item.size) return false;
  const statusNorm = String(item.status || "").trim().toLowerCase();
  if (statusNorm === "missing") return false;
  if (item.admin_confirmed_missing) return false;
  const q = Number(item.quantity) || 0;
  if (q <= 0) return false;
  const g = Number(item.qty_from_general) || 0;
  const v = Number(item.qty_from_venta) || 0;
  return g + v === q && g + v > 0;
}

function hasValidPrice(price: unknown): boolean {
  const n = Number(price);
  return Number.isFinite(n) && n > 0;
}

export async function applyManualConfirmedItems(
  supabase: SupabaseClient,
  insertedItems: Array<{
    id: string;
    variant_id: string | null;
    size: string | null;
    quantity: number;
    admin_confirmed_missing?: boolean | null;
  }>,
  orderId: string,
  warehouseIds: WarehouseIds
) {
  if (!insertedItems.length || !warehouseIds.general) return;

  const manualItems = insertedItems.filter(
    (i) =>
      Boolean(i.admin_confirmed_missing) &&
      i.variant_id &&
      i.size &&
      Number(i.quantity) > 0
  );
  if (!manualItems.length) return;

  const p_items = manualItems.map((item) => ({
    variant_id: item.variant_id,
    size: normalizeSize(item.size),
    warehouse_id: warehouseIds.general,
    qty: Number(item.quantity),
    order_item_id: item.id,
  }));

  const { error } = await supabase.rpc("rpc_admin_manual_inject_and_deduct", {
    p_items,
    p_order_id: orderId,
  });
  if (error) throw error;
}

export async function applyOrderStockDeduction(
  supabase: SupabaseClient,
  items: OrderEditDraftItem[],
  orderId: string,
  warehouseIds: WarehouseIds,
  source = "order_edit"
) {
  const itemsToUpdate = items.filter(itemQualifiesForStockDeduction);
  if (!itemsToUpdate.length) return;

  const deductions: Array<{
    variant_id: string;
    size: string;
    warehouse_id: string;
    qty_to_deduct: number;
    order_item_id: string | null;
  }> = [];

  for (const item of itemsToUpdate) {
    const normalizedSize = normalizeSize(item.size);
    if (!normalizedSize) continue;

    const quantity = Number(item.quantity) || 0;
    const qtyFromGeneral = Number(item.qty_from_general) || 0;
    const qtyFromVenta = Number(item.qty_from_venta) || 0;
    if (quantity <= 0 || qtyFromGeneral + qtyFromVenta !== quantity) continue;

    if (qtyFromGeneral > 0 && warehouseIds.general && item.variant_id) {
      deductions.push({
        variant_id: item.variant_id,
        size: normalizedSize,
        warehouse_id: warehouseIds.general,
        qty_to_deduct: qtyFromGeneral,
        order_item_id: null,
      });
    }
    if (qtyFromVenta > 0 && warehouseIds.ventaPublico && item.variant_id) {
      deductions.push({
        variant_id: item.variant_id,
        size: normalizedSize,
        warehouse_id: warehouseIds.ventaPublico,
        qty_to_deduct: qtyFromVenta,
        order_item_id: null,
      });
    }
  }

  if (!deductions.length) return;

  const { data, error } = await supabase.rpc("rpc_apply_order_stock_deduction", {
    p_items: deductions,
    p_order_id: orderId,
    p_source: source,
  });

  if (error) throw new Error(`Error descontando stock: ${error.message}`);
  if (!data?.ok) throw new Error("Error descontando stock (respuesta inesperada).");
}

export async function resolveSkuOrQrToOrderItem(
  supabase: SupabaseClient,
  code: string,
  warehouseIds: WarehouseIds,
  quantity = 1
): Promise<OrderEditDraftItem> {
  const qrNormalized = String(code).trim().replace(/\s+/g, "");
  if (!qrNormalized) throw new Error("Ingresá un SKU o código QR.");

  const baseQuery = () =>
    supabase.from("variant_sizes").select(`
      variant_id,
      size,
      sku,
      qr_code,
      product_variants!inner (
        id,
        sku,
        color,
        price,
        active,
        products!inner (
          id,
          name,
          status
        )
      )
    `);

  let sizeData: Record<string, unknown> | null = null;

  if (/^\d+$/.test(qrNormalized)) {
    const { data, error } = await baseQuery()
      .eq("qr_code", qrNormalized)
      .in("product_variants.products.status", ["active", "pending_stock", "draft"])
      .maybeSingle();
    if (error) throw new Error(error.message);
    sizeData = data;
    if (!sizeData?.product_variants) {
      const fallback = await baseQuery().eq("qr_code", qrNormalized).maybeSingle();
      if (fallback.error) throw new Error(fallback.error.message);
      sizeData = fallback.data;
    }
  }

  if (!sizeData?.product_variants) {
    const { data, error } = await baseQuery()
      .eq("sku", qrNormalized)
      .in("product_variants.products.status", ["active", "pending_stock", "draft"])
      .maybeSingle();
    if (error) throw new Error(error.message);
    sizeData = data;
  }

  const variantJoin = sizeData?.product_variants as
    | {
        id: string;
        color: string | null;
        price: number | null;
        products: { name: string };
      }
    | undefined;

  if (!variantJoin) {
    throw new Error(`No se encontró producto con código "${qrNormalized}".`);
  }

  const variant = variantJoin;
  const product = variant.products;
  if (!hasValidPrice(variant.price)) {
    throw new Error(catalogPriceGuardMessage(product.name));
  }

  // Precio efectivo: oferta activa por color si existe (misma regla que PAU).
  const effective = await getEffectivePrice(supabase, variant.id);
  const unitPrice = effective != null ? effective : Number(variant.price);

  const normalizedSize = normalizeSize(String(sizeData?.size || ""));
  let stockGeneral = 0;
  let stockVenta = 0;

  if (normalizedSize && warehouseIds.general && warehouseIds.ventaPublico) {
    const { data: stocks } = await supabase
      .from("variant_size_warehouse_stock")
      .select("size, warehouse_id, stock_qty")
      .eq("variant_id", variant.id)
      .in("warehouse_id", [warehouseIds.general, warehouseIds.ventaPublico]);

    for (const row of stocks || []) {
      if (normalizeSize(row.size) !== normalizedSize) continue;
      if (row.warehouse_id === warehouseIds.general) stockGeneral += Number(row.stock_qty) || 0;
      if (row.warehouse_id === warehouseIds.ventaPublico) stockVenta += Number(row.stock_qty) || 0;
    }
  }

  const qty = Math.max(1, Number(quantity) || 1);
  const split = computeWarehouseQtySplitForOrderItem(qty, stockGeneral, stockVenta);
  const hasConfirmedStock = split.qty_from_general + split.qty_from_venta >= qty;

  const { data: imageData } = await supabase
    .from("variant_images")
    .select("url")
    .eq("variant_id", variant.id)
    .eq("position", 1)
    .maybeSingle();

  return {
    product_name: product.name,
    color: variant.color,
    size: normalizedSize,
    quantity: qty,
    price_snapshot: unitPrice,
    imagen: imageData?.url || null,
    variant_id: variant.id,
    qty_from_general: split.qty_from_general,
    qty_from_venta: split.qty_from_venta,
    // Igual criterio que enrichDraftItemsWithStock: escaneado/agregado por el
    // admin siempre queda "picked" para la clienta, aunque no haya stock real.
    status: "picked",
    admin_confirmed_missing: !hasConfirmedStock,
  };
}

export async function addItemsToExistingOrder(
  supabase: SupabaseClient,
  orderId: string,
  items: OrderEditDraftItem[]
): Promise<void> {
  if (!items.length) return;

  const warehouseIds = await loadWarehouses(supabase);

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("status, total_amount, notes")
    .eq("id", orderId)
    .single();

  if (orderError || !order) throw new Error("No se pudo cargar el pedido.");
  if (order.status === "stock_pending") {
    throw new Error(
      "No se puede editar: el pedido está en stock pendiente. Resolvelo antes de editar."
    );
  }

  const newItemsTotal = items.reduce(
    (sum, item) => sum + (Number(item.price_snapshot) || 0) * (Number(item.quantity) || 0),
    0
  );
  void newItemsTotal;

  const orderItemsData = items.map((item) => ({
    order_id: orderId,
    variant_id: item.is_special_extra ? null : item.variant_id,
    product_name: item.product_name,
    color: item.is_special_extra ? null : item.color,
    size: item.is_special_extra ? null : item.size || null,
    quantity: item.quantity,
    price_snapshot: item.price_snapshot,
    imagen: item.imagen ?? null,
    status: item.status || "picked",
    admin_confirmed_missing: Boolean(item.admin_confirmed_missing),
  }));

  const { data: insertedItems, error: itemsError } = await supabase
    .from("order_items")
    .insert(orderItemsData)
    .select("id, variant_id, size, quantity, admin_confirmed_missing");

  if (itemsError) throw new Error(`Error agregando productos: ${itemsError.message}`);

  const updateData: { status?: string; notes?: string | null } = {};

  const statusNorm = String(order.status || "").trim().toLowerCase();
  if (
    statusNorm !== "closed" &&
    statusNorm !== "sent" &&
    statusNorm !== "devolución" &&
    statusNorm !== "devolucion"
  ) {
    updateData.status = "active";
  }

  if (order.notes) updateData.notes = order.notes;

  if (Object.keys(updateData).length > 0) {
    const { error: updateError } = await supabase.from("orders").update(updateData).eq("id", orderId);
    if (updateError) throw updateError;
  }

  const stockItems = items.filter((item) => !item.is_special_extra);
  const insertedStockItems = (insertedItems || []).filter(
    (_, index) => !items[index]?.is_special_extra
  );

  try {
    await applyManualConfirmedItems(supabase, insertedStockItems, orderId, warehouseIds);
    const itemsWithIds = stockItems.map((item, index) => ({
      ...item,
      order_item_id: insertedStockItems?.[index]?.id ?? null,
    }));
    await applyOrderStockDeduction(supabase, itemsWithIds, orderId, warehouseIds);
  } catch (stockErr) {
    const pendingNotesObj = (() => {
      try {
        return order.notes ? JSON.parse(order.notes) : {};
      } catch {
        return {};
      }
    })();
    pendingNotesObj.stock_pending_reason =
      stockErr instanceof Error ? stockErr.message : String(stockErr);
    pendingNotesObj.stock_pending_at = new Date().toISOString();
    pendingNotesObj.stock_pending_source = "nj/order-edit";

    await supabase
      .from("orders")
      .update({
        status: "stock_pending",
        notes: JSON.stringify(pendingNotesObj),
      })
      .eq("id", orderId);

    throw new Error(
      stockErr instanceof Error
        ? `${stockErr.message}. El pedido quedó en stock pendiente.`
        : "Error de stock. El pedido quedó en stock pendiente."
    );
  }
}
