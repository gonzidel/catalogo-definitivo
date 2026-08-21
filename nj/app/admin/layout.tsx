/**
 * Shell admin genérico con scroll de documento natural.
 * Oculta header/buscador/bottom-nav del catálogo vía CSS (:has(.admin-app-shell)).
 * El Kanban de pedidos se envuelve a sí mismo con `.kanban-admin-shell`
 * (que además bloquea overflow en html/body) — no aplicarlo a todo /admin.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="admin-app-shell">{children}</div>;
}
