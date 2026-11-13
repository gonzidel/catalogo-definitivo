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
        Borradores generados por IA (modelo default <code>gpt-6-luna</code>) la primera vez que el
        producto tiene tags + talles + foto. La descripción pública no se modifica. Solo{" "}
        <strong>approved</strong> entra al buscador. Los de alta confianza se aprueban solos; los
        dudosos quedan en &quot;draft&quot; para revisar a mano. Usá &quot;Generar faltantes&quot;
        para el catálogo ya cargado (cada clic procesa varios lotes).
      </p>
      <SearchProfilesQueue initialRows={rows} status={status} canEdit={canEdit} />
    </div>
  );
}
