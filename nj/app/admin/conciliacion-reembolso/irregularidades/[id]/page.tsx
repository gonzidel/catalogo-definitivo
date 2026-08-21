import Link from "next/link";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import IrregularityDetailView from "@/components/admin-reconciliation/IrregularityDetailView";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadIrregularityDetail } from "@/lib/reconciliation/irregularity-queries";
import { RECONCILIATION_PERMISSION_KEY } from "@/lib/reconciliation/constants";
import styles from "../../conciliacion.module.css";

export const dynamic = "force-dynamic";

export default async function IrregularidadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getAdminContext();
  const { id } = await params;

  if (!ctx) {
    return (
      <div className={styles.root}>
        <AccessDenied reason="Tu cuenta no tiene acceso al panel de administración." />
      </div>
    );
  }

  if (!hasPermission(ctx, RECONCILIATION_PERMISSION_KEY, "view")) {
    return (
      <div className={styles.root}>
        <AccessDenied reason="No tenés permiso para ver Conciliación de reembolso." />
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();
  const detail = await loadIrregularityDetail(supabase, id);
  const canEdit = hasPermission(ctx, RECONCILIATION_PERMISSION_KEY, "edit");

  if (!detail) {
    return (
      <div className={styles.root}>
        <div className={styles.shell}>
          <p className={styles.errorBox}>Reclamo no encontrado.</p>
          <Link href="/admin/conciliacion-reembolso/irregularidades" className={styles.btn}>
            Volver
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <IrregularityDetailView detail={detail} canEdit={canEdit} />
    </div>
  );
}
