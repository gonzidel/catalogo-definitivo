import {
  buildCartFingerprint,
  markCheckoutCompleted,
  markCheckoutFailed,
  peekCheckoutOperation,
  resolveCheckoutOperation,
  withCustomerCheckoutLock,
  type CheckoutOperationStorage,
  type CheckoutRequest,
  type FingerprintableCartItem,
} from "./checkout-operation";
import type { ExclusiveLock } from "./checkout-lock";

export const CHECKOUT_SYNC_FAILED = "sync_failed";

export type CheckoutRpc = (args: {
  operationId: string;
  request: CheckoutRequest;
}) => Promise<{ error?: { message: string } | null }>;

export type CustomerCheckoutResult = {
  success: boolean;
  error?: string;
  skipped?: boolean;
  operationId?: string;
  syncCalls?: number;
  rpcCalls?: number;
};

export function isEmptyCartRpcError(message?: string | null): boolean {
  if (!message) return false;
  return /no se encontró un carrito activo/i.test(message) || /carrito está vacío/i.test(message);
}

export async function runCustomerCheckout(opts: {
  customerId: string;
  items: FingerprintableCartItem[];
  syncNow: () => Promise<boolean>;
  rpc: CheckoutRpc;
  storage: CheckoutOperationStorage;
  lock?: ExclusiveLock;
}): Promise<CustomerCheckoutResult> {
  const { customerId, items, syncNow, rpc, storage } = opts;
  const fingerprint = buildCartFingerprint(items);
  let syncCalls = 0;
  let rpcCalls = 0;
  const operationSeenBeforeLock = peekCheckoutOperation(customerId, storage);

  return withCustomerCheckoutLock(
    customerId,
    async () => {
      const current = peekCheckoutOperation(customerId, storage);
      const concurrentAttemptCompletedWhileWaiting =
        operationSeenBeforeLock?.status !== "completed" &&
        current?.status === "completed" &&
        current.request.cart_fingerprint === fingerprint;

      if (concurrentAttemptCompletedWhileWaiting) {
        return {
          success: true,
          skipped: true,
          operationId: current.operationId,
          syncCalls,
          rpcCalls,
        };
      }

      const existing = peekCheckoutOperation(customerId, storage);
      const resumePending = existing?.status === "pending";
      const operation = resolveCheckoutOperation(fingerprint, customerId, storage);

      async function callRpc() {
        rpcCalls += 1;
        return rpc({
          operationId: operation.operationId,
          request: operation.request,
        });
      }

      async function syncCart(): Promise<boolean> {
        syncCalls += 1;
        return syncNow();
      }

      if (!resumePending) {
        const synced = await syncCart();
        if (!synced) {
          markCheckoutFailed(customerId, storage);
          return {
            success: false,
            error: CHECKOUT_SYNC_FAILED,
            operationId: operation.operationId,
            syncCalls,
            rpcCalls,
          };
        }
      }

      const first = await callRpc();
      if (!first.error) {
        markCheckoutCompleted(customerId, storage);
        return {
          success: true,
          operationId: operation.operationId,
          syncCalls,
          rpcCalls,
        };
      }

      if (resumePending && isEmptyCartRpcError(first.error.message)) {
        const synced = await syncCart();
        if (!synced) {
          markCheckoutFailed(customerId, storage);
          return {
            success: false,
            error: CHECKOUT_SYNC_FAILED,
            operationId: operation.operationId,
            syncCalls,
            rpcCalls,
          };
        }
        const retry = await callRpc();
        if (!retry.error) {
          markCheckoutCompleted(customerId, storage);
          return {
            success: true,
            operationId: operation.operationId,
            syncCalls,
            rpcCalls,
          };
        }
        return {
          success: false,
          error: retry.error.message,
          operationId: operation.operationId,
          syncCalls,
          rpcCalls,
        };
      }

      return {
        success: false,
        error: first.error.message,
        operationId: operation.operationId,
        syncCalls,
        rpcCalls,
      };
    },
    { lock: opts.lock, storage }
  );
}
