import { redirect } from "next/navigation";
import { createSupabaseServerClient, getServerUser } from "@/lib/supabase/server";
import DashboardClient from "./DashboardClient";
import { canonicalizeTransportName } from "@/lib/transport";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getServerUser();
  if (!user) redirect("/login");

  const supabase = await createSupabaseServerClient();

  // Load customer profile
  const { data: customer } = await supabase
    .from("customers")
    .select("id, full_name, email, phone, address, dni, city, province, customer_number, transport_id, created_at")
    .eq("id", user.id)
    .maybeSingle();

  // Nombre del transporte asignado (customers.transport_id). Fuente de verdad
  // compartida con admin/closed-orders — gana sobre geo/localStorage en el cliente.
  let assignedTransportName: string | null = null;
  if (customer?.transport_id) {
    const { data: transport } = await supabase
      .from("transports")
      .select("name")
      .eq("id", customer.transport_id)
      .maybeSingle();
    assignedTransportName = canonicalizeTransportName(transport?.name ?? "") || null;
  }

  // Load orders with items
  const { data: orders } = await supabase
    .from("orders")
    .select(`
      id,
      order_number,
      status,
      total_amount,
      created_at,
      payment_method,
      dismantle_at,
      local_deferred_pickup,
      expires_at,
      notes,
      order_items (
        id,
        product_name,
        color,
        size,
        quantity,
        price_snapshot,
        imagen,
        sku,
        status,
        created_at,
        variant_id,
        order_item_stock_sources ( warehouse_id, qty )
      )
    `)
    .eq("customer_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <DashboardClient
      user={{ id: user.id, email: user.email ?? "" }}
      customer={customer ?? null}
      orders={orders ?? []}
      assignedTransportName={assignedTransportName}
    />
  );
}
