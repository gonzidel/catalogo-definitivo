"use client";

import { useEffect } from "react";
import { useOrdersStore } from "@/hooks/useOrders";
import type { ToastKind } from "@/hooks/useOrders";

interface OrdersToastProps {
  message: string;
  kind: ToastKind;
  onDismiss: () => void;
}

export default function OrdersToast({ message, kind, onDismiss }: OrdersToastProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  return (
    <div className={`orders-toast orders-toast--${kind}`} role="status">
      {message}
    </div>
  );
}

export function OrdersToastContainer() {
  const toast = useOrdersStore((s) => s.toast);
  const clearToast = useOrdersStore((s) => s.clearToast);

  if (!toast) return null;

  return (
    <OrdersToast
      message={toast.message}
      kind={toast.kind}
      onDismiss={clearToast}
    />
  );
}
