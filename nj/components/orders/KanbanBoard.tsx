"use client";

import { useEffect, useMemo, useState } from "react";
import { filterOrdersForColumn } from "@/lib/orders/classification";
import { useOrdersStore } from "@/hooks/useOrders";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadWarehouses } from "@/lib/supabase/order-queries";
import type { AdminOrder } from "@/types/orders";
import KanbanColumn from "./KanbanColumn";
import KanbanDrawer from "./KanbanDrawer";
import NewOrderForm from "./NewOrderForm";
import { OrdersToastContainer } from "./OrdersToast";

interface KanbanBoardProps {
  initialOrders: AdminOrder[];
}

type DrawerId = "closed" | "stock_pending" | "picked" | "waiting" | "cancelled" | null;
/** Vista inline mobile: el header (☰, + Pedido, Enviados, botones) se mantiene siempre. */
type MobileQuickView = "active" | "waiting" | "cancelled";

const MAIN_COLUMNS = [
  { id: "active" as const, label: "Activos" },
  { id: "picked" as const, label: "Apartados" },
  { id: "cancelled" as const, label: "Cancelados" },
  { id: "waiting" as const, label: "Espera" },
];

/** Columnas que quedan en el menú ☰ mobile. Espera y Cancelados salieron a botones fijos. */
const MOBILE_MENU_COLUMNS: { id: Exclude<DrawerId, null>; label: string; icon: string }[] = [
  { id: "picked", label: "Apartados", icon: "📌" },
  { id: "closed", label: "Cerrados", icon: "📦" },
];

