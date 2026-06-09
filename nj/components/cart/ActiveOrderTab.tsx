"use client";

import { useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCartStore } from "@/store/cart";

function formatARS(n: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency", currency: "ARS", minimumFractionDigits: 0,
  }).format(n);
}

// Matches ITEM_STATUS_INFO in admin/orders.js
const ITEM_STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  reserved:  { label: "Reservado", color: "#555",    bg: "#f0f0f0" },
  picked:    { label: "Apartado",  color: "#1b5e20", bg: "#e6f4ea" },
  missing:   { label: "Sin stock", color: "#991b1b", bg: "#fee2e2" },
  cancelled: { label: "Cancelado", color: "#991b1b", bg: "#fee2e2" },
  waiting:   { label: "Espera",    color: "#b45309", bg: "#fef3c7" },
};

const ORDER_STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  active:       { label: "Activo",     color: "#1b5e20", bg: "#e6f4ea" },
  closing_soon: { label: "Por cerrar", color: "#92400e", bg: "#fef3c7" },
  closed:       { label: "Cerrado",    color: "#1e40af", bg: "#dbeafe" },
};

interface OrderItem {
  id: string;
  product_name: string;
  color: string;
  size: string;
  quantity: number;
  price_snapshot: number;
  imagen?: string;
  status?: string;
  variant_id?: string;
}

interface ActiveOrder {
  id: string;
  order_number: string;
  status: string;
  total_amount: number;
  created_at: string;
  dismantle_at?: string | null;
  expires_at?: string | null;
  order_items: OrderItem[];
}

const ORDER_DISMANTLE_DAYS = 7;
const WHATSAPP_HREF = "https://wa.me/5493624118637";

function orderDaysRemaining(createdAt: string, dismantleAt?: string | null): number {
  const oneDayMs = 1000 * 60 * 60 * 24;
  const now = Date.now();
  if (dismantleAt) {
    const t = new Date(dismantleAt).getTime();
    if (!Number.isNaN(t)) return Math.max(0, Math.ceil((t - now) / oneDayMs));
  }
  const created = new Date(createdAt).getTime();
  const elapsed = Math.floor((now - created) / oneDayMs);
  return Math.max(0, ORDER_DISMANTLE_DAYS - elapsed);
}

function isOrderExpired(order: ActiveOrder): boolean {
  const now = Date.now();
  if (order.dismantle_at) {
    const t = new Date(order.dismantle_at).getTime();
    if (!Number.isNaN(t)) return now >= t;
  }
  if (!order.created_at) return false;
  const elapsed = (now - new Date(order.created_at).getTime()) / (1000 * 60 * 60 * 24);
  return elapsed >= ORDER_DISMANTLE_DAYS;
}

interface AlternativeProduct {
  Articulo: string;
  Color: string;
  Talle: string;
  Precio: number;
  "Imagen Principal": string;
  variant_id?: string;
}

// ─── Alternatives panel ───────────────────────────────────────────────────────

async function fetchAlternatives(
  articulo: string,
  size: string,
  color: string
): Promise<AlternativeProduct[]> {
  const supabase = getSupabaseBrowserClient();

  // Get product tags
  const { data: catalogRow } = await supabase
    .from("catalog_public_view")
    .select('"Filtro1","Filtro2","Filtro3","Categoria"')
    .eq("Articulo", articulo)
    .limit(1)
    .maybeSingle();

  const filters = [
    catalogRow?.Filtro1,
    catalogRow?.Filtro2,
    catalogRow?.Filtro3,
  ].filter(Boolean) as string[];

  let query = supabase
    .from("catalog_public_view")
    .select('"Articulo","Color","Talle","Precio","Imagen Principal"')
    .eq("Talle", size)
    .neq("Articulo", articulo)
    .gt("Stock", 0)
    .limit(12);

  // Try to match by tags first
  if (filters.length > 0) {
    query = query.or(
      filters.map((f) => `"Filtro1".ilike.${f},"Filtro2".ilike.${f},"Filtro3".ilike.${f}`).join(",")
    );
  } else if (catalogRow?.Categoria) {
    query = query.ilike("Categoria", catalogRow.Categoria);
  }

  const { data } = await query;
  return (data ?? []) as AlternativeProduct[];
}

