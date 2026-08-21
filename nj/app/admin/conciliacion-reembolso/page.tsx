import { Suspense } from "react";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import ReconciliationDashboard from "@/components/admin-reconciliation/ReconciliationDashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadReconciliationDashboard } from "@/lib/reconciliation/queries";
import { listCodRemittances } from "@/lib/reconciliation/remittance-queries";
import { RECONCILIATION_PERMISSION_KEY } from "@/lib/reconciliation/constants";
import styles from "./conciliacion.module.css";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  month?: string;
  transport?: string;
  q?: string;
  page?: string;
  bucket?: string;
}>;

export default async function ConciliacionReembolsoPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
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
        <AccessDenied reason="No tenés permiso para ver Conciliación de reembolso. Por ahora el módulo está disponible solo para super admin." />
      </div>
    );
  }

  const sp = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [data, remittances] = await Promise.all([
    loadReconciliationDashboard(supabase, {
      month: sp.month,
      transport: sp.transport,
      q: sp.q,
      page: sp.page,
      bucket: sp.bucket,
    }),
    listCodRemittances(supabase),
  ]);

  const canCreateRemittance = hasPermission(ctx, RECONCILIATION_PERMISSION_KEY, "edit");

  return (
    <div className={styles.root}>
      <Suspense fallback={<div className={styles.shell}>Cargando…</div>}>
        <ReconciliationDashboard
          data={data}
          remittances={remittances}
          canCreateRemittance={canCreateRemittance}
        />
      </Suspense>
    </div>
  );
}
