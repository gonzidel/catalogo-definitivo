import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import UnassignedPaymentsPanel from "@/components/admin-reconciliation/UnassignedPaymentsPanel";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listUnassignedConfirmedPayments } from "@/lib/reconciliation/unassigned-queries";
import { RECONCILIATION_PERMISSION_KEY } from "@/lib/reconciliation/constants";
import styles from "../conciliacion.module.css";

export const dynamic = "force-dynamic";

export default async function SinIdentificarPage() {
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

  const supabase = await createSupabaseServerClient();
  const items = await listUnassignedConfirmedPayments(supabase);
  const canEdit = hasPermission(ctx, RECONCILIATION_PERMISSION_KEY, "edit");

  return (
    <div className={styles.root}>
      <UnassignedPaymentsPanel items={items} canEdit={canEdit} />
    </div>
  );
}
