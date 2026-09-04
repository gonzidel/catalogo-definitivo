"use client";



import { useEffect, useMemo, useState } from "react";

import { orderBelongsOnKanban, type BoardScope } from "@/lib/orders/board-scope";

import { buildExpiryBellNotifications } from "@/lib/orders/expiry-bell-notifications";

import { isCustomerClosedNotificationKind } from "@/lib/orders/closed-order-messages";

import { useExpiryWarnSentStore } from "@/lib/orders/expiry-warning-sent";

import { buildWhatsAppUrl, isCustomerSourcedOrder } from "@/lib/orders/domain";

import {

  useOrderMsgNotifsStore,

  type OrderMsgNotification,

} from "@/lib/orders/local-wait-notifications";

import { useOrdersStore } from "@/hooks/useOrders";



async function copyText(text: string): Promise<boolean> {

  try {

    await navigator.clipboard.writeText(text);

    return true;

  } catch {

    return false;

  }

}



function NotifCard({

  notif,

  onCopy,

  onSend,

  onDismiss,

}: {

  notif: OrderMsgNotification;

  onCopy: () => void;

  onSend: () => void;

  onDismiss: () => void;

}) {

  const waEmpty = buildWhatsAppUrl(notif.phone);

  const isExpiry = notif.kind === "expiry_warning";

  const isClosed = isCustomerClosedNotificationKind(notif.kind);

  const copied = Boolean(notif.copiedAt);



  let cardClass = "order-msg-bell__card";

  if (isExpiry) {

    cardClass += " order-msg-bell__card--expiry";

  } else if (isClosed) {

    cardClass += " order-msg-bell__card--closed";

  } else if (copied) {

    cardClass += " order-msg-bell__card--copied";

  }



  return (

    <article className={cardClass}>

      <button

        type="button"

        className="order-msg-bell__card-close"

        aria-label="Cerrar aviso"

        onClick={onDismiss}

      >

        ×

      </button>

      {isClosed ? (

        <span className="order-msg-bell__card-badge">Cerrado</span>

      ) : null}

      <p className="order-msg-bell__card-name">{notif.customerName}</p>

      {notif.phone && waEmpty ? (

        <a

          className="order-msg-bell__card-phone"

          href={waEmpty}

          target="_blank"

          rel="noopener noreferrer"

        >

          {notif.phone}

        </a>

      ) : (

        <span className="order-msg-bell__card-phone order-msg-bell__card-phone--muted">

          Sin teléfono

        </span>

      )}

      <div className="order-msg-bell__card-actions">

        <button type="button" className="order-msg-bell__btn" onClick={onCopy}>

          Copiar mensaje

        </button>

        <button

          type="button"

          className="order-msg-bell__btn order-msg-bell__btn--primary"

          disabled={!notif.phone}

          onClick={onSend}

        >

          Enviar mensaje

        </button>

      </div>

    </article>

  );

}



interface OrderMessageBellProps {

  boardScope: BoardScope;

}



/** Campana: avisos de espera resuelta, vencimiento y cierre clienta. */

