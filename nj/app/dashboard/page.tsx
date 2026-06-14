import { redirect } from "next/navigation";
import { createSupabaseServerClient, getServerUser } from "@/lib/supabase/server";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getServerUser();
  if (!user) redirect("/login");

  const supabase = await createSupabaseServerClient();

  // Load customer profile
  const { data: customer } = await supabase
    .from("customers")
    .select("id, full_name, email, phone, city, province, customer_number, created_at")
    .eq("id", user.id)
    .maybeSingle();

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
        variant_id
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
    />
  );
}
