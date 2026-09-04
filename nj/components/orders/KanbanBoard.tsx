"use client";

import { useEffect, useMemo, useState } from "react";
import { filterOrdersForColumn } from "@/lib/orders/classification";
import {
  boardTitleForScope,
  filterOrdersByBoardScope,
  type BoardScope,
} from "@/lib/orders/board-scope";
import { useOrdersStore } from "@/hooks/useOrders";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadWarehouses } from "@/lib/supabase/order-queries";
import type { AdminOrder } from "@/types/orders";
import KanbanColumn from "./KanbanColumn";
import KanbanDrawer from "./KanbanDrawer";
import NewOrderForm from "./NewOrderForm";
import OrderMessageBell from "./OrderMessageBell";
import OrderPaymentsPanel, { usePaymentPendingCount } from "./OrderPaymentsPanel";
import LocalCannotSeparateAlert from "./LocalCannotSeparateAlert";
import { OrdersToastContainer } from "./OrdersToast";
import { useIsMobile } from "@/hooks/useIsMobile";

interface KanbanBoardProps {
  initialOrders: AdminOrder[];
  scope?: BoardScope;
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

export default function KanbanBoard({
  initialOrders,
  scope = "shipping",
}: KanbanBoardProps) {
  const [drawer, setDrawer] = useState<DrawerId>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileView, setMobileView] = useState<MobileQuickView>("active");
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const isMobile = useIsMobile();
  const paymentPendingCount = usePaymentPendingCount();
  const hydrate = useOrdersStore((s) => s.hydrate);
  const refreshAll = useOrdersStore((s) => s.refreshAll);
  const subscribeNewOrders = useOrdersStore((s) => s.subscribeNewOrders);
  const boardScope = useOrdersStore((s) => s.boardScope);
  const hydrated = useOrdersStore((s) => s.hydrated);
  const allOrders = useOrdersStore((s) => s.orders);
  const warehouseIds = useOrdersStore((s) => s.warehouseIds);
  const title = boardTitleForScope(scope);

  const columnFilterCtx = useMemo(
    () => ({ boardScope, warehouseIds }),
    [boardScope, warehouseIds]
  );

  const closedCount = useMemo(
    () => filterOrdersForColumn(allOrders, "closed", columnFilterCtx).length,
    [allOrders, columnFilterCtx]
  );
  const activeCount = useMemo(
    () => filterOrdersForColumn(allOrders, "active", columnFilterCtx).length,
    [allOrders, columnFilterCtx]
  );
  const waitingCount = useMemo(
    () => filterOrdersForColumn(allOrders, "waiting", columnFilterCtx).length,
    [allOrders, columnFilterCtx]
  );
  const cancelledCount = useMemo(
    () => filterOrdersForColumn(allOrders, "cancelled", columnFilterCtx).length,
    [allOrders, columnFilterCtx]
  );
  const stockPendingCount = useMemo(
    () => filterOrdersForColumn(allOrders, "stock_pending", columnFilterCtx).length,
    [allOrders, columnFilterCtx]
  );

  const openDrawer = (id: Exclude<DrawerId, null>) => setDrawer(id);
  const closeDrawer = () => setDrawer(null);

  useEffect(() => {
    hydrate(initialOrders, scope);
    const supabase = getSupabaseBrowserClient();
    void loadWarehouses(supabase).then((warehouseIds) => {
      useOrdersStore.setState((state) => ({
        warehouseIds,
        orders: filterOrdersByBoardScope(state.orders, state.boardScope, {
          warehouseIds,
        }),
      }));
    });
  }, [initialOrders, hydrate, scope]);

  useEffect(() => {
    const unsubscribe = subscribeNewOrders();
    return unsubscribe;
  }, [subscribeNewOrders, boardScope]);

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
    <div className={`kanban-shell${scope === "local_pickup" ? " kanban-shell--retiro" : ""}`}>
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
                      : filterOrdersForColumn(allOrders, col.id, columnFilterCtx).length;
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
                {scope === "shipping" ? (
                  <button
                    type="button"
                    className="kanban-mobile-menu__item"
                    role="menuitem"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      setPaymentsOpen(true);
                    }}
                  >
                    <span>💳 Pagos</span>
                    {paymentPendingCount > 0 ? (
                      <span className="kanban-column__count kanban-column__count--alert">
                        {paymentPendingCount}
                      </span>
                    ) : (
                      <span className="kanban-column__count">0</span>
                    )}
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
        <h1 className="kanban-header__title">{title}</h1>
        {scope === "shipping" || isMobile || scope === "local_pickup" ? (
          <OrderMessageBell boardScope={scope} />
        ) : null}
        <div className="kanban-header__alerts">
          {!hydrated ? <span className="kanban-column__count">…</span> : null}
          {scope === "shipping" && !isMobile ? (
            <button
              type="button"
              className={`kanban-alert-btn kanban-alert-btn--neutral${paymentPendingCount > 0 ? " kanban-alert-btn--has-badge" : ""}`}
              onClick={() => setPaymentsOpen(true)}
            >
              💳 Pagos
              {paymentPendingCount > 0 ? (
                <span className="kanban-alert-btn__badge">{paymentPendingCount}</span>
              ) : null}
            </button>
          ) : null}
          {closedCount > 0 ? (
            <button
              type="button"
              className="kanban-alert-btn kanban-alert-btn--neutral"
              onClick={() => openDrawer("closed")}
            >
              📦 Cerrados {closedCount}
            </button>
          ) : null}
          {scope === "shipping" ? (
            <a
              href="http://localhost:5500/admin/sent-orders.html"
              className="kanban-alert-btn kanban-alert-btn--neutral"
            >
              🚚 Enviados
            </a>
          ) : null}
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

      {scope === "shipping" ? <LocalCannotSeparateAlert /> : null}
      {scope === "shipping" ? (
        <OrderPaymentsPanel open={paymentsOpen} onClose={() => setPaymentsOpen(false)} />
      ) : null}
      <OrdersToastContainer />
    </div>
  );
}