function AlternativesPanel({
  item,
  onClose,
  onSelected,
}: {
  item: OrderItem;
  onClose: () => void;
  onSelected: (alt: AlternativeProduct) => void;
}) {
  const [alts, setAlts] = useState<AlternativeProduct[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  if (!fetched && !loading) {
    setLoading(true);
    setFetched(true);
    fetchAlternatives(item.product_name, item.size, item.color).then((res) => {
      setAlts(res);
      setLoading(false);
    });
  }

  return (
    <div style={{
      background: "#fffaf6", border: "1.5px solid #f0c898",
      borderRadius: 14, padding: "14px 14px 10px", marginTop: 4,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#555" }}>
          Alternativas en Talle {item.size}
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "none", cursor: "pointer",
          fontSize: 18, color: "#aaa", lineHeight: 1, padding: 2,
        }}>×</button>
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: "12px 0", fontSize: 13, color: "#aaa" }}>
          Buscando alternativas...
        </div>
      )}

      {!loading && alts !== null && alts.length === 0 && (
        <div style={{ textAlign: "center", padding: "10px 0", fontSize: 13, color: "#aaa" }}>
          No encontramos alternativas disponibles en este talle.
        </div>
      )}

      {!loading && alts && alts.length > 0 && (
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
          {alts.map((alt, i) => (
            <button
              key={`${alt.Articulo}-${alt.Color}-${i}`}
              onClick={() => onSelected(alt)}
              style={{
                flexShrink: 0, width: 90, background: "#fff",
                border: "1.5px solid #eee", borderRadius: 10,
                padding: "8px 6px", cursor: "pointer", textAlign: "left",
              }}
            >
              {alt["Imagen Principal"] && (
                <img
                  src={alt["Imagen Principal"]}
                  alt={alt.Articulo}
                  style={{ width: "100%", aspectRatio: "4/5", objectFit: "cover", borderRadius: 6 }}
                />
              )}
              <div style={{ fontSize: 11, fontWeight: 700, color: "#222", marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {alt.Articulo}
              </div>
              <div style={{ fontSize: 10, color: "#888", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {alt.Color}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#CD844D", marginTop: 2 }}>
                {formatARS(alt.Precio)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ActiveOrderTabProps {
  order: ActiveOrder | null;
  onOrderSent: () => void;
  onOrderRefresh: () => void;
  onOrderDismissed: () => void;
}

export default function ActiveOrderTab({ order, onOrderSent, onOrderRefresh, onOrderDismissed }: ActiveOrderTabProps) {
  const [sending, setSending]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [cancelingId, setCancelingId]   = useState<string | null>(null);
  const [altOpenFor, setAltOpenFor]     = useState<string | null>(null);
  const [menuOpenFor, setMenuOpenFor]   = useState<string | null>(null);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const addItem = useCartStore((s) => s.addItem);

  if (!order) {
    return (
      <div style={{
        background: "#fff", borderRadius: 16, padding: "40px 24px",
        textAlign: "center", boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
      }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>📋</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#555", marginBottom: 6 }}>
          No tenés ningún pedido activo
        </div>
        <p style={{ fontSize: 13, color: "#aaa", margin: "0 0 20px" }}>
          Agregá productos al carrito y hacé tu pedido
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

  // ── Sent: "Tu pedido fue enviado" ──────────────────────────────────────────
  if (order.status === "sent") {
    function dismiss() {
      const key = `fyl-order-sent-dismissed-${order!.id}`;
      localStorage.setItem(key, String(Date.now()));
      onOrderDismissed();
    }
    return (
      <div style={{
        background: "#fff", borderRadius: 20, padding: "32px 24px",
        boxShadow: "0 1px 4px rgba(0,0,0,0.07)", textAlign: "center",
        position: "relative",
      }}>
        <button onClick={dismiss} aria-label="Cerrar" style={{
          position: "absolute", top: 14, right: 14,
          background: "none", border: "none", cursor: "pointer",
          fontSize: 20, color: "#ccc", lineHeight: 1,
        }}>×</button>
        <div style={{ fontSize: 52, marginBottom: 10 }}>🚚</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: "#1b5e20", marginBottom: 6 }}>
          ¡Tu pedido fue enviado!
        </div>
        <p style={{ fontSize: 14, color: "#555", lineHeight: 1.5, margin: "0 0 6px" }}>
          Pedido <strong>#{order.order_number}</strong>
        </p>
        <p style={{ fontSize: 13, color: "#888", lineHeight: 1.5, margin: "0 0 24px" }}>
          Ya está en camino. Podés ver el detalle completo en tu historial.
        </p>
        <div style={{ display: "flex", gap: 10, flexDirection: "column" }}>
          <button onClick={dismiss} style={{
            padding: "13px 20px", borderRadius: 12, border: "none",
            background: "#1b5e20", color: "#fff", fontSize: 15, fontWeight: 700,
            cursor: "pointer", boxShadow: "0 4px 12px rgba(27,94,32,0.3)",
          }}>
            Ver en historial
          </button>
          <Link href="/" style={{
            display: "block", padding: "11px 20px", borderRadius: 12,
            border: "1.5px solid #e0d5cb", color: "#888",
            textDecoration: "none", fontSize: 14, fontWeight: 500,
          }}>
            Seguir comprando
          </Link>
        </div>
      </div>
    );
  }

  // ── Closed: "En preparación" (only if no unresolved missing items) ─────────
  if (order.status === "closed") {
    const hasUnresolvedMissing = order.order_items.some(
      (i) => i.status === "missing" && Number(i.quantity ?? 0) > 0
    );
    // If there are missing items the client must resolve → fall through to normal view
    if (hasUnresolvedMissing) {
      /* intentional fall-through — rendered below with full item list */
    } else {
    const totalUnits = order.order_items
      .filter((i) => i.status !== "cancelled" && Number(i.quantity ?? 0) > 0)
      .reduce((a, i) => a + i.quantity, 0);
    const totalAmt = order.order_items
      .filter((i) => i.status !== "cancelled" && Number(i.quantity ?? 0) > 0 && i.status !== "missing")
      .reduce((a, i) => a + i.price_snapshot * i.quantity, 0);

    return (
      <div>
        {/* Status card */}
        <div style={{
          background: "#fff", borderRadius: 16, padding: "20px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 10,
          textAlign: "center", borderTop: "4px solid #CD844D",
        }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>📦</div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#222", marginBottom: 6 }}>
            Tu pedido está en preparación
          </div>
          <p style={{ fontSize: 13, color: "#666", lineHeight: 1.5, margin: "0 0 4px" }}>
            Pedido <strong>#{order.order_number}</strong>
          </p>
          <p style={{ fontSize: 12, color: "#aaa", margin: "0 0 16px" }}>
            {new Date(order.created_at).toLocaleDateString("es-AR", {
              day: "2-digit", month: "long", year: "numeric",
            })}
          </p>
          {/* Animated waiting indicator */}
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 14 }}>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{
                width: 8, height: 8, borderRadius: "50%", background: "#CD844D",
                display: "inline-block",
                animation: `pulse-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
          <style>{`
            @keyframes pulse-dot {
              0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
              40% { opacity: 1; transform: scale(1.1); }
            }
          `}</style>
          <div style={{ fontSize: 12, color: "#CD844D", fontWeight: 600 }}>
            Te avisamos cuando esté listo para enviar
          </div>
        </div>

        {/* Order summary */}
        <div style={{
          background: "#fff", borderRadius: 14, padding: "14px 16px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 10,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ fontSize: 13, color: "#888" }}>
            {totalUnits} unidad{totalUnits !== 1 ? "es" : ""}
          </span>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#222" }}>
            {formatARS(totalAmt)}
          </span>
        </div>

        {/* Items list collapsed */}
        <div style={{
          background: "#fff", borderRadius: 14,
          boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 10,
          overflow: "hidden",
        }}>
          {order.order_items
            .filter((i) => i.status !== "cancelled" && Number(i.quantity ?? 0) > 0)
            .map((item, idx, arr) => {
              const ist = ITEM_STATUS_INFO[item.status ?? "reserved"] ?? ITEM_STATUS_INFO.reserved;
              return (
                <div key={item.id} style={{
                  display: "flex", gap: 10, padding: "12px 16px",
                  borderBottom: idx < arr.length - 1 ? "1px solid #f5f5f5" : "none",
                  alignItems: "center",
                }}>
                  {item.imagen && (
                    <img src={item.imagen} alt={item.product_name} style={{
                      width: 44, height: 44, borderRadius: 7, objectFit: "cover",
                      flexShrink: 0, background: "#f5f5f5",
                    }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#222" }}>
                      {item.product_name}
                    </div>
                    <div style={{ fontSize: 12, color: "#888" }}>
                      {[item.color, item.size && `T. ${item.size}`].filter(Boolean).join(" · ")}
                      {" · "}Cant. {item.quantity}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 20,
                    color: ist.color, background: ist.bg, flexShrink: 0,
                  }}>
                    {ist.label}
                  </span>
                </div>
              );
            })}
        </div>

        <Link href="/" style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "13px", borderRadius: 12,
          background: "#FFF5EE", border: "1.5px solid #f0c898",
          color: "#CD844D", textDecoration: "none", fontSize: 14, fontWeight: 600,
        }}>
          + Seguir eligiendo productos
        </Link>
      </div>
    );
    } // end if (!hasUnresolvedMissing)
  } // end if (order.status === "closed")

  const visibleItems = order.order_items.filter(
    (i) => i.status !== "cancelled" && Number(i.quantity ?? 0) > 0
  );
  const missingItems    = visibleItems.filter((i) => i.status === "missing");
  const regularItems    = visibleItems.filter((i) => i.status !== "missing");
  const totalItems      = regularItems.reduce((a, i) => a + i.quantity, 0);
  const totalAmount     = regularItems.reduce((a, i) => a + i.price_snapshot * i.quantity, 0);
  // Block send if there are unresolved missing items
  const hasMissing      = missingItems.length > 0;
  const canSend         = totalItems >= 4 && !hasMissing;
  const remaining       = Math.max(0, 4 - totalItems);
  // For "closed" orders re-confirming after resolving missing items: allow re-send
  const isClosed        = order.status === "closed";
  const orderStatusInfo = ORDER_STATUS_INFO[order.status] ?? ORDER_STATUS_INFO.active;

  // Deadline logic — same as dashboard-instant.js
  const isExpired    = isOrderExpired(order);
  const daysLeft     = orderDaysRemaining(order.created_at, order.dismantle_at);
  const isReadOnly   = isExpired;                           // expired = no more edits
  const warnSoon     = !isExpired && (daysLeft === 1 || daysLeft === 2);

  async function handleCancelItem(itemId: string) {
    setCancelingId(itemId);
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: itemId });
    setCancelingId(null);
    if (err) {
      setError("No se pudo quitar el producto. Intentá de nuevo.");
    } else {
      setAltOpenFor(null);
      onOrderRefresh();
    }
  }

  async function handleSelectAlternative(missingItem: OrderItem, alt: AlternativeProduct) {
    // Add alternative to cart
    addItem({
      variant_id: alt.variant_id ?? "",
      product_name: alt.Articulo,
      color: alt.Color,
      size: alt.Talle,
      qty: 1,
      price_snapshot: Number(alt.Precio ?? 0),
      imagen: alt["Imagen Principal"],
    });
    // Cancel the missing item from the order
    await handleCancelItem(missingItem.id);
    setAltOpenFor(null);
  }

  async function handleSend() {
    if (!order) return;
    setSending(true);
    setError(null);
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase
      .from("orders")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", order.id);
    setSending(false);
    if (err) {
      setError("No se pudo enviar el pedido. Intentá de nuevo.");
    } else {
      // Refresh — order is now "closed" (En preparación screen will display)
      onOrderSent();
    }
  }

  function renderItem(item: OrderItem, isMissing: boolean) {
    const ist       = ITEM_STATUS_INFO[item.status ?? "reserved"] ?? ITEM_STATUS_INFO.reserved;
    const isAltOpen = altOpenFor === item.id;
    const isMenuOpen = menuOpenFor === item.id;
    const productSlug = encodeURIComponent(item.product_name ?? "");

    return (
      <div key={item.id}>
        <div style={{
          display: "flex", gap: 10, padding: "14px 16px", alignItems: "flex-start",
          background: isMissing ? "#fff5f5" : "transparent",
          borderLeft: isMissing ? "3px solid #fca5a5" : "3px solid transparent",
        }}>
          {item.imagen && (
            <img src={item.imagen} alt={item.product_name} style={{
              width: 52, height: 52, borderRadius: 8, objectFit: "cover",
              flexShrink: 0, background: "#f5f5f5",
              opacity: isMissing ? 0.55 : 1,
              filter: isMissing ? "grayscale(0.3)" : "none",
            }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: isMissing ? "#991b1b" : "#222" }}>
              {item.product_name}
            </div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
              {[item.color, item.size && `Talle ${item.size}`].filter(Boolean).join(" · ")}
              {" · "}Cant. {item.quantity}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
              {item.status && (
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 20,
                  color: ist.color, background: ist.bg,
                }}>
                  {ist.label}
                </span>
              )}
              {/* Missing item inline actions */}
              {isMissing && !isReadOnly && (
                <>
                  <button
                    onClick={() => setAltOpenFor(isAltOpen ? null : item.id)}
                    style={{
                      fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 20,
                      background: "#FFF5EE", border: "1.5px solid #f0c898",
                      color: "#CD844D", cursor: "pointer",
                    }}
                  >
                    {isAltOpen ? "Cerrar" : "Ver alternativas"}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Right: price + kebab menu */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                fontSize: 13, fontWeight: 700,
                color: isMissing ? "#ccc" : "#555",
                textDecoration: isMissing ? "line-through" : "none",
              }}>
                {formatARS(item.price_snapshot * item.quantity)}
              </span>

              {/* Kebab ⋯ */}
              {!isReadOnly && (
                <div style={{ position: "relative" }}>
                  <button
                    onClick={() => setMenuOpenFor(isMenuOpen ? null : item.id)}
                    aria-label="Opciones"
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      fontSize: 18, color: "#aaa", padding: "2px 4px",
                      lineHeight: 1, borderRadius: 6,
                    }}
                  >
                    ⋯
                  </button>

                  {isMenuOpen && (
                    <>
                      {/* backdrop to close on outside click */}
                      <div
                        onClick={() => setMenuOpenFor(null)}
                        style={{
                          position: "fixed", inset: 0, zIndex: 40,
                        }}
                      />
                      <div style={{
                        position: "absolute", right: 0, top: "calc(100% + 4px)",
                        background: "#fff", borderRadius: 12, zIndex: 50,
                        boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
                        minWidth: 170, overflow: "hidden",
                        border: "1px solid #f0f0f0",
                      }}>
                        {/* Quitar del pedido */}
                        <button
                          onClick={() => { setMenuOpenFor(null); handleCancelItem(item.id); }}
                          disabled={cancelingId === item.id}
                          style={{
                            display: "block", width: "100%", padding: "12px 16px",
                            background: "none", border: "none", textAlign: "left",
                            fontSize: 14, fontWeight: 500, color: "#e53e3e",
                            cursor: "pointer", borderBottom: "1px solid #f5f5f5",
                          }}
                        >
                          {cancelingId === item.id ? "Quitando..." : "Quitar del pedido"}
                        </button>
                        {/* Ver producto */}
                        <a
                          href={`/nj/producto/${productSlug}`}
                          onClick={() => setMenuOpenFor(null)}
                          style={{
                            display: "block", padding: "12px 16px",
                            fontSize: 14, fontWeight: 500, color: "#333",
                            textDecoration: "none",
                          }}
                        >
                          Ver producto
                        </a>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Alternatives panel */}
        {isMissing && isAltOpen && (
          <div style={{ padding: "0 14px 10px" }}>
            <AlternativesPanel
              item={item}
              onClose={() => setAltOpenFor(null)}
              onSelected={(alt) => handleSelectAlternative(item, alt)}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Expired overlay — full blocking banner */}
      {isExpired && (
        <div style={{
          background: "#fff", borderRadius: 16, padding: "20px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 10,
          borderTop: "4px solid #CD844D",
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#222", marginBottom: 8, textAlign: "center" }}>
            Tu pedido alcanzó el plazo de 7 días
          </div>
          <p style={{ fontSize: 13, color: "#555", textAlign: "center", margin: "0 0 8px", lineHeight: 1.5 }}>
            Ya no podés modificarlo desde la web, pero todavía no fue desarmado.
          </p>
          <p style={{ fontSize: 13, color: "#555", textAlign: "center", margin: "0 0 16px", lineHeight: 1.5 }}>
            Si querés que lo preparemos o tenés dudas, escribinos por WhatsApp y te ayudamos.
          </p>
          <a
            href={WHATSAPP_HREF}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              width: "100%", padding: "14px", borderRadius: 12, textDecoration: "none",
              background: "#25D366", color: "#fff", fontSize: 15, fontWeight: 700,
              boxShadow: "0 4px 12px rgba(37,211,102,0.35)",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            Escribir por WhatsApp
          </a>
        </div>
      )}

      {/* Header */}
      <div style={{
        background: "#fff", borderRadius: 16, padding: "16px",
        boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 10,
        opacity: isExpired ? 0.6 : 1,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#222" }}>
            Pedido #{order.order_number}
          </span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {/* Days remaining chip */}
            {!isExpired && (
              <span style={{
                fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 20,
                background: warnSoon ? "#fef3c7" : "#f5f5f5",
                color: warnSoon ? "#92400e" : "#666",
              }}>
                {daysLeft === 0 ? "Hoy vence" : `${daysLeft} día${daysLeft !== 1 ? "s" : ""}`}
              </span>
            )}
            <span style={{
              fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20,
              color: orderStatusInfo.color, background: orderStatusInfo.bg,
            }}>
              {orderStatusInfo.label}
            </span>
          </div>
        </div>
        <div style={{ fontSize: 12, color: "#aaa" }}>
          {new Date(order.created_at).toLocaleDateString("es-AR", {
            day: "2-digit", month: "short", year: "numeric",
          })}
        </div>
        {/* Deadline warning — 1 or 2 days left */}
        {warnSoon && (
          <div style={{
            marginTop: 10, padding: "10px 12px", borderRadius: 10,
            background: "#fef3c7", border: "1px solid #fde68a",
            fontSize: 12, color: "#92400e", lineHeight: 1.4,
          }}>
            {daysLeft === 1
              ? canSend
                ? "⏰ Tu pedido se cierra mañana. Finalizalo hoy para asegurarte el envío."
                : `⏰ Tu pedido se cierra mañana. Te faltan ${remaining} unidades para el mínimo. Si no lo completás, el pedido se desarmará.`
              : canSend
                ? "⏰ Faltan 2 días para que se cierre tu pedido. Finalizalo cuando quieras."
                : `⏰ Faltan 2 días para cerrar. Te faltan ${remaining} unidades para el mínimo.`}
          </div>
        )}
      </div>

      {/* "Closed + missing items" banner — admin is processing but found unavailable stock */}
      {isClosed && missingItems.length > 0 && (
        <div style={{
          background: "#fff5f5", border: "1.5px solid #f87171", borderRadius: 12,
          padding: "14px 16px", marginBottom: 10,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#991b1b", marginBottom: 4 }}>
            ⚠️ Tu pedido está siendo preparado, pero hay {missingItems.length === 1 ? "un producto" : `${missingItems.length} productos`} sin stock
          </div>
          <div style={{ fontSize: 12, color: "#b91c1c", lineHeight: 1.45 }}>
            Nuestro equipo no encontró disponibilidad de estos productos. Podés quitarlos o elegir una alternativa para poder confirmar el envío.
          </div>
        </div>
      )}

      {/* Regular missing items warning (active/closing_soon) */}
      {!isClosed && missingItems.length > 0 && (
        <div style={{
          background: "#fff5f5", border: "1px solid #fca5a5", borderRadius: 12,
          padding: "12px 14px", marginBottom: 10, display: "flex", gap: 10, alignItems: "flex-start",
        }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#991b1b" }}>
              {missingItems.length === 1
                ? "1 producto sin stock"
                : `${missingItems.length} productos sin stock`}
            </div>
            <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 2, lineHeight: 1.4 }}>
              Podés quitarlos o elegir una alternativa disponible.
            </div>
          </div>
        </div>
      )}

      {/* Items list */}
      <div style={{
        background: "#fff", borderRadius: 16, marginBottom: 10,
        boxShadow: "0 1px 4px rgba(0,0,0,0.07)", overflow: "hidden",
      }}>
        {/* Missing items first */}
        {missingItems.map((item, idx) => (
          <div key={item.id} style={{
            borderBottom: idx < missingItems.length - 1 || regularItems.length > 0
              ? "1px solid #f5f5f5" : "none",
          }}>
            {renderItem(item, true)}
          </div>
        ))}

        {/* Regular items */}
        {regularItems.map((item, idx) => (
          <div key={item.id} style={{
            borderBottom: idx < regularItems.length - 1 ? "1px solid #f5f5f5" : "none",
          }}>
            {renderItem(item, false)}
          </div>
        ))}

        {visibleItems.length === 0 && (
          <div style={{ padding: "20px 16px", textAlign: "center", color: "#aaa", fontSize: 13 }}>
            No hay productos en este pedido
          </div>
        )}
      </div>

      {/* Total (excludes missing items) */}
      <div style={{
        background: "#fff", borderRadius: 14, padding: "14px 16px",
        boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 12,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <span style={{ fontSize: 13, color: "#888" }}>
            {totalItems} unidad{totalItems !== 1 ? "es" : ""}
          </span>
          {missingItems.length > 0 && (
            <div style={{ fontSize: 11, color: "#aaa", marginTop: 1 }}>
              Los productos sin stock no se incluyen
            </div>
          )}
        </div>
        <span style={{ fontSize: 17, fontWeight: 700, color: "#222" }}>
          {formatARS(totalAmount)}
        </span>
      </div>

      {/* Minimum progress */}
      {!canSend && totalItems > 0 && (
        <div style={{
          background: "#fff", borderRadius: 14, padding: "14px 16px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 12,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#555" }}>Mínimo de envío</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#CD844D" }}>
              {totalItems} / 4 unidades
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 99, background: "#f0ebe4", overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 99, background: "#CD844D",
              width: `${Math.min(100, (totalItems / 4) * 100)}%`, transition: "width 0.3s",
            }} />
          </div>
          <div style={{ fontSize: 12, color: "#aaa", marginTop: 8 }}>
            Necesitás al menos {remaining} unidad{remaining !== 1 ? "es" : ""} más para enviar
          </div>
          <Link href="/" style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            marginTop: 12, padding: "11px 16px", borderRadius: 10,
            background: "#FFF5EE", border: "1.5px solid #f0c898",
            color: "#CD844D", textDecoration: "none", fontSize: 14, fontWeight: 600,
          }}>
            + Seguir eligiendo productos
          </Link>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          marginBottom: 12, padding: "12px 14px", borderRadius: 10,
          background: "#fef2f2", border: "1px solid #fca5a5", color: "#991b1b", fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* When expired: only show WhatsApp + send if 4+ */}
      {isExpired ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {canSend && (
            <button
              onClick={() => setShowSendConfirm(true)}
              disabled={sending}
              style={{
                width: "100%", padding: "16px", borderRadius: 14, border: "none",
                background: sending ? "#e8a96b" : "#CD844D",
                color: "#fff", fontSize: 16, fontWeight: 700,
                cursor: sending ? "not-allowed" : "pointer",
                boxShadow: "0 4px 14px rgba(205,132,77,0.35)",
              }}
            >
              {sending ? "Enviando..." : "✓ Enviar pedido"}
            </button>
          )}
          <a
            href={WHATSAPP_HREF}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              width: "100%", padding: "14px", borderRadius: 12, textDecoration: "none",
              background: "#25D366", color: "#fff", fontSize: 15, fontWeight: 700,
              boxShadow: "0 4px 12px rgba(37,211,102,0.3)",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            Escribir por WhatsApp
          </a>
        </div>
      ) : (
        /* Normal send button — opens confirmation dialog first */
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Missing items block */}
          {hasMissing && (
            <div style={{
              padding: "11px 14px", borderRadius: 10,
              background: "#fff5f5", border: "1px solid #fca5a5",
              fontSize: 12, color: "#991b1b", lineHeight: 1.45,
            }}>
              ⛔ Tenés {missingItems.length} producto{missingItems.length > 1 ? "s" : ""} sin stock.
              Quitálos o reemplazálos antes de enviar el pedido.
            </div>
          )}
          <button
            onClick={() => {
              if (!canSend) return;
              setShowSendConfirm(true);
            }}
            disabled={!canSend || sending}
            style={{
              width: "100%", padding: "16px", borderRadius: 14, border: "none",
              background: !canSend ? "#e8e0d8" : sending ? "#e8a96b" : "#CD844D",
              color: !canSend ? "#b0a090" : "#fff",
              fontSize: 16, fontWeight: 700,
              cursor: !canSend || sending ? "not-allowed" : "pointer",
              boxShadow: canSend ? "0 4px 14px rgba(205,132,77,0.35)" : "none",
              transition: "background 0.2s",
            }}
          >
            {sending
              ? "Enviando..."
              : hasMissing
                ? `⛔ Resolvé los productos sin stock`
                : canSend
                  ? isClosed ? "✓ Confirmar pedido" : "✓ Enviar pedido"
                  : totalItems === 0
                    ? "Agregá productos para enviar"
                    : `Faltan ${remaining} unidad${remaining !== 1 ? "es" : ""} para enviar`}
          </button>
        </div>
      )}

      {/* ── Confirmation modal ─────────────────────────────────────────────── */}
      {showSendConfirm && (
        <div
          onClick={() => setShowSendConfirm(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            zIndex: 9999, display: "flex", alignItems: "flex-end",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff", borderRadius: "20px 20px 0 0",
              padding: "28px 24px 36px", width: "100%",
              boxShadow: "0 -4px 24px rgba(0,0,0,0.12)",
              animation: "slide-up-modal 0.22s ease",
            }}
          >
            <style>{`@keyframes slide-up-modal { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
            <div style={{ fontSize: 36, textAlign: "center", marginBottom: 12 }}>📦</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#222", textAlign: "center", marginBottom: 8 }}>
              ¿Enviamos tu pedido?
            </div>
            <p style={{ fontSize: 13, color: "#666", textAlign: "center", lineHeight: 1.55, margin: "0 0 6px" }}>
              Tu pedido tiene <strong>{totalItems} unidades</strong> por un total de <strong>{formatARS(totalAmount)}</strong>.
            </p>
            <p style={{ fontSize: 13, color: "#888", textAlign: "center", lineHeight: 1.5, margin: "0 0 24px" }}>
              Una vez enviado, lo prepararemos para el despacho. Si hay algún cambio te avisamos.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                onClick={async () => { setShowSendConfirm(false); await handleSend(); }}
                disabled={sending}
                style={{
                  padding: "16px", borderRadius: 14, border: "none",
                  background: sending ? "#e8a96b" : "#CD844D",
                  color: "#fff", fontSize: 16, fontWeight: 700,
                  cursor: sending ? "not-allowed" : "pointer",
                  boxShadow: "0 4px 14px rgba(205,132,77,0.3)",
                }}
              >
                {sending ? "Enviando..." : "Sí, enviar pedido"}
              </button>
              <button
                onClick={() => setShowSendConfirm(false)}
                style={{
                  padding: "14px", borderRadius: 12, border: "1.5px solid #e0d5cb",
                  background: "transparent", color: "#888", fontSize: 15, fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
