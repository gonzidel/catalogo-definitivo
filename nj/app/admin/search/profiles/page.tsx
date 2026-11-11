import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import { listSearchProfiles } from "@/lib/admin/search-profiles-admin";
import SearchProfilesQueue from "@/components/admin-search/SearchProfilesQueue";
import styles from "../search-admin.module.css";

export const dynamic = "force-dynamic";

export default async function SearchProfilesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, "search", "view")) {
    return (
      <div className={styles.page}>
        <p>Sin acceso al admin de búsqueda.</p>
      </div>
    );
  }

  const sp = await searchParams;
  const status =
    sp.status === "approved" ||
    sp.status === "rejected" ||
    sp.status === "stale" ||
    sp.status === "all"
      ? sp.status
      : "draft";

  const rows = await listSearchProfiles(status, 100);
  const canEdit = hasPermission(ctx, "search", "edit");

  return (
    <div className={styles.page}>
      <h1>Perfiles de búsqueda (IA)</h1>
      <p className={styles.muted}>
        Borradores generados por IA. La descripción pública del producto no se modifica.
        Solo <strong>approved</strong> entra al buscador.
      </p>
      <SearchProfilesQueue initialRows={rows} status={status} canEdit={canEdit} />
    </div>
  );
}
