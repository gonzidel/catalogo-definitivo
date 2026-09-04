"use client";

import { useEffect } from "react";
import {
  useOrderMsgNotifsStore,
  type OrderMsgNotification,
} from "@/lib/orders/local-wait-notifications";

function pickLatest(
  notifications: OrderMsgNotification[]
): OrderMsgNotification | null {
  const list = notifications.filter((n) => n.kind === "local_cannot_separate");
  if (list.length === 0) return null;
  return list.reduce((a, b) =>
    a.createdAt >= b.createdAt ? a : b
  );
}

/** Modal centrado cuando el depósito reporta que no puede separar. */
export default function LocalCannotSeparateAlert() {
  const hydrate = useOrderMsgNotifsStore((s) => s.hydrate);
  const subscribeRealtime = useOrderMsgNotifsStore((s) => s.subscribeRealtime);
  const notifications = useOrderMsgNotifsStore((s) => s.notifications);
  const markCopied = useOrderMsgNotifsStore((s) => s.markCopied);
  const dismiss = useOrderMsgNotifsStore((s) => s.dismiss);

  useEffect(() => {
    void hydrate();
    const unsub = subscribeRealtime();
    return unsub;
  }, [hydrate, subscribeRealtime]);

  const active = pickLatest(notifications);
  if (!active) return null;

  const handleAvisar = async () => {
    await markCopied(active.id);
  };

  const handleAceptar = async () => {
    await dismiss(active.id);
  };

  return (
    <div
      className="local-cannot-separate-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="local-cannot-separate-title"
    >
      <div className="local-cannot-separate-modal">
        <p className="local-cannot-separate-modal__eyebrow">Aviso del depósito</p>
        <h2 id="local-cannot-separate-title" className="local-cannot-separate-modal__title">
          El local no puede separar
        </h2>
        <p className="local-cannot-separate-modal__text">{active.message}</p>
        <div className="local-cannot-separate-modal__actions">
          <button
            type="button"
            className="local-cannot-separate-modal__btn local-cannot-separate-modal__btn--warn"
            onClick={() => void handleAvisar()}
          >
            Avisar
          </button>
          <button
            type="button"
            className="local-cannot-separate-modal__btn local-cannot-separate-modal__btn--ok"
            onClick={() => void handleAceptar()}
          >
            Aceptar
          </button>
        </div>
      </div>
    </div>
  );
}
