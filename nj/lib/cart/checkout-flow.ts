import {
  buildCartFingerprint,
  markCheckoutCompleted,
  markCheckoutFailed,
  peekCheckoutOperation,
  resolveCheckoutOperation,
  shouldSkipCheckoutSync,
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

  return withCustomerCheckoutLock(
    customerId,
    async () => {
      if (shouldSkipCheckoutSync(customerId, fingerprint, storage)) {
        const skipped = peekCheckoutOperation(customerId, storage);
        return {
          success: true,
          skipped: true,
          operationId: skipped?.operationId,
          syncCalls,
          rpcCalls,
        };
      }

      const existing = peekCheckoutOperation(customerId, storage);
      const resumePending = existing?.status === "pending";
      const operation = resolveCheckoutOperation(fingerprint, customerId, storage);

      if (operation.status === "completed") {
        return {
          success: true,
          skipped: true,
          operationId: operation.operationId,
          syncCalls,
          rpcCalls,
        };
      }

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
