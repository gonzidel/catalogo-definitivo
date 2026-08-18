"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { getTransporte, canonicalizeTransportName, getTransportesDisponibles } from "@/lib/transport";
import { resolveShippingOptions, getTransportExplanationText, isLocalPickupTransport } from "@/lib/transport/shipping-helpers";
import { useRouter, useSearchParams } from "next/navigation";
import { getCustomerFacingItemStatus } from "@/lib/orders/waiting-source";
import { getOrderDeadlineDate } from "@/lib/orders/deadline";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadWarehouses } from "@/lib/supabase/order-queries";
import type { WarehouseIds } from "@/types/orders";
import CartTab from "@/components/cart/CartTab";
import ActiveOrderTab from "@/components/cart/ActiveOrderTab";
import ProfileTab from "@/components/profile/ProfileTab";
import { useProfileGate } from "@/components/profile/ProfileGateProvider";
import { useCartStore, selectCartCount } from "@/store/cart";

// Mirrors dashboard-instant.js buildSyntheticDeadlineNotificationsList
function buildDeadlineNotifications(order: { id: string; status: string; created_at: string; dismantle_at?: string | null; order_items: { quantity: number; status?: string }[] } | null) {
  if (!order || !["active", "closing_soon"].includes(order.status)) return [];

  const oneDayMs = 1000 * 60 * 60 * 24;
  const now = Date.now();
  const deadline = getOrderDeadlineDate(order.created_at, order.dismantle_at).getTime();
  const daysLeft = Math.max(0, Math.ceil((deadline - now) / oneDayMs));

  if (daysLeft !== 1 && daysLeft !== 2 && daysLeft !== 0) return [];

  const totalItems = order.order_items
    .filter((i) => i.status !== "cancelled" && i.status !== "missing" && Number(i.quantity ?? 0) > 0)
    .reduce((a: number, i) => a + i.quantity, 0);
  const hasMin = totalItems >= 4;
  const missing = Math.max(0, 4 - totalItems);
  const tier = daysLeft === 2 ? 5 : 6;

  const message = tier === 5
    ? hasMin
      ? "Faltan 2 días para que se cierre tu pedido. Cerralo cuando quieras para que lo preparemos."
      : `Faltan 2 días para que se cierre tu pedido.<br>Te faltan ${missing} productos para alcanzar el mínimo y poder cerrarlo.`
    : hasMin
      ? "Tu pedido se cierra mañana.<br>Cerralo hoy para que podamos prepararlo."
      : `Tu pedido se cierra mañana.<br>Te faltan ${missing} productos para alcanzar el mínimo.<br>Si no lo completás, el pedido se desarmará.`;

  const isExpired = daysLeft === 0;
  const expiredMsg = "Tu pedido alcanzó el plazo de 7 días. Ya no se puede editar desde la web y está pendiente de desarme por administración.";

  const results = [];
  if (isExpired) {
    results.push({
      id: `synthetic-order-expired-pending-disassembly-${order.id}`,
      type: "ORDER_EXPIRED_PENDING_DISASSEMBLY",
      message: expiredMsg,
      read: false,
      created_at: order.dismantle_at ?? order.created_at,
    });
  } else {
    results.push({
      id: `synthetic-order-deadline-${order.id}-${tier}`,
      type: "ORDER_DEADLINE_REMINDER",
      message,
      read: false,
      created_at: order.dismantle_at ?? order.created_at,
    });
  }
  return results;
}

// ─── Types ────────────────────────────────────────────────────────────────────

// Estados visibles para cliente: solo mostramos incidencias reales.
const ITEM_STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  missing:   { label: "Sin stock",       color: "#991b1b", bg: "#fee2e2" },
  cancelled: { label: "Cancelado",       color: "#991b1b", bg: "#fee2e2" },
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
  created_at?: string;
  variant_id?: string;
  order_item_stock_sources?: { warehouse_id: string; qty: number }[];
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
  notes?: string | null;
  order_items: OrderItem[];
}

interface Customer {
  id: string;
  full_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  dni?: string;
  city?: string;
  province?: string;
  customer_number?: string;
  transport_id?: string | null;
  created_at?: string;
}

