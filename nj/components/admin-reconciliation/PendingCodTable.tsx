"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { formatPriceAr } from "@/lib/orders/domain";
import type { PendingCodRow } from "@/lib/reconciliation/types";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

function formatDateAr(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function ageClass(days: number): string {
  if (days >= 90) return styles.ageAlert;
  if (days >= 45) return styles.ageWarn;
  return "";
}

type Props = {
  rows: PendingCodRow[];
  total: number;
  page: number;
  pageSize: number;
};

export default function PendingCodTable({ rows, total, page, pageSize }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const hrefForPage = (p: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (p <= 1) params.delete("page");
    else params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const maxPage = Math.max(1, Math.ceil(total / pageSize) || 1);

  return (
    <section>
      <h2 className={styles.sectionTitle}>Pedidos pendientes de rendir</h2>

      {rows.length === 0 ? (
        <div className={`${styles.tableWrap} ${styles.empty}`}>
          No hay pendientes con los filtros actuales.
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Cliente</th>
                <th>Salida</th>
                <th>Transporte</th>
                <th className={styles.tdNum}>Monto</th>
                <th className={styles.tdNum}>Antigüedad</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={styles.orderCell}>{r.orderNumber ?? r.id.slice(0, 8)}</td>
                  <td>
                    {r.displayName}
                    {r.isApprovedWaiting ? (
                      <span className={`${styles.badge} ${styles.badgeMuted}`}>
                        Esperando confirmación
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <span className={styles.mono}>{formatDateAr(r.effectiveSentDate)}</span>
                    {r.isEstimatedDate ? (
                      <span className={styles.estDate} title="Sin sent_at; se usa closed_at">
                        Fecha estimada
                      </span>
                    ) : null}
                  </td>
                  <td>{r.transportName ?? <span className={styles.muted}>Sin transporte</span>}</td>
                  <td className={styles.tdNum}>{formatPriceAr(r.amount)}</td>
                  <td className={`${styles.tdNum} ${ageClass(r.ageDays)}`}>
                    {r.ageDays} {r.ageDays === 1 ? "día" : "días"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.pagination}>
        <div className={styles.paginationInfo}>
          {total === 0
            ? "0 resultados"
            : `Mostrando ${from}–${to} de ${total.toLocaleString("es-AR")}`}
        </div>
        <div className={styles.paginationBtns}>
          {page > 1 ? (
            <Link className={styles.btn} href={hrefForPage(page - 1)}>
              Anterior
            </Link>
          ) : (
            <span className={styles.btn} style={{ opacity: 0.45, pointerEvents: "none" }}>
              Anterior
            </span>
          )}
          {page < maxPage ? (
            <Link className={styles.btn} href={hrefForPage(page + 1)}>
              Siguiente
            </Link>
          ) : (
            <span className={styles.btn} style={{ opacity: 0.45, pointerEvents: "none" }}>
              Siguiente
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
