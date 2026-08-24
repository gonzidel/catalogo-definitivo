"use client";

import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";
import { formatPriceAr } from "@/lib/orders/domain";
import type {
  IrregularityKpis,
  IrregularityListItem,
  IrregularityFilters,
} from "@/lib/reconciliation/irregularity-queries";
import { amountDiffLabel } from "@/lib/reconciliation/match-presentation";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

function formatDateAr(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Abierto";
    case "in_review":
      return "En revisión";
    case "resolved":
      return "Resuelto";
    case "superseded":
      return "Invalidado";
    default:
      return status;
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "open":
      return styles.badgeWarn;
    case "in_review":
      return styles.badgeMuted;
    case "resolved":
      return styles.badgeOk;
    case "superseded":
      return styles.badgeDanger;
    default:
      return styles.badgeMuted;
  }
}

export default function IrregularitiesPanel({
  kpis,
  items,
  filters,
  transports,
}: {
  kpis: IrregularityKpis;
  items: IrregularityListItem[];
  filters: IrregularityFilters;
  transports: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const setFilter = useCallback(
    (key: "status" | "transport" | "from" | "to", value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      const isDefaultStatus = key === "status" && value === "open";
      const isAllTransport = key === "transport" && value === "all";
      if (!value || isDefaultStatus || isAllTransport) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      const qs = params.toString();
      startTransition(() => {
        router.push(qs ? `${pathname}?${qs}` : pathname);
      });
    },
    [searchParams, pathname, router]
  );

  const hasActive =
    filters.status !== "open" ||
    filters.transportId !== "all" ||
    !!filters.fromDate ||
    !!filters.toDate;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Admin · Contra reembolso</p>
        <h1 className={styles.title}>Irregularidades / Reclamos</h1>
        <p className={styles.subtitle}>
          Reclamos al transporte por diferencia de monto en rendiciones ya confirmadas.
          Resolver cierra el reclamo sin deshacer la conciliación del pedido.
        </p>
        <div className={styles.headerActions}>
          <Link href="/admin/conciliacion-reembolso" className={styles.btn}>
            Volver al dashboard
          </Link>
        </div>
      </header>

      <div className={styles.secondaryRow}>
        <div className={styles.secondaryItem}>
          <span>Abiertas</span>
          <strong>{kpis.openCount.toLocaleString("es-AR")}</strong>
        </div>
        <div className={styles.secondaryItem}>
          <span>En revisión</span>
          <strong>{kpis.inReviewCount.toLocaleString("es-AR")}</strong>
        </div>
        <div className={styles.secondaryItem}>
          <span>Diferencias negativas</span>
          <strong>{formatPriceAr(Math.abs(kpis.negativeSum))}</strong>
        </div>
        <div className={styles.secondaryItem}>
          <span>Diferencias positivas</span>
          <strong>{formatPriceAr(kpis.positiveSum)}</strong>
        </div>
        <div className={styles.secondaryItem}>
          <span>Neto</span>
          <strong>
            {kpis.netSum > 0 ? "+" : ""}
            {formatPriceAr(kpis.netSum)}
          </strong>
        </div>
      </div>

      <form className={styles.filters} onSubmit={(e) => e.preventDefault()}>
        <div className={styles.filterGroup}>
          <label htmlFor="irr-status">Estado</label>
          <select
            id="irr-status"
            value={filters.status}
            disabled={pending}
            onChange={(e) => setFilter("status", e.target.value)}
          >
            <option value="open">Abiertas</option>
            <option value="in_review">En revisión</option>
            <option value="resolved">Resueltas</option>
            <option value="all">Todas</option>
          </select>
        </div>
        <div className={styles.filterGroup}>
          <label htmlFor="irr-transport">Transporte</label>
          <select
            id="irr-transport"
            value={filters.transportId}
            disabled={pending}
            onChange={(e) => setFilter("transport", e.target.value)}
          >
            <option value="all">Todos</option>
            {transports.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.filterGroup}>
          <label htmlFor="irr-from">Desde</label>
          <input
            id="irr-from"
            type="date"
            value={filters.fromDate}
            disabled={pending}
            onChange={(e) => setFilter("from", e.target.value)}
          />
        </div>
        <div className={styles.filterGroup}>
          <label htmlFor="irr-to">Hasta</label>
          <input
            id="irr-to"
            type="date"
            value={filters.toDate}
            disabled={pending}
            onChange={(e) => setFilter("to", e.target.value)}
          />
        </div>
        {hasActive ? (
          <div className={styles.filterActions}>
            <button
              type="button"
              className={styles.btn}
              disabled={pending}
              onClick={() => {
                startTransition(() => router.push(pathname));
              }}
            >
              Limpiar filtros
            </button>
          </div>
        ) : null}
      </form>

      {items.length === 0 ? (
        <div className={`${styles.tableWrap} ${styles.empty}`}>
          No hay irregularidades con los filtros actuales.
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Cliente</th>
                <th>Nº</th>
                <th>Transporte</th>
                <th>Fecha salida</th>
                <th>Fecha rendición</th>
                <th className={styles.tdNum}>Esperado</th>
                <th className={styles.tdNum}>Rendido</th>
                <th>Tipo</th>
                <th className={styles.tdNum}>Diferencia</th>
                <th>Estado</th>
                <th className={styles.tdNum}>Antigüedad</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const diffLab = amountDiffLabel(r.amountDiff);
                return (
                <tr key={r.id}>
                  <td className={styles.orderCell}>
                    <Link href={`/admin/conciliacion-reembolso/irregularidades/${r.id}`}>
                      {r.orderNumber ?? r.orderId.slice(0, 8)}
                    </Link>
                  </td>
                  <td>{r.customerName ?? "—"}</td>
                  <td className={styles.mono}>{r.customerNumber ? `#${r.customerNumber}` : "—"}</td>
                  <td>{r.transportName ?? "—"}</td>
                  <td className={styles.mono}>{formatDateAr(r.orderSentDate)}</td>
                  <td className={styles.mono}>{formatDateAr(r.remittanceDate)}</td>
                  <td className={styles.tdNum}>{formatPriceAr(r.expectedAmount)}</td>
                  <td className={styles.tdNum}>{formatPriceAr(r.reportedAmount)}</td>
                  <td>
                    <span
                      className={`${styles.badge} ${
                        diffLab.kind === "faltante"
                          ? styles.badgeDanger
                          : diffLab.kind === "sobrante"
                            ? styles.badgeWarn
                            : styles.badgeMuted
                      }`}
                    >
                      {diffLab.kind === "faltante"
                        ? "Faltante"
                        : diffLab.kind === "sobrante"
                          ? "Sobrante"
                          : "Exacto"}
                    </span>
                  </td>
                  <td
                    className={`${styles.tdNum} ${r.amountDiff !== 0 ? styles.diffAlert : ""}`}
                  >
                    {diffLab.short}
                  </td>
                  <td>
                    <span className={`${styles.badge} ${statusClass(r.status)}`}>
                      {statusLabel(r.status)}
                    </span>
                  </td>
                  <td className={styles.tdNum}>
                    {r.ageDays} {r.ageDays === 1 ? "día" : "días"}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
