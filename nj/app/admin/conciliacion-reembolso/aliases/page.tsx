import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import TransportAliasesAdmin from "@/components/admin-reconciliation/TransportAliasesAdmin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listTransportCustomerAliases } from "@/lib/reconciliation/alias-queries";
import { RECONCILIATION_PERMISSION_KEY } from "@/lib/reconciliation/constants";
import styles from "../conciliacion.module.css";

export const dynamic = "force-dynamic";

export default async function TransportAliasesPage() {
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
  const aliases = await listTransportCustomerAliases(supabase);
  const canEdit = hasPermission(ctx, RECONCILIATION_PERMISSION_KEY, "edit");

  return (
    <div className={styles.root}>
      <TransportAliasesAdmin aliases={aliases} canEdit={canEdit} />
    </div>
  );
}
