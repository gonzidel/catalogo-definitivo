"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DbNotification {
  id: number;
  customer_id: string;
  order_id?: string | null;
  type: string;
  message: string;
  payload?: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
  read_at?: string | null;
}

interface SyntheticNotification {
  id: string; // starts with "synthetic-"
  type: string;
  message: string;
  read: boolean;
  created_at: string;
  payload?: { action_url?: string };
}

type AnyNotification = DbNotification | SyntheticNotification;

// ─── Constants (mirrors scripts/notifications.js) ──────────────────────────

const TYPE_LABELS: Record<string, string> = {
  ORDER_MISSING_ITEMS: "Faltantes",
  ORDER_ALL_RESERVED: "Reservado",
  ORDER_PACKAGED_TODAY: "Envío",
  ORDER_DEADLINE_REMINDER: "Pedido",
  ORDER_EXPIRED_PENDING_DISASSEMBLY: "Pedido",
  ORDER_DISMANTLED_TIMEOUT: "Pedido",
  ORDER_MARKED_DEVOLUCION: "Pedido",
};

const CHIP_COLOR: Record<string, { bg: string; color: string }> = {
  missing: { bg: "#fef2f2", color: "#b91c1c" },
  reserved: { bg: "#f0fdf4", color: "#166534" },
  default: { bg: "#f5f5f5", color: "#555" },
};

function chipKind(type: string) {
  if (type === "ORDER_ALL_RESERVED") return "reserved";
  if (type === "ORDER_MISSING_ITEMS") return "missing";
  return "default";
}

function isSynthetic(id: string | number) {
  return String(id).startsWith("synthetic-");
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  const now = new Date();
  const time = date.toLocaleTimeString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay =
    date.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) ===
    now.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
  if (sameDay) return `Hoy ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) ===
    yesterday.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
  if (isYesterday) return `Ayer ${time}`;
  return date.toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }) + ` ${time}`;
}

function mergeAndSort(db: DbNotification[], synth: SyntheticNotification[]): AnyNotification[] {
  const merged: AnyNotification[] = [...synth, ...db];
  merged.sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return tb - ta;
  });
  return merged;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface NotificationsPanelProps {
  customerId: string | null;
  /** Synthetic notifications built from active order state */
  syntheticNotifications: SyntheticNotification[];
  open: boolean;
  onClose: () => void;
  onUnreadCountChange: (count: number) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function NotificationsPanel({
  customerId,
  syntheticNotifications,
  open,
  onClose,
  onUnreadCountChange,
}: NotificationsPanelProps) {
  const [notifications, setNotifications] = useState<AnyNotification[]>([]);
  const channelRef = useRef<ReturnType<ReturnType<typeof getSupabaseBrowserClient>["channel"]> | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // ── Load from Supabase ─────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    let dbData: DbNotification[] = [];

    if (customerId) {
      const { data } = await supabase
        .from("customer_notifications")
        .select("id,customer_id,order_id,type,message,payload,read,created_at,read_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(30);
      dbData = (data as DbNotification[]) ?? [];
    }

    const merged = mergeAndSort(dbData, syntheticNotifications);
    setNotifications(merged);
    const unread = merged.filter((n) => !n.read).length;
    onUnreadCountChange(unread);
  }, [customerId, syntheticNotifications, onUnreadCountChange]);

  // ── Initial load + reload when syntheticNotifications changes ─────────────

  useEffect(() => { load(); }, [load]);

  // ── Realtime subscription ──────────────────────────────────────────────────

  useEffect(() => {
    if (!customerId) return;
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel(`notif-panel-${customerId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "customer_notifications", filter: `customer_id=eq.${customerId}` },
        () => load()
      )
      .subscribe();
    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); };
  }, [customerId, load]);

  // ── Mark read on open ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!open || !customerId) return;
    const supabase = getSupabaseBrowserClient();
    (async () => {
      const { data } = await supabase
        .from("customer_notifications")
        .select("id,type")
        .eq("customer_id", customerId)
        .eq("read", false)
        .limit(50);

      // Only auto-mark types that don't require a click (mirrors original MARK_READ_ON_CLICK_TYPES)
      const CLICK_TYPES = new Set(["ORDER_MISSING_ITEMS"]);
      const ids = ((data as { id: number; type: string }[]) ?? [])
        .filter((n) => !CLICK_TYPES.has(n.type))
        .map((n) => n.id);

      if (ids.length > 0) {
        await supabase
          .from("customer_notifications")
          .update({ read: true, read_at: new Date().toISOString() })
          .in("id", ids);
        await load();
      }
    })();
  }, [open, customerId, load]);

  // ── Keyboard close ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // ── Handle item click ──────────────────────────────────────────────────────

  async function handleItemClick(n: AnyNotification) {
    const CLICK_TYPES = new Set(["ORDER_MISSING_ITEMS"]);
    if (!isSynthetic(n.id) && CLICK_TYPES.has(n.type)) {
      const supabase = getSupabaseBrowserClient();
      await supabase
        .from("customer_notifications")
        .update({ read: true, read_at: new Date().toISOString() })
        .eq("id", n.id as number);
      await load();
    }
    onClose();

    // Navigate to dashboard active-order tab for order-related notifications
    const ORDER_TYPES = new Set([
      "ORDER_MISSING_ITEMS", "ORDER_ALL_RESERVED", "ORDER_PACKAGED_TODAY",
      "ORDER_DEADLINE_REMINDER", "ORDER_EXPIRED_PENDING_DISASSEMBLY",
      "ORDER_DISMANTLED_TIMEOUT",
    ]);
    if (ORDER_TYPES.has(n.type)) {
      window.location.href = "/dashboard?tab=active-order";
    }
  }

  if (!mounted) return null;

  const panel = (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
          zIndex: 9000,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.2s",
        }}
        aria-hidden="true"
      />

      {/* Slide-in panel */}
      <aside
        aria-label="Notificaciones"
        aria-hidden={!open}
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0,
          width: "min(340px, 100vw)",
          background: "#fff",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
          zIndex: 9001,
          display: "flex", flexDirection: "column",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 18px",
          borderBottom: "1px solid #f0ebe4",
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#222" }}>Notificaciones</span>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 22, color: "#aaa", lineHeight: 1, padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
          {notifications.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#bbb", fontSize: 14 }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>🔔</div>
              No tenés notificaciones.
            </div>
          ) : (
            notifications.map((n) => {
              const kind = chipKind(n.type);
              const chip = CHIP_COLOR[kind];
              const unread = !n.read;
              return (
                <div
                  key={String(n.id)}
                  onClick={() => handleItemClick(n)}
                  style={{
                    padding: "12px 18px",
                    borderBottom: "1px solid #f5f5f5",
                    cursor: "pointer",
                    background: unread ? "#fffaf5" : "#fff",
                    borderLeft: unread ? "3px solid #CD844D" : "3px solid transparent",
                    transition: "background 0.15s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                      background: chip.bg, color: chip.color, flexShrink: 0,
                    }}>
                      {TYPE_LABELS[n.type] ?? "Aviso"}
                    </span>
                    <span style={{ fontSize: 11, color: "#bbb", marginLeft: "auto" }}>
                      {formatWhen(n.created_at)}
                    </span>
                    {unread && (
                      <span style={{
                        width: 7, height: 7, borderRadius: "50%",
                        background: "#CD844D", flexShrink: 0,
                      }} />
                    )}
                  </div>
                  <div
                    style={{ fontSize: 13, color: "#333", lineHeight: 1.5 }}
                    dangerouslySetInnerHTML={{ __html: n.message }}
                  />
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );

  return createPortal(panel, document.body);
}
