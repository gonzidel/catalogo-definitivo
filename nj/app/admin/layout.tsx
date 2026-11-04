import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/auth/admin";

/**
 * Shell admin genérico con scroll de documento natural.
 * Oculta header/buscador/bottom-nav del catálogo vía CSS (:has(.admin-app-shell)).
 * El Kanban de pedidos se envuelve a sí mismo con `.kanban-admin-shell`
 * (que además bloquea overflow en html/body) — no aplicarlo a todo /admin.
 * Staff only: un cliente authenticated no entra (333C + launch).
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/dashboard");
  return <div className="admin-app-shell">{children}</div>;
}
