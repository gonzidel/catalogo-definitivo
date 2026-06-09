"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import CartTab from "@/components/cart/CartTab";
import ActiveOrderTab from "@/components/cart/ActiveOrderTab";
import { useCartStore, selectCartCount } from "@/store/cart";

// ─── Types ────────────────────────────────────────────────────────────────────

// Item statuses match ITEM_STATUS_INFO in admin/orders.js
const ITEM_STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  reserved:  { label: "Reservado",       color: "#555",    bg: "#f0f0f0" },
  picked:    { label: "Apartado",        color: "#1b5e20", bg: "#e6f4ea" },
  missing:   { label: "Falta",           color: "#991b1b", bg: "#fee2e2" },
  cancelled: { label: "Cancelado",       color: "#991b1b", bg: "#fee2e2" },
  waiting:   { label: "Espera",          color: "#b45309", bg: "#fef3c7" },
};

interface OrderItem {
  id: string;
  product_name: string;
  color: string;
  size: string;
  quantity: number;
  price_snapshot: number;
  imagen?: string;
  sku?: string;
  status?: string;
}

interface Order {
  id: string;
  order_number: string;
  status: string;
  total_amount: number;
  created_at: string;
  payment_method?: string;
  dismantle_at?: string | null;
  expires_at?: string | null;
  order_items: OrderItem[];
}

interface Customer {
  id: string;
  full_name?: string;
  email?: string;
  phone?: string;
  city?: string;
  province?: string;
  customer_number?: string;
  created_at?: string;
}

interface DashboardClientProps {
  user: { id: string; email: string };
  customer: Customer | null;
  orders: Order[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Matches ORDER_STATUS_LABELS in admin/orders.js
const STATUS_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  active:        { label: "Activo",          color: "#1b5e20", bg: "#e6f4ea" },
  closing_soon:  { label: "Por cerrar",      color: "#92400e", bg: "#fef3c7" },
  closed:        { label: "Cerrado",         color: "#1e40af", bg: "#dbeafe" },
  sent:          { label: "Enviado",         color: "#065f46", bg: "#d1fae5" },
  pending:       { label: "Pendiente",       color: "#92400e", bg: "#fef3c7" },
  stock_pending: { label: "Stock pendiente", color: "#5b21b6", bg: "#ede9fe" },
  waiting:       { label: "Espera",          color: "#b45309", bg: "#fef3c7" },
  cancelled:     { label: "Cancelado",       color: "#991b1b", bg: "#fee2e2" },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function formatARS(n: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency", currency: "ARS", minimumFractionDigits: 0,
  }).format(n);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABELS[status] ?? { label: status, color: "#555", bg: "#f0f0f0" };
  return (
    <span style={{
      display: "inline-block", padding: "3px 10px", borderRadius: 20,
      fontSize: 11, fontWeight: 600, color: s.color, background: s.bg, whiteSpace: "nowrap",
    }}>
      {s.label}
    </span>
  );
}