interface DashboardClientProps {
  user: { id: string; email: string };
  customer: Customer | null;
  orders: Order[];
  /** Transporte asignado manualmente al cliente (customers.transport_id -> transports.name), ej. "MyM" o "SEDE" -- no siempre se puede derivar de provincia/localidad. */
  assignedTransportName?: string | null;
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

const OPERATIONAL_ITEM_STATUSES = new Set(["reserved", "picked", "waiting", "missing"]);

function orderHasOperationalItems(order: Order): boolean {
  return (order.order_items ?? []).some(
    (i) =>
      OPERATIONAL_ITEM_STATUSES.has((i.status ?? "reserved").toLowerCase()) &&
      Number(i.quantity ?? 0) > 0
  );
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

function OrderCard({ order, expanded, onToggle, warehouseIds }: {
  order: Order; expanded: boolean; onToggle: () => void; warehouseIds: WarehouseIds;
}) {
  // Historial = "qué se le mandó finalmente" -- un ítem cancelado (ej. se
  // marcó sin stock y la clienta lo quitó, o un reemplazo por alternativa)
  // no formó parte del pedido final, no debería contarse ni listarse acá.
  const visibleItems = order.order_items.filter((item) => item.status !== "cancelled");
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
            {formatDate(order.created_at)} · {visibleItems.reduce((a, i) => a + i.quantity, 0)} unidades
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
          {visibleItems.map((item) => {
            const displayKey = getCustomerFacingItemStatus(item, warehouseIds);
            const ist = ITEM_STATUS_INFO[displayKey];
            return (
              <div key={item.id} style={{
                display: "flex", gap: 10, paddingTop: 12, alignItems: "flex-start",
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
                  {ist && (
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

function IconCart({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

function IconOrder({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      <line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  );
}

function IconHistory({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconProfile({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export default function DashboardClient({ user, customer: initialCustomer, orders: initialOrders, assignedTransportName }: DashboardClientProps) {
  const router = useRouter();
  const { profileUpdatedAt } = useProfileGate();
  // Estado propio (no solo prop): así los cambios guardados en ProfileTab sobreviven
  // el desmontaje/remontaje del tab "Perfil" al navegar entre pestañas del dashboard.
  const [customer, setCustomer] = useState<Customer | null>(initialCustomer);
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  // getTransporte() lee la elección guardada en localStorage; este contador solo
  // fuerza un re-render para que el header recalcule effectiveTransport al toque.
  const [transportRefreshTick, setTransportRefreshTick] = useState(0);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const [loggingOut, setLoggingOut] = useState(false);
  const [warehouseIds, setWarehouseIds] = useState<WarehouseIds>({
    general: null,
    ventaPublico: null,
  });
  const cartCount = useCartStore(selectCartCount);
  const setActiveOrderStatus      = useCartStore((s) => s.setActiveOrderStatus);
  const setSyntheticNotifications = useCartStore((s) => s.setSyntheticNotifications);

  const VALID_TABS = new Set<TabId>(["cart", "active-order", "orders", "profile"]);
  const paramTab = searchParams.get("tab") as TabId | null;
  const [tab, setTab] = useState<TabId>(
    paramTab && VALID_TABS.has(paramTab) ? paramTab : "cart"
  );
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // Notificaciones / deep-links: ?tab=active-order debe cambiar la pestaña
  // aunque el dashboard ya esté montado (solo useState no alcanza).
  useEffect(() => {
    const t = searchParams.get("tab") as TabId | null;
    if (t && VALID_TABS.has(t)) setTab(t);
    // VALID_TABS is a stable Set literal for this component scope
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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
      if (!orderHasOperationalItems(o)) return false;
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
        id, order_number, status, total_amount, created_at, payment_method, dismantle_at, expires_at, notes,
        order_items ( id, product_name, color, size, quantity, price_snapshot, imagen, sku, status, created_at, variant_id, order_item_stock_sources(warehouse_id, qty) )
      `)
      .eq("customer_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) setOrders(data as Order[]);
  }

  async function refreshCustomer() {
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase
      .from("customers")
      .select(
        "id, full_name, email, phone, address, dni, city, province, customer_number, transport_id, created_at"
      )
      .eq("id", user.id)
      .maybeSingle();
    if (data) setCustomer(data as Customer);
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

  // Revert closed → active: go to cart tab so user can add more
  function handleOrderCancelled() {
    refreshOrders().then(() => setTab("cart"));
  }

  const [showCancelSuccess, setShowCancelSuccess] = useState(false);

  function handleOrderFullyCancelled() {
    setShowCancelSuccess(true);
    refreshOrders().then(() => setTab("active-order"));
  }

  function handleCancelSuccessDismiss() {
    setShowCancelSuccess(false);
    setTab("cart");
  }

  // Tras router.refresh() del server, sincronizar props → estado local
  // (useState solo toma initialCustomer en el primer mount).
  // No pisar con null: tras el onboarding el refetch client puede llegar antes.
  useEffect(() => {
    if (initialCustomer) setCustomer(initialCustomer);
  }, [initialCustomer]);

  useEffect(() => {
    setOrders(initialOrders);
  }, [initialOrders]);

  // Tras completar el onboarding de perfil, refetch inmediato (sin F5).
  useEffect(() => {
    if (!profileUpdatedAt) return;
    void refreshCustomer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileUpdatedAt, user.id]);

  // Sync active order status + synthetic notifications to Zustand
  useEffect(() => {
    setActiveOrderStatus(activeOrder?.status ?? null);
    setSyntheticNotifications(buildDeadlineNotifications(activeOrder));
  }, [activeOrder?.id, activeOrder?.status, setActiveOrderStatus, setSyntheticNotifications]);

  useEffect(() => {
    void loadWarehouses(getSupabaseBrowserClient()).then(setWarehouseIds);
  }, []);

  useEffect(() => {
    getSupabaseBrowserClient().auth.getSession().then(({ data }: { data: any }) => {
      const meta = data.session?.user?.user_metadata ?? {};
      setAvatarUrl(meta.avatar_url ?? meta.picture ?? null);
    });
  }, []);

  // Realtime + refresh al volver a la pestaña: estados (reservado/apartado) y pedidos nuevos.
  // RLS limita eventos al cliente; no hace falta filtrar por order_id.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void refreshOrders();
      }, 200);
    };

    const channel = supabase
      .channel(`order-watch-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `customer_id=eq.${user.id}`,
        },
        scheduleRefresh
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "order_items" },
        scheduleRefresh
      )
      .subscribe();

    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshOrders();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    // Respaldo liviano si Realtime se cae (solo con pestaña visible)
    const pollId = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshOrders();
    }, 20000);

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      window.clearInterval(pollId);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  const displayName = customer?.full_name ?? user.email.split("@")[0] ?? "Cliente";

  // Resolve transport name from province+city (same logic as ProfileShippingBlock)
  const [showTransportInfo, setShowTransportInfo] = useState(false);
  const transportInfoRef = useRef<HTMLDivElement>(null);
  const effectiveTransport = (() => {
    const prov = (customer?.province || "").trim();
    const city = (customer?.city || "").trim();
    if (!prov || !city) return null;
    const raw = getTransportesDisponibles(prov, city);
    const resolved = resolveShippingOptions(prov, city, raw);
    const auto = canonicalizeTransportName(getTransporte(prov, city));
    return resolved.opciones.includes(auto) ? auto : (resolved.opciones[0] ?? null);
  })();
  const isCorreo = effectiveTransport ? canonicalizeTransportName(effectiveTransport) === "Correo Argentino" : false;
  // Si el admin le asignó un transporte puntual al cliente (ej. MyM, que no
  // sale del cálculo automático por provincia/localidad), ese manda sobre
  // el auto-calculado -- mismo criterio que attachTransportMeta en el admin.
  const orderTransportName = effectiveTransport && isLocalPickupTransport(effectiveTransport)
    ? effectiveTransport
    : (assignedTransportName ?? effectiveTransport);

  const transportExplanation = effectiveTransport
    ? getTransportExplanationText(effectiveTransport)
    : null;

  const PRIMARY_TABS = [
    { id: "cart" as TabId,         label: "Carrito",   sublabel: "Lo que querés pedir",      iconType: "cart" as const,  badge: cartCount > 0 ? String(cartCount) : null },
    { id: "active-order" as TabId, label: "Mi pedido", sublabel: "Pedido abierto o listo para cerrar", iconType: "order" as const, badge: activeOrder && tab !== "active-order" ? "·" : null },
  ];

  return (
    <div className="dashboard-shell" style={{ minHeight: "100svh", background: "#E5E1DC" }}>
      {/* Header compacto: icono perfil + nombre + accesos secundarios en una sola fila */}
      <div style={{
        background: "#fff", padding: "10px 14px",
        display: "flex", alignItems: "center", gap: 10,
        borderBottom: "1px solid #eee",
        position: "sticky", top: 0, zIndex: 10,
      }}>
        {/* Foto de perfil (izquierda) — toca para ir a Perfil */}
        <button
          type="button"
          onClick={() => setTab("profile")}
          aria-label="Ver perfil"
          style={{
            width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
            background: "#CD844D", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            border: tab === "profile" ? "2px solid #CD844D" : "2px solid transparent",
            outline: tab === "profile" ? "2px solid #CD844D" : "none",
            outlineOffset: 1,
            cursor: "pointer", padding: 0, overflow: "hidden",
            transition: "outline 0.15s",
          }}
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt="Foto de perfil"
              width={36} height={36}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
              referrerPolicy="no-referrer"
            />
          ) : (
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.5px" }}>
              {displayName.charAt(0).toUpperCase()}
            </span>
          )}
        </button>

        {/* Nombre + transporte */}
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#222", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayName}
          </div>

          {/* Fila transporte (key fuerza recalcular effectiveTransport si el cliente elige otro en su perfil) */}
          <div key={transportRefreshTick} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
            {effectiveTransport ? (
              <>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
                </svg>
                <span style={{ fontSize: 11, color: "#999", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {effectiveTransport}
                </span>
                <button
                  type="button"
                  onClick={() => setShowTransportInfo((v) => !v)}
                  aria-label="¿Cómo funciona tu retiro o envío?"
                  style={{
                    width: 15, height: 15, borderRadius: "50%", flexShrink: 0,
                    background: showTransportInfo ? "#CD844D" : "#e0d8d0",
                    color: showTransportInfo ? "#fff" : "#888",
                    border: "none", cursor: "pointer",
                    fontSize: 9, fontWeight: 800,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    lineHeight: 1, transition: "background 0.15s",
                  }}
                >
                  ?
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setTab("profile")}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
              >
                <span style={{ fontSize: 11, color: "#CD844D", textDecoration: "underline dotted", textUnderlineOffset: 2 }}>
                  Configurar retiro/envío
                </span>
              </button>
            )}
          </div>

          {/* Popover transporte */}
          {showTransportInfo && effectiveTransport && (
            <>
              <div
                onClick={() => setShowTransportInfo(false)}
                style={{ position: "fixed", inset: 0, zIndex: 998 }}
              />
              <div ref={transportInfoRef} style={{
                position: "absolute", top: "calc(100% + 8px)", left: 0,
                zIndex: 999, width: 260,
                background: "#fff", borderRadius: 12,
                boxShadow: "0 6px 24px rgba(0,0,0,0.13)",
                border: "1px solid #f0e8e0", padding: "13px 14px",
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#222", marginBottom: 5, display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#CD844D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
                  </svg>
                  {effectiveTransport}
                </div>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "#555", lineHeight: 1.55 }}>
                  {transportExplanation}
                </p>
                <button
                  type="button"
                  onClick={() => { setShowTransportInfo(false); setTab("profile"); }}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    fontSize: 11, color: "#CD844D", fontWeight: 600, padding: 0,
                    textDecoration: "underline dotted", textUnderlineOffset: 2,
                  }}
                >
                  Cambiar retiro/envío →
                </button>
              </div>
            </>
          )}
        </div>

        {/* Accesos secundarios */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <button
            onClick={() => setTab("orders")}
            aria-label="Historial"
            style={{
              background: tab === "orders" ? "#f5f0eb" : "none", border: "none",
              cursor: "pointer", borderRadius: 8, padding: "6px 8px",
              color: tab === "orders" ? "#CD844D" : "#aaa",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
            }}
          >
            <IconHistory size={18} />
            <span style={{ fontSize: 9, fontWeight: 600, lineHeight: 1 }}>Historial</span>
          </button>
          <button
            onClick={() => setTab("profile")}
            aria-label="Perfil"
            style={{
              background: tab === "profile" ? "#f5f0eb" : "none", border: "none",
              cursor: "pointer", borderRadius: 8, padding: "6px 8px",
              color: tab === "profile" ? "#CD844D" : "#aaa",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
            }}
          >
            <IconProfile size={18} />
            <span style={{ fontSize: 9, fontWeight: 600, lineHeight: 1 }}>Perfil</span>
          </button>
        </div>
      </div>

      <div style={{ padding: "12px 16px", maxWidth: 640, margin: "0 auto" }}>

        <div
          className={[
            "dashboard-commerce-tabs",
            tab === "active-order" ? "is-order" : "",
            tab === "cart" ? "is-cart" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {/* ── Primary tabs: Carrito + Mi pedido ── */}
          <div className="dashboard-primary-tabs" role="tablist" aria-label="Carrito y pedido">
            {PRIMARY_TABS.map((t, index) => {
              const isActive = tab === t.id;
              return (
                <button
                  key={t.id}
                  id={`dashboard-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`dashboard-panel-${t.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                    event.preventDefault();
                    const dir = event.key === "ArrowRight" ? 1 : -1;
                    const next = PRIMARY_TABS[(index + dir + PRIMARY_TABS.length) % PRIMARY_TABS.length];
                    setTab(next.id);
                    window.requestAnimationFrame(() => {
                      document.getElementById(`dashboard-tab-${next.id}`)?.focus();
                    });
                  }}
                  className={[
                    "dashboard-primary-tab",
                    isActive ? "is-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span className="dashboard-primary-tab__label">
                    {t.iconType === "cart" ? <IconCart size={16} /> : <IconOrder size={16} />}
                    {t.label}
                  </span>
                  {t.badge && (
                    <span
                      className={[
                        "dashboard-primary-tab__badge",
                        t.badge === "·" ? "tab-badge-dot--pulse" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {t.badge === "·" ? "" : t.badge}
                      {t.badge === "·" && <span className="dashboard-primary-tab__dot" />}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {tab === "cart" && (
            <div
              id="dashboard-panel-cart"
              role="tabpanel"
              aria-labelledby="dashboard-tab-cart"
              className="dashboard-primary-panel"
            >
              <CartTab
                customerId={user.id}
                onOrderCreated={handleOrderCreated}
                activeOrderStatus={activeOrder?.status ?? null}
                onGoToOrder={() => setTab("active-order")}
              />
            </div>
          )}

          {tab === "active-order" && (
            <div
              id="dashboard-panel-active-order"
              role="tabpanel"
              aria-labelledby="dashboard-tab-active-order"
              className="dashboard-primary-panel"
            >
              <ActiveOrderTab
                order={activeOrder}
                customerId={user.id}
                customerProvince={customer?.province ?? null}
                customerCity={customer?.city ?? null}
                showCancelSuccess={showCancelSuccess}
                onCancelSuccessDismiss={handleCancelSuccessDismiss}
                onOrderSent={handleOrderSent}
                onOrderRefresh={refreshOrders}
                onOrderDismissed={handleOrderDismissed}
                onOrderCancelled={handleOrderCancelled}
                onOrderFullyCancelled={handleOrderFullyCancelled}
                transportName={orderTransportName}
              />
            </div>
          )}
        </div>

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
                  Todavía no finalizaste ningún pedido
                </div>
                <p style={{ fontSize: 13, color: "#aaa", margin: "0 0 16px" }}>
                  Acá aparecen los pedidos que ya finalizaste
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
                  warehouseIds={warehouseIds}
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
          <ProfileTab
            customer={customer}
            userEmail={user.email}
            userId={user.id}
            onLogout={handleLogout}
            loggingOut={loggingOut}
            onCustomerUpdate={(patch) => setCustomer((prev) => ({ ...(prev ?? { id: user.id }), ...patch }))}
            onTransportChange={() => setTransportRefreshTick((t) => t + 1)}
          />
        )}
      </div>
    </div>
  );
}
