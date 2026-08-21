import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import NewRemittanceWizard from "@/components/admin-reconciliation/NewRemittanceWizard";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { RECONCILIATION_PERMISSION_KEY } from "@/lib/reconciliation/constants";
import { listTransportsForRemittance } from "@/lib/reconciliation/remittance-queries";
import styles from "../../conciliacion.module.css";

export const dynamic = "force-dynamic";

export default async function NuevaRemesaPage() {
  const ctx = await getAdminContext();
  if (!ctx) {
    return (
      <div className={styles.root}>
        <AccessDenied reason="Tu cuenta no tiene acceso al panel de administración." />
      </div>
    );
  }
  if (!hasPermission(ctx, RECONCILIATION_PERMISSION_KEY, "edit")) {
    return (
      <div className={styles.root}>
        <AccessDenied reason="No tenés permiso para crear rendiciones." />
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();
  const transports = await listTransportsForRemittance(supabase);

  return (
    <div className={styles.root}>
      <NewRemittanceWizard transports={transports} />
    </div>
  );
}