function OrderCard({ order, expanded, onToggle }: {
  order: Order; expanded: boolean; onToggle: () => void;
}) {
  return (
    <div style={{
      background: "#fff", borderRadius: 14, marginBottom: 10,
      overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
    }}>
      <button onClick={onToggle} style={{
        width: "100%", display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "14px 16px",
        background: "none", border: "none", cursor: "pointer", textAlign: "left", gap: 8,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#222" }}>
              #{order.order_number}
            </span>
            <StatusBadge status={order.status} />
          </div>
          <div style={{ fontSize: 12, color: "#999", marginTop: 3 }}>
            {formatDate(order.created_at)} · {order.order_items.reduce((a, i) => a + i.quantity, 0)} unidades
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#CD844D" }}>
            {formatARS(order.total_amount)}
          </span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </button>
      {expanded && (
        <div style={{ borderTop: "1px solid #f0f0f0", padding: "0 16px 16px" }}>
          {order.order_items.map((item) => {
            const ist = ITEM_STATUS_INFO[item.status ?? "reserved"] ?? ITEM_STATUS_INFO.reserved;
            const isCancelled = item.status === "cancelled";
            return (
              <div key={item.id} style={{
                display: "flex", gap: 10, paddingTop: 12, alignItems: "flex-start",
                opacity: isCancelled ? 0.5 : 1,
              }}>
                {item.imagen && (
                  <img src={item.imagen} alt={item.product_name} style={{
                    width: 48, height: 48, borderRadius: 6,
                    objectFit: "cover", flexShrink: 0, background: "#f5f5f5",
                  }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>{item.product_name}</div>
                  <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                    {[item.color, item.size && `Talle ${item.size}`].filter(Boolean).join(" · ")}
                    {" · "}Cant. {item.quantity}
                  </div>
                  {item.status && (
                    <span style={{
                      display: "inline-block", marginTop: 4,
                      fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 20,
                      color: ist.color, background: ist.bg,
                    }}>
                      {ist.label}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#555", flexShrink: 0 }}>
                  {formatARS(item.price_snapshot * item.quantity)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type TabId = "cart" | "active-order" | "orders" | "profile";

export default function DashboardClient({ user, customer, orders: initialOrders }: DashboardClientProps) {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [tab, setTab] = useState<TabId>("cart");
  const cartCount = useCartStore(selectCartCount);

  // Priority: active → closing_soon → closed → sent (if recently sent / not dismissed)
  const statusRank = (s: string) => {
    if (s === "active")       return 0;
    if (s === "closing_soon") return 1;
    if (s === "closed")       return 2;
    if (s === "sent")         return 3;
    return 99;
  };

  // "Mi pedido" shows: active, closing_soon, closed, and sent (if not dismissed)
  const MY_ORDER_STATUSES = new Set(["active", "closing_soon", "closed", "sent"]);
  const activeOrder = [...orders]
    .filter((o) => {
      if (!MY_ORDER_STATUSES.has(o.status)) return false;
      // For "sent" orders: only show if user hasn't dismissed the notification
      if (o.status === "sent") {
        const key = `fyl-order-sent-dismissed-${o.id}`;
        const dismissed = typeof window !== "undefined" ? localStorage.getItem(key) : null;
        if (dismissed) return false; // already dismissed by user
      }
      return true;
    })
    .sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      return r !== 0 ? r : new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })[0] ?? null;

  // History = everything NOT shown in Mi pedido
  const historyOrders = orders.filter((o) => {
    if (o.id === activeOrder?.id) return false;
    return !MY_ORDER_STATUSES.has(o.status) || o.status === "sent";
  });

  async function handleLogout() {
    setLoggingOut(true);
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function refreshOrders() {
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase
      .from("orders")
      .select(`
        id, order_number, status, total_amount, created_at, payment_method, dismantle_at, expires_at,
        order_items ( id, product_name, color, size, quantity, price_snapshot, imagen, sku, status )
      `)
      .eq("customer_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) setOrders(data as Order[]);
  }

  function handleOrderCreated() {
    refreshOrders().then(() => setTab("active-order"));
  }

  // When user manually dismisses: move to history
  function handleOrderSent() {
    refreshOrders().then(() => setTab("active-order"));
  }

  function handleOrderDismissed() {
    refreshOrders().then(() => setTab("orders"));
  }

  // Realtime: watch the active order for status changes (e.g. sent by admin)
  // Realtime: watch the active order and its items for status changes
  useEffect(() => {
    if (!activeOrder || !["active", "closing_soon", "closed"].includes(activeOrder.status)) return;

    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`order-watch-${activeOrder.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${activeOrder.id}` },
        () => { refreshOrders(); }
      )
      .on(
        // Watch order_items for missing/picked status changes set by admin
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "order_items", filter: `order_id=eq.${activeOrder.id}` },
        () => { refreshOrders(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrder?.id, activeOrder?.status]);

  const displayName = customer?.full_name ?? user.email.split("@")[0] ?? "Cliente";

  const TABS = [
    {
      id: "cart" as TabId,
      label: cartCount > 0 ? `🛒 Carrito (${cartCount})` : "🛒 Carrito",
    },
    {
      id: "active-order" as TabId,
      label: activeOrder ? "📋 Mi pedido" : "📋 Mi pedido",
    },
    { id: "orders" as TabId, label: "🕐 Historial" },
    { id: "profile" as TabId, label: "👤 Perfil" },
  ];

  return (
    <div style={{ minHeight: "100svh", background: "#E5E1DC" }}>
      {/* Header */}
      <div style={{
        background: "#fff", padding: "16px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: "1px solid #eee", position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link href="/" style={{ display: "flex", textDecoration: "none" }}>
            <img src="/nj/logo.png" alt="FYL" style={{ height: 36, objectFit: "contain" }} />
          </Link>
          <span style={{ fontSize: 14, color: "#aaa" }}>/ Mi cuenta</span>
        </div>
        <button onClick={handleLogout} disabled={loggingOut} style={{
          background: "none", border: "1px solid #ddd", borderRadius: 8,
          padding: "6px 12px", fontSize: 13, color: "#666",
          cursor: loggingOut ? "not-allowed" : "pointer",
        }}>
          {loggingOut ? "Saliendo..." : "Cerrar sesión"}
        </button>
      </div>

      <div style={{ padding: "16px", maxWidth: 640, margin: "0 auto" }}>
        {/* Welcome */}
        <div style={{
          background: "#fff", borderRadius: 16, padding: "20px",
          marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
        }}>
          <div style={{ fontSize: 13, color: "#888" }}>Hola,</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#222", marginTop: 2 }}>
            {displayName}
          </div>
          {customer?.customer_number && (
            <div style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>
              Cliente #{customer.customer_number}
            </div>
          )}
        </div>

        {/* Tabs — scroll horizontal en mobile */}
        <div style={{
          display: "flex", gap: 6, marginBottom: 12,
          overflowX: "auto", paddingBottom: 2,
          scrollbarWidth: "none",
        }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flexShrink: 0, padding: "10px 12px", borderRadius: 12, border: "none",
                background: tab === t.id ? "#CD844D" : "#fff",
                color: tab === t.id ? "#fff" : "#555",
                fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
                cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                transition: "all 0.15s",
                position: "relative",
              }}
            >
              {t.label}
              {/* Dot indicator on "Mi pedido" when there's an active order */}
              {t.id === "active-order" && activeOrder && tab !== "active-order" && (
                <span style={{
                  position: "absolute", top: 6, right: 6,
                  width: 7, height: 7, borderRadius: "50%",
                  background: "#e85d04", border: "1.5px solid #fff",
                }} />
              )}
            </button>
          ))}
        </div>

        {/* ── Tab: Carrito ── */}
        {tab === "cart" && (
          <CartTab
            customerId={user.id}
            onOrderCreated={handleOrderCreated}
          />
        )}

        {/* ── Tab: Mi pedido ── */}
        {tab === "active-order" && (
          <ActiveOrderTab
            order={activeOrder}
            onOrderSent={handleOrderSent}
            onOrderRefresh={refreshOrders}
            onOrderDismissed={handleOrderDismissed}
          />
        )}

        {/* ── Tab: Historial ── */}
        {tab === "orders" && (
          <>
            {historyOrders.length === 0 ? (
              <div style={{
                background: "#fff", borderRadius: 16, padding: "32px",
                textAlign: "center", color: "#aaa",
              }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🛍️</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#555", marginBottom: 6 }}>
                  Todavía no enviaste ningún pedido
                </div>
                <p style={{ fontSize: 13, color: "#aaa", margin: "0 0 16px" }}>
                  Acá aparecen los pedidos confirmados
                </p>
                <Link href="/" style={{
                  display: "inline-block", padding: "10px 20px", borderRadius: 10,
                  background: "#CD844D", color: "#fff",
                  textDecoration: "none", fontSize: 14, fontWeight: 600,
                }}>
                  Ver catálogo
                </Link>
              </div>
            ) : (
              historyOrders.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  expanded={expandedOrder === order.id}
                  onToggle={() =>
                    setExpandedOrder(expandedOrder === order.id ? null : order.id)
                  }
                />
              ))
            )}
          </>
        )}

        {/* ── Tab: Perfil ── */}
        {tab === "profile" && (
          <div style={{
            background: "#fff", borderRadius: 16, padding: "20px",
            boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
          }}>
            {[
              { label: "Nombre",    value: customer?.full_name },
              { label: "Email",     value: customer?.email ?? user.email },
              { label: "Teléfono",  value: customer?.phone },
              { label: "Ciudad",    value: customer?.city },
              { label: "Provincia", value: customer?.province },
            ].map(({ label, value }) =>
              value ? (
                <div key={label} style={{
                  display: "flex", justifyContent: "space-between",
                  padding: "12px 0", borderBottom: "1px solid #f5f5f5",
                }}>
                  <span style={{ fontSize: 13, color: "#888" }}>{label}</span>
                  <span style={{ fontSize: 14, fontWeight: 500, color: "#333" }}>{value}</span>
                </div>
              ) : null
            )}
            <div style={{ marginTop: 20, textAlign: "center" }}>
              <a href="/dashboard/perfil" style={{
                display: "inline-block", padding: "10px 20px", borderRadius: 10,
                border: "1.5px solid #ddd", color: "#555", textDecoration: "none", fontSize: 14,
              }}>
                Editar perfil
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
