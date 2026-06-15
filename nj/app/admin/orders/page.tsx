import { fetchOrdersInitial } from "@/lib/supabase/order-queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import KanbanBoard from "@/components/orders/KanbanBoard";

export const dynamic = "force-dynamic";

export default async function AdminOrdersPage() {
  const supabase = await createSupabaseServerClient();
  const initialOrders = await fetchOrdersInitial(supabase);

  return <KanbanBoard initialOrders={initialOrders} />;
}
