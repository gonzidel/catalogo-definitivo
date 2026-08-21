import Link from "next/link";
import { formatPriceAr } from "@/lib/orders/domain";
import type { RemittanceListItem } from "@/lib/reconciliation/remittance-queries";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

function formatDateAr(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Borrador";
    case "analyzed":
      return "Analizada";
    case "confirmed":
      return "Confirmada";
    case "voided":
      return "Anulada";
    default:
      return status;
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "draft":
      return styles.statusDraft;
    case "analyzed":
      return styles.statusAnalyzed;
    case "confirmed":
      return styles.statusConfirmed;
    case "voided":
      return styles.statusVoided;
    default:
      return styles.statusDraft;
  }
}

export default function RemittanceHistoryTable({
  items,
  canCreate,
  statusFilter = "all",
}: {
  items: RemittanceListItem[];
  canCreate: boolean;
  statusFilter?: "all" | "confirmed";
}) {
  const visible =
    statusFilter === "confirmed" ? items.filter((r) => r.status === "confirmed") : items;

  return (
    <section style={{ marginTop: 28 }}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Rendiciones</h2>
        {canCreate ? (
          <Link
            href="/admin/conciliacion-reembolso/remesas/nueva"
            className={`${styles.btn} ${styles.btnPrimary}`}
          >
            Nueva rendición
          </Link>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <div className={`${styles.tableWrap} ${styles.empty}`}>
          {statusFilter === "confirmed"
            ? "No hay rendiciones confirmadas todavía."
            : "Todavía no hay rendiciones cargadas."}
          {canCreate && statusFilter !== "confirmed" ? (
            <>
              {" "}
              <Link href="/admin/conciliacion-reembolso/remesas/nueva">Crear la primera</Link>.
            </>
          ) : null}
        </div>
      ) : (
        <div className={`${styles.tableWrap} ${styles.tableWrapCompact}`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Fecha rendición</th>
                <th>Transporte</th>
                <th className={styles.tdNum}>Filas</th>
                <th className={styles.tdNum}>Informado</th>
                <th className={styles.tdNum}>Calculado</th>
                <th className={styles.tdNum}>Diferencia</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const calc = r.calculatedTotal ?? 0;
                const diff = Math.round((calc - r.reportedTotal) * 100) / 100;
                return (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/admin/conciliacion-reembolso/remesas/${r.id}`}>
                        {formatDateAr(r.remittanceDate)}
                      </Link>
                    </td>
                    <td>{r.transportName ?? "—"}</td>
                    <td className={styles.tdNum}>{r.rowCount}</td>
                    <td className={styles.tdNum}>{formatPriceAr(r.reportedTotal)}</td>
                    <td className={styles.tdNum}>{formatPriceAr(calc)}</td>
                    <td className={styles.tdNum}>
                      {diff === 0 ? (
                        "—"
                      ) : (
                        <span className={diff !== 0 ? styles.diffAlert : undefined}>
                          {diff > 0 ? "+" : ""}
                          {formatPriceAr(diff)}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`${styles.statusBadge} ${statusClass(r.status)}`}>
                        {statusLabel(r.status)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