export default function OrderMessageBell({ boardScope }: OrderMessageBellProps) {

  const [open, setOpen] = useState(false);

  const [dismissedExpiryIds, setDismissedExpiryIds] = useState<Set<string>>(new Set());



  const hydrate = useOrderMsgNotifsStore((s) => s.hydrate);

  const subscribeRealtime = useOrderMsgNotifsStore((s) => s.subscribeRealtime);

  const notifications = useOrderMsgNotifsStore((s) => s.notifications);

  const markCopied = useOrderMsgNotifsStore((s) => s.markCopied);

  const dismiss = useOrderMsgNotifsStore((s) => s.dismiss);

  const completeClosed = useOrderMsgNotifsStore((s) => s.completeClosed);



  const hydrateExpirySent = useExpiryWarnSentStore((s) => s.hydrate);

  const markExpirySent = useExpiryWarnSentStore((s) => s.markSent);

  const expirySentIds = useExpiryWarnSentStore((s) => s.sentIds);



  const orders = useOrdersStore((s) => s.orders);

  const warehouseIds = useOrdersStore((s) => s.warehouseIds);



  const ordersById = useMemo(

    () => new Map(orders.map((o) => [o.id, o])),

    [orders]

  );



  const notificationBelongsToBoard = useMemo(() => {

    return (notif: OrderMsgNotification): boolean => {

      if (!notif.orderId) return boardScope === "shipping";

      const order = ordersById.get(notif.orderId);

      if (!order) {

        // Sin pedido en memoria: en retiro no mostrar (evita avisos de pedidos admin).

        // En shipping mantener avisos mientras recarga.

        return boardScope === "shipping";

      }

      // Campana solo para pedidos auto-gestionados por la clienta (no admin/PAU).

      if (!isCustomerSourcedOrder(order)) return false;

      return orderBelongsOnKanban(order, boardScope, warehouseIds);

    };

  }, [boardScope, ordersById, warehouseIds]);



  useEffect(() => {

    void hydrate();

    void hydrateExpirySent();

    const unsub = subscribeRealtime();

    return unsub;

  }, [hydrate, hydrateExpirySent, subscribeRealtime]);



  const dbNotifications = useMemo(

    () =>

      notifications.filter(

        (n) => n.kind !== "local_cannot_separate" && notificationBelongsToBoard(n)

      ),

    [notifications, notificationBelongsToBoard]

  );



  const expiryNotifications = useMemo(

    () =>

      buildExpiryBellNotifications(orders, expirySentIds, dismissedExpiryIds).filter(

        notificationBelongsToBoard

      ),

    [orders, expirySentIds, dismissedExpiryIds, notificationBelongsToBoard]

  );



  const messageNotifications = useMemo(() => {

    return [...expiryNotifications, ...dbNotifications].sort((a, b) => {

      if (a.kind === "expiry_warning" && b.kind !== "expiry_warning") return -1;

      if (b.kind === "expiry_warning" && a.kind !== "expiry_warning") return 1;

      const aClosed = isCustomerClosedNotificationKind(a.kind);

      const bClosed = isCustomerClosedNotificationKind(b.kind);

      if (aClosed && !bClosed) return -1;

      if (bClosed && !aClosed) return 1;

      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

    });

  }, [expiryNotifications, dbNotifications]);



  const count = messageNotifications.length;

  const hasPendingCopy = messageNotifications.some(

    (n) => n.kind === "expiry_warning" || !n.copiedAt

  );



  const handleCopy = async (notif: OrderMsgNotification) => {

    const ok = await copyText(notif.message);

    if (!ok) return;

    if (notif.kind === "expiry_warning") return;

    if (isCustomerClosedNotificationKind(notif.kind)) return;

    await markCopied(notif.id);

  };



  const handleSend = async (notif: OrderMsgNotification) => {

    const ok = await copyText(notif.message);

    if (!ok) return;



    if (notif.kind === "expiry_warning") {

      if (notif.orderId) {

        await markExpirySent(notif.orderId);

      }

      const url = buildWhatsAppUrl(notif.phone, notif.message);

      if (url) window.open(url, "_blank", "noopener,noreferrer");

      return;

    }



    if (isCustomerClosedNotificationKind(notif.kind)) {

      await completeClosed(notif.id, true);

      const url = buildWhatsAppUrl(notif.phone, notif.message);

      if (url) window.open(url, "_blank", "noopener,noreferrer");

      return;

    }



    await markCopied(notif.id);

    const url = buildWhatsAppUrl(notif.phone, notif.message);

    if (url) window.open(url, "_blank", "noopener,noreferrer");

  };



  const handleDismiss = (notif: OrderMsgNotification) => {

    if (notif.kind === "expiry_warning") {

      if (notif.orderId) {

        setDismissedExpiryIds((prev) => {

          const next = new Set(prev);

          next.add(notif.orderId!);

          return next;

        });

      }

      return;

    }

    void dismiss(notif.id);

  };



  const badgeLabel = count > 99 ? "99+" : String(count);



  return (

    <div className="order-msg-bell">

      <button

        type="button"

        className={`order-msg-bell__trigger${count > 0 && hasPendingCopy ? " order-msg-bell__trigger--pulse" : ""}`}

        aria-label={

          count > 0

            ? `Notificaciones de mensajes: ${count}`

            : "Notificaciones de mensajes"

        }

        aria-expanded={open}

        onClick={() => setOpen((v) => !v)}

      >

        <span className="order-msg-bell__icon" aria-hidden>

          🔔

        </span>

        {count > 0 ? (

          <span className="order-msg-bell__badge" aria-hidden>

            {badgeLabel}

          </span>

        ) : null}

      </button>



      {open ? (

        <>

          <div

            className="order-msg-bell__backdrop"

            role="presentation"

            onClick={() => setOpen(false)}

          />

          <div className="order-msg-bell__panel" role="dialog" aria-label="Mensajes pendientes">

            <div className="order-msg-bell__panel-head">

              <h2 className="order-msg-bell__panel-title">Mensajes</h2>

              <button

                type="button"

                className="order-msg-bell__panel-close"

                aria-label="Cerrar panel"

                onClick={() => setOpen(false)}

              >

                ×

              </button>

            </div>

            {count === 0 ? (

              <p className="order-msg-bell__empty">Sin avisos pendientes</p>

            ) : (

              <div className="order-msg-bell__list">

                {messageNotifications.map((notif) => (

                  <NotifCard

                    key={notif.id}

                    notif={notif}

                    onCopy={() => void handleCopy(notif)}

                    onSend={() => void handleSend(notif)}

                    onDismiss={() => handleDismiss(notif)}

                  />

                ))}

              </div>

            )}

          </div>

        </>

      ) : null}

    </div>

  );

}

