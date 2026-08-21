import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import RemittanceDetailView from "@/components/admin-reconciliation/RemittanceDetailView";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { RECONCILIATION_PERMISSION_KEY } from "@/lib/reconciliation/constants";
import { getCodRemittanceDetail } from "@/lib/reconciliation/remittance-queries";
import styles from "../../conciliacion.module.css";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export default async function RemesaDetailPage({ params }: { params: Params }) {
  const ctx = await getAdminContext();
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

  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const detail = await getCodRemittanceDetail(supabase, id);

  if (!detail) {
    return (
      <div className={styles.root}>
        <div className={styles.shell}>
          <p className={styles.subtitle}>Rendición no encontrada.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <RemittanceDetailView
        detail={detail}
        canEdit={hasPermission(ctx, RECONCILIATION_PERMISSION_KEY, "edit")}
      />
    </div>
  );
}
