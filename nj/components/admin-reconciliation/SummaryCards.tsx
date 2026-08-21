import Link from "next/link";
import { formatPriceAr } from "@/lib/orders/domain";
import type { ReconciliationKpis } from "@/lib/reconciliation/types";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

function hrefWithBucket(bucket: string) {
  const params = new URLSearchParams();
  if (bucket && bucket !== "all") params.set("bucket", bucket);
  const qs = params.toString();
  return qs ? `/admin/conciliacion-reembolso?${qs}#pendientes` : "/admin/conciliacion-reembolso#pendientes";
}

export default function SummaryCards({ kpis }: { kpis: ReconciliationKpis }) {
  return (
    <>
      <div className={styles.primaryGrid}>
        <Link
          href={hrefWithBucket("pending")}
          className={`${styles.card} ${styles.cardPrimary} ${styles.cardClickable}`}
        >
          <p className={styles.cardLabel}>Pendientes de rendir</p>
          <p className={styles.cardValue}>{kpis.pendingCount.toLocaleString("es-AR")}</p>
          <p className={styles.cardMeta}>{formatPriceAr(kpis.pendingAmount)}</p>
          {kpis.approvedWaitingCount > 0 ? (
            <p className={styles.cardHint}>
              De estos, {kpis.approvedWaitingCount.toLocaleString("es-AR")} ya están aprobados y
              solo falta confirmar su rendición · {formatPriceAr(kpis.approvedWaitingAmount)}
            </p>
          ) : (
            <p className={styles.cardHint}>Deuda COD aún sin asociación confirmada</p>
          )}
        </Link>

        <Link
          href="/admin/conciliacion-reembolso?bucket=reconciled#rendiciones"
          className={`${styles.card} ${styles.cardClickable}`}
        >
          <p className={styles.cardLabel}>Conciliados</p>
          <p className={styles.cardValue}>
            {kpis.reconciledTotalCount.toLocaleString("es-AR")}
          </p>
          <p className={styles.cardMeta}>{formatPriceAr(kpis.reconciledTotalAmount)}</p>
          <p className={styles.cardHint}>
            Exactos {kpis.reconciledExactCount.toLocaleString("es-AR")} · Con irreg. abierta{" "}
            {kpis.reconciledOpenIrregularityCount.toLocaleString("es-AR")}
          </p>
        </Link>

        <Link
          href="/admin/conciliacion-reembolso/irregularidades"
          className={`${styles.card} ${styles.cardClickable}`}
        >
          <p className={styles.cardLabel}>Irregularidades abiertas</p>
          <p className={styles.cardValue}>
            {kpis.openIrregularitiesCount.toLocaleString("es-AR")}
          </p>
          <p className={styles.cardMeta}>
            − {formatPriceAr(Math.abs(kpis.openDiffNegative))} · +{" "}
            {formatPriceAr(kpis.openDiffPositive)}
          </p>
          <p className={styles.cardHint}>Reclamos abiertos por diferencia de monto</p>
        </Link>
      </div>

      <div className={styles.secondaryRow}>
        <div className={styles.secondaryItem}>
          <span>Total COD</span>
          <strong>
            {kpis.universeCount.toLocaleString("es-AR")} · {formatPriceAr(kpis.universeAmount)}
          </strong>
        </div>
        {kpis.unassignedPaymentsCount > 0 ? (
          <Link
            href="/admin/conciliacion-reembolso/sin-identificar"
            className={`${styles.secondaryItem} ${styles.secondaryClickable}`}
          >
            <span>Sin identificar</span>
            <strong>
              {kpis.unassignedPaymentsCount.toLocaleString("es-AR")} ·{" "}
              {formatPriceAr(kpis.unassignedPaymentsAmount)}
            </strong>
          </Link>
        ) : (
          <div className={styles.secondaryItem}>
            <span>Sin identificar</span>
            <strong>
              {kpis.unassignedPaymentsCount.toLocaleString("es-AR")} ·{" "}
              {formatPriceAr(kpis.unassignedPaymentsAmount)}
            </strong>
          </div>
        )}
        {kpis.approvedWaitingCount > 0 ? (
          <Link
            href={hrefWithBucket("waiting")}
            className={`${styles.secondaryItem} ${styles.secondaryClickable}`}
          >
            <span>Esperando confirmación</span>
            <strong>
              {kpis.approvedWaitingCount.toLocaleString("es-AR")} ·{" "}
              {formatPriceAr(kpis.approvedWaitingAmount)}
            </strong>
          </Link>
        ) : (
          <div className={styles.secondaryItem}>
            <span>Esperando confirmación</span>
            <strong>0 · {formatPriceAr(0)}</strong>
          </div>
        )}
      </div>
    </>
  );
}
