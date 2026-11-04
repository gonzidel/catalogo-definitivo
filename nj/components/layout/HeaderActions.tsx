"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCartStore, selectCartCount } from "@/store/cart";
import NotificationsPanel from "@/components/notifications/NotificationsPanel";
import WhatsAppButton from "@/components/contact/WhatsAppButton";
import WhatsAppIcon from "@/components/contact/WhatsAppIcon";
import FullOnly from "@/components/rollout/FullOnly";
import { openCatalogAccount } from "@/components/rollout/CatalogAccountNotice";
import { EXP_CATALOG_ONLY, EXP_FULL_ONLY } from "@/lib/rollout/client";

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
  const cartCount = useCartStore(selectCartCount);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isDashboard = pathname?.includes("/dashboard");
  const dashboardTab = searchParams.get("tab");
  const cartActive = !!isDashboard && (dashboardTab === "cart" || !dashboardTab);
  const orderActive = !!isDashboard && dashboardTab === "active-order";

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

  const profileStyle = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 34, height: 34, borderRadius: "50%",
    textDecoration: "none", overflow: "hidden",
    border: isLoggedIn ? "2px solid #CD844D" : "none",
    flexShrink: 0,
  } as const;

  const profileContent = isLoggedIn && userInfo?.avatarUrl ? (
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
  );

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {/* ── catalog: consulta por WhatsApp en lugar de la campana ── */}
        <WhatsAppButton
          variant="header"
          className={EXP_CATALOG_ONLY}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, borderRadius: "50%",
            background: "#25D366", color: "#fff",
            textDecoration: "none", flexShrink: 0,
          }}
        >
          <WhatsAppIcon width={20} height={20} fill="currentColor" />
        </WhatsAppButton>

        {/* ── Campana de notificaciones ── */}
        <button
          className={EXP_FULL_ONLY}
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

        <div className={`desktop-commerce ${EXP_FULL_ONLY}`}>
          <Link
            href="/dashboard?tab=cart"
            className={`desktop-commerce__link${cartActive ? " is-active" : ""}`}
            aria-label={
              cartCount > 0
                ? `Carrito, ${cartCount} producto${cartCount === 1 ? "" : "s"}`
                : "Carrito"
            }
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="9" cy="21" r="1" />
              <circle cx="20" cy="21" r="1" />
              <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
            </svg>
            Carrito
            {cartCount > 0 && (
              <span className="desktop-commerce__badge">
                {cartCount > 9 ? "9+" : cartCount}
              </span>
            )}
          </Link>
          <Link
            href="/dashboard?tab=active-order"
            className={`desktop-commerce__link${orderActive ? " is-active" : ""}`}
            aria-label="Mi pedido"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 2h12v4H6z" />
              <path d="M6 6h12l-1 16H7L6 6z" />
            </svg>
            Mi pedido
          </Link>
        </div>

        {/* ── Perfil — oculto en el dashboard (la foto aparece en el header propio) ──
             catalog anónimo: sin «Ingresar», como el catálogo público (/login sigue por URL). */}
        {!isDashboard && (
          <Link
            href={isLoggedIn ? "/dashboard" : "/login"}
            className={EXP_FULL_ONLY}
            aria-label={isLoggedIn ? "Mi cuenta" : "Ingresar"}
            style={profileStyle}
          >
            {profileContent}
          </Link>
        )}
        {/* catalog + cuenta sin full: el avatar muestra la cuenta y permite cerrar sesión */}
        {!isDashboard && isLoggedIn && (
          <button
            type="button"
            className={EXP_CATALOG_ONLY}
            onClick={openCatalogAccount}
            aria-label="Mi cuenta"
            style={{ ...profileStyle, background: "none", padding: 0, cursor: "pointer" }}
          >
            {profileContent}
          </button>
        )}
      </div>

      {/* ── Notifications panel (portal) ── */}
      <FullOnly>
        <NotificationsPanel
          customerId={userInfo?.id ?? null}
          syntheticNotifications={syntheticNotifications}
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          onUnreadCountChange={handleUnreadCount}
        />
      </FullOnly>
    </>
  );
}
