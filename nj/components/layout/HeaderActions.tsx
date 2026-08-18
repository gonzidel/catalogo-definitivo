"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCartStore } from "@/store/cart";
import NotificationsPanel from "@/components/notifications/NotificationsPanel";

interface UserInfo {
  id: string;
  avatarUrl: string | null;
  initials: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function HeaderActions() {
  const [userInfo, setUserInfo]   = useState<UserInfo | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const syntheticNotifications = useCartStore((s) => s.syntheticNotifications);
  const pathname = usePathname();
  const isDashboard = pathname?.includes("/dashboard");

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    function extractUser(session: { user: { id: string; user_metadata?: Record<string, string>; email?: string } } | null): UserInfo | null {
      if (!session) return null;
      const meta = session.user.user_metadata ?? {};
      const avatar = meta.avatar_url ?? meta.picture ?? null;
      const name: string = meta.full_name ?? meta.name ?? session.user.email ?? "";
      const initials = name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((w: string) => w[0].toUpperCase())
        .join("");
      return { id: session.user.id, avatarUrl: avatar, initials: initials || "?" };
    }

    supabase.auth.getSession().then(({ data }: { data: any }) => {
      setUserInfo(extractUser(data.session));
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event: any, session: any) => {
      setUserInfo(extractUser(session));
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const handleUnreadCount = useCallback((count: number) => {
    setUnreadCount(count);
  }, []);

  const isLoggedIn = userInfo !== null;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {/* ── Campana de notificaciones ── */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          aria-label="Notificaciones"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, borderRadius: "50%",
            background: "none", border: "none", cursor: "pointer",
            color: "#555", position: "relative",
          }}
        >
          <svg
            width="22" height="22" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          {/* Badge */}
          {unreadCount > 0 && (
            <span style={{
              position: "absolute", top: 4, right: 4,
              width: 8, height: 8, borderRadius: "50%",
              background: "#CD844D",
              border: "1.5px solid #fff",
            }} />
          )}
        </button>

        {/* ── Perfil — oculto en el dashboard (la foto aparece en el header propio) ── */}
        {!isDashboard && (
          <Link
            href={isLoggedIn ? "/dashboard" : "/login"}
            aria-label={isLoggedIn ? "Mi cuenta" : "Iniciar sesión"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 34, height: 34, borderRadius: "50%",
              textDecoration: "none", overflow: "hidden",
              border: isLoggedIn ? "2px solid #CD844D" : "none",
              flexShrink: 0,
            }}
          >
            {isLoggedIn && userInfo?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={userInfo.avatarUrl}
                alt="Foto de perfil"
                width={34} height={34}
                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
                referrerPolicy="no-referrer"
              />
            ) : isLoggedIn ? (
              <div style={{
                width: "100%", height: "100%",
                background: "#CD844D", color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 700, borderRadius: "50%",
              }}>
                {userInfo?.initials}
              </div>
            ) : (
              <svg
                width="22" height="22" viewBox="0 0 24 24"
                fill="none" stroke="#555" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            )}
          </Link>
        )}
      </div>

      {/* ── Notifications panel (portal) ── */}
      <NotificationsPanel
        customerId={userInfo?.id ?? null}
        syntheticNotifications={syntheticNotifications}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onUnreadCountChange={handleUnreadCount}
      />
    </>
  );
}