export default function KanbanBoard({ initialOrders }: KanbanBoardProps) {
  const [drawer, setDrawer] = useState<DrawerId>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileView, setMobileView] = useState<MobileQuickView>("active");
  const hydrate = useOrdersStore((s) => s.hydrate);
  const refreshAll = useOrdersStore((s) => s.refreshAll);
  const subscribeNewOrders = useOrdersStore((s) => s.subscribeNewOrders);
  const hydrated = useOrdersStore((s) => s.hydrated);
  const allOrders = useOrdersStore((s) => s.orders);

  const closedCount = useMemo(
    () => filterOrdersForColumn(allOrders, "closed").length,
    [allOrders]
  );
  const activeCount = useMemo(
    () => filterOrdersForColumn(allOrders, "active").length,
    [allOrders]
  );
  const waitingCount = useMemo(
    () => filterOrdersForColumn(allOrders, "waiting").length,
    [allOrders]
  );
  const cancelledCount = useMemo(
    () => filterOrdersForColumn(allOrders, "cancelled").length,
    [allOrders]
  );
  const stockPendingCount = useMemo(
    () => filterOrdersForColumn(allOrders, "stock_pending").length,
    [allOrders]
  );

  const openDrawer = (id: Exclude<DrawerId, null>) => setDrawer(id);
  const closeDrawer = () => setDrawer(null);

  useEffect(() => {
    hydrate(initialOrders);
    const supabase = getSupabaseBrowserClient();
    void loadWarehouses(supabase).then((warehouseIds) => {
      useOrdersStore.setState({ warehouseIds });
    });
  }, [initialOrders, hydrate]);

  useEffect(() => {
    const unsubscribe = subscribeNewOrders();
    return unsubscribe;
  }, [subscribeNewOrders]);

  // Respaldo: al volver a la pestaña o cada 20s si está visible
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const pollId = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshAll();
    }, 20000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(pollId);
    };
  }, [refreshAll]);

  useEffect(() => {
    if (drawer === "closed" && closedCount === 0) setDrawer(null);
    if (drawer === "stock_pending" && stockPendingCount === 0) setDrawer(null);
  }, [drawer, closedCount, stockPendingCount]);

  return (
    <div className="kanban-shell">
      <div className="kanban-header">
        <div className="kanban-header__mobile-nav">
          <button
            type="button"
            className="kanban-mobile-menu-btn"
            aria-label="Ver otras columnas"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((v) => !v)}
          >
            ☰
          </button>
          <NewOrderForm className="kanban-mobile-add-btn" label="+ Pedido" />
          {mobileMenuOpen ? (
            <>
              <div
                className="kanban-mobile-menu-catcher"
                role="presentation"
                onClick={() => setMobileMenuOpen(false)}
              />
              <div className="kanban-mobile-menu" role="menu">
                {MOBILE_MENU_COLUMNS.map((col) => {
                  const count =
                    col.id === "closed"
                      ? closedCount
                      : filterOrdersForColumn(allOrders, col.id).length;
                  return (
                    <button
                      key={col.id}
                      type="button"
                      className="kanban-mobile-menu__item"
                      role="menuitem"
                      onClick={() => {
                        setMobileMenuOpen(false);
                        openDrawer(col.id);
                      }}
                    >
                      <span>
                        {col.icon} {col.label}
                      </span>
                      <span className="kanban-column__count">{count}</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
        <h1 className="kanban-header__title">Pedidos</h1>
        <div className="kanban-header__alerts">
          {!hydrated ? <span className="kanban-column__count">…</span> : null}
          {closedCount > 0 ? (
            <button
              type="button"
              className="kanban-alert-btn kanban-alert-btn--neutral"
              onClick={() => openDrawer("closed")}
            >
              📦 Cerrados {closedCount}
            </button>
          ) : null}
          <a
            href="http://localhost:5500/admin/sent-orders.html"
            className="kanban-alert-btn kanban-alert-btn--neutral"
          >
            🚚 Enviados
          </a>
          {stockPendingCount > 0 ? (
            <button
              type="button"
              className="kanban-alert-btn kanban-alert-btn--danger"
              onClick={() => openDrawer("stock_pending")}
            >
              ⚠️ Stock Pend. {stockPendingCount}
            </button>
          ) : null}
        </div>
      </div>

      <div className="kanban-mobile-quick" aria-label="Accesos rápidos de pedidos">
        {mobileView === "waiting" ? (
          <button
            type="button"
            className="kanban-mobile-quick__btn kanban-mobile-quick__btn--activos"
            onClick={() => setMobileView("active")}
            aria-label={`Volver a Activos: ${activeCount} pedidos`}
          >
            <span className="kanban-mobile-quick__label">Activos</span>
            <span className="kanban-mobile-quick__count">{activeCount}</span>
          </button>
        ) : (
          <button
            type="button"
            className="kanban-mobile-quick__btn kanban-mobile-quick__btn--waiting"
            onClick={() => setMobileView("waiting")}
            aria-label={`Espera: ${waitingCount} pedidos`}
          >
            <span className="kanban-mobile-quick__label">
              <span aria-hidden="true">⏳</span> Espera
            </span>
            <span className="kanban-mobile-quick__count">{waitingCount}</span>
          </button>
        )}
        {mobileView === "cancelled" ? (
          <button
            type="button"
            className="kanban-mobile-quick__btn kanban-mobile-quick__btn--activos"
            onClick={() => setMobileView("active")}
            aria-label={`Volver a Activos: ${activeCount} pedidos`}
          >
            <span className="kanban-mobile-quick__label">Activos</span>
            <span className="kanban-mobile-quick__count">{activeCount}</span>
          </button>
        ) : (
          <button
            type="button"
            className="kanban-mobile-quick__btn kanban-mobile-quick__btn--cancelled"
            onClick={() => setMobileView("cancelled")}
            aria-label={`Cancelados: ${cancelledCount} pedidos`}
          >
            <span className="kanban-mobile-quick__label">
              <span aria-hidden="true">🚫</span> Cancelados
            </span>
            <span className="kanban-mobile-quick__count">{cancelledCount}</span>
          </button>
        )}
      </div>

      <div className="kanban-main">
        {MAIN_COLUMNS.map((col) => {
          // Mobile: solo la vista actual (Activos / Espera / Cancelados). Desktop: las 4.
          const showOnMobile = col.id === mobileView;
          return (
            <div
              key={col.id}
              className={`kanban-column-slot${showOnMobile ? "" : " kanban-column-slot--mobile-hidden"}`}
            >
              <KanbanColumn
                columnId={col.id}
                label={col.label}
                showAddButton={col.id === "picked"}
              />
            </div>
          );
        })}
      </div>

      {drawer ? <KanbanDrawer columnId={drawer} onClose={closeDrawer} /> : null}

      <OrdersToastContainer />
    </div>
  );
}
