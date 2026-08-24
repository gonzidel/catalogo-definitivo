import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import NewRemittanceWizard from "@/components/admin-reconciliation/NewRemittanceWizard";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { RECONCILIATION_PERMISSION_KEY } from "@/lib/reconciliation/constants";
import {
  getCodRemittanceDetail,
  listTransportsForRemittance,
} from "@/lib/reconciliation/remittance-queries";
import { rowsToPasteText } from "@/lib/reconciliation/paste-rebuild";
import styles from "../../../conciliacion.module.css";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

function isoToDisplay(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

export default async function RemesaEditarPage({ params }: { params: Params }) {
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
        <AccessDenied reason="No tenés permiso para editar Conciliación de reembolso." />
      </div>
    );
  }

  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const [detail, transports] = await Promise.all([
    getCodRemittanceDetail(supabase, id),
    listTransportsForRemittance(supabase),
  ]);

  if (!detail) {
    return (
      <div className={styles.root}>
        <div className={styles.shell}>
          <p className={styles.subtitle}>Rendición no encontrada.</p>
        </div>
      </div>
    );
  }

  if (detail.status === "confirmed" || detail.status === "voided") {
    return (
      <div className={styles.root}>
        <div className={styles.shell}>
          <div className={styles.errorBox}>
            <p>
              <strong>
                {detail.status === "confirmed"
                  ? "Esta rendición ya fue confirmada."
                  : "Rendición anulada — solo lectura."}
              </strong>
            </p>
            <p className={styles.cardHint}>No se puede editar la planilla.</p>
          </div>
        </div>
      </div>
    );
  }

  const approvedCount = detail.rows.filter(
    (r) => r.rowStatus === "approved_pending_confirmation"
  ).length;

  return (
    <div className={styles.root}>
      <NewRemittanceWizard
        transports={transports}
        mode="edit"
        editInitial={{
          remittanceId: detail.id,
          transportId: detail.transportId,
          transportName: detail.transportName,
          remittanceDateText: isoToDisplay(detail.remittanceDate),
          reportedTotalText: String(detail.reportedTotal),
          pasteText: rowsToPasteText(detail.rows),
          notes: detail.notes ?? "",
          status: detail.status,
          sheetRevision: detail.sheetRevision,
          rowCount: detail.rows.length,
          approvedCount,
        }}
      />
    </div>
  );
}
