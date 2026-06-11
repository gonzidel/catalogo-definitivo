"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useCartStore, type CartItem } from "@/store/cart";
import { useCartSync, checkoutCart } from "@/hooks/useCart";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import LineItemRow, { formatItemARS } from "@/components/cart/LineItemRow";

function formatARS(n: number) {
  return formatItemARS(n);
}

// ─── Stock check ──────────────────────────────────────────────────────────────

/** Map of "variantId__size" → available stock qty */
type StockMap = Record<string, number>;

async function fetchCartStock(items: CartItem[]): Promise<StockMap> {
  const variantIds = [...new Set(items.map((i) => i.variant_id).filter(Boolean))];
  if (variantIds.length === 0) return {};

  const supabase = getSupabaseBrowserClient();
  const { data } = await supabase
    .from("variant_sizes")
    .select("variant_id, size, stock_qty")
    .in("variant_id", variantIds);

  const map: StockMap = {};
  for (const row of data ?? []) {
    const key = `${row.variant_id}__${String(row.size ?? "").toLowerCase()}`;
    map[key] = Number(row.stock_qty ?? 0);
  }
  return map;
}

function useCartStock(items: CartItem[]) {
  const [stockMap, setStockMap] = useState<StockMap>({});
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (items.length === 0) { setStockMap({}); return; }
    setChecking(true);
    fetchCartStock(items).then((map) => {
      setStockMap(map);
      setChecking(false);
    });
  // Re-check whenever the variant IDs change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.variant_id).join(",")]);

  function getStock(item: CartItem): number | null {
    const key = `${item.variant_id}__${item.size.toLowerCase()}`;
    return key in stockMap ? stockMap[key] : null;
  }

  return { getStock, checking };
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface CartTabProps {
  customerId: string;
  onOrderCreated: () => void;
  activeOrderStatus?: string | null; // warn if "closed"
  onGoToOrder?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CartTab({ customerId, onOrderCreated, activeOrderStatus, onGoToOrder }: CartTabProps) {
  const items            = useCartStore((s) => s.items);
  const removeItem       = useCartStore((s) => s.removeItem);
  const updateQty        = useCartStore((s) => s.updateQty);
  const clearCart        = useCartStore((s) => s.clearCart);
  const isCheckingOut    = useCartStore((s) => s.isCheckingOut);
  const checkoutError    = useCartStore((s) => s.checkoutError);
  const setCheckingOut   = useCartStore((s) => s.setCheckingOut);
  const setCheckoutError = useCartStore((s) => s.setCheckoutError);

  const { removeFromSupabase, syncNow } = useCartSync(customerId);
  const { getStock, checking } = useCartStock(items);

  // Items with stock info
  const itemsWithStock = items.map((item) => {
    const stock = getStock(item);
    const outOfStock = stock !== null && stock <= 0;
    const limitedStock = stock !== null && stock > 0 && stock < item.qty;
    return { item, stock, outOfStock, limitedStock };
  });

  const outOfStockCount = itemsWithStock.filter((x) => x.outOfStock).length;

  // Total counts only items with stock available
  const total      = itemsWithStock
    .filter((x) => !x.outOfStock)
    .reduce((a, { item }) => a + item.price_snapshot * item.qty, 0);
  const totalItems = itemsWithStock
    .filter((x) => !x.outOfStock)
    .reduce((a, { item }) => a + item.qty, 0);

  async function handleRemove(item: CartItem) {
    removeItem(item.variant_id, item.size);
    await removeFromSupabase(item.id);
  }

  function handleQty(item: CartItem, delta: number) {
    const next = item.qty + delta;
    if (next <= 0) return; // don't auto-remove
    updateQty(item.variant_id, item.size, next);
  }

  async function handleCheckout() {
    setCheckingOut(true);
    setCheckoutError(null);
    await syncNow();
    const currentItems = useCartStore.getState().items;
    const result = await checkoutCart(currentItems);
    setCheckingOut(false);
    if (result.success) {
      clearCart();
      onOrderCreated();
    } else {
      let msg = result.error ?? "Error al crear el pedido";
      if (msg.includes("conflict_in_progress")) {
        msg = "Hay un pedido en proceso. Esperá unos segundos e intentá nuevamente.";
      } else if (msg.includes("operation_id_conflict")) {
        msg = "El carrito cambió entre intentos. Intentá nuevamente.";
      } else if (/no tiene variante asociada/i.test(msg)) {
        msg = "Hay un producto que ya no está disponible. Eliminalo y volvé a intentar.";
      }
      setCheckoutError(msg);
    }
  }

  if (items.length === 0) {
    return (
      <div style={{
        background: "#fff", borderRadius: 16, padding: "40px 24px",
        textAlign: "center", boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
      }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🛒</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#555", marginBottom: 6 }}>
          Tu carrito está vacío
        </div>
        <p style={{ fontSize: 13, color: "#aaa", margin: "0 0 20px" }}>
          Navegá el catálogo, elegí los productos y agregalos acá
        </p>
        <Link href="/" style={{
          display: "inline-block", padding: "10px 24px", borderRadius: 10,
          background: "#CD844D", color: "#fff", textDecoration: "none",
          fontSize: 14, fontWeight: 600,
        }}>
          Ver catálogo
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Out-of-stock banner */}
      {outOfStockCount > 0 && (
        <div style={{
          background: "#fff5f5", border: "1px solid #fca5a5", borderRadius: 12,
          padding: "12px 14px", marginBottom: 10,
          display: "flex", gap: 10, alignItems: "flex-start",
        }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#991b1b" }}>
              {outOfStockCount === 1
                ? "1 producto sin stock disponible"
                : `${outOfStockCount} productos sin stock disponible`}
            </div>
            <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 2, lineHeight: 1.4 }}>
              Están marcados en rojo. Podés quitarlos o continuar sin ellos.
            </div>
          </div>
        </div>
      )}

      {/* Items */}
      <div style={{
        background: "#fff", borderRadius: 16, marginBottom: 10,
        boxShadow: "0 1px 4px rgba(0,0,0,0.07)", overflow: "hidden",
      }}>
        {itemsWithStock.map(({ item, stock, outOfStock, limitedStock }, idx) => (
          <div key={`${item.variant_id}__${item.size}`} style={{
            borderBottom: idx < items.length - 1 ? "1px solid #f5f5f5" : "none",
          }}>
            <LineItemRow
              imagen={item.imagen}
              productName={item.product_name}
              color={item.color}
              size={item.size}
              quantity={item.qty}
              unitPrice={item.price_snapshot}
              highlight={outOfStock ? "outOfStock" : null}
              line2={outOfStock ? (
                <span style={{ color: "#991b1b" }}>Cant. {item.qty} · sin stock</span>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button onClick={() => handleQty(item, -1)} aria-label="Menos" style={{
                      width: 26, height: 26, borderRadius: 7, border: "1.5px solid #ddd",
                      background: "#fff", cursor: "pointer", fontSize: 15, fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center", color: "#555",
                    }}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 700, minWidth: 16, textAlign: "center" }}>
                      {item.qty}
                    </span>
                    <button onClick={() => handleQty(item, +1)} aria-label="Más" style={{
                      width: 26, height: 26, borderRadius: 7, border: "1.5px solid #ddd",
                      background: "#fff", cursor: "pointer", fontSize: 15, fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center", color: "#555",
                    }}>+</button>
                  </div>
                  <span>· {formatARS(item.price_snapshot)} c/u</span>
                </div>
              )}
              trailing={
                <button onClick={() => handleRemove(item)} aria-label="Eliminar" style={{
                  background: "none", border: "none",
                  color: outOfStock ? "#fca5a5" : "#ccc",
                  cursor: "pointer", padding: 4, marginLeft: 2,
                  display: "flex", alignItems: "center",
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6M14 11v6"/>
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                  </svg>
                </button>
              }
              below={
                outOfStock || limitedStock ? (
                  <span style={{
                    display: "inline-flex", alignItems: "center",
                    fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 20,
                    background: outOfStock ? "#fee2e2" : "#fef3c7",
                    color: outOfStock ? "#991b1b" : "#92400e",
                  }}>
                    {outOfStock ? "Sin stock" : `Máx. ${stock} disponibles`}
                  </span>
                ) : undefined
              }
            />
          </div>
        ))}
      </div>

      {/* Resumen — excludes out-of-stock */}
      <div style={{
        background: "#fff", borderRadius: 14, padding: "14px 16px",
        boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 12,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 13, color: "#888" }}>
            {totalItems} unidad{totalItems !== 1 ? "es" : ""}
            {outOfStockCount > 0 && (
              <span style={{ fontSize: 11, color: "#e05252", marginLeft: 6 }}>
                ({outOfStockCount} sin stock no incluidos)
              </span>
            )}
          </span>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#222" }}>{formatARS(total)}</span>
        </div>
        <div style={{ fontSize: 12, color: "#aaa" }}>Precio por mayor</div>
      </div>

      {/* Error */}
      {checkoutError && (
        <div style={{
          marginBottom: 12, padding: "12px 14px", borderRadius: 10,
          background: "#fef2f2", border: "1px solid #fca5a5", color: "#991b1b", fontSize: 13,
        }}>
          {checkoutError}
        </div>
      )}

      {/* Pedido en preparación — block "Hacer pedido" */}
      {activeOrderStatus === "closed" ? (
        <div>
          <div style={{
            padding: "14px", borderRadius: 12,
            background: "#f5f5f5", border: "1.5px solid #e0d5cb",
            textAlign: "center", marginBottom: 10,
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#555", marginBottom: 4 }}>
              📦 Tenés un pedido en preparación
            </div>
            <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5, marginBottom: 12 }}>
              Para enviar un nuevo pedido primero cancelá la preparación del pedido actual.
            </div>
            {onGoToOrder && (
              <button
                onClick={onGoToOrder}
                style={{
                  padding: "10px 20px", borderRadius: 10, border: "none",
                  background: "#CD844D", color: "#fff",
                  fontSize: 13, fontWeight: 700, cursor: "pointer",
                }}
              >
                Ver pedido en preparación →
              </button>
            )}
          </div>
          <p style={{ fontSize: 11, color: "#aaa", textAlign: "center", margin: "4px 0 0" }}>
            Podés seguir agregando productos al carrito
          </p>
        </div>
      ) : (
        <>
          <button
            onClick={handleCheckout}
            disabled={isCheckingOut || checking}
            style={{
              width: "100%", padding: "16px", borderRadius: 14, border: "none",
              background: isCheckingOut || checking ? "#e8a96b" : "#CD844D",
              color: "#fff", fontSize: 16, fontWeight: 700,
              cursor: isCheckingOut || checking ? "not-allowed" : "pointer",
              boxShadow: "0 4px 14px rgba(205,132,77,0.35)",
            }}
          >
            {checking ? "Verificando stock..." : isCheckingOut ? "Creando pedido..." : "Hacer pedido →"}
          </button>
          <p style={{ fontSize: 11, color: "#aaa", textAlign: "center", margin: "8px 0 0" }}>
            Revisás el detalle antes de enviarlo
          </p>
        </>
      )}
    </div>
  );
}
