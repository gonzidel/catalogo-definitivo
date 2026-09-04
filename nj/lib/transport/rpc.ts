import type { SupabaseClient } from "@supabase/supabase-js";

export type SetTransportResult = {
  ok: boolean;
  transport_id?: string;
  transport_name?: string | null;
};

function parseTransportRpcPayload(data: unknown): SetTransportResult {
  if (!data || typeof data !== "object") {
    return { ok: true };
  }
  const row = data as Record<string, unknown>;
  return {
    ok: row.ok !== false,
    transport_id: typeof row.transport_id === "string" ? row.transport_id : undefined,
    transport_name:
      typeof row.transport_name === "string" ? row.transport_name : null,
  };
}

/** Cliente: guarda transporte preferido en customers (+ pedidos operativos). */
export async function rpcSetMyTransport(
  supabase: SupabaseClient,
  transportName: string
): Promise<SetTransportResult> {
  const { data, error } = await supabase.rpc("rpc_set_my_transport", {
    p_transport_name: transportName,
  });
  if (error) throw error;
  return parseTransportRpcPayload(data);
}

/** Cliente: antes de cerrar, fija transporte en customer + ese pedido. */
export async function rpcSetTransportBeforeCloseOrder(
  supabase: SupabaseClient,
  orderId: string,
  transportName: string
): Promise<SetTransportResult> {
  const { data, error } = await supabase.rpc(
    "rpc_set_transport_before_close_order",
    {
      p_order_id: orderId,
      p_transport_name: transportName,
    }
  );
  if (error) throw error;
  return parseTransportRpcPayload(data);
}
