"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import type { MonthOption, TransportOption } from "@/lib/reconciliation/types";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

type Props = {
  months: MonthOption[];
  transports: TransportOption[];
  month: string;
  transportId: string;
  q: string;
  bucket: string;
};

export default function ReconciliationFilters({
  months,
  transports,
  month,
  transportId,
  q,
  bucket,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [localQ, setLocalQ] = useState(q);

  const pushFilters = useCallback(
    (next: {
      month?: string;
      transport?: string;
      q?: string;
      page?: string;
      bucket?: string;
    }) => {
      const params = new URLSearchParams(searchParams.toString());
      const monthVal = next.month ?? month;
      const transportVal = next.transport ?? transportId;
      const qVal = next.q ?? localQ;
      const bucketVal = next.bucket ?? bucket;

      if (!monthVal || monthVal === "all") params.delete("month");
      else params.set("month", monthVal);

      if (!transportVal || transportVal === "all") params.delete("transport");
      else params.set("transport", transportVal);

      const trimmed = qVal.trim();
      if (!trimmed) params.delete("q");
      else params.set("q", trimmed);

      if (!bucketVal || bucketVal === "all") params.delete("bucket");
      else params.set("bucket", bucketVal);

      if (next.page && next.page !== "1") params.set("page", next.page);
      else params.delete("page");

      const qs = params.toString();
      startTransition(() => {
        router.push(qs ? `${pathname}?${qs}` : pathname);
      });
    },
    [searchParams, month, transportId, localQ, bucket, pathname, router]
  );

  const hasActive =
    (month && month !== "all") ||
    (transportId && transportId !== "all") ||
    !!q.trim() ||
    (bucket && bucket !== "all");

  return (
    <>
      <form
        className={styles.filters}
        onSubmit={(e) => {
          e.preventDefault();
          pushFilters({ q: localQ, page: "1" });
        }}
      >
        <div className={styles.filterGroup}>
          <label htmlFor="cod-month">Mes de salida</label>
          <select
            id="cod-month"
            value={month}
            disabled={pending}
            onChange={(e) => pushFilters({ month: e.target.value, page: "1" })}
          >
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.filterGroup}>
          <label htmlFor="cod-transport">Transporte</label>
          <select
            id="cod-transport"
            value={transportId}
            disabled={pending}
            onChange={(e) => pushFilters({ transport: e.target.value, page: "1" })}
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
          <label htmlFor="cod-bucket">Estado</label>
          <select
            id="cod-bucket"
            value={bucket || "all"}
            disabled={pending}
            onChange={(e) => pushFilters({ bucket: e.target.value, page: "1" })}
          >
            <option value="all">Todos</option>
            <option value="pending">Pendientes</option>
            <option value="waiting">Aprobados esperando confirmación</option>
            <option value="reconciled">Conciliados</option>
          </select>
        </div>

        <div className={styles.filterGroup}>
          <label htmlFor="cod-q">Buscar pedido / nombre</label>
          <input
            id="cod-q"
            type="search"
            value={localQ}
            disabled={pending}
            placeholder="Nº pedido o cliente"
            onChange={(e) => setLocalQ(e.target.value)}
          />
        </div>

        <div className={styles.filterActions}>
          <button
            type="submit"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={pending}
          >
            Buscar
          </button>
          {hasActive ? (
            <button
              type="button"
              className={styles.btn}
              disabled={pending}
              onClick={() => {
                setLocalQ("");
                pushFilters({
                  month: "all",
                  transport: "all",
                  q: "",
                  bucket: "all",
                  page: "1",
                });
              }}
            >
              Limpiar filtros
            </button>
          ) : null}
        </div>
      </form>

      {hasActive ? (
        <div className={styles.filterChips} aria-label="Filtros activos">
          {month !== "all" ? (
            <span className={styles.filterChip}>
              Mes: {months.find((m) => m.value === month)?.label ?? month}
            </span>
          ) : null}
          {transportId !== "all" ? (
            <span className={styles.filterChip}>
              Transporte: {transports.find((t) => t.id === transportId)?.name ?? transportId}
            </span>
          ) : null}
          {bucket !== "all" ? (
            <span className={styles.filterChip}>
              Estado:{" "}
              {bucket === "pending"
                ? "Pendientes"
                : bucket === "waiting"
                  ? "Esperando confirmación"
                  : "Conciliados"}
            </span>
          ) : null}
          {q.trim() ? <span className={styles.filterChip}>Buscar: {q.trim()}</span> : null}
        </div>
      ) : null}
    </>
  );
}
