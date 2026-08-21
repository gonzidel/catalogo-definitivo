"use client";

import Link from "next/link";
import type { ReconciliationDashboardData } from "@/lib/reconciliation/types";
import type { RemittanceListItem } from "@/lib/reconciliation/remittance-queries";
import SummaryCards from "@/components/admin-reconciliation/SummaryCards";
import ReconciliationFilters from "@/components/admin-reconciliation/ReconciliationFilters";
import PendingCodTable from "@/components/admin-reconciliation/PendingCodTable";
import RemittanceHistoryTable from "@/components/admin-reconciliation/RemittanceHistoryTable";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

export default function ReconciliationDashboard({
  data,
  remittances,
  canCreateRemittance,
}: {
  data: ReconciliationDashboardData;
  remittances: RemittanceListItem[];
  canCreateRemittance: boolean;
}) {
  const { kpis, filters } = data;
  const identityOk =
    kpis.universeCount === kpis.pendingCount + kpis.reconciledTotalCount;

  const remittanceFilter =
    filters.bucket === "reconciled" ? ("confirmed" as const) : ("all" as const);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Admin · Contra reembolso</p>
        <h1 className={styles.title}>Conciliación de reembolso</h1>
        <p className={styles.subtitle}>
          Seguimiento de deuda COD por mes de salida y transporte. Las rendiciones se cargan como
          borrador; confirmar es la única acción que cierra pagos.
        </p>
        <div className={styles.headerActions}>
          {canCreateRemittance ? (
            <Link
              href="/admin/conciliacion-reembolso/remesas/nueva"
              className={`${styles.btn} ${styles.btnPrimary}`}
            >
              Nueva rendición
            </Link>
          ) : null}
          <Link href="/admin/conciliacion-reembolso/aliases" className={styles.btn}>
            Alias de transportes
          </Link>
          <Link href="/admin/conciliacion-reembolso/irregularidades" className={styles.btn}>
            Irregularidades
          </Link>
          <Link href="/admin/conciliacion-reembolso/sin-identificar" className={styles.btn}>
            Sin identificar
          </Link>
        </div>
      </header>

      {!identityOk ? (
        <div className={styles.errorBox}>
          Inconsistencia: universo ({kpis.universeCount}) ≠ pendientes (
          {kpis.pendingCount}) + conciliados ({kpis.reconciledTotalCount}).
        </div>
      ) : null}

      <SummaryCards kpis={kpis} />

      <ReconciliationFilters
        months={data.months}
        transports={data.transports}
        month={filters.month}
        transportId={filters.transportId}
        q={filters.q}
        bucket={filters.bucket}
      />

      {filters.bucket !== "reconciled" ? (
        <div id="pendientes" className={styles.sectionAnchor}>
          <PendingCodTable
            rows={data.pendingRows}
            total={data.pendingTotal}
            page={data.pendingPage}
            pageSize={data.pendingPageSize}
          />
        </div>
      ) : (
        <p className={styles.infoBox} id="pendientes">
          Filtro «Conciliados»: los pendientes se ocultan. Revisá las rendiciones confirmadas
          abajo.
        </p>
      )}

      <div id="rendiciones" className={styles.sectionAnchor}>
        <RemittanceHistoryTable
          items={remittances}
          canCreate={canCreateRemittance}
          statusFilter={remittanceFilter}
        />
      </div>
    </div>
  );
}
