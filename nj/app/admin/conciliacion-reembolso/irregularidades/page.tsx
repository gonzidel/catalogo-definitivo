import { Suspense } from "react";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import IrregularitiesPanel from "@/components/admin-reconciliation/IrregularitiesPanel";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  listIrregularities,
  loadIrregularityKpis,
} from "@/lib/reconciliation/irregularity-queries";
import { RECONCILIATION_PERMISSION_KEY } from "@/lib/reconciliation/constants";
import styles from "../conciliacion.module.css";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  status?: string;
  transport?: string;
  from?: string;
  to?: string;
}>;

export default async function IrregularidadesPage({
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
        <AccessDenied reason="No tenés permiso para ver Conciliación de reembolso." />
      </div>
    );
  }

  const sp = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [kpis, list] = await Promise.all([
    loadIrregularityKpis(supabase),
    listIrregularities(supabase, {
      status: sp.status,
      transport: sp.transport,
      from: sp.from,
      to: sp.to,
    }),
  ]);

  return (
    <div className={styles.root}>
      <Suspense fallback={<div className={styles.shell}>Cargando…</div>}>
        <IrregularitiesPanel
          kpis={kpis}
          items={list.items}
          filters={list.filters}
          transports={list.transports}
        />
      </Suspense>
    </div>
  );
}
